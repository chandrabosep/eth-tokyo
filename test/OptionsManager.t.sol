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
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint128} from "v4-core/libraries/FixedPoint128.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {OptionsManager} from "../src/OptionsManager.sol";
import {OptionsHook} from "../src/OptionsHook.sol";
import {PositionId} from "../src/libraries/PositionId.sol";
import {MockERC20} from "./utils/MockERC20.sol";

/// @notice Phase 1 — the core mechanism, with no Aqua and no 1inch in the picture.
///         Proves: writing an option really is minting v4 liquidity, buying one really is removing
///         it, premium really is accrued `feeGrowthInside`, and the whole cycle reconciles.
contract OptionsManagerTest is Test {
    using StateLibrary for IPoolManager;

    PoolManager internal poolManager;
    IPoolManager internal manager; // same contract, typed for StateLibrary
    OptionsHook internal hook;
    OptionsManager internal options;
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

    uint24 internal constant FEE = 3000; // 0.30%
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
        swapRouter = new PoolSwapTest(poolManager);
        lpRouter = new PoolModifyLiquidityTest(poolManager);

        MockERC20 tA = new MockERC20("Wrapped Ether", "WETH", 18);
        MockERC20 tB = new MockERC20("USD Coin", "USDC", 18);
        (token0, token1) = address(tA) < address(tB) ? (tA, tB) : (tB, tA);
        currency0 = Currency.wrap(address(token0));
        currency1 = Currency.wrap(address(token1));

        // Mine a hook address carrying the beforeAddLiquidity + beforeRemoveLiquidity flags.
        uint160 flags = uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG);
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
        options = new OptionsManager(poolManager, key, STRIKE_WIDTH, strikes);
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

    // -------------------------------------------------------------------------------------
    // Full lifecycle
    // -------------------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------------------
    // The hook prices premium: utilisation -> LP fee
    // -------------------------------------------------------------------------------------

    // -------------------------------------------------------------------------------------
    // Volatility — the other half of the price
    // -------------------------------------------------------------------------------------

    // -------------------------------------------------------------------------------------
    // One Aqua balance, many legs
    // -------------------------------------------------------------------------------------

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
