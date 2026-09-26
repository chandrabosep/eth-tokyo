import { USDC_DECIMALS, WETH_DECIMALS } from "./config";

/**
 * Uniswap tick maths, in floating point.
 *
 * Exactness is the contract's job — every amount that actually moves is computed on-chain by
 * `modifyLiquidity`. These helpers only size inputs and render estimates.
 */

/** sqrt(price) at a tick, where price is raw token1-per-token0. */
export function sqrtPriceAtTick(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

/** Human-readable USDC per WETH, correcting for the 18 vs 6 decimal difference. */
export function tickToUsdPrice(tick: number): number {
  const raw = Math.pow(1.0001, tick);
  return raw * Math.pow(10, WETH_DECIMALS - USDC_DECIMALS);
}

/** Raw token amounts a liquidity position holds at the current tick. */
export function amountsForLiquidity(
  liquidity: number,
  tickLower: number,
  tickUpper: number,
  currentTick: number,
): { amount0: number; amount1: number } {
  const sl = sqrtPriceAtTick(tickLower);
  const su = sqrtPriceAtTick(tickUpper);

  if (currentTick < tickLower) {
    // Entirely below the range: all token0.
    return { amount0: liquidity * (1 / sl - 1 / su), amount1: 0 };
  }
  if (currentTick >= tickUpper) {
    // Entirely above the range: all token1.
    return { amount0: 0, amount1: liquidity * (su - sl) };
  }
  const sp = sqrtPriceAtTick(currentTick);
  return { amount0: liquidity * (1 / sp - 1 / su), amount1: liquidity * (sp - sl) };
}

/** Liquidity needed to put `amount1Raw` of token1 into a range that sits entirely below spot. */
export function liquidityForAmount1(amount1Raw: number, tickLower: number, tickUpper: number): number {
  const d = sqrtPriceAtTick(tickUpper) - sqrtPriceAtTick(tickLower);
  return d <= 0 ? 0 : amount1Raw / d;
}

/** Liquidity needed to put `amount0Raw` of token0 into a range that sits entirely above spot. */
export function liquidityForAmount0(amount0Raw: number, tickLower: number, tickUpper: number): number {
  const d = 1 / sqrtPriceAtTick(tickLower) - 1 / sqrtPriceAtTick(tickUpper);
  return d <= 0 ? 0 : amount0Raw / d;
}

/**
 * Inverse of `liquidityForAmount0` — the range's full WETH capacity at `liquidity`.
 *
 * Used to turn written liquidity back into a size a trader recognises. A buy is a claim on
 * liquidity someone else already wrote, so "how much of this can I actually buy" is a real limit,
 * and it has to be quoted in the same unit the builder sizes legs in.
 */
export function amount0ForLiquidity(liquidity: number, tickLower: number, tickUpper: number): number {
  return liquidity * (1 / sqrtPriceAtTick(tickLower) - 1 / sqrtPriceAtTick(tickUpper));
}

/**
 * Simplified net delta, in WETH.
 *
 * A concentrated position's WETH exposure at the current price IS its delta in the only sense that
 * matters for a spot hedge: holding W WETH is +W delta. A written (short) option holds that
 * exposure; a bought (long) option has inverted it, so it contributes the negative.
 *
 * HACKATHON SIMPLIFICATION: this is position delta, not a Black-Scholes greek. It ignores gamma,
 * so it is only accurate for an instantaneous hedge — which is exactly what a one-click flatten is.
 */
export function positionDelta(
  liquidity: number,
  tickLower: number,
  tickUpper: number,
  currentTick: number,
  isLong: boolean,
): number {
  const { amount0 } = amountsForLiquidity(liquidity, tickLower, tickUpper, currentTick);
  const eth = amount0 / Math.pow(10, WETH_DECIMALS);
  return isLong ? -eth : eth;
}

export function fmt(value: number, dp = 4): string {
  if (!isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < Math.pow(10, -dp)) return value > 0 ? `<${Math.pow(10, -dp)}` : `>-${Math.pow(10, -dp)}`;
  return value.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fromRaw(raw: bigint, decimals: number): number {
  return Number(raw) / Math.pow(10, decimals);
}

export function toRaw(value: number, decimals: number): bigint {
  return BigInt(Math.floor(value * Math.pow(10, decimals)));
}

import { STRIKE_INDICES } from "./config";

/** Every (strike, put/call) pair the market lists. */
export const SERIES = STRIKE_INDICES.flatMap((strikeIndex) =>
  [true, false].map((isPut) => ({ strikeIndex, isPut })),
);

/**
 * Which token(s) a range actually demands at the current tick, and how much per unit of liquidity.
 *
 * This is the honest way to denominate an option, and it does NOT follow from put-vs-call. A range
 * entirely below spot is pure token1 (USDC); entirely above, pure token0 (WETH); straddling spot,
 * both. An in-the-money put sits ABOVE spot and is therefore funded in WETH, and the at-the-money
 * strike straddles and needs both. Labelling by put/call instead of by range gets these wrong.
 */
export function fundingProfile(tickLower: number, tickUpper: number, currentTick: number) {
  const unit = amountsForLiquidity(1e18, tickLower, tickUpper, currentTick);
  const needsWeth = unit.amount0 > 0;
  const needsUsdc = unit.amount1 > 0;
  return {
    unit,
    needsWeth,
    needsUsdc,
    mixed: needsWeth && needsUsdc,
    /** The token the size box is denominated in: whichever leg the range is dominated by. */
    quoteInWeth: needsWeth && !needsUsdc,
  };
}

/**
 * Liquidity required to post `targetRaw` of one token into a range at the current tick.
 * Inverts `amountsForLiquidity` by scaling from a unit-liquidity probe, so it stays correct in all
 * three regimes (below, inside, above the range) instead of assuming the position is single-sided.
 */
export function liquidityForTargetAmount(
  targetRaw: number,
  tickLower: number,
  tickUpper: number,
  currentTick: number,
  useToken0: boolean,
): number {
  const unit = amountsForLiquidity(1e18, tickLower, tickUpper, currentTick);
  const per = useToken0 ? unit.amount0 : unit.amount1;
  if (per <= 0) return 0;
  return (targetRaw / per) * 1e18;
}

/** Inverse of `tickToUsdPrice` — the tick a given USD price corresponds to. */
export function usdPriceToTick(usd: number): number {
  if (usd <= 0) return 0;
  const raw = usd / Math.pow(10, WETH_DECIMALS - USDC_DECIMALS);
  return Math.round(Math.log(raw) / Math.log(1.0001));
}

/**
 * P&L of one option leg at a hypothetical price, in USD.
 *
 * A long removed range amounts (a0, a1) at open and must restore (b0, b1) to close:
 *
 *   long  P&L(P) = (a0·P + a1) − (b0(P)·P + b1(P))
 *   short P&L(P) = −long                              (zero-sum; see test_H_zeroSum…)
 *
 * Both are zero at inception, because b == a there. That is the honest shape of this mechanism:
 * opening a position is delta-neutral against the capital you posted, and exposure appears only as
 * the range recomposes. Reading a static `amount0` and calling it delta misses the fixed notional
 * leg entirely, which is why this returns a payoff curve rather than a single greek.
 *
 * Premium is excluded — it depends on realised swap volume between now and close, which no
 * scenario table can know. Shorts earn it on top of these numbers; longs pay it.
 */
/**
 * Is this range earning anything right now?
 *
 * Premium here is `feeGrowthInside`, which only accrues while spot is inside the range. There is no
 * theta: a written option two strikes away from spot does not decay in the writer's favour, it
 * simply earns nothing at all until price arrives. The mirror is just as sharp — a long pays
 * premium only while its range is live, so holding a far strike costs nothing to carry.
 *
 * Uniswap's own convention for "in range", so this agrees with the fee accounting to the tick.
 */
export function isLive(tickLower: number, tickUpper: number, tick: number): boolean {
  return tick >= tickLower && tick < tickUpper;
}

export function legPnlAtPrice(
  liquidity: number,
  tickLower: number,
  tickUpper: number,
  openTick: number,
  scenarioTick: number,
  scenarioPrice: number,
  isLong: boolean,
): number {
  const open = amountsForLiquidity(liquidity, tickLower, tickUpper, openTick);
  const now = amountsForLiquidity(liquidity, tickLower, tickUpper, scenarioTick);
  const a0 = open.amount0 / 10 ** WETH_DECIMALS;
  const a1 = open.amount1 / 10 ** USDC_DECIMALS;
  const b0 = now.amount0 / 10 ** WETH_DECIMALS;
  const b1 = now.amount1 / 10 ** USDC_DECIMALS;
  const longPnl = a0 * scenarioPrice + a1 - (b0 * scenarioPrice + b1);
  return isLong ? longPnl : -longPnl;
}
