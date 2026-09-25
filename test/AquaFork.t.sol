// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

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
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {OptionsManager} from "../src/OptionsManager.sol";
import {OptionsHook} from "../src/OptionsHook.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";

interface IERC20Like {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Phase 2 against the real thing.
///
/// @dev Aqua is deployed on 17 mainnets and no testnet, so "test against Aqua's sandbox" is not an
///      option — forking Base is strictly better than mocking anyway. Everything here is the
///      genuine deployed article: the Uniswap v4 PoolManager, the Aqua registry, canonical WETH and
///      USDC. Only the hook and OptionsManager are ours.
///
///      Run: forge test --match-contract AquaFork
///      Skip when offline: forge test --no-match-contract AquaFork
contract AquaForkTest is Test {
    using StateLibrary for IPoolManager;

    // Real Base mainnet deployments.
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IAqua internal constant AQUA = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    uint24 internal constant FEE = LPFeeLibrary.DYNAMIC_FEE_FLAG;
    int24 internal constant TICK_SPACING = 60;
    int24 internal constant STRIKE_WIDTH = 120;

    /// @dev ≈ $4,060 per ETH once the 18/6 decimal difference is accounted for.
    int24 internal constant SPOT_TICK = -193_200;
    uint8 internal constant IDX_SPOT = 1;

    bytes32 internal constant OFFER_SALT = bytes32(uint256(0xA01A));

    OptionsHook internal hook;
    OptionsManager internal options;
    PoolKey internal key;
    PoolId internal poolId;

    address internal seller = makeAddr("seller");
    address internal matcher = makeAddr("matcher");

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")), 51_698_307);

        // Sanity: we really are pointed at deployed code, not empty addresses.
        assertGt(address(POOL_MANAGER).code.length, 0, "no PoolManager at Base address");
        assertGt(address(AQUA).code.length, 0, "no Aqua at Base address");

        uint160 flags =
            uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG);
        (address hookAddr, bytes32 salt) = HookMiner.find(
            address(this), flags, type(OptionsHook).creationCode, abi.encode(POOL_MANAGER, address(this))
        );
        hook = new OptionsHook{salt: salt}(POOL_MANAGER, address(this));
        assertEq(address(hook), hookAddr);

        // WETH < USDC by address, so currency0 = WETH and the tick axis is USDC per WETH.
        key = PoolKey({
            currency0: Currency.wrap(WETH),
            currency1: Currency.wrap(USDC),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();

        int24[] memory strikes = new int24[](3);
        strikes[0] = SPOT_TICK - 480;
        strikes[1] = SPOT_TICK;
        strikes[2] = SPOT_TICK + 480;
        options = new OptionsManager(POOL_MANAGER, AQUA, key, STRIKE_WIDTH, strikes);
        hook.initialize(address(options));

        POOL_MANAGER.initialize(key, TickMath.getSqrtPriceAtTick(SPOT_TICK));

        deal(USDC, seller, 1_000_000e6);
        deal(WETH, seller, 100e18);
    }

    /// @notice End to end on real infrastructure: ship an offer to the real Aqua registry, then
    ///         write an option that mints real Uniswap v4 liquidity, funded by a pull straight out
    ///         of the seller's wallet.
    function test_fork_shipThenWriteAgainstRealAqua() public {
        // 1. The seller approves Aqua once and ships the offer. Tokens do not move.
        bytes memory strategy = options.encodeAquaStrategy(seller, OFFER_SALT);
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = USDC;
        amounts[0] = 500_000e6;

        uint256 usdcBeforeShip = IERC20Like(USDC).balanceOf(seller);

        vm.startPrank(seller);
        IERC20Like(USDC).approve(address(AQUA), type(uint256).max);
        bytes32 strategyHash = AQUA.ship(address(options), strategy, tokens, amounts);
        vm.stopPrank();

        assertEq(strategyHash, options.aquaStrategyHash(seller, OFFER_SALT), "strategy hash mismatch");
        assertEq(IERC20Like(USDC).balanceOf(seller), usdcBeforeShip, "shipping must not move tokens");
        assertEq(IERC20Like(USDC).balanceOf(address(AQUA)), 0, "Aqua must not custody anything");
        assertEq(
            options.aquaBackingOf(seller, OFFER_SALT, Currency.wrap(USDC)),
            500_000e6,
            "offer not registered with Aqua"
        );

        // 2. A matcher writes the option. Only now is collateral drawn, and only what v4 needs.
        uint128 liquidity = 1e15;
        (int24 lo, int24 hi) = options.seriesTicks(IDX_SPOT, true);

        vm.prank(matcher);
        options.sellOptionViaAqua(seller, IDX_SPOT, true, liquidity, OFFER_SALT);

        uint256 pulled = usdcBeforeShip - IERC20Like(USDC).balanceOf(seller);
        assertGt(pulled, 0, "collateral should have been pulled from the wallet");

        // The option is real Uniswap v4 liquidity on the real PoolManager.
        (uint128 poolLiquidity,,) = POOL_MANAGER.getPositionInfo(poolId, address(options), lo, hi, bytes32(uint256(1)));
        assertEq(poolLiquidity, liquidity, "liquidity not minted into the real v4 pool");

        // An at-the-money short put is single-sided USDC — no WETH was touched.
        assertEq(IERC20Like(WETH).balanceOf(seller), 100e18, "short put should not consume WETH");

        // Aqua decremented exactly what was pulled; the remainder is still committed and liquid.
        assertEq(
            options.aquaBackingOf(seller, OFFER_SALT, Currency.wrap(USDC)),
            500_000e6 - pulled,
            "Aqua balance not decremented correctly"
        );

        uint256 shortId = options.tokenIdFor(IDX_SPOT, true, false);
        assertEq(options.balanceOf(seller, shortId), liquidity, "seller should hold the short receipt");
    }

    /// @notice An offer that does not cover the write fails by NAME, not by panic.
    ///
    /// @dev This started as a loose `vm.expectRevert()`, and the looseness cost a real debugging
    ///      session. Aqua decrements its registered balance with plain arithmetic, so an over-draw
    ///      surfaced as a bare `panic(0x11)` — which a wallet renders as "reverted with the
    ///      following reason:" followed by nothing at all. The manager now checks the registered
    ///      balance first and names the token, what it needed and what was there.
    function test_fork_cannotWriteBeyondTheShippedOffer() public {
        bytes memory strategy = options.encodeAquaStrategy(seller, OFFER_SALT);
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = USDC;
        amounts[0] = 1e6; // 1 USDC of backing

        vm.startPrank(seller);
        IERC20Like(USDC).approve(address(AQUA), type(uint256).max);
        AQUA.ship(address(options), strategy, tokens, amounts);
        vm.stopPrank();

        // This range is funded in USDC, and 1 USDC does not cover it. That is the realistic failure:
        // not a missing token, but an offer that has been partly spent already.
        (, uint256 need1) = options.collateralFor(IDX_SPOT, true, 1e15);
        assertGt(need1, 1e6, "test needs a write larger than the offer");

        vm.prank(matcher);
        vm.expectRevert(
            abi.encodeWithSelector(OptionsManager.InsufficientAquaBacking.selector, USDC, need1, uint256(1e6))
        );
        options.sellOptionViaAqua(seller, IDX_SPOT, true, 1e15, OFFER_SALT);
    }

    /// @notice The collateral quote is exact, against the real PoolManager.
    ///
    /// @dev An Aqua strategy is immutable once shipped — a seller who under-ships cannot top the
    ///      offer up, they have to abandon it and ship a new one under a new salt. So "roughly the
    ///      right amount" is not good enough: if the quote is one wei light, the write reverts and
    ///      the offer is burnt. This pins the quote to the amount the pool actually takes.
    function test_fork_collateralQuoteMatchesWhatTheWriteActuallyPulls() public {
        // A strike above spot is WETH-funded, one below is USDC-funded, and the straddling one
        // needs both — so quote all three and ship exactly the sum, the way the UI has to.
        uint256 need0;
        uint256 need1;
        for (uint8 i = 0; i < 3; i++) {
            (uint256 a0, uint256 a1) = options.collateralFor(i, true, 1e15);
            need0 += a0;
            need1 += a1;
        }
        assertGt(need0, 0, "expected at least one WETH-funded leg");
        assertGt(need1, 0, "expected at least one USDC-funded leg");

        bytes memory strategy = options.encodeAquaStrategy(seller, OFFER_SALT);
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (tokens[0], amounts[0]) = (WETH, need0);
        (tokens[1], amounts[1]) = (USDC, need1);

        vm.startPrank(seller);
        IERC20Like(WETH).approve(address(AQUA), type(uint256).max);
        IERC20Like(USDC).approve(address(AQUA), type(uint256).max);
        AQUA.ship(address(options), strategy, tokens, amounts);
        vm.stopPrank();

        uint256 weth0 = IERC20Like(WETH).balanceOf(seller);
        uint256 usdc0 = IERC20Like(USDC).balanceOf(seller);

        // Shipping the quote and nothing more must be enough — and must leave nothing behind.
        OptionsManager.Leg[] memory legs = new OptionsManager.Leg[](3);
        legs[0] = OptionsManager.Leg({strikeIndex: 0, isPut: true, liquidity: 1e15});
        legs[1] = OptionsManager.Leg({strikeIndex: 1, isPut: true, liquidity: 1e15});
        legs[2] = OptionsManager.Leg({strikeIndex: 2, isPut: true, liquidity: 1e15});

        vm.prank(matcher);
        options.sellStrategy(seller, legs, OFFER_SALT);

        assertEq(weth0 - IERC20Like(WETH).balanceOf(seller), need0, "WETH pulled != quoted");
        assertEq(usdc0 - IERC20Like(USDC).balanceOf(seller), need1, "USDC pulled != quoted");
        assertEq(options.aquaBackingOf(seller, OFFER_SALT, Currency.wrap(WETH)), 0, "WETH backing left over");
        assertEq(options.aquaBackingOf(seller, OFFER_SALT, Currency.wrap(USDC)), 0, "USDC backing left over");
    }

    /// @notice The hook invariant holds on mainnet infrastructure too: a normal LP router cannot
    ///         add liquidity to this pool, so every unit of liquidity really is a written option.
    function test_fork_hookStillBlocksOutsideLiquidity() public {
        PoolModifyLiquidityTest lpRouter = new PoolModifyLiquidityTest(POOL_MANAGER);
        (int24 lo, int24 hi) = options.seriesTicks(IDX_SPOT, true);

        vm.startPrank(seller);
        IERC20Like(USDC).approve(address(lpRouter), type(uint256).max);
        IERC20Like(WETH).approve(address(lpRouter), type(uint256).max);
        // v4 wraps a reverting hook call, so assert the whole envelope: our hook, on
        // beforeAddLiquidity, rejecting this exact caller.
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeAddLiquidity.selector,
                abi.encodeWithSelector(OptionsHook.NotOptionsManager.selector, address(lpRouter)),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        lpRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: 1e12, salt: bytes32(0)}), ""
        );
        vm.stopPrank();
    }
}
