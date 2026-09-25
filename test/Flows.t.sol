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
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {OptionsManager} from "../src/OptionsManager.sol";
import {OptionsHook} from "../src/OptionsHook.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {MockERC20} from "./utils/MockERC20.sol";
import {MockAqua} from "./utils/MockAqua.sol";

/// @notice Exact token flows for all four trades: write/buy x put/call.
///
/// @dev Prints a four-column ledger (seller, buyer, protocol, pool vault) for every step, so the
///      answer to "where do the tokens actually go" is measured rather than described. Run with:
///
///        forge test --match-contract Flows -vv
contract FlowsTest is Test {
    using StateLibrary for IPoolManager;

    PoolManager internal poolManager;
    IPoolManager internal manager;
    OptionsHook internal hook;
    OptionsManager internal options;
    MockAqua internal aqua;

    MockERC20 internal weth; // currency0
    MockERC20 internal usdc; // currency1
    PoolKey internal key;
    PoolId internal poolId;

    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");

    uint8 internal constant SPOT = 1;
    uint128 internal constant SIZE = 1_000e18;
    bytes32 internal constant SALT = bytes32(uint256(0xA01A));

    struct L {
        uint256 sw;
        uint256 su;
        uint256 bw;
        uint256 bu;
        uint256 pw;
        uint256 pu;
        uint256 vw;
        uint256 vu;
    }

    function setUp() public {
        poolManager = new PoolManager(address(this));
        manager = IPoolManager(address(poolManager));
        aqua = new MockAqua();

        MockERC20 a = new MockERC20("Wrapped Ether", "WETH", 18);
        MockERC20 b = new MockERC20("USD Coin", "USDC", 18);
        (weth, usdc) = address(a) < address(b) ? (a, b) : (b, a);

        uint160 flags =
            uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG);
        (, bytes32 salt) = HookMiner.find(
            address(this), flags, type(OptionsHook).creationCode, abi.encode(poolManager, address(this))
        );
        hook = new OptionsHook{salt: salt}(poolManager, address(this));

        key = PoolKey({
            currency0: Currency.wrap(address(weth)),
            currency1: Currency.wrap(address(usdc)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();

        int24[] memory strikes = new int24[](3);
        strikes[0] = -480;
        strikes[1] = 0;
        strikes[2] = 480;
        options = new OptionsManager(poolManager, IAqua(address(aqua)), key, 120, strikes);
        hook.initialize(address(options));
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(0));

        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? seller : buyer;
            weth.mint(who, 1_000_000e18);
            usdc.mint(who, 1_000_000e18);
            vm.startPrank(who);
            weth.approve(address(options), type(uint256).max);
            usdc.approve(address(options), type(uint256).max);
            weth.approve(address(aqua), type(uint256).max);
            usdc.approve(address(aqua), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------------------------
    // Ledger helpers
    // ------------------------------------------------------------------------------------

    function _snap() internal view returns (L memory) {
        return L({
            sw: weth.balanceOf(seller),
            su: usdc.balanceOf(seller),
            bw: weth.balanceOf(buyer),
            bu: usdc.balanceOf(buyer),
            pw: weth.balanceOf(address(options)),
            pu: usdc.balanceOf(address(options)),
            vw: weth.balanceOf(address(poolManager)),
            vu: usdc.balanceOf(address(poolManager))
        });
    }

    function _row(string memory who, int256 dw, int256 du) internal pure {
        if (dw == 0 && du == 0) return;
        console2.log(string.concat("        ", who, "  WETH ", _s(dw), "   USDC ", _s(du)));
    }

    function _diff(string memory step, L memory a, L memory b) internal pure {
        console2.log(string.concat("      ", step));
        _row("seller  ", int256(b.sw) - int256(a.sw), int256(b.su) - int256(a.su));
        _row("buyer   ", int256(b.bw) - int256(a.bw), int256(b.bu) - int256(a.bu));
        _row("protocol", int256(b.pw) - int256(a.pw), int256(b.pu) - int256(a.pu));
        _row("v4 vault", int256(b.vw) - int256(a.vw), int256(b.vu) - int256(a.vu));
    }

    function _s(int256 v) internal pure returns (string memory) {
        return v >= 0 ? string.concat("+", _fmt(uint256(v))) : string.concat("-", _fmt(uint256(-v)));
    }

    function _fmt(uint256 v) internal pure returns (string memory) {
        uint256 whole = v / 1e18;
        uint256 frac = (v % 1e18) / 1e14;
        string memory f = vm.toString(frac);
        while (bytes(f).length < 4) f = string.concat("0", f);
        return string.concat(vm.toString(whole), ".", f);
    }

    function _poolLiq(bool isPut) internal view returns (uint128 liq) {
        (int24 lo, int24 hi) = options.seriesTicks(SPOT, isPut);
        (liq,,) = manager.getPositionInfo(poolId, address(options), lo, hi, bytes32(uint256(isPut ? 1 : 0)));
    }

    function _ticks(bool isPut) internal view {
        (int24 lo, int24 hi) = options.seriesTicks(SPOT, isPut);
        console2.log(
            string.concat(
                "      range: ticks ",
                vm.toString(int256(lo)),
                " .. ",
                vm.toString(int256(hi)),
                "   (spot tick 0)"
            )
        );
    }

    function _ship(bool isPut) internal {
        address token = isPut ? address(usdc) : address(weth);
        address[] memory t = new address[](1);
        uint256[] memory amt = new uint256[](1);
        t[0] = token;
        amt[0] = 500_000e18;
        // Compute the strategy bytes BEFORE pranking: vm.prank applies to the next call of any
        // kind, and an argument-position staticcall would consume it, making the test contract the
        // maker instead of the seller.
        bytes memory strategy = options.encodeAquaStrategy(seller, SALT);
        vm.prank(seller);
        aqua.ship(address(options), strategy, t, amt);
    }

    // ------------------------------------------------------------------------------------
    // 1. SELL a PUT
    // ------------------------------------------------------------------------------------

    function test_flow_1_sellPut() public {
        console2.log("");
        console2.log("### 1. SELL PUT (write) - collateral is USDC ###");
        _ticks(true);

        L memory a = _snap();
        _ship(true);
        _diff("step 1: seller ships an Aqua offer", a, _snap());
        console2.log("        (no rows above = nothing moved. Aqua only registers.)");

        a = _snap();
        vm.prank(buyer); // a matcher, not the seller
        options.sellOptionViaAqua(seller, SPOT, true, SIZE, SALT);
        _diff("step 2: option is written -> Aqua pulls, v4 mints", a, _snap());
        console2.log(string.concat("        pool liquidity now: ", vm.toString(uint256(_poolLiq(true)))));
        console2.log("        seller holds ERC-1155 SHORT PUT");
    }

    // ------------------------------------------------------------------------------------
    // 2. BUY a PUT
    // ------------------------------------------------------------------------------------

    function test_flow_2_buyPut() public {
        console2.log("");
        console2.log("### 2. BUY PUT ###");
        _ticks(true);
        _ship(true);
        vm.prank(buyer);
        options.sellOptionViaAqua(seller, SPOT, true, SIZE, SALT);

        L memory a = _snap();
        vm.prank(buyer);
        options.buyOption(SPOT, true, SIZE);
        _diff("buyer buys the whole size", a, _snap());
        console2.log(string.concat("        pool liquidity now: ", vm.toString(uint256(_poolLiq(true)))));
        console2.log("        note: protocol GAINS the notional pulled out of the pool and KEEPS it;");
        console2.log("              the buyer only pays 10% collateral and receives nothing up front.");
    }

    // ------------------------------------------------------------------------------------
    // 3. SELL a CALL
    // ------------------------------------------------------------------------------------

    function test_flow_3_sellCall() public {
        console2.log("");
        console2.log("### 3. SELL CALL (write) - collateral is WETH ###");
        _ticks(false);

        L memory a = _snap();
        _ship(false);
        _diff("step 1: seller ships an Aqua offer", a, _snap());
        console2.log("        (no rows above = nothing moved.)");

        a = _snap();
        vm.prank(buyer);
        options.sellOptionViaAqua(seller, SPOT, false, SIZE, SALT);
        _diff("step 2: option is written -> Aqua pulls, v4 mints", a, _snap());
        console2.log(string.concat("        pool liquidity now: ", vm.toString(uint256(_poolLiq(false)))));
        console2.log("        seller holds ERC-1155 SHORT CALL");
    }

    // ------------------------------------------------------------------------------------
    // 4. BUY a CALL
    // ------------------------------------------------------------------------------------

    function test_flow_4_buyCall() public {
        console2.log("");
        console2.log("### 4. BUY CALL ###");
        _ticks(false);
        _ship(false);
        vm.prank(buyer);
        options.sellOptionViaAqua(seller, SPOT, false, SIZE, SALT);

        L memory a = _snap();
        vm.prank(buyer);
        options.buyOption(SPOT, false, SIZE);
        _diff("buyer buys the whole size", a, _snap());
        console2.log(string.concat("        pool liquidity now: ", vm.toString(uint256(_poolLiq(false)))));
    }

    // ------------------------------------------------------------------------------------
    // 5. Closing both legs, so the round trip is visible end to end
    // ------------------------------------------------------------------------------------

    function test_flow_5_closeBothLegs() public {
        console2.log("");
        console2.log("### 5. CLOSING (put, no price move, no swaps) ###");
        _ship(true);
        vm.prank(buyer);
        options.sellOptionViaAqua(seller, SPOT, true, SIZE, SALT);
        vm.prank(buyer);
        options.buyOption(SPOT, true, SIZE);

        L memory a = _snap();
        vm.prank(buyer);
        options.closeLong(SPOT, true, SIZE);
        _diff("buyer closes the long -> liquidity goes back into v4", a, _snap());

        a = _snap();
        vm.prank(seller);
        options.closeShort(SPOT, true, SIZE);
        _diff("seller closes the short -> principal comes back", a, _snap());

        console2.log(
            string.concat(
                "        protocol residue: WETH ",
                _fmt(weth.balanceOf(address(options))),
                "  USDC ",
                _fmt(usdc.balanceOf(address(options)))
            )
        );
    }
}
