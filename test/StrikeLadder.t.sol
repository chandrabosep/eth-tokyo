// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {StrikeLadder} from "../script/StrikeLadder.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";

/// @notice The ladder is the market's shared reference point, so its dollar→tick conversion has to
///         be exact enough that a "$2,700 strike" really is $2,700.
contract StrikeLadderTest is Test {
    /// @dev Inverse of the conversion: tick → dollars per WETH, for 18/6 decimals.
    function _usdAtTick(int24 tick) internal pure returns (uint256 centsPerWeth) {
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        uint256 priceX96 = FullMath.mulDiv(sqrtP, sqrtP, 1 << 96);
        // price is amount1/amount0 in raw units; x 1e12 converts to whole USDC per whole WETH.
        return FullMath.mulDiv(priceX96, 1e12 * 100, 1 << 96);
    }

    function test_ladderIsEvenlySpacedOnANiceStep() public pure {
        uint256[] memory usd = StrikeLadder.usdStrikes();
        uint256 step = StrikeLadder.stepUsd();
        assertEq(usd.length, StrikeLadder.COUNT, "unexpected ladder length");
        assertEq(step, 50, "ETH at ~$2,700 should ladder in $50 steps");
        for (uint256 i = 0; i < usd.length; i++) {
            assertEq(usd[i] % step, 0, "strikes must sit on the step");
            if (i > 0) assertEq(usd[i] - usd[i - 1], step, "strikes must be evenly spaced");
        }
        assertEq(usd[usd.length / 2], StrikeLadder.REFERENCE_USD, "reference must be centred");
    }

    /// @notice The step has to scale with the asset, or a $50 ladder on BTC would need thousands of
    ///         strikes to cover the same percentage band.
    function test_stepScalesWithTheAssetPrice() public pure {
        assertEq(StrikeLadder.niceStep((2_700 * 200) / 10_000), 50, "ETH ~$2,700 -> $50");
        assertEq(StrikeLadder.niceStep((100_000 * 200) / 10_000), 2_000, "BTC ~$100k -> $2,000");
        assertEq(StrikeLadder.niceStep(uint256(1) * 200 / 10_000), 1, "degenerate prices still give a step");
        // 1-2-5 series, never an arbitrary number like 53 or 1971.
        assertEq(StrikeLadder.niceStep(53), 50);
        assertEq(StrikeLadder.niceStep(1_971), 2_000);
        assertEq(StrikeLadder.niceStep(7), 5);
        assertEq(StrikeLadder.niceStep(8), 10);
    }

    function test_eachStrikeTickResolvesBackToItsDollarPrice() public pure {
        uint256[] memory usd = StrikeLadder.usdStrikes();
        for (uint256 i = 0; i < usd.length; i++) {
            int24 tick = StrikeLadder.tickForUsd(usd[i], 1);
            uint256 cents = _usdAtTick(tick);
            uint256 targetCents = usd[i] * 100;
            // Within one cent per dollar of strike (a tick is ~0.01%).
            assertApproxEqAbs(cents, targetCents, usd[i], "tick does not price back to its strike");
        }
    }

    function test_ticksAscendWithPrice() public pure {
        uint256[] memory usd = StrikeLadder.usdStrikes();
        int24 prev = type(int24).min;
        for (uint256 i = 0; i < usd.length; i++) {
            int24 t = StrikeLadder.tickForUsd(usd[i], 1);
            assertGt(t, prev, "ticks must ascend with price");
            prev = t;
        }
    }

    /// @dev The conventional spacing of 60 is what makes "fixed" strikes stop being round.
    function test_snappingToCoarseSpacingIsWhyTickSpacingIsOne() public pure {
        int24 fine = StrikeLadder.tickForUsd(2_700, 1);
        int24 coarse = StrikeLadder.tickForUsd(2_700, 60);
        assertEq(coarse % 60, 0, "coarse tick must be aligned");
        assertApproxEqAbs(_usdAtTick(fine), 270_000, 2_700, "fine spacing should be near-exact");
        // Coarse snapping can move the strike by dollars, not cents.
        assertGt(_absDiff(_usdAtTick(coarse), 270_000), 0, "coarse snapping shifts the price");
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    /// @notice The step is a RULE, not a constant. Change the market's reference price and the
    ///         ladder re-derives itself: cheap assets get fine steps, expensive ones coarse.
    function test_printStepForDifferentAssets() public pure {
        uint256[8] memory refs = [uint256(1), 12, 150, 640, 2_700, 9_500, 45_000, 100_000];
        console2.log("reference price  ->  derived strike step");
        for (uint256 i = 0; i < refs.length; i++) {
            console2.log(
                string.concat(
                    "  $",
                    vm.toString(refs[i]),
                    "  ->  $",
                    vm.toString(StrikeLadder.niceStep((refs[i] * StrikeLadder.STEP_BPS) / 10_000))
                )
            );
        }
    }

    function test_printLadder() public pure {
        uint256[] memory usd = StrikeLadder.usdStrikes();
        console2.log("strike  ->  tick  ->  priced back at (cents)");
        for (uint256 i = 0; i < usd.length; i++) {
            int24 t = StrikeLadder.tickForUsd(usd[i], 1);
            console2.log(usd[i], uint256(int256(-t)), _usdAtTick(t));
        }
    }
}
