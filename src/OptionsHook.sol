// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

/// @title OptionsHook
/// @notice The hook is where this protocol's pricing actually lives.
///
/// @dev It does two jobs, and the second is the one that matters.
///
///      **1. Liquidity is options-only** (`beforeAddLiquidity` / `beforeRemoveLiquidity`).
///      Only OptionsManager may be an LP here, which turns "every unit of liquidity in this pool is
///      a written option" from a convention into an on-chain invariant. That is what lets
///      `feeGrowthInside` over a range be attributed entirely to option writers, and stops a
///      passive LP parking capital at a strike to collect premium earned by the people actually
///      carrying assignment risk.
///
///      **2. Premium is priced** (`beforeSwap`, dynamic LP fee).
///      Premium in this protocol IS the pool's swap fee — a short earns `feeGrowthInside`, a long
///      pays it. With a static fee tier, premium is therefore a pure function of trading volume and
///      carries no information about what the option is actually worth. That is the single biggest
///      weakness of the naive design: a writer earns the same whether the market is dead calm or
///      tearing through their strike, and the same whether their book is untouched or fully lent
///      out.
///
///      So the hook prices it, from the two things that actually set an option's price, both
///      measured on-chain from this pool and nothing else:
///
///        fee = volatility fee, then widened by utilisation
///
///        * VOLATILITY sets fair value. Realised volatility is estimated from the pool's own tick
///          path — see `_observe`. An option on a calm market is worth less than the same option on
///          a violent one, and the premium stream should say so.
///        * UTILISATION sets the spread. As longs buy written liquidity out of the pool, the
///          remaining writers carry more risk across a thinner book, so the fee widens toward the
///          ceiling. This is the design doc's "utilisation spread".
///
///      That is the same decomposition a real options desk uses: a fair value from volatility, then
///      a spread from inventory and demand. Neither input is quoted, signed or oracle-fed — one is
///      the pool's price history, the other is this protocol's own open interest.
///
///      The fee is bounded and monotonic in both inputs: BASE_FEE when the market is calm and the
///      book untouched, MAX_FEE when volatility is at or above the reference and every written unit
///      is bought out. At zero measured volatility it collapses exactly to the pure utilisation
///      curve, so the two mechanisms compose rather than interfere.
///
///      HACKATHON SIMPLIFICATIONS, both deliberate and both next steps rather than rewrites:
///        * Utilisation is market-wide rather than per-strike, so a swap through an untouched range
///          pays the same spread as one through a fully-bought range. Per-range means resolving the
///          current tick to a series inside `beforeSwap` — a tick-bucket lookup.
///        * Volatility is realised, not implied, and market-wide rather than per-strike, so there is
///          no smile. A real desk would also let the two inputs interact (high vol AND high
///          utilisation is worse than the sum suggests); here they compose linearly.
contract OptionsHook is IHooks {
    using LPFeeLibrary for uint24;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @notice Flags encoded in this contract's address. Must match `getHookPermissions()`.
    uint160 public constant REQUIRED_FLAGS =
        uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG);

    /// @notice LP fee on a calm market with an untouched book: 0.30%.
    uint24 public constant BASE_FEE = 3000;

    /// @notice LP fee volatility alone can reach, with the book untouched: 0.60%.
    uint24 public constant VOL_FEE_MAX = 6000;

    /// @notice LP fee when every written unit has been bought out: 1.00%.
    uint24 public constant MAX_FEE = 10_000;

    /// @notice Annualised realised volatility at which the volatility component saturates: 150%.
    /// @dev Above this the option is not priced any richer. ETH's realised vol sits around 50-80%,
    ///      so the reference is set where a genuinely disorderly market would be, not where a
    ///      normal one is.
    uint256 public constant VOL_REFERENCE_BPS = 15_000;

    uint16 internal constant BPS = 10_000;

    /// @dev EWMA smoothing: each observation carries 1/8 of the weight.
    uint256 internal constant VOL_ALPHA = 8;

    /// @dev Ticks are log-price — `1.0001^tick` — so a tick delta IS a log return, and no logarithm
    ///      is needed anywhere in this estimator. One tick is `ln(1.0001) ~= 1e-4` of price.
    ///      Annualising a per-second sigma multiplies by `sqrt(365 * 24 * 3600) = 5616`, so
    ///      converting sigma in ticks-per-root-second into annualised basis points is
    ///      `sigma * 1e-4 * 5616 * 10000 = sigma * 5616`. That constant is this:
    uint256 internal constant ANNUALISE_BPS = 5616;

    /// @dev Variance is stored scaled by 1e18, so `sqrt(varianceX)` is sigma scaled by 1e9.
    uint256 internal constant VARIANCE_SCALE = 1e18;
    uint256 internal constant SIGMA_SCALE = 1e9;

    /// @dev Cap on a single observation, pinned at 400% annualised. Two swaps in one block would
    ///      otherwise divide a large tick move by the one-second floor and spike the estimate; this
    ///      cap plus the EWMA bounds what any single swap can do to the fee.
    ///
    ///      Derivation, since it is easy to get wrong by a factor of a million: inverting
    ///      `volBps = sqrt(varianceX) * ANNUALISE_BPS / SIGMA_SCALE` at 40,000 bps gives
    ///      `sqrt(varianceX) = 40000 * 1e9 / 5616 = 7.12e9`, so `varianceX = 5.07e19`.
    ///      As a sanity check in the other direction, 65% annualised is `varianceX = 1.34e18`,
    ///      which is a 3.4% daily move — about right for ETH.
    uint256 internal constant MAX_VARIANCE_SAMPLE = 5.07e19;

    IPoolManager public immutable poolManager;

    /// @notice The only address permitted to modify liquidity, and the only one that may report
    ///         utilisation.
    address public optionsManager;

    /// @notice Share of written liquidity currently bought out by longs, in basis points.
    uint16 public utilisationBps;

    /// @notice Realised-volatility accumulator, sampled from the pool's own tick path.
    /// @dev One storage slot: 176 + 32 + 24 = 232 bits. Measuring volatility therefore costs the
    ///      swapper one SSTORE and one `extsload`, which is the entire price of not needing an
    ///      oracle.
    struct VolState {
        /// EWMA of tick-variance per second, scaled by `VARIANCE_SCALE`.
        uint176 varianceX;
        /// When the last observation was taken. Zero means "never", so the first swap only seeds.
        uint32 timestamp;
        /// The tick at that observation.
        int24 tick;
    }

    VolState public vol;

    address private immutable _admin;

    error NotPoolManager();
    error NotOptionsManager(address sender);
    error AlreadyInitialized();
    error NotAdmin();
    error UtilisationOutOfRange(uint16 bps);
    error HookNotImplemented();

    event UtilisationUpdated(uint16 utilisationBps, uint24 lpFee);
    event VolatilityObserved(int24 tick, uint256 realisedVolBps, uint24 lpFee);

    modifier onlyPoolManager() {
        require(msg.sender == address(poolManager), NotPoolManager());
        _;
    }

    /// @param admin_ The address allowed to call `initialize` once. Passed explicitly rather than
    ///        taken from `msg.sender` because the hook is deployed through the CREATE2 proxy, which
    ///        would otherwise end up owning the wiring step.
    constructor(IPoolManager poolManager_, address admin_) {
        poolManager = poolManager_;
        _admin = admin_;
        // Reverts unless this contract was deployed to an address carrying REQUIRED_FLAGS.
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    /// @notice One-shot wiring of the OptionsManager.
    /// @dev OptionsManager needs the hook address to build its PoolKey, and the hook needs the
    ///      manager address to gate liquidity — a deployment cycle. The deployer closes the loop
    ///      once and it is then immutable.
    function initialize(address optionsManager_) external {
        require(msg.sender == _admin, NotAdmin());
        require(optionsManager == address(0), AlreadyInitialized());
        optionsManager = optionsManager_;
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // --------------------------------------------------------------------------------------------
    // Utilisation -> premium
    // --------------------------------------------------------------------------------------------

    /// @notice Report how much of the written book is currently bought out.
    /// @dev Pushed by OptionsManager whenever open interest changes, so `beforeSwap` stays a single
    ///      storage read instead of a cross-contract call on the hot path.
    function setUtilisation(uint16 bps) external {
        require(msg.sender == optionsManager, NotOptionsManager(msg.sender));
        require(bps <= BPS, UtilisationOutOfRange(bps));
        utilisationBps = bps;
        emit UtilisationUpdated(bps, currentFee());
    }

    /// @notice Annualised realised volatility of this pool, in basis points. 10,000 = 100%.
    ///
    /// @dev Estimated entirely from the pool's own tick path — no oracle, no feed, no signed quote,
    ///      which is the same standard the rest of this protocol holds itself to for premium.
    ///
    ///      `vol.varianceX` is an EWMA of squared tick moves per second. Ticks are log-price, so a
    ///      tick delta is already a log return; sigma is the root of that variance, and annualising
    ///      it is one multiplication. See `ANNUALISE_BPS`.
    function realisedVolBps() public view returns (uint256) {
        uint256 v = vol.varianceX;
        if (v == 0) return 0;
        // sqrt of a 1e18-scaled variance is a 1e9-scaled sigma, in ticks per root-second.
        return (FixedPointMathLib.sqrt(v) * ANNUALISE_BPS) / SIGMA_SCALE;
    }

    /// @notice What the option is worth before any scarcity premium: the volatility component.
    /// @dev Linear from BASE_FEE at a dead-flat market to VOL_FEE_MAX at or above the reference.
    function volFee() public view returns (uint24) {
        uint256 v = realisedVolBps();
        if (v > VOL_REFERENCE_BPS) v = VOL_REFERENCE_BPS;
        return BASE_FEE + uint24((uint256(VOL_FEE_MAX - BASE_FEE) * v) / VOL_REFERENCE_BPS);
    }

    /// @notice The LP fee a swap would pay right now — and therefore the premium its writers earn.
    ///
    /// @dev Volatility sets the fair value, utilisation widens it toward the ceiling:
    ///
    ///        fee = volFee + (MAX_FEE - volFee) * utilisation
    ///
    ///      Monotonic in both inputs and bounded to [BASE_FEE, MAX_FEE]. Note that the spread is
    ///      applied to the REMAINING headroom rather than added on top, which is what keeps the two
    ///      components from double-counting and keeps the ceiling hard. At zero measured volatility
    ///      `volFee()` is exactly BASE_FEE, so this collapses to the original utilisation curve.
    function currentFee() public view returns (uint24) {
        uint24 base = volFee();
        return base + uint24((uint256(MAX_FEE - base) * utilisationBps) / BPS);
    }

    /// @dev Fold the current tick into the volatility estimate. Called once per swap, before the
    ///      swap executes — so a swap is priced on the volatility that preceded it and can never
    ///      quote itself a fee from its own impact.
    function _observe(PoolKey calldata key) internal {
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        VolState memory v = vol;

        if (v.timestamp != 0) {
            // Same-block swaps floor at one second rather than dividing by zero. The cap below is
            // what stops that floor being used to manufacture volatility.
            uint256 dt = block.timestamp - v.timestamp;
            if (dt == 0) dt = 1;

            int256 dTick = int256(tick) - int256(v.tick);
            uint256 sample = (uint256(dTick * dTick) * VARIANCE_SCALE) / dt;
            if (sample > MAX_VARIANCE_SAMPLE) sample = MAX_VARIANCE_SAMPLE;

            v.varianceX = uint176((uint256(v.varianceX) * (VOL_ALPHA - 1) + sample) / VOL_ALPHA);
        }

        v.timestamp = uint32(block.timestamp);
        v.tick = tick;
        vol = v;

        emit VolatilityObserved(tick, realisedVolBps(), currentFee());
    }

    // --------------------------------------------------------------------------------------------
    // Enforced hooks
    // --------------------------------------------------------------------------------------------

    function beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        override
        onlyPoolManager
        returns (bytes4)
    {
        require(sender == optionsManager, NotOptionsManager(sender));
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeRemoveLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        override
        onlyPoolManager
        returns (bytes4)
    {
        require(sender == optionsManager, NotOptionsManager(sender));
        return IHooks.beforeRemoveLiquidity.selector;
    }

    /// @notice Price the swap. The returned fee becomes this swap's LP fee, which is the premium
    ///         the writers of this range earn from it.
    /// @dev No longer a view: this is where volatility is sampled. One SSTORE per swap.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _observe(key);

        // OVERRIDE_FEE_FLAG tells the PoolManager to use this value for this swap only.
        return (
            IHooks.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            currentFee() | LPFeeLibrary.OVERRIDE_FEE_FLAG
        );
    }

    // --------------------------------------------------------------------------------------------
    // Unused hooks — the address flags mean the PoolManager never calls these.
    // --------------------------------------------------------------------------------------------

    function beforeInitialize(address, PoolKey calldata, uint160) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        override
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }
}
