// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";

interface IERC20Like {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice One round of trading on the demo fork: walk the price toward a target, then churn.
///
/// @dev A fork is frozen the moment it is made. Left alone the demo shows one price forever, no
///      volatility history worth the name, and — the part that matters — not a single swap, which
///      is the only thing that pays a writer. Premium here IS `feeGrowthInside`, so a book with no
///      flow through it earns exactly nothing no matter how much is written.
///
///      So this runs on a timer and does two things in one pass:
///
///        1. Moves the pool toward `TARGET_TICK`, capped at `MAX_STEP` ticks per run. The cap is
///           not politeness: the hook reads realised volatility from the gap between ticks and the
///           time between observations, so closing a large gap in one swap prints a vertical move
///           and pegs the volatility fee at its ceiling. Walking it over several runs, minutes
///           apart, gives the EWMA a price path a real market could have produced.
///
///        2. Round-trips a small size regardless. Fees are charged on the way in, so a there-and-
///           back pair pays the in-range writers twice and leaves the price where it started —
///           which is what makes accrued premium visible on a quiet day.
///
///      Every swap is an oversized amount with a `sqrtPriceLimit` at a tick boundary: v4 fills to
///      the limit and stops. Fixed sizes cannot work here, because the only liquidity in the pool
///      is whatever happens to be written at the time.
contract Churn is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @dev Ticks per run. At the timer's 90s that is ~0.12% a step, which annualises to roughly
    ///      70% -- the order of magnitude ETH actually trades at, rather than the 288% three
    ///      swaps a run produced. A 2% gap to the real price then closes over about twenty
    ///      minutes, which is the price of a believable tape.
    int24 internal constant MAX_STEP = 12;

    /// @dev Inside this, the price is "there" and the run wanders instead of walking.
    int24 internal constant DEADBAND = 4;

    /// @dev How far a wander goes when there is no gap left to close.
    int24 internal constant DRIFT = 5;

    function run() external {
        string memory raw = vm.readFile("./deployments/base-fork.json");
        IPoolManager poolManager = IPoolManager(vm.parseJsonAddress(raw, ".poolManager"));
        address weth = vm.parseJsonAddress(raw, ".weth");
        address usdc = vm.parseJsonAddress(raw, ".usdc");

        // Seed.s.sol records the router it deployed. No router means nothing has been seeded on
        // this chain yet, and the reset job owns that, not this one.
        address routerAddr = vm.parseJsonAddress(raw, ".swapRouter");
        if (routerAddr == address(0) || routerAddr.code.length == 0) {
            console2.log("no swap router on this chain yet; nothing to churn");
            return;
        }

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(weth),
            currency1: Currency.wrap(usdc),
            fee: uint24(vm.parseJsonUint(raw, ".fee")),
            tickSpacing: int24(vm.parseJsonInt(raw, ".tickSpacing")),
            hooks: IHooks(vm.parseJsonAddress(raw, ".optionsHook"))
        });

        uint256 pk = vm.envUint("CHURN_PK");
        int24 target = int24(int256(vm.envOr("TARGET_TICK", int256(0))));
        uint256 seed = vm.envOr("SEED", uint256(1));

        (, int24 cur,,) = poolManager.getSlot0(key.toId());
        if (target == 0) target = cur;

        int24 gap = target - cur;
        if (gap > MAX_STEP) gap = MAX_STEP;
        if (gap < -MAX_STEP) gap = -MAX_STEP;

        // No gap worth closing: wander instead, so the book still sees flow on a flat tape. The
        // direction comes from the seed, which the caller randomises per run.
        if (gap > -DEADBAND && gap < DEADBAND) {
            gap = seed % 2 == 0 ? -DRIFT : DRIFT;
        }
        int24 step = cur + gap;

        console2.log("tick now / target / stepping to");
        console2.logInt(int256(cur));
        console2.logInt(int256(target));
        console2.logInt(int256(step));

        PoolSwapTest router = PoolSwapTest(routerAddr);

        vm.startBroadcast(pk);
        // Cheap and idempotent: a churn account that has never traded here needs these, and one
        // that has pays a few thousand gas to set an already-max allowance.
        IERC20Like(weth).approve(address(router), type(uint256).max);
        IERC20Like(usdc).approve(address(router), type(uint256).max);

        // The one swap. zeroForOne sells WETH for USDC, which lowers the price and the tick with
        // it, so a negative gap is a sell.
        _swapTo(router, key, gap < 0, gap < 0 ? 40e18 : 120_000e6, step);
        vm.stopBroadcast();

        (, int24 after_,,) = poolManager.getSlot0(key.toId());
        console2.log("tick after");
        console2.logInt(int256(after_));
    }

    /// @dev Swap up to `maxIn`, stopping at `limitTick`. The limit is what keeps the swap inside
    ///      the liquidity that actually exists rather than sweeping the pool to an extreme.
    function _swapTo(PoolSwapTest router, PoolKey memory key, bool zeroForOne, uint256 maxIn, int24 limitTick)
        internal
    {
        if (limitTick <= TickMath.MIN_TICK) limitTick = TickMath.MIN_TICK + 1;
        if (limitTick >= TickMath.MAX_TICK) limitTick = TickMath.MAX_TICK - 1;
        try router.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(maxIn),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(limitTick)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {} catch {
            // A limit already on the wrong side of spot, or a range with nothing left in it.
            // Neither is worth failing a timer run over.
            console2.log("swap skipped");
        }
    }
}
