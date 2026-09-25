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
///      **2. Premium responds to demand** (`beforeSwap`, dynamic LP fee).
///      Premium in this protocol IS the pool's swap fee — a short earns `feeGrowthInside`, a long
///      pays it. With a static fee tier, premium is therefore a pure function of trading volume and
///      carries no signal about demand for optionality itself. That is the single biggest weakness
///      of the naive design: writers earn the same whether their strike is untouched or almost
///      entirely bought out.
///
///      So the hook prices it. As longs buy written liquidity out of the pool, utilisation rises,
///      the remaining writers are carrying more risk across a thinner book, and the hook raises the
///      LP fee accordingly. A higher fee is a higher `feeGrowthInside`, which is a higher premium
///      stream to the writers who stayed. This is the "utilisation spread" from the design doc,
///      implemented where it belongs — in the swap path, not in an off-chain quote.
///
///      The fee is bounded and monotonic: BASE_FEE at zero utilisation, MAX_FEE at full. It cannot
///      be set arbitrarily; it is derived from open interest that OptionsManager pushes on every
///      state change.
///
///      HACKATHON SIMPLIFICATION: utilisation is market-wide rather than per-strike, so a swap
///      through an untouched range pays the same spread as one through a fully-bought range. Making
///      it per-range means resolving the current tick to a series inside `beforeSwap`; the honest
///      version is a tick-bucket lookup, which is a next step rather than a rewrite.
contract OptionsHook is IHooks {
    using LPFeeLibrary for uint24;

    /// @notice Flags encoded in this contract's address. Must match `getHookPermissions()`.
    uint160 public constant REQUIRED_FLAGS =
        uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG);

    /// @notice LP fee with nothing bought out: 0.30%.
    uint24 public constant BASE_FEE = 3000;

    /// @notice LP fee when every written unit has been bought out: 1.00%.
    uint24 public constant MAX_FEE = 10_000;

    uint16 internal constant BPS = 10_000;

    IPoolManager public immutable poolManager;

    /// @notice The only address permitted to modify liquidity, and the only one that may report
    ///         utilisation.
    address public optionsManager;

    /// @notice Share of written liquidity currently bought out by longs, in basis points.
    uint16 public utilisationBps;

    address private immutable _admin;

    error NotPoolManager();
    error NotOptionsManager(address sender);
    error AlreadyInitialized();
    error NotAdmin();
    error UtilisationOutOfRange(uint16 bps);
    error HookNotImplemented();

    event UtilisationUpdated(uint16 utilisationBps, uint24 lpFee);

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

    /// @notice The LP fee a swap would pay right now. Linear in utilisation between the bounds.
    function currentFee() public view returns (uint24) {
        return BASE_FEE + uint24((uint256(MAX_FEE - BASE_FEE) * utilisationBps) / BPS);
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
    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        view
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
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
