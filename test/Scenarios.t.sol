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
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {OptionsManager} from "../src/OptionsManager.sol";
import {OptionsHook} from "../src/OptionsHook.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {MockERC20} from "./utils/MockERC20.sol";
import {MockAqua} from "./utils/MockAqua.sol";

/// @notice Financial outcomes, measured rather than asserted from theory.
///
/// @dev Every scenario runs the real mechanism on a real pool and reports each participant's
///      mark-to-market P&L in USDC at the closing price. Both test tokens use 18 decimals so the
///      raw tick price is directly readable as USDC per WETH; spot starts at tick 0 = $1.00, which
///      keeps the arithmetic legible. Run with:
///
///        forge test --match-contract Scenarios -vv
contract ScenariosTest is Test {
    using StateLibrary for IPoolManager;

    PoolManager internal poolManager;
    IPoolManager internal manager;
    OptionsHook internal hook;
    OptionsManager internal options;
    PoolSwapTest internal swapRouter;
    MockAqua internal aqua;

    MockERC20 internal token0;
    MockERC20 internal token1;
    PoolKey internal key;
    PoolId internal poolId;

    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal swapper = makeAddr("swapper");

    uint24 internal constant FEE = LPFeeLibrary.DYNAMIC_FEE_FLAG;
    int24 internal constant TICK_SPACING = 60;
    int24 internal constant STRIKE_WIDTH = 120;
    uint8 internal constant SPOT = 1;
    uint128 internal constant SIZE = 1_000e18;

    function setUp() public {
        poolManager = new PoolManager(address(this));
        manager = IPoolManager(address(poolManager));
        swapRouter = new PoolSwapTest(poolManager);
        aqua = new MockAqua();

        MockERC20 a = new MockERC20("Wrapped Ether", "WETH", 18);
        MockERC20 b = new MockERC20("USD Coin", "USDC", 18);
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);

        uint160 flags =
            uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG);
        (, bytes32 salt) = HookMiner.find(
            address(this), flags, type(OptionsHook).creationCode, abi.encode(poolManager, address(this))
        );
        hook = new OptionsHook{salt: salt}(poolManager, address(this));

        key = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();

        int24[] memory strikes = new int24[](3);
        strikes[0] = -480;
        strikes[1] = 0;
        strikes[2] = 480;
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
        vm.stopPrank();
    }

    // -----------------------------------------------------------------------------------
    // Measurement helpers
    // -----------------------------------------------------------------------------------

    /// @dev A wallet snapshot. P&L is measured as the CHANGE in these two balances valued at one
    ///      single price, never as a mark-to-market of the whole wallet: these accounts hold a
    ///      million idle WETH, so revaluing the lot would swamp the option's result with inventory
    ///      noise. Valuing the delta at the closing price isolates the trade itself.
    struct Snap {
        uint256 weth;
        uint256 usdc;
    }

    function _snap(address who) internal view returns (Snap memory) {
        return Snap({weth: token0.balanceOf(who), usdc: token1.balanceOf(who)});
    }

    /// @dev Trade P&L in USDC: the change in each balance, valued at the current price.
    function _tradePnl(address who, Snap memory s0) internal view returns (int256) {
        (uint160 sqrtP,,,) = manager.getSlot0(poolId);
        uint256 priceX96 = FullMath.mulDiv(sqrtP, sqrtP, 1 << 96);
        Snap memory s1 = _snap(who);
        int256 dUsdc = int256(s1.usdc) - int256(s0.usdc);
        int256 dWeth = int256(s1.weth) - int256(s0.weth);
        int256 dWethUsd = dWeth >= 0
            ? int256(FullMath.mulDiv(uint256(dWeth), priceX96, 1 << 96))
            : -int256(FullMath.mulDiv(uint256(-dWeth), priceX96, 1 << 96));
        return dUsdc + dWethUsd;
    }

    function _spotUsd() internal view returns (uint256) {
        (uint160 sqrtP,,,) = manager.getSlot0(poolId);
        return FullMath.mulDiv(FullMath.mulDiv(sqrtP, sqrtP, 1 << 96), 1e18, 1 << 96);
    }

    function _swapTo(bool zeroForOne, uint256 maxIn, int24 limitTick) internal {
        vm.prank(swapper);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(maxIn),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(limitTick)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Trade back and forth across the at-the-money range to generate genuine swap fees.
    function _churn(uint8 rounds) internal {
        for (uint8 i = 0; i < rounds; i++) {
            _swapTo(true, 100e18, -119);
            _swapTo(false, 100e18, -1);
        }
    }

    function _report(string memory who, address addr, Snap memory s0) internal view returns (int256 pnl) {
        (uint160 sqrtP,,,) = manager.getSlot0(poolId);
        sqrtP;
        Snap memory s1 = _snap(addr);
        console2.log(string.concat("      ", who, " WETH : ", _signed(int256(s1.weth) - int256(s0.weth))));
        console2.log(string.concat("      ", who, " USDC : ", _signed(int256(s1.usdc) - int256(s0.usdc))));
        pnl = _tradePnl(addr, s0);
        console2.log(string.concat("      ", who, " P&L  : ", _signed(pnl), " USDC  (valued at close)"));
    }

    function _signed(int256 v) internal pure returns (string memory) {
        return v >= 0 ? string.concat("+", _fmt(uint256(v))) : string.concat("-", _fmt(uint256(-v)));
    }

    /// @dev 18-decimal fixed point as a human string with 4 decimal places.
    function _fmt(uint256 v) internal pure returns (string memory) {
        uint256 whole = v / 1e18;
        uint256 frac = (v % 1e18) / 1e14;
        string memory f = vm.toString(frac);
        while (bytes(f).length < 4) f = string.concat("0", f);
        return string.concat(vm.toString(whole), ".", f);
    }

    function _header(string memory title) internal view {
        console2.log("");
        console2.log(string.concat("=== ", title, " ==="));
        console2.log(string.concat("      open  spot: $", _fmt(_spotUsd())));
    }

    function _close() internal view {
        console2.log(string.concat("      close spot: $", _fmt(_spotUsd())));
    }

    // -----------------------------------------------------------------------------------
    // 1. Volatility seller, price goes nowhere. The base case for writing options.
    // -----------------------------------------------------------------------------------

    function test_A_shortPut_priceFlat_sellerKeepsPremium() public {
        _header("A. SHORT PUT, price round-trips back to the strike");
        Snap memory s0 = _snap(seller);

        vm.prank(seller);
        options.sellOption(SPOT, true, SIZE);

        _churn(6);
        _swapTo(false, 100e18, 0); // back to the strike

        vm.prank(seller);
        options.closeShort(SPOT, true, SIZE);

        _close();
        int256 pnl = _report("seller", seller, s0);
        console2.log("      -> never assigned; kept the swap fees. The covered-put carry trade.");
        assertGt(pnl, 0, "seller should profit on a flat tape");
    }

    // -----------------------------------------------------------------------------------
    // 2. Volatility seller, price crashes through the strike. Assignment.
    // -----------------------------------------------------------------------------------

    function test_B_shortPut_priceCrashes_sellerIsAssigned() public {
        _header("B. SHORT PUT, price crashes through the strike");
        Snap memory s0 = _snap(seller);

        vm.prank(seller);
        options.sellOption(SPOT, true, SIZE);

        _swapTo(true, 100e18, -180); // straight through the range

        vm.prank(seller);
        options.closeShort(SPOT, true, SIZE);

        _close();
        int256 pnl = _report("seller", seller, s0);
        console2.log("      -> assigned: spent USDC, now holds WETH bought at the strike, now worth less.");
        assertGt(_snap(seller).weth, s0.weth, "seller must end up holding the underlying");
        assertLt(pnl, 0, "an assigned put with no premium is a loss");
    }

    // -----------------------------------------------------------------------------------
    // 3. The buyer's side of the same crash. The speculation / hedging leg.
    // -----------------------------------------------------------------------------------

    function test_C_longPut_priceCrashes_buyerProfits() public {
        _header("C. LONG PUT, price crashes (buyer speculating on a drop)");

        vm.prank(seller);
        options.sellOption(SPOT, true, SIZE);

        Snap memory b0 = _snap(buyer);
        vm.prank(buyer);
        options.buyOption(SPOT, true, SIZE);
        console2.log(string.concat("      buyer posted : ", _fmt(b0.usdc - _snap(buyer).usdc), " USDC collateral"));

        _swapTo(true, 100e18, -180);

        vm.prank(buyer);
        options.closeLong(SPOT, true, SIZE);

        _close();
        int256 pnl = _report("buyer", buyer, b0);
        console2.log("      -> directionally the mirror of B, but not equal in size: here the seller was");
        console2.log("         fully bought out, so no liquidity remained to earn fees during the crash.");
        assertGt(pnl, 0, "long put should profit on a crash");
    }

    // -----------------------------------------------------------------------------------
    // 4. Long put when the move never happens. The cost of being wrong.
    // -----------------------------------------------------------------------------------

    function test_D_longPut_priceFlat_buyerPaysStreamia() public {
        _header("D. LONG PUT, price goes nowhere (buyer is wrong)");

        vm.prank(seller);
        options.sellOption(SPOT, true, SIZE);

        Snap memory b0 = _snap(buyer);
        vm.prank(buyer);
        options.buyOption(SPOT, true, SIZE / 2);

        _churn(6);
        _swapTo(false, 100e18, 0);

        uint256 longId = options.tokenIdFor(SPOT, true, true);
        (uint256 owed0, uint256 owed1) = options.accruedPremium(buyer, longId);
        console2.log(string.concat("      premium owed : ", _fmt(owed1), " USDC + ", _fmt(owed0), " WETH"));

        vm.prank(buyer);
        options.closeLong(SPOT, true, SIZE / 2);

        _close();
        int256 pnl = _report("buyer", buyer, b0);
        console2.log("      -> paid rent (streamia) for holding the position. Theta, charged continuously.");
        assertLt(pnl, 0, "a long that never moves must lose the premium");
    }

    // -----------------------------------------------------------------------------------
    // 5. Short call, price rips. The mirror-image assignment.
    // -----------------------------------------------------------------------------------

    function test_E_shortCall_priceRips_sellerDeliversUnderlying() public {
        _header("E. SHORT CALL, price rips through the strike");
        Snap memory s0 = _snap(seller);

        vm.prank(seller);
        options.sellOption(SPOT, false, SIZE); // call: range sits ABOVE spot, funded in WETH

        _swapTo(false, 100e18, 180); // push price up through the call range

        vm.prank(seller);
        options.closeShort(SPOT, false, SIZE);

        _close();
        int256 pnl = _report("seller", seller, s0);
        console2.log("      -> delivered WETH at the strike while spot ran past it: a covered call, called away.");
        assertLt(_snap(seller).weth, s0.weth, "seller must have delivered WETH");
        assertLt(pnl, 0, "being called away below spot is an opportunity loss");
    }

    // -----------------------------------------------------------------------------------
    // 6. Hedging: a WETH holder writes a call to earn yield on inventory it already holds.
    // -----------------------------------------------------------------------------------

    function test_F_hedging_coveredCallOnInventory() public {
        _header("F. HEDGING: WETH holder writes a covered call for yield");
        Snap memory s0 = _snap(seller);

        vm.prank(seller);
        options.sellOption(SPOT, false, SIZE);

        // Price probes the strike repeatedly and falls back: fees accrue, never called away.
        for (uint8 i = 0; i < 4; i++) {
            _swapTo(false, 100e18, 60);
            _swapTo(true, 100e18, 1);
        }

        vm.prank(seller);
        options.closeShort(SPOT, false, SIZE);

        _close();
        int256 pnl = _report("seller", seller, s0);
        console2.log("      -> yield earned on inventory that was going to be held anyway.");
        assertGt(pnl, 0, "covered call should earn on a choppy tape");
    }

    // -----------------------------------------------------------------------------------
    // 7. Conservation: with no swaps there is nothing to transfer.
    // -----------------------------------------------------------------------------------

    function test_G_conservation_noSwapsNoTransfer() public {
        _header("G. CONSERVATION: no swaps, no fees, everyone ends flat");

        Snap memory s0 = _snap(seller);
        vm.prank(seller);
        options.sellOption(SPOT, true, SIZE);

        Snap memory b0 = _snap(buyer);
        vm.prank(buyer);
        options.buyOption(SPOT, true, SIZE);

        vm.prank(buyer);
        options.closeLong(SPOT, true, SIZE);
        vm.prank(seller);
        options.closeShort(SPOT, true, SIZE);

        _close();
        int256 sp = _report("seller", seller, s0);
        int256 bp = _report("buyer", buyer, b0);
        console2.log(
            string.concat("      protocol residue: ", _fmt(token1.balanceOf(address(options))), " USDC")
        );
        console2.log("      -> nothing was created or destroyed. Premium only exists if swappers pay fees.");

        assertApproxEqAbs(sp, int256(0), 1e12, "seller should be flat");
        assertApproxEqAbs(bp, int256(0), 1e12, "buyer should be flat");
    }

    // -----------------------------------------------------------------------------------
    // 8. Zero-sum under a real price move: both legs of the SAME trade, closed together.
    // -----------------------------------------------------------------------------------

    function test_H_zeroSum_bothLegsOfOneTradeThroughACrash() public {
        _header("H. ZERO-SUM: both legs of one trade, through a crash");

        Snap memory s0 = _snap(seller);
        vm.prank(seller);
        options.sellOption(SPOT, true, SIZE);

        Snap memory b0 = _snap(buyer);
        vm.prank(buyer);
        options.buyOption(SPOT, true, SIZE);

        _swapTo(true, 100e18, -180);

        vm.prank(buyer);
        options.closeLong(SPOT, true, SIZE);
        vm.prank(seller);
        options.closeShort(SPOT, true, SIZE);

        _close();
        int256 sp = _report("seller", seller, s0);
        int256 bp = _report("buyer", buyer, b0);
        int256 net = sp + bp;
        console2.log(string.concat("      seller + buyer = ", _signed(net), " USDC"));
        console2.log("      -> the two legs net to zero. No house edge, no subsidy, no leak.");

        assertApproxEqAbs(net, int256(0), 1e13, "the two legs must net out");
    }
}
