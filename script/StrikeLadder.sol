// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title StrikeLadder
/// @notice The market's fixed strike ladder, and the dollar → tick conversion behind it.
///
/// @dev Two properties matter, and they pull in opposite directions.
///
///      **Strikes must be constant.** They are round dollar levels fixed at deployment, never
///      derived from live spot. A strike that moves with the price is not a shared reference point,
///      and two deployments would disagree about what "the $2,700 put" means.
///
///      **Strike spacing must scale with the asset.** $50 apart is right for ETH near $2,700 and
///      absurd for BTC near $100,000 — you would need two thousand strikes to cover the same
///      percentage band. Real venues solve this the same way: Deribit lists ETH $50 apart and BTC
///      $1,000+ apart.
///
///      Both are satisfied by deriving the step from a per-market REFERENCE price that is itself a
///      constant. The step is ~2% of reference, snapped to a 1–2–5 series so it lands on a number a
///      human would choose:
///
///        ETH  reference $2,700   -> 2% = $54     -> step $50
///        BTC  reference $100,000 -> 2% = $2,000  -> step $2,000
///
///      Price → tick, for an 18-decimal currency0 and a 6-decimal currency1 (WETH/USDC):
///
///        pool price P = amount1 / amount0 = S * 1e6 / 1e18 = S * 1e-12
///        sqrtPriceX96 = sqrt(P) * 2^96 = sqrt(S * 2^192 / 1e12)
///
///      which TickMath turns into a tick. Declaring the ladder in dollars — the unit humans think
///      in — beats hardcoding opaque tick constants.
library StrikeLadder {
    /// @notice The market's anchor price. Fixed, so the ladder is identical for every user.
    /// @dev ETH was ~$2,668 on Base at the pinned fork block; $2,700 is the round level nearest it.
    uint256 internal constant REFERENCE_USD = 2_700;

    /// @notice Target spacing as a fraction of the reference price, before snapping.
    uint256 internal constant STEP_BPS = 200; // 2%

    /// @notice How many strikes to list. Odd, so the reference sits exactly in the middle.
    uint256 internal constant COUNT = 9;

    /// @notice The spacing actually used, in whole dollars.
    function stepUsd() internal pure returns (uint256) {
        return niceStep((REFERENCE_USD * STEP_BPS) / 10_000);
    }

    /// @notice Dollar strikes, ascending, centred on the reference price.
    function usdStrikes() internal pure returns (uint256[] memory s) {
        uint256 step = stepUsd();
        uint256 mid = COUNT / 2;
        s = new uint256[](COUNT);
        for (uint256 i = 0; i < COUNT; i++) {
            s[i] = i >= mid ? REFERENCE_USD + (i - mid) * step : REFERENCE_USD - (mid - i) * step;
        }
    }

    /// @notice Round `x` to the nearest 1–2–5 step: 10, 20, 50, 100, 200, 500, 1000, …
    /// @dev Plain rounding would give $53 for ETH and $1,971 for BTC. Nobody quotes strikes like
    ///      that; the 1–2–5 series is what exchanges actually use.
    function niceStep(uint256 x) internal pure returns (uint256) {
        if (x < 1) return 1;
        uint256 mag = 1;
        while (mag * 10 <= x) mag *= 10;

        uint256 best = mag;
        uint256 bestDiff = _diff(x, mag);
        uint256[3] memory rest = [2 * mag, 5 * mag, 10 * mag];
        for (uint256 i = 0; i < 3; i++) {
            uint256 d = _diff(x, rest[i]);
            if (d < bestDiff) {
                best = rest[i];
                bestDiff = d;
            }
        }
        return best;
    }

    /// @notice The tick whose price is closest to `usd` dollars, snapped to `tickSpacing`.
    function tickForUsd(uint256 usd, int24 tickSpacing) internal pure returns (int24) {
        return snap(TickMath.getTickAtSqrtPrice(sqrtPriceX96ForUsd(usd)), tickSpacing);
    }

    function sqrtPriceX96ForUsd(uint256 usd) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(usd, 1 << 192, 1e12)));
    }

    /// @dev Round to the nearest multiple of `tickSpacing`, not toward zero — truncation would bias
    ///      every strike in the same direction.
    function snap(int24 tick, int24 tickSpacing) internal pure returns (int24) {
        if (tickSpacing <= 1) return tick;
        int24 down = (tick / tickSpacing) * tickSpacing;
        if (tick < 0 && tick % tickSpacing != 0) down -= tickSpacing;
        int24 up = down + tickSpacing;
        return (tick - down) <= (up - tick) ? down : up;
    }

    function _diff(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : b - a;
    }
}
