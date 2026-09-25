// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

/// @title OptionsHook
/// @notice Keeps this pool to option writers, and nobody else.
///
/// @dev One job for now. `beforeAddLiquidity` / `beforeRemoveLiquidity` reject every sender except
///      OptionsManager, which turns "every unit of liquidity in this pool is a written option" from
///      a convention into an on-chain invariant.
///
///      That invariant is load-bearing rather than tidy. Premium here is `feeGrowthInside` over an
///      option's tick range, so it is only attributable to the writers if nobody else can be an LP.
///      Without the gate a passive LP could park capital at a strike and collect premium earned by
///      the people actually carrying assignment risk.
contract OptionsHook is IHooks {
    /// @notice Flags encoded in this contract's address. Must match `getHookPermissions()`.
    uint160 public constant REQUIRED_FLAGS =
        uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG);

    IPoolManager public immutable poolManager;

    /// @notice The only address permitted to modify liquidity here.
    address public optionsManager;

    address private immutable _admin;

    error NotPoolManager();
    error NotOptionsManager(address sender);
    error AlreadyInitialized();
    error NotAdmin();
    error HookNotImplemented();

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
            beforeSwap: false,
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

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
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
