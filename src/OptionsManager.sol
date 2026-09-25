// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint128} from "v4-core/libraries/FixedPoint128.sol";
import {ERC1155} from "solmate/src/tokens/ERC1155.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

import {PositionId} from "./libraries/PositionId.sol";
import {IAqua} from "./interfaces/IAqua.sol";

/// @title OptionsManager
/// @notice A perpetual options market built by *reusing* Uniswap v4 liquidity instead of
///         bootstrapping an options order book.
///
/// @dev The core equivalence
///      ----------------------
///      A concentrated liquidity position has the payoff of a short option:
///
///        * Range entirely BELOW spot → the LP holds currency1 (USDC) and earns swap fees. If price
///          falls through the range they end up holding currency0 (ETH) bought at the range price.
///          That is a SHORT PUT: collect premium, get assigned the underlying on a drawdown.
///        * Range entirely ABOVE spot → mirror image. That is a SHORT CALL.
///
///      So writing an option is literally minting liquidity, and buying one is literally removing
///      that liquidity from the pool — which hands the buyer the inverted payoff. No separate
///      options liquidity has to be sourced; the AMM's own liquidity and pricing are reused.
///
///      Premium
///      -------
///      Premium is not modelled, quoted, or oracle-derived. It is the pool's own
///      `feeGrowthInside` over the option's tick range — real fees paid by real swappers:
///
///        premium(position) = (feeGrowthInside_now - feeGrowthInside_at_open) * liquidity / 2**128
///
///      A short EARNS that. A long OWES it (it is the rent for having pulled that liquidity out of
///      the pool). The two net out exactly, because the fees the pool actually collects accrue on
///      `shortLiquidity - longLiquidity`, while shorts are owed on `shortLiquidity` and longs owe on
///      `longLiquidity`. See `test/OptionsManager.t.sol:test_premiumConservation`.
///
///      Hackathon scope
///      ---------------
///      Deliberately NOT built (roadmap only, see README): Aave yield stacking, IV-aware pricing
///      floor, insurance fund, auto-deleveraging, portfolio margin, flash-loan liquidation bots,
///      multi-asset markets, real perps hedging. `liquidateLong` below is a hand-cranked stand-in
///      for real liquidation infrastructure. Position accounting is keyed by (owner, tokenId), so
///      the ERC-1155 acts as a receipt — transferring it does not move the underlying accounting.
contract OptionsManager is ERC1155, IUnlockCallback {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using SafeTransferLib for ERC20;

    // ---------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------

    uint8 public constant MARKET_ID = 0;

    /// @notice Buyer collateral as a fraction of the notional they take out of the pool.
    /// @dev This is the "small traders can trade with less liquidity" claim: the buyer posts 10%
    ///      because the position is an *inverted existing LP position*, not newly sourced capital.
    uint256 public constant BUYER_COLLATERAL_BPS = 1_000; // 10%

    uint256 internal constant BPS = 10_000;

    // ---------------------------------------------------------------------------------------
    // Immutables / market definition
    // ---------------------------------------------------------------------------------------

    IPoolManager public immutable poolManager;

    /// @notice 1inch Aqua — the shared liquidity registry that backs option sellers.
    IAqua public immutable AQUA;

    Currency public immutable currency0;
    Currency public immutable currency1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    IHooks public immutable hooks;

    /// @notice Half-width, in ticks, of every option's liquidity range.
    int24 public immutable strikeWidth;

    /// @notice The market's strike ladder, as ticks.
    /// @dev Strikes are FIXED round-dollar levels chosen once and baked into the deployment — not
    ///      offsets from whatever spot happened to be at deploy time. Everyone sees the same
    ///      $2,300 / $2,400 / … ladder, which is what makes a strike a shared reference point
    ///      rather than a per-deployment accident. See script/Deploy.s.sol for the ladder and how
    ///      each tick is derived from its dollar price.
    int24[] public strikeTicks;

    // ---------------------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------------------

    struct Series {
        uint128 shortLiquidity; // total liquidity written by sellers
        uint128 longLiquidity; // subset of the above that buyers have pulled out of the pool
    }

    struct Position {
        uint128 liquidity;
        uint256 feeGrowth0SnapshotX128;
        uint256 feeGrowth1SnapshotX128;
        // shorts: principal paid into the pool. longs: notional released out of the pool.
        uint256 amount0;
        uint256 amount1;
        // longs only: collateral backing the premium stream.
        uint256 collateral0;
        uint256 collateral1;
        // premium realised at earlier touches of this position.
        uint256 premium0Settled;
        uint256 premium1Settled;
    }

    mapping(uint256 tokenId => Series) public series;

    mapping(address owner => mapping(uint256 tokenId => Position)) internal _positions;

    // ---------------------------------------------------------------------------------------
    // Errors / events
    // ---------------------------------------------------------------------------------------

    error NotPoolManager();
    error NativeCurrencyUnsupported();
    error ZeroLiquidity();
    error BadStrikeIndex(uint8 index);
    error BadStrikeLadder(uint256 length);
    error InsufficientWrittenLiquidity(uint128 available, uint128 requested);
    error NoPosition();
    error PositionTooLarge(uint128 held, uint128 requested);
    error LongStillSolvent();

    event OptionWritten(
        address indexed seller, uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1
    );
    event OptionBought(
        address indexed buyer, uint256 indexed tokenId, uint128 liquidity, uint256 notional0, uint256 notional1
    );
    event ShortClosed(address indexed seller, uint256 indexed tokenId, uint128 liquidity, uint256 paid0, uint256 paid1);
    event LongClosed(address indexed buyer, uint256 indexed tokenId, uint128 liquidity, uint256 paid0, uint256 paid1);
    event LongLiquidated(address indexed keeper, address indexed buyer, uint256 indexed tokenId, uint128 liquidity);

    // ---------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------

    constructor(
        IPoolManager poolManager_,
        IAqua aqua_,
        PoolKey memory key,
        int24 strikeWidth_,
        int24[] memory strikeTicks_
    ) {
        require(!key.currency0.isAddressZero(), NativeCurrencyUnsupported());
        // Strike indices are uint8 on the trading entrypoints.
        require(strikeTicks_.length > 0 && strikeTicks_.length <= 255, BadStrikeLadder(strikeTicks_.length));
        poolManager = poolManager_;
        AQUA = aqua_;
        currency0 = key.currency0;
        currency1 = key.currency1;
        fee = key.fee;
        tickSpacing = key.tickSpacing;
        hooks = key.hooks;
        strikeWidth = strikeWidth_;
        strikeTicks = strikeTicks_;
    }

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey({currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: hooks});
    }

    function poolId() public view returns (PoolId) {
        return poolKey().toId();
    }

    function uri(uint256) public pure override returns (string memory) {
        return "";
    }

    // ---------------------------------------------------------------------------------------
    // Series helpers
    // ---------------------------------------------------------------------------------------

    /// @notice Resolve a strike index + direction into the liquidity range that represents it.
    /// @dev A put sits BELOW its strike (so it is funded in currency1 and gets assigned currency0
    ///      on the way down); a call sits ABOVE its strike (mirror image).
    function seriesTicks(uint8 strikeIndex, bool isPut) public view returns (int24 tickLower, int24 tickUpper) {
        require(strikeIndex < strikeTicks.length, BadStrikeIndex(strikeIndex));
        int24 strike = strikeTicks[strikeIndex];
        if (isPut) {
            (tickLower, tickUpper) = (strike - strikeWidth, strike);
        } else {
            (tickLower, tickUpper) = (strike, strike + strikeWidth);
        }
    }

    function tokenIdFor(uint8 strikeIndex, bool isPut, bool isLong) public view returns (uint256) {
        (int24 tickLower, int24 tickUpper) = seriesTicks(strikeIndex, isPut);
        return PositionId.encode(MARKET_ID, tickLower, tickUpper, isPut, isLong);
    }

    /// @dev Puts and calls are separate v4 positions even if their ranges were to coincide.
    function _salt(bool isPut) internal pure returns (bytes32) {
        return bytes32(uint256(isPut ? 1 : 0));
    }

    function getStrikes() external view returns (int24[] memory) {
        return strikeTicks;
    }

    function strikeCount() external view returns (uint256) {
        return strikeTicks.length;
    }

    function getPosition(address owner, uint256 tokenId) external view returns (Position memory) {
        return _positions[owner][tokenId];
    }

    // ---------------------------------------------------------------------------------------
    // Premium — real accrued Uniswap fee growth, nothing synthetic
    // ---------------------------------------------------------------------------------------

    function _feeGrowthInside(int24 tickLower, int24 tickUpper) internal view returns (uint256, uint256) {
        return poolManager.getFeeGrowthInside(poolId(), tickLower, tickUpper);
    }

    /// @notice Premium accrued to (or owed by) a position since it was opened.
    /// @dev Shorts collect this; longs pay it. Uniswap's fee growth accumulators are intentionally
    ///      allowed to overflow, so the subtraction is unchecked — same convention as v3/v4 core.
    function accruedPremium(address owner, uint256 tokenId) public view returns (uint256 premium0, uint256 premium1) {
        Position storage p = _positions[owner][tokenId];
        if (p.liquidity == 0) return (p.premium0Settled, p.premium1Settled);

        (,, int24 tickLower, int24 tickUpper) = _unpack(tokenId);
        (uint256 fg0, uint256 fg1) = _feeGrowthInside(tickLower, tickUpper);
        bool roundUp = PositionId.isLong(tokenId);

        unchecked {
            premium0 = p.premium0Settled + _premiumOf(fg0 - p.feeGrowth0SnapshotX128, p.liquidity, roundUp);
            premium1 = p.premium1Settled + _premiumOf(fg1 - p.feeGrowth1SnapshotX128, p.liquidity, roundUp);
        }
    }

    /// @dev Debts round up, credits round down.
    ///      Without this the protocol is left a wei short: a short is owed on `L`, while the fees
    ///      backing that come from the pool (on `L - Llong`) plus the long (on `Llong`), and
    ///      `floor(x·L)` can exceed `floor(x·(L-Llong)) + floor(x·Llong)`. Charging longs the ceiling
    ///      closes the gap and leaves only harmless dust in the protocol's favour.
    function _premiumOf(uint256 feeGrowthDeltaX128, uint128 liquidity, bool roundUp) internal pure returns (uint256) {
        return roundUp
            ? FullMath.mulDivRoundingUp(feeGrowthDeltaX128, liquidity, FixedPoint128.Q128)
            : FullMath.mulDiv(feeGrowthDeltaX128, liquidity, FixedPoint128.Q128);
    }

    function _unpack(uint256 tokenId)
        internal
        pure
        returns (bool isLong, bool isPut, int24 tickLower, int24 tickUpper)
    {
        (, tickLower, tickUpper, isPut, isLong) = PositionId.decode(tokenId);
    }

    /// @dev Roll any premium accrued so far into `premiumXSettled` and re-snapshot, so that a
    ///      position can be added to without losing history.
    function _realizePremium(Position storage p, int24 tickLower, int24 tickUpper, bool roundUp) internal {
        (uint256 fg0, uint256 fg1) = _feeGrowthInside(tickLower, tickUpper);
        if (p.liquidity != 0) {
            unchecked {
                p.premium0Settled += _premiumOf(fg0 - p.feeGrowth0SnapshotX128, p.liquidity, roundUp);
                p.premium1Settled += _premiumOf(fg1 - p.feeGrowth1SnapshotX128, p.liquidity, roundUp);
            }
        }
        p.feeGrowth0SnapshotX128 = fg0;
        p.feeGrowth1SnapshotX128 = fg1;
    }

    // ---------------------------------------------------------------------------------------
    // User entrypoints
    // ---------------------------------------------------------------------------------------

    enum Action {
        SELL,
        BUY,
        CLOSE_SHORT,
        CLOSE_LONG
    }

    struct CallbackData {
        Action action;
        address user;
        uint8 strikeIndex;
        bool isPut;
        uint128 liquidity;
        // Seller-collateral routing. When `viaAqua` is set the seller's collateral is pulled
        // straight out of their wallet through Aqua instead of being transferred in directly.
        bool viaAqua;
        bytes32 aquaSalt;
    }

    /// @notice Write an option: mint concentrated liquidity at the strike. You are now short.
    /// @dev The collateral you post is exactly what the v4 pool demands for that range — no more.
    function sellOption(uint8 strikeIndex, bool isPut, uint128 liquidity) external {
        require(liquidity != 0, ZeroLiquidity());
        poolManager.unlock(
            abi.encode(
                CallbackData({
                    action: Action.SELL,
                    user: msg.sender,
                    strikeIndex: strikeIndex,
                    isPut: isPut,
                    liquidity: liquidity,
                    viaAqua: false,
                    aquaSalt: bytes32(0)
                })
            )
        );
    }

    // ---------------------------------------------------------------------------------------
    // Aqua-backed writing — the seller never deposits
    // ---------------------------------------------------------------------------------------

    /// @notice A seller's standing offer to back option writing, as registered with Aqua.
    ///
    /// @dev The strategy is scoped to the MARKET, not to a single series — deliberately. This is
    ///      the whole reason Aqua is in the stack.
    ///
    ///      If the hash included the strike and the side, one shipped balance would back exactly
    ///      one series, and a four-leg structure (a spread, a strangle, a condor) would need four
    ///      separate offers and four times the committed capital. That is just a vault with extra
    ///      steps. Scoped to the market, a single untouched wallet balance backs every leg the
    ///      seller writes, and Aqua caps total draw at the registered amount — so the seller's
    ///      worst case is bounded by one number no matter how many legs they run.
    ///
    ///      `salt` lets one seller keep several independent offers alive, since Aqua strategies are
    ///      immutable once shipped.
    struct AquaStrategy {
        address maker;
        address app;
        bytes32 salt;
    }

    /// @notice The exact bytes a seller must pass to `IAqua.ship` to back this series.
    /// @dev Exposed so the frontend and the seller never have to guess the encoding:
    ///        token.approve(AQUA, amount);
    ///        AQUA.ship(address(optionsManager), encodeAquaStrategy(...), [token], [amount]);
    ///      The tokens stay in the seller's wallet until someone actually writes against the offer.
    function encodeAquaStrategy(address maker, bytes32 salt) public view returns (bytes memory) {
        return abi.encode(AquaStrategy({maker: maker, app: address(this), salt: salt}));
    }

    function aquaStrategyHash(address maker, bytes32 salt) public view returns (bytes32) {
        return keccak256(encodeAquaStrategy(maker, salt));
    }

    /// @notice How much of a seller's wallet balance is still committed to this offer.
    /// @dev This is the headline Aqua property: the number is non-zero while the tokens are still
    ///      sitting in the seller's own wallet, spendable and able to back other Aqua strategies.
    function aquaBackingOf(address maker, bytes32 salt, Currency token) external view returns (uint256) {
        (uint248 balance,) =
            AQUA.rawBalances(maker, address(this), aquaStrategyHash(maker, salt), Currency.unwrap(token));
        return balance;
    }

    /// @notice Write an option funded from a maker's Aqua-registered wallet balance.
    ///
    /// @dev This is the Aqua path, and the difference from `sellOption` is where the collateral
    ///      comes from. There is no vault and no prior deposit: the maker shipped an offer, kept
    ///      their tokens, and this call pulls exactly the amount the v4 mint needs at the moment
    ///      the option is actually written.
    ///
    ///      Callable by anyone, because shipping the strategy IS the maker's commitment — that is
    ///      Aqua's model of a quoted liquidity commitment. Aqua itself caps the pull at the
    ///      registered amount, and the maker can withdraw the offer at any time with `IAqua.dock`.
    ///
    ///      HACKATHON SIMPLIFICATION: the strategy does not encode a minimum acceptable premium, so
    ///      a matcher chooses the moment of execution. Production would sign a price band into the
    ///      strategy bytes.
    function sellOptionViaAqua(address maker, uint8 strikeIndex, bool isPut, uint128 liquidity, bytes32 salt) external {
        require(liquidity != 0, ZeroLiquidity());
        poolManager.unlock(
            abi.encode(
                CallbackData({
                    action: Action.SELL,
                    user: maker,
                    strikeIndex: strikeIndex,
                    isPut: isPut,
                    liquidity: liquidity,
                    viaAqua: true,
                    aquaSalt: salt
                })
            )
        );
    }

    /// @notice Buy an option: pull previously-written liquidity out of the pool. You are now long.
    /// @dev You post only `BUYER_COLLATERAL_BPS` of the notional you removed.
    function buyOption(uint8 strikeIndex, bool isPut, uint128 liquidity) external {
        require(liquidity != 0, ZeroLiquidity());
        poolManager.unlock(
            abi.encode(
                CallbackData({
                    action: Action.BUY,
                    user: msg.sender,
                    strikeIndex: strikeIndex,
                    isPut: isPut,
                    liquidity: liquidity,
                    viaAqua: false,
                    aquaSalt: bytes32(0)
                })
            )
        );
    }

    /// @notice Close a short: withdraw your liquidity plus the premium it earned.
    function closeShort(uint8 strikeIndex, bool isPut, uint128 liquidity) external {
        require(liquidity != 0, ZeroLiquidity());
        poolManager.unlock(
            abi.encode(
                CallbackData({
                    action: Action.CLOSE_SHORT,
                    user: msg.sender,
                    strikeIndex: strikeIndex,
                    isPut: isPut,
                    liquidity: liquidity,
                    viaAqua: false,
                    aquaSalt: bytes32(0)
                })
            )
        );
    }

    /// @notice Close a long: put the liquidity back and collect the payoff.
    function closeLong(uint8 strikeIndex, bool isPut, uint128 liquidity) external {
        require(liquidity != 0, ZeroLiquidity());
        poolManager.unlock(
            abi.encode(
                CallbackData({
                    action: Action.CLOSE_LONG,
                    user: msg.sender,
                    strikeIndex: strikeIndex,
                    isPut: isPut,
                    liquidity: liquidity,
                    viaAqua: false,
                    aquaSalt: bytes32(0)
                })
            )
        );
    }

    // ---------------------------------------------------------------------------------------
    // Unlock callback
    // ---------------------------------------------------------------------------------------

    function unlockCallback(bytes calldata raw) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), NotPoolManager());
        CallbackData memory d = abi.decode(raw, (CallbackData));

        if (d.action == Action.SELL) {
            _doSell(d);
        } else if (d.action == Action.BUY) {
            _doBuy(d);
        } else if (d.action == Action.CLOSE_SHORT) {
            _doCloseShort(d);
        } else {
            _doCloseLong(d);
        }
        return "";
    }

    /// @dev Runs `modifyLiquidity` and separates principal from fees.
    ///      `callerDelta` bundles both; `feesAccrued` is the pool auto-collecting everything the
    ///      protocol's position has earned since it was last touched. Those fees belong to the
    ///      shorts collectively, so they must NOT offset the principal the acting user owes —
    ///      hence the split.
    function _modify(int24 tickLower, int24 tickUpper, bool isPut, int256 liquidityDelta)
        internal
        returns (int128 principal0, int128 principal1, int128 total0, int128 total1)
    {
        (BalanceDelta callerDelta, BalanceDelta feesAccrued) = poolManager.modifyLiquidity(
            poolKey(),
            ModifyLiquidityParams({
                tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: liquidityDelta, salt: _salt(isPut)
            }),
            ""
        );
        BalanceDelta principal = callerDelta - feesAccrued;
        principal0 = principal.amount0();
        principal1 = principal.amount1();
        total0 = callerDelta.amount0();
        total1 = callerDelta.amount1();
    }

    /// @dev Zero out this contract's outstanding delta with the PoolManager.
    function _netOut(Currency currency, int128 delta) internal {
        if (delta < 0) {
            uint256 amount = uint256(uint128(-delta));
            poolManager.sync(currency);
            currency.transfer(address(poolManager), amount);
            poolManager.settle();
        } else if (delta > 0) {
            poolManager.take(currency, address(this), uint256(uint128(delta)));
        }
    }

    function _pull(Currency currency, address from, uint256 amount) internal {
        if (amount == 0) return;
        ERC20(Currency.unwrap(currency)).safeTransferFrom(from, address(this), amount);
    }

    /// @dev Pull a seller's collateral out of their own wallet through Aqua. Aqua decrements the
    ///      registered balance (reverting if the offer does not cover it) and performs the
    ///      `transferFrom` itself, so the maker approved Aqua rather than this contract.
    function _pullViaAqua(Currency currency, address maker, bytes32 strategyHash, uint256 amount) internal {
        if (amount == 0) return;
        AQUA.pull(maker, strategyHash, Currency.unwrap(currency), amount, address(this));
    }

    function _pay(Currency currency, address to, uint256 amount) internal {
        if (amount == 0) return;
        currency.transfer(to, amount);
    }

    // ---------------------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------------------

    function _doSell(CallbackData memory d) internal {
        (int24 tickLower, int24 tickUpper) = seriesTicks(d.strikeIndex, d.isPut);
        uint256 tokenId = PositionId.encode(MARKET_ID, tickLower, tickUpper, d.isPut, false);

        Position storage p = _positions[d.user][tokenId];
        _realizePremium(p, tickLower, tickUpper, false);

        (int128 principal0, int128 principal1, int128 total0, int128 total1) =
            _modify(tickLower, tickUpper, d.isPut, int256(uint256(d.liquidity)));

        // Adding liquidity: principal is owed to the pool, so take exactly that from the seller —
        // either straight from their wallet via Aqua, or by direct transfer.
        uint256 owed0 = principal0 < 0 ? uint256(uint128(-principal0)) : 0;
        uint256 owed1 = principal1 < 0 ? uint256(uint128(-principal1)) : 0;
        if (d.viaAqua) {
            bytes32 strategyHash = aquaStrategyHash(d.user, d.aquaSalt);
            _pullViaAqua(currency0, d.user, strategyHash, owed0);
            _pullViaAqua(currency1, d.user, strategyHash, owed1);
        } else {
            _pull(currency0, d.user, owed0);
            _pull(currency1, d.user, owed1);
        }

        _netOut(currency0, total0);
        _netOut(currency1, total1);

        p.liquidity += d.liquidity;
        p.amount0 += owed0;
        p.amount1 += owed1;
        series[tokenId].shortLiquidity += d.liquidity;

        _mint(d.user, tokenId, d.liquidity, "");
        emit OptionWritten(d.user, tokenId, d.liquidity, owed0, owed1);
    }

    function _doBuy(CallbackData memory d) internal {
        (int24 tickLower, int24 tickUpper) = seriesTicks(d.strikeIndex, d.isPut);
        uint256 shortId = PositionId.encode(MARKET_ID, tickLower, tickUpper, d.isPut, false);
        uint256 longId = PositionId.encode(MARKET_ID, tickLower, tickUpper, d.isPut, true);

        Series storage s = series[shortId];
        uint128 available = s.shortLiquidity - s.longLiquidity;
        require(available >= d.liquidity, InsufficientWrittenLiquidity(available, d.liquidity));

        Position storage p = _positions[d.user][longId];
        _realizePremium(p, tickLower, tickUpper, true);

        (int128 principal0, int128 principal1, int128 total0, int128 total1) =
            _modify(tickLower, tickUpper, d.isPut, -int256(uint256(d.liquidity)));

        // Removing liquidity: the principal comes back out of the pool. It stays in this contract —
        // it is the seller's capital, now on loan to back the buyer's long payoff.
        _netOut(currency0, total0);
        _netOut(currency1, total1);

        uint256 notional0 = principal0 > 0 ? uint256(uint128(principal0)) : 0;
        uint256 notional1 = principal1 > 0 ? uint256(uint128(principal1)) : 0;

        uint256 collateral0 = (notional0 * BUYER_COLLATERAL_BPS) / BPS;
        uint256 collateral1 = (notional1 * BUYER_COLLATERAL_BPS) / BPS;
        _pull(currency0, d.user, collateral0);
        _pull(currency1, d.user, collateral1);

        p.liquidity += d.liquidity;
        p.amount0 += notional0;
        p.amount1 += notional1;
        p.collateral0 += collateral0;
        p.collateral1 += collateral1;
        s.longLiquidity += d.liquidity;

        _mint(d.user, longId, d.liquidity, "");
        emit OptionBought(d.user, longId, d.liquidity, notional0, notional1);
    }

    function _doCloseShort(CallbackData memory d) internal {
        (int24 tickLower, int24 tickUpper) = seriesTicks(d.strikeIndex, d.isPut);
        uint256 tokenId = PositionId.encode(MARKET_ID, tickLower, tickUpper, d.isPut, false);

        Position storage p = _positions[d.user][tokenId];
        require(p.liquidity != 0, NoPosition());
        require(p.liquidity >= d.liquidity, PositionTooLarge(p.liquidity, d.liquidity));

        Series storage s = series[tokenId];
        // Liquidity that buyers have pulled out is not sitting in the pool to be withdrawn.
        uint128 available = s.shortLiquidity - s.longLiquidity;
        require(available >= d.liquidity, InsufficientWrittenLiquidity(available, d.liquidity));

        _realizePremium(p, tickLower, tickUpper, false);

        (int128 principal0, int128 principal1, int128 total0, int128 total1) =
            _modify(tickLower, tickUpper, d.isPut, -int256(uint256(d.liquidity)));

        _netOut(currency0, total0);
        _netOut(currency1, total1);

        uint256 fraction = (uint256(d.liquidity) * 1e18) / p.liquidity;
        uint256 premium0 = (p.premium0Settled * fraction) / 1e18;
        uint256 premium1 = (p.premium1Settled * fraction) / 1e18;

        uint256 out0 = (principal0 > 0 ? uint256(uint128(principal0)) : 0) + premium0;
        uint256 out1 = (principal1 > 0 ? uint256(uint128(principal1)) : 0) + premium1;

        // Book-keeping before paying out.
        p.premium0Settled -= premium0;
        p.premium1Settled -= premium1;
        p.amount0 -= (p.amount0 * fraction) / 1e18;
        p.amount1 -= (p.amount1 * fraction) / 1e18;
        p.liquidity -= d.liquidity;
        s.shortLiquidity -= d.liquidity;

        _burn(d.user, tokenId, d.liquidity);

        _pay(currency0, d.user, out0);
        _pay(currency1, d.user, out1);
        emit ShortClosed(d.user, tokenId, d.liquidity, out0, out1);
    }

    function _doCloseLong(CallbackData memory d) internal {
        (int24 tickLower, int24 tickUpper) = seriesTicks(d.strikeIndex, d.isPut);
        uint256 longId = PositionId.encode(MARKET_ID, tickLower, tickUpper, d.isPut, true);
        uint256 shortId = PositionId.encode(MARKET_ID, tickLower, tickUpper, d.isPut, false);

        Position storage p = _positions[d.user][longId];
        require(p.liquidity != 0, NoPosition());
        require(p.liquidity >= d.liquidity, PositionTooLarge(p.liquidity, d.liquidity));

        _realizePremium(p, tickLower, tickUpper, true);

        uint256 fraction = (uint256(d.liquidity) * 1e18) / p.liquidity;
        uint256 notional0 = (p.amount0 * fraction) / 1e18;
        uint256 notional1 = (p.amount1 * fraction) / 1e18;
        uint256 collateral0 = (p.collateral0 * fraction) / 1e18;
        uint256 collateral1 = (p.collateral1 * fraction) / 1e18;
        uint256 premium0 = (p.premium0Settled * fraction) / 1e18;
        uint256 premium1 = (p.premium1Settled * fraction) / 1e18;

        // Put the liquidity back into the pool. What it costs to restore versus what was released
        // when the long was opened IS the option payoff: if price moved the buyer's way, restoring
        // costs less than was taken out.
        (int128 principal0, int128 principal1, int128 total0, int128 total1) =
            _modify(tickLower, tickUpper, d.isPut, int256(uint256(d.liquidity)));

        uint256 cost0 = principal0 < 0 ? uint256(uint128(-principal0)) : 0;
        uint256 cost1 = principal1 < 0 ? uint256(uint128(-principal1)) : 0;

        // Payoff + collateral back, less the premium (streamia) owed to the shorts.
        (uint256 out0, uint256 short0) = _settleLongLeg(notional0, collateral0, cost0, premium0);
        (uint256 out1, uint256 short1) = _settleLongLeg(notional1, collateral1, cost1, premium1);

        // Collect any shortfall before settling with the pool, so the premium the shorts are owed
        // is always fully in hand. This must happen before `_netOut`, which spends from this
        // contract's balance.
        _pull(currency0, d.user, short0);
        _pull(currency1, d.user, short1);

        _netOut(currency0, total0);
        _netOut(currency1, total1);

        p.premium0Settled -= premium0;
        p.premium1Settled -= premium1;
        p.amount0 -= notional0;
        p.amount1 -= notional1;
        p.collateral0 -= collateral0;
        p.collateral1 -= collateral1;
        p.liquidity -= d.liquidity;
        series[shortId].longLiquidity -= d.liquidity;

        _burn(d.user, longId, d.liquidity);

        _pay(currency0, d.user, out0);
        _pay(currency1, d.user, out1);
        emit LongClosed(d.user, longId, d.liquidity, out0, out1);
    }

    /// @dev Long payoff for one currency leg.
    ///        credit = the notional released when the long was opened + collateral posted
    ///        debit  = what it costs to restore the liquidity + premium owed to the shorts
    ///      A surplus is paid out; a deficit is collected from the buyer's wallet.
    ///
    ///      The deficit branch matters more than it looks. Premium accrues in BOTH currencies
    ///      whenever price churns through the range, but a single-sided option (e.g. an at-the-money
    ///      put, funded purely in currency1) posts collateral in only one of them. Simply flooring
    ///      the payout at zero would silently cancel the buyer's debt in the other currency and
    ///      leave the protocol unable to pay the short side what `feeGrowthInside` says it earned.
    ///
    ///      HACKATHON SIMPLIFICATION: settling a deficit from the wallet means a long's loss is not
    ///      strictly capped at its collateral. Production would value collateral across both legs
    ///      and margin-call first; `liquidateLong` is the crude stand-in for that.
    function _settleLongLeg(uint256 notional, uint256 collateral, uint256 cost, uint256 premium)
        internal
        pure
        returns (uint256 payout, uint256 shortfall)
    {
        uint256 credit = notional + collateral;
        uint256 debit = cost + premium;
        if (credit >= debit) {
            payout = credit - debit;
        } else {
            shortfall = debit - credit;
        }
    }

    // ---------------------------------------------------------------------------------------
    // Liquidation stand-in
    // ---------------------------------------------------------------------------------------

    /// @notice Force-close a long whose accrued premium has eaten through its collateral.
    /// @dev HACKATHON STAND-IN. The real design calls for flash-loan liquidation bots, an insurance
    ///      fund and auto-deleveraging (see README roadmap). This is a manual button anyone can
    ///      press once a single, crude threshold is crossed. There is no liquidation bonus, no
    ///      partial liquidation and no bad-debt socialisation.
    function liquidateLong(address owner, uint8 strikeIndex, bool isPut) external {
        (int24 tickLower, int24 tickUpper) = seriesTicks(strikeIndex, isPut);
        uint256 longId = PositionId.encode(MARKET_ID, tickLower, tickUpper, isPut, true);

        Position storage p = _positions[owner][longId];
        require(p.liquidity != 0, NoPosition());

        (uint256 premium0, uint256 premium1) = accruedPremium(owner, longId);
        require(premium0 >= p.collateral0 && premium1 >= p.collateral1, LongStillSolvent());

        uint128 liquidity = p.liquidity;
        poolManager.unlock(
            abi.encode(
                CallbackData({
                    action: Action.CLOSE_LONG,
                    user: owner,
                    strikeIndex: strikeIndex,
                    isPut: isPut,
                    liquidity: liquidity,
                    viaAqua: false,
                    aquaSalt: bytes32(0)
                })
            )
        );
        emit LongLiquidated(msg.sender, owner, longId, liquidity);
    }
}
