// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {OptionsManager} from "../src/OptionsManager.sol";
import {OptionsHook} from "../src/OptionsHook.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";
import {StrikeLadder} from "./StrikeLadder.sol";

interface IUniswapV3PoolLike {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

/// @notice Deploys Recycled against Base's real Uniswap v4 and 1inch Aqua deployments.
/// @dev Intended to run on an anvil fork of Base:
///        anvil --fork-url https://mainnet.base.org
///        forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
///      Writes deployments/base-fork.json for the frontend to read.
contract Deploy is Script {
    using StateLibrary for IPoolManager;

    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IAqua internal constant AQUA = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// @dev Uniswap v3 WETH/USDC 0.05% on Base. Read only to open our pool at the true market
    ///      price, so the fixed strike ladder brackets something real.
    IUniswapV3PoolLike internal constant V3_REFERENCE =
        IUniswapV3PoolLike(0xd0b53D9277642d899DF5C87A3966A349A798F224);

    /// @dev Foundry routes salted `new` through this CREATE2 proxy when broadcasting, so hook
    ///      addresses must be mined against it rather than against the sender.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev Dynamic, because the hook sets this pool's LP fee per swap from book utilisation.
    ///      A static tier would work too (v4 applies a beforeSwap override regardless), but
    ///      declaring the pool dynamic is the honest signal that the fee is hook-controlled.
    uint24 internal constant FEE = LPFeeLibrary.DYNAMIC_FEE_FLAG;

    /// @dev Tick spacing of 1 so a strike lands within a cent of its round dollar price. At the
    ///      conventional spacing of 60 for this fee tier, snapping would move a $2,700 strike by up
    ///      to ±$8, and a ladder of "fixed" strikes that are not actually round defeats the point.
    int24 internal constant TICK_SPACING = 1;

    /// @dev Half-width of every option's liquidity band, in ticks. ~1.2%, comfortably narrower than
    ///      the $100 gap between strikes, so adjacent series never overlap.
    int24 internal constant STRIKE_WIDTH = 120;

    function run() external {
        address admin = vm.envOr("ADMIN", msg.sender);

        // Open at Base's real WETH/USDC price unless told otherwise.
        int24 spotTick = int24(vm.envOr("SPOT_TICK", int256(0)));
        if (spotTick == 0) {
            (, spotTick,,,,,) = V3_REFERENCE.slot0();
        }

        uint256[] memory strikeUsd = StrikeLadder.usdStrikes();
        int24[] memory strikeTicks = new int24[](strikeUsd.length);
        for (uint256 i = 0; i < strikeUsd.length; i++) {
            strikeTicks[i] = StrikeLadder.tickForUsd(strikeUsd[i], TICK_SPACING);
        }

        vm.startBroadcast();

        uint160 flags = uint160(
            Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
        );
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(OptionsHook).creationCode, abi.encode(POOL_MANAGER, admin));

        OptionsHook hook = new OptionsHook{salt: salt}(POOL_MANAGER, admin);
        require(address(hook) == hookAddr, "hook address mismatch");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(WETH),
            currency1: Currency.wrap(USDC),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        OptionsManager options = new OptionsManager(POOL_MANAGER, AQUA, key, STRIKE_WIDTH, strikeTicks);
        hook.initialize(address(options));

        POOL_MANAGER.initialize(key, TickMath.getSqrtPriceAtTick(spotTick));

        vm.stopBroadcast();

        console2.log("OptionsHook   ", address(hook));
        console2.log("OptionsManager", address(options));
        console2.log("spot tick     ", spotTick);
        console2.log("strike step $ ", StrikeLadder.stepUsd());
        for (uint256 i = 0; i < strikeUsd.length; i++) {
            console2.log(
                string.concat("  $", vm.toString(strikeUsd[i]), " -> tick ", vm.toString(int256(strikeTicks[i])))
            );
        }

        _write(address(hook), address(options), spotTick, strikeTicks, strikeUsd);
    }

    function _write(
        address hook,
        address options,
        int24 spotTick,
        int24[] memory strikeTicks,
        uint256[] memory strikeUsd
    ) internal {
        string memory j = "d";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeAddress(j, "poolManager", address(POOL_MANAGER));
        vm.serializeAddress(j, "aqua", address(AQUA));
        vm.serializeAddress(j, "weth", WETH);
        vm.serializeAddress(j, "usdc", USDC);
        vm.serializeAddress(j, "optionsHook", hook);
        vm.serializeAddress(j, "optionsManager", options);
        vm.serializeUint(j, "fee", FEE);
        vm.serializeInt(j, "tickSpacing", TICK_SPACING);
        vm.serializeInt(j, "strikeWidth", STRIKE_WIDTH);
        vm.serializeInt(j, "spotTick", spotTick);
        vm.serializeUint(j, "strikeUsd", strikeUsd);

        int256[] memory t = new int256[](strikeTicks.length);
        for (uint256 i = 0; i < strikeTicks.length; i++) t[i] = strikeTicks[i];
        string memory out = vm.serializeInt(j, "strikeTicks", t);
        vm.writeJson(out, "./deployments/base-fork.json");
    }
}
