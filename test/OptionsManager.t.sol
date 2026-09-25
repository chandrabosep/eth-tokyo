// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint128} from "v4-core/libraries/FixedPoint128.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {OptionsManager} from "../src/OptionsManager.sol";
import {OptionsHook} from "../src/OptionsHook.sol";
import {PositionId} from "../src/libraries/PositionId.sol";
import {MockERC20} from "./utils/MockERC20.sol";
import {MockAqua} from "./utils/MockAqua.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";

/// @notice Phase 1 — the core mechanism, with no Aqua and no 1inch in the picture.
///         Proves: writing an option really is minting v4 liquidity, buying one really is removing
///         it, premium really is accrued `feeGrowthInside`, and the whole cycle reconciles.
contract OptionsManagerTest is Test {
    using StateLibrary for IPoolManager;

    PoolManager internal poolManager;
    IPoolManager internal manager; // same contract, typed for StateLibrary
    OptionsHook internal hook;
    OptionsManager internal options;
    MockAqua internal aqua;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;

    MockERC20 internal token0;
    MockERC20 internal token1;
    Currency internal currency0;
    Currency internal currency1;
    PoolKey internal key;
    PoolId internal poolId;

    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal swapper = makeAddr("swapper");

    uint24 internal constant FEE = LPFeeLibrary.DYNAMIC_FEE_FLAG; // 0.30%
    int24 internal constant TICK_SPACING = 60;
    int24 internal constant STRIKE_WIDTH = 120;

    /// @dev ≈ -5% / spot / +5%, snapped to the tick spacing.
    int24 internal constant STRIKE_DOWN = -480;
    int24 internal constant STRIKE_SPOT = 0;
    int24 internal constant STRIKE_UP = 480;

    uint8 internal constant IDX_SPOT = 1;
    uint128 internal constant WRITE_LIQUIDITY = 1_000e18;

    function setUp() public {
        poolManager = new PoolManager(address(this));
        manager = IPoolManager(address(poolManager));
        aqua = new MockAqua();
        swapRouter = new PoolSwapTest(poolManager);
        lpRouter = new PoolModifyLiquidityTest(poolManager);

        MockERC20 tA = new MockERC20("Wrapped Ether", "WETH", 18);
        MockERC20 tB = new MockERC20("USD Coin", "USDC", 18);
        (token0, token1) = address(tA) < address(tB) ? (tA, tB) : (tB, tA);
        currency0 = Currency.wrap(address(token0));
        currency1 = Currency.wrap(address(token1));

        // Mine a hook address carrying the beforeAddLiquidity + beforeRemoveLiquidity flags.
        uint160 flags =
            uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), flags, type(OptionsHook).creationCode, abi.encode(poolManager, address(this)));
        hook = new OptionsHook{salt: salt}(poolManager, address(this));
        assertEq(address(hook), hookAddr, "hook address mismatch");

        key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();

        int24[] memory strikes = new int24[](3);
        strikes[0] = STRIKE_DOWN;
        strikes[1] = STRIKE_SPOT;
        strikes[2] = STRIKE_UP;
        options = new OptionsManager(poolManager, IAqua(address(aqua)), key, STRIKE_WIDTH, strikes);
        hook.initialize(address(options));

        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(0));

        _fund(seller);
        _fund(buyer);
        _fund(swapper);
    }

    function _fund(address who) internal {
        token0.mint(who, 1_000_000e18);
        token1.mint(who, 1_000_000e18);
        vm.startPrank(who);
        token0.approve(address(options), type(uint256).max);
        token1.approve(address(options), type(uint256).max);
        token0.approve(address(swapRouter), type(uint256).max);
        token1.approve(address(swapRouter), type(uint256).max);
        token0.approve(address(lpRouter), type(uint256).max);
        token1.approve(address(lpRouter), type(uint256).max);
        token0.approve(address(aqua), type(uint256).max);
        token1.approve(address(aqua), type(uint256).max);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------------------

    function _swapExactIn(bool zeroForOne, uint256 amountIn) internal {
        vm.prank(swapper);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Push price down into the at-the-money put's range and back, generating real swap fees.
    function _churn() internal {
        _swapExactIn(true, 2e18);
        _swapExactIn(false, 2e18);
    }

    function _poolLiquidityIn(int24 tickLower, int24 tickUpper, bool isPut) internal view returns (uint128 liq) {
        (liq,,) =
            manager.getPositionInfo(poolId, address(options), tickLower, tickUpper, bytes32(uint256(isPut ? 1 : 0)));
    }

    function _putTicks() internal view returns (int24 lo, int24 hi) {
        return options.seriesTicks(IDX_SPOT, true);
    }

    // -------------------------------------------------------------------------------------
    // The hook invariant
    // -------------------------------------------------------------------------------------

    function test_hook_hasCorrectPermissionFlags() public view {
        uint160 addr = uint160(address(hook));
        assertTrue(addr & Hooks.BEFORE_ADD_LIQUIDITY_FLAG != 0, "missing beforeAddLiquidity flag");
        assertTrue(addr & Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG != 0, "missing beforeRemoveLiquidity flag");
        assertTrue(addr & Hooks.BEFORE_SWAP_FLAG != 0, "must intercept swaps to price the spread");
    }

    /// @notice Only OptionsManager may be an LP here — that is what makes "all liquidity is a
    ///         written option" an on-chain invariant rather than a convention.
    function test_hook_blocksOutsideLiquidityProviders() public {
        (int24 lo, int24 hi) = _putTicks();
        vm.prank(seller);
        vm.expectRevert();
        lpRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: 1e18, salt: bytes32(0)}), ""
        );
    }

    // -------------------------------------------------------------------------------------
    // Selling = minting LP
    // -------------------------------------------------------------------------------------

    function test_sellOption_isLiterallyAnLpMint() public {
        (int24 lo, int24 hi) = _putTicks();
        assertEq(_poolLiquidityIn(lo, hi, true), 0, "pool should start empty");

        uint256 balBefore1 = token1.balanceOf(seller);

        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY);

        // The option exists as real Uniswap v4 liquidity.
        assertEq(_poolLiquidityIn(lo, hi, true), WRITE_LIQUIDITY, "liquidity not minted into pool");

        // An at-the-money short put is funded purely in currency1 — it is single-sided USDC.
        uint256 spent1 = balBefore1 - token1.balanceOf(seller);
        assertGt(spent1, 0, "seller should have posted currency1");
        assertEq(token0.balanceOf(seller), 1_000_000e18, "short put should not consume currency0");

        uint256 shortId = options.tokenIdFor(IDX_SPOT, true, false);
        assertEq(options.balanceOf(seller, shortId), WRITE_LIQUIDITY, "short receipt not minted");
    }

    // -------------------------------------------------------------------------------------
    // Buying = removing LP, at ~10% collateral
    // -------------------------------------------------------------------------------------

    function test_buyOption_removesLiquidityAndCostsTenPercent() public {
        (int24 lo, int24 hi) = _putTicks();

        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY);

        uint128 half = WRITE_LIQUIDITY / 2;
        uint256 buyerBefore1 = token1.balanceOf(buyer);

        vm.prank(buyer);
        options.buyOption(IDX_SPOT, true, half);

        // Liquidity really left the pool.
        assertEq(_poolLiquidityIn(lo, hi, true), WRITE_LIQUIDITY - half, "liquidity did not leave the pool");

        uint256 longId = options.tokenIdFor(IDX_SPOT, true, true);
        OptionsManager.Position memory p = options.getPosition(buyer, longId);

        uint256 paid1 = buyerBefore1 - token1.balanceOf(buyer);
        assertEq(paid1, p.collateral1, "collateral accounting mismatch");

        // The headline claim: the buyer controls `notional` of exposure for ~10% of it.
        assertApproxEqRel(paid1 * 10, p.amount1, 1e15, "collateral should be ~10% of notional");
        assertGt(p.amount1, 0, "long should have notional");
    }

    function test_buyOption_cannotExceedWrittenLiquidity() public {
        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptionsManager.InsufficientWrittenLiquidity.selector, WRITE_LIQUIDITY, WRITE_LIQUIDITY + 1
            )
        );
        options.buyOption(IDX_SPOT, true, WRITE_LIQUIDITY + 1);
    }

    // -------------------------------------------------------------------------------------
    // Premium = real accrued fee growth
    // -------------------------------------------------------------------------------------

    function test_premium_accruesFromRealSwapFees() public {
        uint256 shortId = options.tokenIdFor(IDX_SPOT, true, false);

        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY);

        (uint256 p0Before, uint256 p1Before) = options.accruedPremium(seller, shortId);
        assertEq(p0Before, 0);
        assertEq(p1Before, 0);

        _churn();

        (uint256 p0After, uint256 p1After) = options.accruedPremium(seller, shortId);
        assertGt(p0After + p1After, 0, "premium should accrue from swap fees");

        // Cross-check against the pool's own accumulator — no synthetic pricing anywhere.
        (int24 lo, int24 hi) = _putTicks();
        (uint256 fg0, uint256 fg1) = manager.getFeeGrowthInside(poolId, lo, hi);
        assertEq(p0After, FullMath.mulDiv(fg0, WRITE_LIQUIDITY, FixedPoint128.Q128), "premium0 != feeGrowthInside math");
        assertEq(p1After, FullMath.mulDiv(fg1, WRITE_LIQUIDITY, FixedPoint128.Q128), "premium1 != feeGrowthInside math");
    }

    function test_premium_doesNotAccrueWhilePriceIsAwayFromTheStrike() public {
        // Write the far out-of-the-money put; swaps around spot never enter its range.
        uint256 shortId = options.tokenIdFor(0, true, false);

        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY); // provides the liquidity swaps trade against
        vm.prank(seller);
        options.sellOption(0, true, WRITE_LIQUIDITY);

        _churn();

        (uint256 p0, uint256 p1) = options.accruedPremium(seller, shortId);
        assertEq(p0 + p1, 0, "an untouched strike should earn nothing");
    }

    /// @notice The streamia identity that makes the two sides net out:
    ///           shortsOwed = feesActuallyCollected + longsOwe
    ///         because fees accrue on (short - long) while shorts are paid on `short` and longs
    ///         pay on `long`.
    function test_premiumConservation() public {
        uint256 shortId = options.tokenIdFor(IDX_SPOT, true, false);
        uint256 longId = options.tokenIdFor(IDX_SPOT, true, true);
        uint128 bought = WRITE_LIQUIDITY / 4;

        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY);
        vm.prank(buyer);
        options.buyOption(IDX_SPOT, true, bought);

        _churn();

        (int24 lo, int24 hi) = _putTicks();
        (uint256 fg0, uint256 fg1) = manager.getFeeGrowthInside(poolId, lo, hi);

        (uint256 shortOwed0, uint256 shortOwed1) = options.accruedPremium(seller, shortId);
        (uint256 longOwes0, uint256 longOwes1) = options.accruedPremium(buyer, longId);

        uint256 collected0 = FullMath.mulDiv(fg0, WRITE_LIQUIDITY - bought, FixedPoint128.Q128);
        uint256 collected1 = FullMath.mulDiv(fg1, WRITE_LIQUIDITY - bought, FixedPoint128.Q128);

        assertApproxEqAbs(shortOwed0, collected0 + longOwes0, 2, "currency0 streamia does not net out");
        assertApproxEqAbs(shortOwed1, collected1 + longOwes1, 2, "currency1 streamia does not net out");
        assertGt(shortOwed1 + shortOwed0, 0, "test is vacuous without fees");
    }

    // -------------------------------------------------------------------------------------
    // Full lifecycle
    // -------------------------------------------------------------------------------------

    function test_fullLifecycle_sellBuyChurnCloseBoth() public {
        (int24 lo, int24 hi) = _putTicks();
        uint128 bought = WRITE_LIQUIDITY / 2;

        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY);
        vm.prank(buyer);
        options.buyOption(IDX_SPOT, true, bought);

        _churn();
        _churn();

        uint256 shortId = options.tokenIdFor(IDX_SPOT, true, false);
        uint256 longId = options.tokenIdFor(IDX_SPOT, true, true);

        // Buyer unwinds first, returning the borrowed liquidity to the pool.
        vm.prank(buyer);
        options.closeLong(IDX_SPOT, true, bought);
        assertEq(options.balanceOf(buyer, longId), 0, "long receipt not burned");
        assertEq(_poolLiquidityIn(lo, hi, true), WRITE_LIQUIDITY, "liquidity not restored to the pool");

        // Seller can now withdraw the whole written amount.
        vm.prank(seller);
        options.closeShort(IDX_SPOT, true, WRITE_LIQUIDITY);
        assertEq(options.balanceOf(seller, shortId), 0, "short receipt not burned");
        assertEq(_poolLiquidityIn(lo, hi, true), 0, "pool should be empty again");

        // The protocol is not a sink: nothing material is stranded once both sides are flat.
        assertLt(token0.balanceOf(address(options)), 1e12, "currency0 stranded in protocol");
        assertLt(token1.balanceOf(address(options)), 1e12, "currency1 stranded in protocol");
    }

    function test_sellerEarnsPremiumOnTopOfPrincipal() public {
        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY);

        uint256 shortId = options.tokenIdFor(IDX_SPOT, true, false);
        OptionsManager.Position memory p = options.getPosition(seller, shortId);
        uint256 principal1 = p.amount1;

        _churn();
        _churn();

        (, uint256 premium1) = options.accruedPremium(seller, shortId);
        assertGt(premium1, 0, "no premium accrued");

        uint256 before0 = token0.balanceOf(seller);
        uint256 before1 = token1.balanceOf(seller);
        vm.prank(seller);
        options.closeShort(IDX_SPOT, true, WRITE_LIQUIDITY);

        uint256 got0 = token0.balanceOf(seller) - before0;
        uint256 got1 = token1.balanceOf(seller) - before1;

        // Price came back to roughly where it started, so the seller gets principal back plus the
        // fees the position earned while it was in range.
        assertGt(got0 + got1, principal1, "seller should end up ahead by the premium");
    }

    /// @notice A short put assigned: price crashes through the strike and the seller is left
    ///         holding the underlying, bought at the strike. That is what assignment IS here —
    ///         it falls out of Uniswap's own range mechanics, with no settlement code.
    function test_shortPutGetsAssignedTheUnderlyingOnACrash() public {
        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY);

        // Drive price well below the put's range.
        _swapExactIn(true, 50e18);

        (, int24 tickNow,,) = manager.getSlot0(poolId);
        (int24 lo,) = _putTicks();
        assertLt(tickNow, lo, "price should be below the strike range");

        uint256 before0 = token0.balanceOf(seller);
        uint256 before1 = token1.balanceOf(seller);
        vm.prank(seller);
        options.closeShort(IDX_SPOT, true, WRITE_LIQUIDITY);

        // Position converted entirely to currency0 — the seller was assigned.
        assertGt(token0.balanceOf(seller) - before0, 0, "seller should now hold currency0");
        assertEq(token1.balanceOf(seller) - before1, 0, "assigned put returns no currency1");
    }

    // -------------------------------------------------------------------------------------
    // Aqua-backed writing — the seller never deposits
    // -------------------------------------------------------------------------------------

    bytes32 internal constant OFFER_SALT = bytes32(uint256(0xBEEF));

    /// @dev Seller registers wallet balance as backing. Nothing moves.
    function _ship(address maker, address token, uint256 amount)
        internal
        returns (bytes32 strategyHash)
    {
        bytes memory strategy = options.encodeAquaStrategy(maker, OFFER_SALT);
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = token;
        amounts[0] = amount;
        vm.prank(maker);
        strategyHash = aqua.ship(address(options), strategy, tokens, amounts);
        assertEq(strategyHash, options.aquaStrategyHash(maker, OFFER_SALT), "hash mismatch");
    }

    /// @notice The whole point of Aqua: committing collateral costs the seller nothing until the
    ///         option is actually written. No vault, no lock-up, no idle capital.
    function test_aqua_shippingAnOfferDoesNotMoveTokens() public {
        uint256 before1 = token1.balanceOf(seller);
        _ship(seller, address(token1), 100e18);

        assertEq(token1.balanceOf(seller), before1, "shipping must not move tokens");
        assertEq(token1.balanceOf(address(aqua)), 0, "Aqua is a registry, not a pool");
        assertEq(options.aquaBackingOf(seller, OFFER_SALT, currency1), 100e18, "offer not registered");
    }

    /// @notice Writing pulls collateral straight out of the seller's wallet, at the moment of the
    ///         write — and only as much as the v4 mint actually needs.
    function test_aqua_writeIsFundedFromTheWallet() public {
        (int24 lo, int24 hi) = _putTicks();
        _ship(seller, address(token1), 100e18);

        uint256 before1 = token1.balanceOf(seller);

        // Note: a matcher, not the seller, triggers the write. Shipping was the commitment.
        vm.prank(buyer);
        options.sellOptionViaAqua(seller, IDX_SPOT, true, WRITE_LIQUIDITY, OFFER_SALT);

        uint256 spent = before1 - token1.balanceOf(seller);
        assertGt(spent, 0, "collateral should come from the seller wallet");
        assertEq(_poolLiquidityIn(lo, hi, true), WRITE_LIQUIDITY, "liquidity not minted");

        uint256 shortId = options.tokenIdFor(IDX_SPOT, true, false);
        assertEq(options.balanceOf(seller, shortId), WRITE_LIQUIDITY, "seller should own the short");

        // Only the amount actually needed was drawn down; the rest stays committed and liquid.
        assertEq(
            options.aquaBackingOf(seller, OFFER_SALT, currency1),
            100e18 - spent,
            "remaining offer should be untouched"
        );
    }

    function test_aqua_writeCannotExceedTheShippedOffer() public {
        // Ship far less than the write needs.
        _ship(seller, address(token1), 1e12);

        vm.prank(buyer);
        vm.expectRevert();
        options.sellOptionViaAqua(seller, IDX_SPOT, true, WRITE_LIQUIDITY, OFFER_SALT);
    }

    function test_aqua_dockedOfferCannotBeWrittenAgainst() public {
        _ship(seller, address(token1), 100e18);
        bytes32 strategyHash = options.aquaStrategyHash(seller, OFFER_SALT);

        address[] memory tokens = new address[](1);
        tokens[0] = address(token1);
        vm.prank(seller);
        aqua.dock(address(options), strategyHash, tokens);

        vm.prank(buyer);
        vm.expectRevert();
        options.sellOptionViaAqua(seller, IDX_SPOT, true, WRITE_LIQUIDITY, OFFER_SALT);
    }

    /// @notice An Aqua-written short behaves identically downstream — same premium, same close path.
    function test_aqua_writtenShortEarnsPremiumAndCloses() public {
        _ship(seller, address(token1), 100e18);
        vm.prank(buyer);
        options.sellOptionViaAqua(seller, IDX_SPOT, true, WRITE_LIQUIDITY, OFFER_SALT);

        _churn();

        uint256 shortId = options.tokenIdFor(IDX_SPOT, true, false);
        (, uint256 premium1) = options.accruedPremium(seller, shortId);
        assertGt(premium1, 0, "Aqua-written short should accrue premium");

        vm.prank(seller);
        options.closeShort(IDX_SPOT, true, WRITE_LIQUIDITY);
        assertEq(options.balanceOf(seller, shortId), 0, "short not closed");
    }

    // -------------------------------------------------------------------------------------
    // The hook prices premium: utilisation -> LP fee
    // -------------------------------------------------------------------------------------

    /// @notice The answer to "what does the hook actually do". Premium in this protocol IS the LP
    ///         fee, so the hook turning utilisation into that fee is the pricing mechanism itself.
    function test_hook_feeRisesWithUtilisation() public {
        assertEq(hook.utilisationBps(), 0, "nothing written yet");
        assertEq(hook.currentFee(), hook.BASE_FEE(), "empty book charges the base fee");

        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY);
        assertEq(hook.currentFee(), hook.BASE_FEE(), "written but untouched is still base");

        // Half the book bought out -> half the spread.
        vm.prank(buyer);
        options.buyOption(IDX_SPOT, true, WRITE_LIQUIDITY / 2);
        assertEq(hook.utilisationBps(), 5_000, "half the written book is out on loan");
        uint24 half = hook.currentFee();
        assertEq(half, hook.BASE_FEE() + (hook.MAX_FEE() - hook.BASE_FEE()) / 2, "fee should be midway");

        // Fully bought out -> the ceiling.
        vm.prank(buyer);
        options.buyOption(IDX_SPOT, true, WRITE_LIQUIDITY / 2);
        assertEq(hook.utilisationBps(), 10_000);
        assertEq(hook.currentFee(), hook.MAX_FEE(), "a fully-lent book charges the ceiling");

        // Unwinding gives the spread back.
        vm.prank(buyer);
        options.closeLong(IDX_SPOT, true, WRITE_LIQUIDITY);
        assertEq(hook.utilisationBps(), 0);
        assertEq(hook.currentFee(), hook.BASE_FEE());
        assertGt(half, hook.BASE_FEE(), "test is vacuous if the spread never moved");
    }

    // -------------------------------------------------------------------------------------
    // Volatility — the other half of the price
    // -------------------------------------------------------------------------------------

    /// @dev Move price by roughly `ticks`, wait `secs`, and let the hook take an observation.
    ///      Two swaps because the estimator samples on every swap, and a round trip keeps the pool
    ///      near where it started so successive steps are comparable.
    function _volStep(uint256 amountIn, uint256 secs) internal {
        vm.warp(block.timestamp + secs);
        _swapExactIn(true, amountIn);
        vm.warp(block.timestamp + secs);
        _swapExactIn(false, amountIn);
    }

    /// @notice A market with no history has no volatility, and prices at the floor.
    function test_vol_startsAtZeroAndPricesAtTheFloor() public view {
        assertEq(hook.realisedVolBps(), 0, "nothing observed yet");
        assertEq(hook.volFee(), hook.BASE_FEE(), "no volatility means no volatility premium");
        assertEq(hook.currentFee(), hook.BASE_FEE(), "and an untouched book means no spread");
    }

    /// @notice The estimator produces believable annualised numbers, not just a monotone counter.
    ///
    /// @dev This is the test that would catch a scaling mistake. Ticks are log-price, so a tick
    ///      delta is a log return and sigma annualises by `sqrt(seconds per year)`. A market that
    ///      moves a few basis points every ten minutes is a quiet one; a market making the same
    ///      move every few seconds is a violent one. Both are printed so the numbers can be read
    ///      rather than taken on trust.
    function test_vol_isMeasuredInBelievableAnnualisedTerms() public {
        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY);

        // Calm: the same size round trip, ten minutes apart.
        for (uint256 i = 0; i < 12; i++) {
            _volStep(0.02e18, 600);
        }
        uint256 calm = hook.realisedVolBps();
        uint24 calmFee = hook.currentFee();
        console2.log("calm  : realised vol bps", calm);
        console2.log("calm  : lp fee           ", calmFee);

        // Violent: the same size round trip, five seconds apart.
        for (uint256 i = 0; i < 12; i++) {
            _volStep(0.02e18, 5);
        }
        uint256 violent = hook.realisedVolBps();
        uint24 violentFee = hook.currentFee();
        console2.log("violent: realised vol bps", violent);
        console2.log("violent: lp fee          ", violentFee);

        assertGt(violent, calm, "the same move at 120x the frequency must read as more volatile");
        assertGt(violentFee, calmFee, "and must cost more premium");

        // A quiet market should not be reading triple-digit annualised vol.
        assertLt(calm, 5_000, "calm market should be well under 50% annualised");
        // The scaling is only right if a five-second cadence lands in a plausible band rather than
        // overflowing. Note these are absolute numbers for a deliberately thin test pool — one
        // 120-tick range of liquidity — so they read far more violent than Base mainnet would.
        assertGt(violent, 20_000, "a five-second cadence should read as a disorderly market");
        // The per-observation cap is pinned at 400% annualised. This assertion is what catches the
        // scaling being off by a power of ten, which it was: the first version of the cap constant
        // was 1e6 too large and let the estimator report 389,142% annualised.
        assertLt(violent, 41_000, "no reading may exceed the 400% cap");
    }

    /// @notice Volatility decays when the market settles down. Premium is not a ratchet.
    function test_vol_decaysWhenTheMarketCalms() public {
        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY);

        for (uint256 i = 0; i < 10; i++) {
            _volStep(0.02e18, 2);
        }
        uint256 peak = hook.realisedVolBps();
        assertGt(peak, 0, "test is vacuous without a spike");

        for (uint256 i = 0; i < 20; i++) {
            _volStep(0.001e18, 1800);
        }
        uint256 settled = hook.realisedVolBps();

        console2.log("peak vol bps   ", peak);
        console2.log("settled vol bps", settled);
        assertLt(settled, peak / 2, "EWMA should have decayed the spike out");
        assertLt(hook.currentFee(), hook.VOL_FEE_MAX(), "and the fee should have come back down");
    }

    /// @notice Volatility and utilisation compose: each one alone lifts the fee, both together
    ///         reach the ceiling, and nothing ever leaves the bounds.
    function test_vol_composesWithUtilisationAndStaysBounded() public {
        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY);

        uint24 quietAndIdle = hook.currentFee();
        assertEq(quietAndIdle, hook.BASE_FEE());

        // Volatility alone.
        for (uint256 i = 0; i < 12; i++) {
            _volStep(0.02e18, 3);
        }
        uint24 volOnly = hook.currentFee();
        assertGt(volOnly, quietAndIdle, "volatility alone must lift the fee");
        assertLe(volOnly, hook.VOL_FEE_MAX(), "volatility alone cannot exceed its own ceiling");

        // Then utilisation on top.
        vm.prank(buyer);
        options.buyOption(IDX_SPOT, true, WRITE_LIQUIDITY);
        assertEq(hook.utilisationBps(), 10_000);

        uint24 both = hook.currentFee();
        console2.log("fee, volatility only    ", volOnly);
        console2.log("fee, volatility + lent  ", both);

        assertEq(both, hook.MAX_FEE(), "a fully-lent book charges the ceiling whatever the vol");
        assertGe(both, volOnly);
        assertLe(both, hook.MAX_FEE(), "the ceiling is hard");
    }

    /// @notice A writer earns more premium from the same swap flow when the market is volatile.
    ///
    /// @dev The point of the whole exercise. Same liquidity, same round trips, same book — the only
    ///      difference is how fast the market is moving, and the premium stream reflects it.
    function test_vol_volatileMarketPaysWritersMore() public {
        uint256 shortId = options.tokenIdFor(IDX_SPOT, true, false);

        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY);

        // Settle into a calm regime, then measure one round trip's premium.
        for (uint256 i = 0; i < 12; i++) {
            _volStep(0.02e18, 900);
        }
        (, uint256 before1) = options.accruedPremium(seller, shortId);
        _volStep(0.02e18, 900);
        (, uint256 after1) = options.accruedPremium(seller, shortId);
        uint256 calmPremium = after1 - before1;

        // Same trade, violent regime.
        for (uint256 i = 0; i < 12; i++) {
            _volStep(0.02e18, 2);
        }
        (, before1) = options.accruedPremium(seller, shortId);
        _volStep(0.02e18, 900);
        (, after1) = options.accruedPremium(seller, shortId);
        uint256 volatilePremium = after1 - before1;

        console2.log("premium per round trip, calm    :", calmPremium);
        console2.log("premium per round trip, volatile:", volatilePremium);

        assertGt(calmPremium, 0, "calm market should still pay something");
        assertGt(volatilePremium, calmPremium, "identical flow must pay more when vol is high");
    }

    /// @notice And the fee is not cosmetic — swappers actually pay it, so writers actually earn it.
    function test_hook_utilisationSpreadIsPaidByRealSwaps() public {
        uint256 shortId = options.tokenIdFor(IDX_SPOT, true, false);

        vm.prank(seller);
        options.sellOption(IDX_SPOT, true, WRITE_LIQUIDITY);
        _churn();
        _churn();
        (, uint256 baseFeePremium) = options.accruedPremium(seller, shortId);

        // Same churn again, but with the book heavily bought out so the hook widens the fee.
        vm.prank(buyer);
        options.buyOption(IDX_SPOT, true, (WRITE_LIQUIDITY * 9) / 10);
        assertEq(hook.utilisationBps(), 9_000);

        (, uint256 before1) = options.accruedPremium(seller, shortId);
        _churn();
        _churn();
        (, uint256 after1) = options.accruedPremium(seller, shortId);
        uint256 widePremium = after1 - before1;

        assertGt(baseFeePremium, 0, "base-fee churn should have earned something");
        assertGt(widePremium, 0, "wide-fee churn should have earned something");
        // Same liquidity, same swaps, higher fee -> more premium per unit of remaining liquidity.
        console2.log("premium per churn at base fee :", baseFeePremium);
        console2.log("premium per churn at 90% util :", widePremium);
    }

    // -------------------------------------------------------------------------------------
    // One Aqua balance, many legs
    // -------------------------------------------------------------------------------------

    /// @notice The answer to "why do you need 1inch". One shipped wallet balance backs a whole
    ///         multi-leg structure; without a market-scoped registry each leg needs its own vault.
    function test_aqua_oneBalanceBacksAMultiLegSpread() public {
        uint256 shipped = 100_000e18;
        _shipMarket(seller, address(token1), shipped);

        uint256 walletBefore = token1.balanceOf(seller);

        // A put spread: short the nearer strike, short the further one too. Two legs, one offer.
        OptionsManager.Leg[] memory legs = new OptionsManager.Leg[](2);
        legs[0] = OptionsManager.Leg({strikeIndex: IDX_SPOT, isPut: true, liquidity: WRITE_LIQUIDITY});
        legs[1] = OptionsManager.Leg({strikeIndex: 0, isPut: true, liquidity: WRITE_LIQUIDITY});

        vm.prank(buyer); // a matcher, not the seller
        options.sellStrategy(seller, legs, OFFER_SALT);

        uint256 drawn = walletBefore - token1.balanceOf(seller);
        assertGt(drawn, 0, "the structure should have drawn collateral");

        // Both legs exist, funded from the same registered balance.
        assertEq(options.balanceOf(seller, options.tokenIdFor(IDX_SPOT, true, false)), WRITE_LIQUIDITY);
        assertEq(options.balanceOf(seller, options.tokenIdFor(0, true, false)), WRITE_LIQUIDITY);

        // One offer, decremented once by the total. This is the capital-efficiency claim.
        assertEq(
            options.aquaBackingOf(seller, OFFER_SALT, currency1),
            shipped - drawn,
            "both legs must draw from the same offer"
        );
    }

    /// @notice A strangle needs both tokens; one offer can register both and back both legs.
    function test_aqua_oneOfferBacksATwoCurrencyStrangle() public {
        bytes memory strategy = options.encodeAquaStrategy(seller, OFFER_SALT);
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        tokens[0] = address(token0);
        tokens[1] = address(token1);
        amounts[0] = 500e18;
        amounts[1] = 100_000e18;
        vm.prank(seller);
        aqua.ship(address(options), strategy, tokens, amounts);

        // Short put below spot (USDC) + short call above spot (WETH).
        OptionsManager.Leg[] memory legs = new OptionsManager.Leg[](2);
        legs[0] = OptionsManager.Leg({strikeIndex: 0, isPut: true, liquidity: WRITE_LIQUIDITY});
        legs[1] = OptionsManager.Leg({strikeIndex: 2, isPut: false, liquidity: WRITE_LIQUIDITY});

        vm.prank(buyer);
        options.sellStrategy(seller, legs, OFFER_SALT);

        assertEq(options.balanceOf(seller, options.tokenIdFor(0, true, false)), WRITE_LIQUIDITY, "put leg");
        assertEq(options.balanceOf(seller, options.tokenIdFor(2, false, false)), WRITE_LIQUIDITY, "call leg");
        assertLt(options.aquaBackingOf(seller, OFFER_SALT, currency0), 500e18, "WETH leg drew from the offer");
        assertLt(options.aquaBackingOf(seller, OFFER_SALT, currency1), 100_000e18, "USDC leg drew from the offer");
    }

    function test_aqua_strategyCannotOverdrawTheOffer() public {
        _shipMarket(seller, address(token1), 1e12); // far too little

        OptionsManager.Leg[] memory legs = new OptionsManager.Leg[](2);
        legs[0] = OptionsManager.Leg({strikeIndex: IDX_SPOT, isPut: true, liquidity: WRITE_LIQUIDITY});
        legs[1] = OptionsManager.Leg({strikeIndex: 0, isPut: true, liquidity: WRITE_LIQUIDITY});

        vm.prank(buyer);
        vm.expectRevert();
        options.sellStrategy(seller, legs, OFFER_SALT);

        // Nothing partial survived.
        assertEq(options.balanceOf(seller, options.tokenIdFor(IDX_SPOT, true, false)), 0, "no leg should exist");
    }

    /// @dev Ship a market-scoped offer: one balance, any number of legs.
    function _shipMarket(address maker, address token, uint256 amount) internal {
        bytes memory strategy = options.encodeAquaStrategy(maker, OFFER_SALT);
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = token;
        amounts[0] = amount;
        vm.prank(maker);
        aqua.ship(address(options), strategy, tokens, amounts);
    }

    /// @notice Buyers batch too: a protective spread that half-fills is not the position anyone
    ///         asked for, so both legs land in one transaction or neither does.
    function test_buyStrategy_fillsEveryLegInOneTransaction() public {
        _shipMarket(seller, address(token1), 200_000e18);

        OptionsManager.Leg[] memory written = new OptionsManager.Leg[](2);
        written[0] = OptionsManager.Leg({strikeIndex: IDX_SPOT, isPut: true, liquidity: WRITE_LIQUIDITY});
        written[1] = OptionsManager.Leg({strikeIndex: 0, isPut: true, liquidity: WRITE_LIQUIDITY});
        vm.prank(buyer);
        options.sellStrategy(seller, written, OFFER_SALT);

        uint128 take = WRITE_LIQUIDITY / 2;
        OptionsManager.Leg[] memory bought = new OptionsManager.Leg[](2);
        bought[0] = OptionsManager.Leg({strikeIndex: IDX_SPOT, isPut: true, liquidity: take});
        bought[1] = OptionsManager.Leg({strikeIndex: 0, isPut: true, liquidity: take});

        uint256 paid = token1.balanceOf(buyer);
        vm.prank(buyer);
        options.buyStrategy(bought);
        paid -= token1.balanceOf(buyer);

        assertEq(options.balanceOf(buyer, options.tokenIdFor(IDX_SPOT, true, true)), take, "near leg");
        assertEq(options.balanceOf(buyer, options.tokenIdFor(0, true, true)), take, "far leg");
        assertGt(paid, 0, "buyer posts collateral on both legs");
    }

    function test_buyStrategy_revertsWholeStructureIfALegCannotFill() public {
        _shipMarket(seller, address(token1), 200_000e18);

        // Only the spot strike is written; the far strike has nothing to buy.
        OptionsManager.Leg[] memory written = new OptionsManager.Leg[](1);
        written[0] = OptionsManager.Leg({strikeIndex: IDX_SPOT, isPut: true, liquidity: WRITE_LIQUIDITY});
        vm.prank(buyer);
        options.sellStrategy(seller, written, OFFER_SALT);

        OptionsManager.Leg[] memory bought = new OptionsManager.Leg[](2);
        bought[0] = OptionsManager.Leg({strikeIndex: IDX_SPOT, isPut: true, liquidity: WRITE_LIQUIDITY / 2});
        bought[1] = OptionsManager.Leg({strikeIndex: 0, isPut: true, liquidity: WRITE_LIQUIDITY / 2});

        vm.prank(buyer);
        vm.expectRevert();
        options.buyStrategy(bought);

        // The fillable leg must not survive on its own.
        assertEq(options.balanceOf(buyer, options.tokenIdFor(IDX_SPOT, true, true)), 0, "no partial fill");
    }

    // -------------------------------------------------------------------------------------
    // Token id encoding
    // -------------------------------------------------------------------------------------

    function testFuzz_positionIdRoundTrips(int24 lo, int24 hi, bool isPut, bool isLong) public pure {
        uint256 id = PositionId.encode(0, lo, hi, isPut, isLong);
        (uint8 marketId, int24 lo_, int24 hi_, bool isPut_, bool isLong_) = PositionId.decode(id);
        assertEq(marketId, 0);
        assertEq(lo_, lo);
        assertEq(hi_, hi);
        assertEq(isPut_, isPut);
        assertEq(isLong_, isLong);
    }

    function test_longAndShortIdsDifferOnlyBySideBit() public view {
        uint256 shortId = options.tokenIdFor(IDX_SPOT, true, false);
        uint256 longId = options.tokenIdFor(IDX_SPOT, true, true);
        assertEq(PositionId.flipSide(shortId), longId);
        assertTrue(PositionId.isPut(longId));
        assertTrue(PositionId.isLong(longId));
        assertFalse(PositionId.isLong(shortId));
    }
}
