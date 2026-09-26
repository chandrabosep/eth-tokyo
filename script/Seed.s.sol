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

import {OptionsManager} from "../src/OptionsManager.sol";
import {IAqua} from "../src/interfaces/IAqua.sol";

interface IERC20Like {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Puts demo state on the fork so the demo does not start from an empty book.
///
/// @dev Writes the WHOLE ladder — every strike, puts and calls — from ONE Aqua offer in ONE
///      `sellStrategy` call. That is not decoration: a long in this protocol is written liquidity
///      handed over, so a strike nobody has written cannot be bought, and a strategy preset sized
///      to a real perp will ask for far more than a single seeded series holds. A one-series book
///      makes every preset on the strategies page fail, which is exactly what it did.
///
///      Seeding it this way also happens to be the pitch, executed: one wallet balance, never
///      deposited anywhere, backing eighteen written options across two currencies.
///
///      Run after Deploy.s.sol.
contract Seed is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    bytes32 internal constant OFFER_SALT = bytes32(uint256(0xA01A));

    /// @dev Per series. Sized so a preset built against a few-ETH perp fills comfortably: this is
    ///      roughly 7 ETH of range capacity, against presets that ask for 3–5.
    uint128 internal constant LADDER_LIQUIDITY = 6e16;

    /// @dev Headroom over the quoted total, so the offer is not spent to the wei by the seed.
    ///      Kept at 2 deliberately: Aqua lets you register more than you hold, and an offer the
    ///      wallet cannot actually cover is a demo that fails at the pull instead of the ship.
    ///      2x the ladder fits inside what demo/setup.sh funds the seller with.
    uint256 internal constant SHIP_MULTIPLIER = 2;

    /// @dev The ladder is fixed, so which strike is at-the-money depends on where spot happens to
    ///      be. Seed whichever one currently brackets the price rather than assuming an index.
    function _atmIndex(OptionsManager options, int24 spotTick) internal view returns (uint8 best) {
        int24[] memory strikes = options.getStrikes();
        int256 bestDist = type(int256).max;
        for (uint256 i = 0; i < strikes.length; i++) {
            int256 d = int256(strikes[i]) - int256(spotTick);
            if (d < 0) d = -d;
            if (d < bestDist) {
                bestDist = d;
                best = uint8(i);
            }
        }
    }

    function run() external {
        string memory raw = vm.readFile("./deployments/base-fork.json");
        OptionsManager options = OptionsManager(vm.parseJsonAddress(raw, ".optionsManager"));
        IPoolManager poolManager = IPoolManager(vm.parseJsonAddress(raw, ".poolManager"));
        IAqua aqua = IAqua(vm.parseJsonAddress(raw, ".aqua"));
        address usdc = vm.parseJsonAddress(raw, ".usdc");
        address weth = vm.parseJsonAddress(raw, ".weth");

        uint256 sellerPk =
            vm.envOr("SELLER_PK", uint256(0xaab17b89d7376948ee5710c0a73b05f449c86946b1bc6da38c89e0803997992f));
        uint256 buyerPk =
            vm.envOr("BUYER_PK", uint256(0x14ab088b7dcb56ff0099d87d5eb505efa89faad5d92be065a89817cf983b8152));
        uint256 swapperPk =
            vm.envOr("SWAPPER_PK", uint256(0xf9cd7ddb26085e7fc4e8037ca83cb802580aaec388206fda702e618790f3579c));

        address seller = vm.addr(sellerPk);
        address buyer = vm.addr(buyerPk);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(weth),
            currency1: Currency.wrap(usdc),
            fee: uint24(vm.parseJsonUint(raw, ".fee")),
            tickSpacing: int24(vm.parseJsonInt(raw, ".tickSpacing")),
            hooks: IHooks(vm.parseJsonAddress(raw, ".optionsHook"))
        });

        (, int24 spotTick,,) = poolManager.getSlot0(key.toId());
        uint8 idx = _atmIndex(options, spotTick);
        console2.log(string.concat("seeding the at-the-money strike, index ", vm.toString(uint256(idx))));

        // ---- 1. Price the whole ladder, then ship ONE offer that covers it. ----
        //
        // Quoted from the contract rather than guessed: ranges above spot want WETH, ranges below
        // want USDC, the straddling one wants both, and an Aqua offer is immutable — ship it short
        // and the only remedy is to abandon it and ship another.
        OptionsManager.Leg[] memory ladder = _ladder(options);
        uint256 needWeth;
        uint256 needUsdc;
        for (uint256 i = 0; i < ladder.length; i++) {
            (uint256 a0, uint256 a1) = options.collateralFor(ladder[i].strikeIndex, ladder[i].isPut, ladder[i].liquidity);
            needWeth += a0;
            needUsdc += a1;
        }
        console2.log("ladder needs WETH (wei)", needWeth);
        console2.log("ladder needs USDC (6dp)", needUsdc);

        vm.startBroadcast(sellerPk);
        IERC20Like(usdc).approve(address(aqua), type(uint256).max);
        IERC20Like(weth).approve(address(aqua), type(uint256).max);
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (tokens[0], amounts[0]) = (weth, needWeth * SHIP_MULTIPLIER);
        (tokens[1], amounts[1]) = (usdc, needUsdc * SHIP_MULTIPLIER);
        aqua.ship(address(options), options.encodeAquaStrategy(seller, OFFER_SALT), tokens, amounts);
        vm.stopBroadcast();
        console2.log("shipped one two-currency Aqua offer for seller", seller);

        // ---- 2. One call writes every series on the ladder, all from that offer. ----
        vm.startBroadcast(swapperPk);
        options.sellStrategy(seller, ladder, OFFER_SALT);
        vm.stopBroadcast();
        console2.log("wrote the full ladder, series:", ladder.length);

        // ---- 3. Buyer takes open interest across the whole ladder. ----
        //
        // Not one spread, for the same reason the write covers everything: a chain with a single
        // bought series looks like a test fixture, and the utilisation spread — half of what the
        // fee bar on the chain page is explaining — only has something to say once longs actually
        // hold a share of the book.
        //
        // Sizes are small and uneven on purpose. Uniform buys across eighteen series read as
        // generated; a book that is heavier near the money and thinner in the wings reads as a
        // market. Every leg stays well under what was written, since a long can only take what
        // someone else already wrote.
        OptionsManager.Leg[] memory bought = _demand(options, idx);

        vm.startBroadcast(buyerPk);
        IERC20Like(usdc).approve(address(options), type(uint256).max);
        IERC20Like(weth).approve(address(options), type(uint256).max);
        options.buyStrategy(bought);
        vm.stopBroadcast();
        console2.log("bought across the ladder for buyer", buyer);
        console2.log("bought series:", bought.length);

        // ---- 4. Churn the pool so premium is already visibly accruing. ----
        //
        // The only liquidity in this pool is the written option, sitting in a 120-tick range. That
        // range can absorb roughly 0.19 WETH before it is exhausted, so a fixed swap size would
        // blow straight through it and pin the price at MIN_TICK. Instead each swap is given an
        // oversized amount plus a sqrtPriceLimit at a tick boundary: v4 fills until it reaches the
        // limit and stops. That sweeps the range for fees without ever draining it, whatever
        // liquidity happens to be written.
        (int24 lo, int24 hi) = options.seriesTicks(idx, true);

        vm.startBroadcast(swapperPk);
        PoolSwapTest router = new PoolSwapTest(poolManager);
        IERC20Like(weth).approve(address(router), type(uint256).max);
        IERC20Like(usdc).approve(address(router), type(uint256).max);

        _swapTo(router, key, true, 5e18, lo); // sweep down to the bottom of the range
        _swapTo(router, key, false, 20_000e6, hi); // sweep back up to the strike
        _swapTo(router, key, true, 5e18, lo + 60); // park mid-range: live delta, live premium
        vm.stopBroadcast();

        // ---- 5. Give the pool a plausible price HISTORY, not just a price. ----
        //
        // The hook measures realised volatility from the gaps between ticks and the time between
        // them, and a forge script's transactions land in consecutive blocks seconds apart. Those
        // three sweeps above therefore read as a market moving several percent every two seconds —
        // about 190% annualised, which pegs the volatility fee at its ceiling before anyone has
        // traded. That is a true reading of a fake price path, which makes it a misleading demo.
        //
        // So walk the price back and forth at a human cadence and let the EWMA settle. What the
        // demo then shows is a market with a history, priced accordingly.
        vm.startBroadcast(swapperPk);
        for (uint256 i = 0; i < 14; i++) {
            _wait(600);
            _swapTo(router, key, i % 2 == 0, i % 2 == 0 ? 0.05e18 : 130e6, i % 2 == 0 ? lo : hi);
        }
        vm.stopBroadcast();
        console2.log("swapRouter", address(router));
        console2.log("seeded: premium is now accruing from real swap fees");

        vm.writeJson(vm.toString(address(router)), "./deployments/base-fork.json", ".swapRouter");
    }

    /// @dev Open interest on the long side, shaped like demand: heaviest at the money, thinning
    ///      out towards the wings, and never more than a fraction of what was written there.
    function _demand(OptionsManager options, uint8 atm)
        internal
        view
        returns (OptionsManager.Leg[] memory legs)
    {
        uint256 n = options.strikeCount();
        legs = new OptionsManager.Leg[](n * 2);
        for (uint256 i = 0; i < n; i++) {
            uint256 distance = i > atm ? i - atm : atm - i;
            // 1/8th of the written series at the money, halving with every strike out, floored so
            // the far wings still show a bid rather than an empty cell.
            uint128 size = uint128(LADDER_LIQUIDITY / (8 * (1 << (distance > 3 ? 3 : distance))));
            uint128 floor_ = LADDER_LIQUIDITY / 64;
            if (size < floor_) size = floor_;
            // Puts carry a little more than calls below the money and the reverse above it, which
            // is what a book that has been hedging a spot position actually looks like.
            legs[i * 2] = OptionsManager.Leg({
                strikeIndex: uint8(i),
                isPut: true,
                liquidity: i <= atm ? size : size / 2
            });
            legs[i * 2 + 1] = OptionsManager.Leg({
                strikeIndex: uint8(i),
                isPut: false,
                liquidity: i >= atm ? size : size / 2
            });
        }
    }

    /// @dev Every series on the ladder — both sides of every strike — as one structure.
    function _ladder(OptionsManager options) internal view returns (OptionsManager.Leg[] memory legs) {
        uint256 n = options.strikeCount();
        legs = new OptionsManager.Leg[](n * 2);
        for (uint256 i = 0; i < n; i++) {
            legs[i * 2] = OptionsManager.Leg({strikeIndex: uint8(i), isPut: true, liquidity: LADDER_LIQUIDITY});
            legs[i * 2 + 1] = OptionsManager.Leg({strikeIndex: uint8(i), isPut: false, liquidity: LADDER_LIQUIDITY});
        }
    }

    /// @dev Advance the node's clock. The hook's volatility estimator divides by elapsed time, so
    ///      a demo where every trade happens in the same second is a demo of a market in freefall.
    function _wait(uint256 secs) internal {
        vm.rpc("evm_increaseTime", string.concat("[", vm.toString(secs), "]"));
        vm.rpc("evm_mine", "[]");
    }

    /// @dev Swap up to `maxIn`, stopping at `limitTick`. The limit is what keeps the swap inside the
    ///      written range instead of exhausting it.
    function _swapTo(PoolSwapTest router, PoolKey memory key, bool zeroForOne, uint256 maxIn, int24 limitTick)
        internal
    {
        router.swap(
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
}
