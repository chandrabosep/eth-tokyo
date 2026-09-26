"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { maxUint256 } from "viem";
import { Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CardNote } from "@/components/page-header";
import { TokenIcon } from "@/components/token-icon";
import { PayoffChart, type PayoffPoint } from "@/components/payoff-chart";
import { BatchNote, BatchPlan, useAtomicBatch, useBatch, type BatchCall } from "@/components/batch";
import { cn } from "@/lib/utils";

import { aquaAbi, erc20Abi, optionsManagerAbi } from "@/lib/abi";
import { deployed, STRIKE_INDICES, strikeLabel, WETH_DECIMALS } from "@/lib/config";
import { useAquaOffers } from "@/lib/aqua";
import {
  amount0ForLiquidity,
  fmt,
  isLive,
  legPnlAtPrice,
  liquidityForAmount0,
  tickToUsdPrice,
  usdPriceToTick,
} from "@/lib/options";
import { useHookPricing, useSeries, useSpotTick, type SeriesRow } from "@/lib/useMarket";
import type { HlPosition } from "@/lib/hyperliquid";
import { resolveIsPut, type StrategyTemplate } from "@/lib/strategies";

/** A concrete leg: a real strike index on this market, not an offset. */
export type BuiltLeg = {
  strikeIndex: number;
  isPut: boolean;
  side: "sell" | "buy";
  /** Size in underlying units (WETH), matched to the perp it hedges. */
  sizeEth: number;
};

type SizedLeg = { row: SeriesRow; liq: number; isLong: boolean };

/**
 * The move a hedge is judged against: how far the chart reaches either side of spot, and the
 * stress case quoted beside it. A quarter is a bad week for ETH, not a black swan — big enough that
 * a floor visibly holds, small enough that the ladder's kinks stay readable on the same axis.
 */
const HEDGE_MOVE = 0.25;

/** The ladder index nearest to spot — the anchor every template offsets from. */
export function atmIndex(strikeTicks: number[], tick: number): number {
  let best = 0;
  let bestDist = Infinity;
  strikeTicks.forEach((t, i) => {
    const d = Math.abs(t - tick);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/**
 * `spotBelowStrike` decides the live half of the nearest strike — see `resolveIsPut`. Without it a
 * template asking for "the range spot is in" would have to guess, and guess wrong half the time.
 */
export function materialise(
  template: StrategyTemplate,
  atm: number,
  sizeEth: number,
  spotBelowStrike = true,
): BuiltLeg[] {
  return template.legs.map((l) => ({
    strikeIndex: Math.min(Math.max(atm + l.strikeOffset, 0), STRIKE_INDICES.length - 1),
    isPut: resolveIsPut(l, spotBelowStrike),
    side: l.side,
    sizeEth,
  }));
}

export function StrategyBuilder({
  position,
  legs,
  setLegs,
  onClear,
}: {
  position?: HlPosition;
  legs: BuiltLeg[];
  setLegs: (l: BuiltLeg[]) => void;
  onClear: () => void;
}) {
  const { address } = useAccount();
  const { tick } = useSpotTick();
  const { rows } = useSeries();
  const pricing = useHookPricing();
  const spot = tick !== undefined ? tickToUsdPrice(tick) : undefined;

  /** Each leg's liquidity, worked out once — it does not depend on the scenario price. */
  const sized = useMemo(
    () =>
      legs
        .map((leg) => {
          const row = rows.find((r) => r.strikeIndex === leg.strikeIndex && r.isPut === leg.isPut);
          if (!row) return null;
          // Sized by the range's FULL underlying capacity, not its composition right now: an
          // out-of-the-money put holds zero WETH at spot, so sizing off the current amount0 would
          // collapse every protective leg to zero liquidity.
          const liq = liquidityForAmount0(leg.sizeEth * 10 ** WETH_DECIMALS, row.tickLower, row.tickUpper);
          return { row, liq, isLong: leg.side === "buy" };
        })
        .filter(Boolean) as SizedLeg[],
    [legs, rows],
  );

  /**
   * Payoff across prices, not a single greek.
   *
   * Every position here is delta-neutral at inception against the capital posted — a long removed
   * range amounts (a0,a1) and must restore (b0,b1), and at open b == a. Exposure only appears as
   * the range recomposes. So an instantaneous delta reading is close to meaningless for a
   * prospective leg; what a hedger actually needs is "what happens to the combined book if ETH
   * goes here", which is exactly what a broker's builder shows.
   *
   * Premium is excluded: it depends on realised swap volume between now and close. Written legs
   * earn it on top of these numbers, bought legs pay it.
   */
  const valueAt = useMemo(() => {
    if (tick === undefined) return undefined;
    return (price: number): PayoffPoint => {
      const sTick = usdPriceToTick(price);
      const perp = position ? position.szi * (price - position.entryPx) : 0;
      let opts = 0;
      for (const l of sized) {
        opts += legPnlAtPrice(l.liq, l.row.tickLower, l.row.tickUpper, tick, sTick, price, l.isLong);
      }
      return { price, perp, opts, total: perp + opts };
    };
  }, [sized, tick, position]);

  const scenarios = useMemo<PayoffPoint[]>(() => {
    if (!valueAt || spot === undefined) return [];
    const ladder = deployed.strikeUsd ?? [];
    if (ladder.length === 0) return [];

    // Standing alone, sweep a little past both ends of the ladder so the curve's flat wings are
    // visible. Against a perp that undersells the point: the ladder only spans about ±8%, so a
    // floor looked like a short flat stub. Reach far enough that a real crash (or squeeze) is on
    // the chart, and the cover can be seen holding through it.
    const step = ladder.length > 1 ? ladder[1] - ladder[0] : 50;
    let lo = ladder[0] - step;
    let hi = ladder[ladder.length - 1] + step;
    if (position) {
      lo = Math.min(lo, Math.floor((spot * (1 - HEDGE_MOVE)) / step) * step);
      hi = Math.max(hi, Math.ceil((spot * (1 + HEDGE_MOVE)) / step) * step);
    }
    // Dense enough that each strike's ~1.2%-wide range still gets several samples, so the kinks
    // read as kinks rather than corners.
    const SAMPLES = position ? 192 : 96;

    const out: PayoffPoint[] = [];
    for (let i = 0; i < SAMPLES; i++) out.push(valueAt(lo + ((hi - lo) * i) / (SAMPLES - 1)));
    return out;
  }, [valueAt, spot, position]);

  const spotNow = spot;

  /** The ladder strikes, priced exactly rather than read off the nearest sample of the sweep. */
  const ladderRows = useMemo<PayoffPoint[]>(
    () => (valueAt ? (deployed.strikeUsd ?? []).map(valueAt) : []),
    [valueAt],
  );

  /**
   * Is the combined loss capped, and what does a real move against the perp do?
   *
   * Outside every leg's range each payoff is linear in price, so the far tails settle whether there
   * is a cap at all: if the combined line still slopes the wrong way out there, the loss keeps
   * growing with the move and there is no number to quote — and the slope itself is how many ETH
   * are left uncovered. When both tails are flat or favourable, the worst case is the lowest point
   * anywhere: a tail, or somewhere through the ranges, which the sweep covers.
   */
  const risk = useMemo(() => {
    if (!valueAt || !position || spot === undefined || scenarios.length === 0) return undefined;
    const edges = sized.flatMap((l) => [tickToUsdPrice(l.row.tickLower), tickToUsdPrice(l.row.tickUpper)]);
    const lowEdge = Math.min(spot, ...edges);
    const highEdge = Math.max(spot, ...edges);
    const slope = (a: number, b: number) => (valueAt(a).total - valueAt(b).total) / (a - b);

    // In ETH: what is still exposed as price falls below every range, or rises above them.
    const exposedDown = Math.max(slope(lowEdge / 2, lowEdge / 4), 0);
    const exposedUp = Math.max(-slope(highEdge * 4, highEdge * 2), 0);
    const tol = 1e-6 * Math.max(1, Math.abs(position.szi));
    const capped = exposedDown <= tol && exposedUp <= tol;
    const worst = Math.min(
      valueAt(lowEdge / 4).total,
      valueAt(highEdge * 4).total,
      ...scenarios.map((s) => s.total),
      ...ladderRows.map((r) => r.total),
    );

    const long = position.szi > 0;
    const exposed = long ? exposedDown : exposedUp;
    return {
      long,
      capped,
      worst,
      // Quoted for the side the perp loses on. If that side is covered but there is still no cap,
      // a written leg has overshot the perp and the loss runs the other way instead.
      exposed: exposed > tol ? exposed : 0,
      exposedFrom: long ? lowEdge : highEdge,
      stress: valueAt(spot * (long ? 1 - HEDGE_MOVE : 1 + HEDGE_MOVE)),
    };
  }, [valueAt, position, spot, sized, scenarios, ladderRows]);

  /**
   * What the bought legs cost to hold.
   *
   * A long pays `feeGrowthInside` on its liquidity, and one full pass of price through a range
   * generates fee growth worth the pool fee on that range's whole notional — in either direction,
   * since the range's USDC side is its ETH side times the range's geometric mid. So a pass costs
   * roughly `fee × size × mid`, and time spent outside the range costs nothing at all.
   */
  const rent = useMemo(() => {
    const fee = pricing.currentFee / 1e6;
    const bought = sized.filter((l) => l.isLong);
    const passes = bought.map((l) => {
      const lo = tickToUsdPrice(l.row.tickLower);
      const hi = tickToUsdPrice(l.row.tickUpper);
      const eth = amount0ForLiquidity(l.liq, l.row.tickLower, l.row.tickUpper) / 10 ** WETH_DECIMALS;
      return { lo, hi, usd: eth * Math.sqrt(lo * hi) * fee };
    });
    const paying = tick !== undefined && bought.some((l) => isLive(l.row.tickLower, l.row.tickUpper, tick));
    return { fee, passes, paying };
  }, [sized, pricing.currentFee, tick]);

  /** The standalone summary: the extremes of the structure, and the prices that produce them. */
  const outcome = useMemo(() => {
    if (ladderRows.length === 0) return undefined;
    let low = ladderRows[0];
    let high = ladderRows[0];
    for (const r of ladderRows) {
      if (r.total < low.total) low = r;
      if (r.total > high.total) high = r;
    }
    return { worst: low.total, worstAt: low.price, best: high.total, bestAt: high.price };
  }, [ladderRows]);

  /**
   * How much of each bought leg the book can actually fill.
   *
   * A long here is not minted, it is REMOVED from written liquidity — so a buy is a claim on a
   * position someone else already opened, and it is capped by what they wrote. A preset sized to
   * the whole perp will routinely ask for more than exists at a thin strike, and the contract
   * rightly refuses the lot. Surfacing the cap next to the leg is the difference between a builder
   * that quotes a trade and one that quotes a trade you can do.
   *
   * Written legs are unconstrained: writing ADDS liquidity, so there is nothing to run out of.
   */
  /** Which legs are earning right now — premium is `feeGrowthInside`, so only the in-range ones. */
  const live = useMemo(
    () =>
      legs.map((leg) => {
        const row = rows.find((r) => r.strikeIndex === leg.strikeIndex && r.isPut === leg.isPut);
        return row && tick !== undefined ? isLive(row.tickLower, row.tickUpper, tick) : undefined;
      }),
    [legs, rows, tick],
  );

  const depth = useMemo(
    () =>
      legs.map((leg) => {
        if (leg.side !== "buy") return undefined;
        const row = rows.find((r) => r.strikeIndex === leg.strikeIndex && r.isPut === leg.isPut);
        if (!row) return undefined;
        const free = row.shortLiquidity - row.longLiquidity;
        const eth =
          amount0ForLiquidity(Number(free), row.tickLower, row.tickUpper) / 10 ** WETH_DECIMALS;
        return { eth, short: leg.sizeEth > eth };
      }),
    [legs, rows],
  );


  return (
    <Card className="flex flex-col p-0">
      <CardHeader>
        <CardTitle>Strategy builder</CardTitle>
        <CardDescription>
          {position
            ? "Legs execute here. The perp stays on Hyperliquid."
            : "Legs execute here, as one transaction where your wallet allows it."}
        </CardDescription>
      </CardHeader>

      <div className="flex flex-col gap-4 p-5 pt-0">
        {legs.length === 0 ? (
          <CardNote>No legs yet. Pick a structure, or add one below.</CardNote>
        ) : (
          <div className="overflow-hidden rounded-md border-rule border-line">
            {legs.map((leg, i) => (
              <div
                key={`${leg.strikeIndex}-${leg.isPut}-${leg.side}-${i}`}
                className="flex items-center gap-2.5 border-b border-line px-3 py-2.5 last:border-0"
              >
                <Badge variant={leg.side === "sell" ? "call" : "put"}>
                  {leg.side === "sell" ? "Write" : "Buy"}
                </Badge>
                <span className="text-[13px] font-bold tnum">{strikeLabel(leg.strikeIndex)}</span>
                <span className="text-[13px] font-semibold text-ink-soft">{leg.isPut ? "put" : "call"}</span>
                {/* The single most useful fact about a leg on this protocol, and one the ladder
                    below cannot show: premium moves only while spot is inside the range. */}
                {live[i] !== undefined && (
                  <span
                    className={cn(
                      "rounded-pill border-rule px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.08em]",
                      live[i] ? "border-lime-deep bg-lime-wash text-ink" : "border-line bg-paper-2 text-ink-faint",
                    )}
                    title={
                      live[i]
                        ? "Spot is inside this range, so premium is accruing on it now."
                        : "Spot is outside this range. No premium accrues either way until price reaches it."
                    }
                  >
                    {live[i] ? "collecting" : "idle"}
                  </span>
                )}
                <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-xs text-ink-soft tnum">
                  {fmt(leg.sizeEth, 4)} <TokenIcon symbol="ETH" size={13} /> ETH
                </span>
                {depth[i]?.short && (
                  <button
                    className="rounded-pill border-rule border-line bg-destructive/12 px-2 py-0.5 font-mono text-[10.5px] font-bold tnum hover:bg-destructive/20"
                    title="Only this much has been written at this strike. Click to resize the leg."
                    onClick={() =>
                      setLegs(
                        legs.map((l, j) =>
                          j === i ? { ...l, sizeEth: Math.max(depth[i]!.eth * 0.999, 0) } : l,
                        ),
                      )
                    }
                  >
                    max {fmt(depth[i]!.eth, 4)}
                  </button>
                )}
                <button
                  aria-label="Remove leg"
                  className="rounded-pill border-rule border-line bg-card p-1 shadow-xs hover:bg-paper-2"
                  onClick={() => setLegs(legs.filter((_, j) => j !== i))}
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        <AddLeg onAdd={(l) => setLegs([...legs, l])} defaultSize={Math.abs(position?.szi ?? 0) || 1} />

        {/* The answer a hedger came for, before the chart that proves it. */}
        {risk && legs.length > 0 && <HedgeOutcome risk={risk} rent={rent} />}

        {/* The integration's payoff: one curve spanning both venues. */}
        {scenarios.length > 0 && (
          <div className="rounded-md border-rule border-line bg-card p-3 shadow-xs">
            <p className="mb-2 text-[11.5px] leading-relaxed text-ink-soft">
              Position value only — <strong className="font-bold text-ink">premium is not in this curve</strong>
              . A written leg is an LP range, so on its own it can only give value back as price moves through
              it; the fee it collects while spot is inside is the whole of the writer&apos;s return, and it is
              the buyer&apos;s whole cost.
            </p>
            <PayoffChart
              points={scenarios}
              spot={spotNow}
              strikes={deployed.strikeUsd ?? []}
              hasPerp={!!position}
            />
          </div>
        )}

        {ladderRows.length > 0 && (
          <div className="overflow-hidden rounded-md border-rule border-line">
            {/* Without a perp there is no second book to combine with, and a column of zeros
                between the price and the payoff is just something to read past. */}
            <div
              className={cn(
                "grid gap-2 border-b-rule border-line bg-paper-2 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-ink-soft",
                position ? "grid-cols-4" : "grid-cols-2",
              )}
            >
              <span className="inline-flex items-center gap-1.5">
                <TokenIcon symbol="ETH" size={13} /> ETH at
              </span>
              {position && <span className="text-right">Perp</span>}
              {position && <span className="text-right">Options</span>}
              <span className="text-right">{position ? "Combined" : "This structure"}</span>
            </div>
            {ladderRows.map((sc) => {
              const atSpot = spotNow !== undefined && Math.abs(sc.price - spotNow) < 26;
              return (
                <div
                  key={sc.price}
                  className={cn(
                    "grid gap-2 border-b border-line px-3 py-2 font-mono text-xs tnum last:border-0",
                    position ? "grid-cols-4" : "grid-cols-2",
                    atSpot && "bg-flag/35",
                  )}
                >
                  <span className="font-bold">${sc.price.toLocaleString()}</span>
                  {position && <Money v={sc.perp} />}
                  {position && <Money v={sc.opts} />}
                  <Money v={sc.total} strong />
                </div>
              );
            })}
          </div>
        )}

        {legs.length > 0 && !position && outcome && (
          // Standing alone there is nothing to compare against, so the useful summary is the
          // shape of the thing itself: how bad it gets, how good, and where.
          <CardNote tone={outcome.best > 0 ? "lime" : "default"}>
            <strong className="font-extrabold text-ink">Across this ladder:</strong> worst{" "}
            {usd(outcome.worst)} at ${outcome.worstAt.toLocaleString()}, best {usd(outcome.best)} at $
            {outcome.bestAt.toLocaleString()}. Premium sits on top — written legs earn it, bought legs
            pay it.
          </CardNote>
        )}

        {depth.some((d) => d?.short) && (
          <CardNote tone="danger">
            <strong className="font-extrabold text-ink">Not enough written at that strike.</strong> Click the
            cap on a leg to resize it.
          </CardNote>
        )}

        <ExecuteLegs legs={legs} onDone={onClear} />
      </div>
    </Card>
  );
}

/** Currency with the sign outside the symbol: −$540.56, not $-540.56. */
function usd(v: number): string {
  return `${v < 0 ? "\u2212" : ""}$${fmt(Math.abs(v), 2)}`;
}

function Money({ v, strong, muted }: { v: number; strong?: boolean; muted?: boolean }) {
  return (
    <span
      className={cn(
        "text-right",
        strong && "font-extrabold",
        muted ? "text-ink-faint" : v > 0 ? "text-lime-deep" : v < 0 ? "text-peri-deep" : "text-ink-soft",
      )}
    >
      {v > 0 ? "+" : ""}
      {fmt(v, 2)}
    </span>
  );
}

/** Whole dollars, for prices: $2,569, not $2,568.94. */
function usd0(v: number): string {
  return `$${fmt(v, 0)}`;
}

type Risk = {
  long: boolean;
  capped: boolean;
  worst: number;
  exposed: number;
  exposedFrom: number;
  stress: PayoffPoint;
};

type Rent = { fee: number; passes: { lo: number; hi: number; usd: number }[]; paying: boolean };

/**
 * The three things a hedger asks, in the order they ask them: is my loss capped now, what does a
 * bad week look like with and without this, and what does it cost me to hold.
 */
function HedgeOutcome({ risk, rent }: { risk: Risk; rent: Rent }) {
  const move = risk.long ? "falls" : "rallies";
  const helps = risk.stress.total > risk.stress.perp + 0.005;
  const pct = `${(rent.fee * 100).toFixed(2)}%`;

  let rentNote: string;
  if (rent.passes.length === 0) {
    rentNote = "Nothing bought, so nothing to pay. Written legs earn instead.";
  } else if (rent.fee === 0) {
    rentNote = "Reading today's fee…";
  } else if (rent.passes.length === 1) {
    const p = rent.passes[0];
    rentNote = `≈ ${usd(p.usd)} each time ETH trades through ${usd0(p.lo)}–${usd0(p.hi)}, at today's ${pct} fee.`;
  } else {
    const costs = rent.passes.map((p) => p.usd);
    rentNote = `≈ ${usd(Math.min(...costs))}–${usd(Math.max(...costs))} each time ETH trades through a bought range, at today's ${pct} fee.`;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid overflow-hidden rounded-md border-rule border-line bg-card shadow-xs sm:grid-cols-3">
        <Outcome
          label="Max loss"
          value={risk.capped ? (risk.worst < 0 ? usd(risk.worst) : "None") : "No cap"}
          tone={risk.capped ? "pos" : "neg"}
          note={
            risk.capped
              ? `However far ETH ${move}. The perp alone has no cap.`
              : risk.exposed > 0
                ? `${fmt(risk.exposed, 4)} ETH still exposed ${risk.long ? "below" : "above"} ${usd0(risk.exposedFrom)}.`
                : `Loss keeps growing if ETH ${risk.long ? "rallies" : "falls"}.`
          }
          lead
        />
        <Outcome
          label={`If ETH ${move} 25%`}
          value={usd(risk.stress.total)}
          tone={helps ? "pos" : "neg"}
          note={`To ${usd0(risk.stress.price)}. The perp alone: ${usd(risk.stress.perp)}.`}
        />
        <Outcome
          label="Rent right now"
          value={rent.paying ? "Paying" : "$0"}
          tone={rent.paying ? "neg" : "pos"}
          note={rentNote}
        />
      </div>
      {!helps && (
        <CardNote>
          These legs do not protect the perp against a 25% move. Fine for yield, but it is not protection.
        </CardNote>
      )}
    </div>
  );
}

function Outcome({
  label,
  value,
  note,
  tone,
  lead,
}: {
  label: string;
  value: string;
  note: string;
  tone: "pos" | "neg";
  lead?: boolean;
}) {
  return (
    <div
      className={cn(
        "border-b border-line px-3.5 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0",
        lead && tone === "pos" && "bg-lime-wash",
      )}
    >
      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-soft">{label}</div>
      <div
        className={cn(
          "mt-1 text-[20px] font-extrabold leading-none tracking-[-0.02em] tnum",
          tone === "pos" ? "text-lime-deep" : "text-peri-deep",
        )}
      >
        {value}
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-ink-soft">{note}</p>
    </div>
  );
}

function AddLeg({ onAdd, defaultSize }: { onAdd: (l: BuiltLeg) => void; defaultSize: number }) {
  const [strikeIndex, setStrikeIndex] = useState(Math.floor(STRIKE_INDICES.length / 2));
  const [isPut, setIsPut] = useState(true);
  const [side, setSide] = useState<"sell" | "buy">("sell");
  const [size, setSize] = useState(String(Number(defaultSize.toPrecision(4))));

  useEffect(() => {
    setSize(String(Number(defaultSize.toPrecision(4))));
  }, [defaultSize]);

  return (
    <div className="rounded-md border-rule border-line bg-paper-2 p-3.5">
      <Label className="mb-2 block">Add a leg</Label>
      <div className="flex flex-wrap items-end gap-1.5">
        <select
          aria-label="Strike"
          className="h-10 rounded-md border-rule border-line bg-card px-2 text-[13px] font-bold shadow-xs tnum"
          value={strikeIndex}
          onChange={(e) => setStrikeIndex(Number(e.target.value))}
        >
          {STRIKE_INDICES.map((i) => (
            <option key={i} value={i}>
              {strikeLabel(i)}
            </option>
          ))}
        </select>
        <select
          aria-label="Put or call"
          className="h-10 rounded-md border-rule border-line bg-card px-2 text-[13px] font-bold shadow-xs"
          value={isPut ? "put" : "call"}
          onChange={(e) => setIsPut(e.target.value === "put")}
        >
          <option value="put">put</option>
          <option value="call">call</option>
        </select>
        <select
          aria-label="Write or buy"
          className="h-10 rounded-md border-rule border-line bg-card px-2 text-[13px] font-bold shadow-xs"
          value={side}
          onChange={(e) => setSide(e.target.value as "sell" | "buy")}
        >
          <option value="sell">write</option>
          <option value="buy">buy</option>
        </select>
        {/* The size is in ETH and nothing on the row said so — the mark labels the
            field without spending another line on a word. */}
        <div className="relative">
          <Input
            aria-label="Size in ETH"
            className="h-10 w-[104px] pr-8"
            inputMode="decimal"
            value={size}
            onChange={(e) => setSize(e.target.value)}
          />
          <TokenIcon
            symbol="ETH"
            size={15}
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onAdd({ strikeIndex, isPut, side, sizeEth: Number(size) || 0 })}
        >
          <Plus aria-hidden="true" /> Add
        </Button>
      </div>
    </div>
  );
}

/**
 * Execution.
 *
 * Written legs go out as ONE `sellStrategy` call funded from a single Aqua offer — which is the
 * capital-efficiency point: a four-leg structure commits one wallet balance, not four deposits.
 * Bought legs go out as ONE `buyStrategy` call. They still post collateral directly rather than
 * registering Aqua backing, but batching them matters for a different reason: a spread that fills
 * one leg and fails the next leaves the trader holding naked exposure they did not ask for.
 */
function ExecuteLegs({ legs, onDone }: { legs: BuiltLeg[]; onDone: () => void }) {
  const { address, isConnected } = useAccount();
  const { tick } = useSpotTick();
  const { rows } = useSeries();

  const sells = legs.filter((l) => l.side === "sell");
  const buys = legs.filter((l) => l.side === "buy");

  const batch = useBatch();
  const atomic = useAtomicBatch();

  const { data: usdcAllowance } = useReadContract({
    address: deployed.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, deployed.aqua] : undefined,
    query: { enabled: !!address },
  });
  const { data: wethAllowance } = useReadContract({
    address: deployed.weth,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, deployed.aqua] : undefined,
    query: { enabled: !!address },
  });
  // Buyers post collateral straight to the manager, so that is a separate allowance.
  const { data: mgrUsdc } = useReadContract({
    address: deployed.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, deployed.optionsManager] : undefined,
    query: { enabled: !!address },
  });
  const { data: mgrWeth } = useReadContract({
    address: deployed.weth,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, deployed.optionsManager] : undefined,
    query: { enabled: !!address },
  });

  /**
   * Convert each leg's ETH size into the liquidity the contract expects.
   *
   * Sized identically to the payoff curve — if these two ever diverged the chart would be quoting
   * a position the user is not actually about to open.
   */
  const toContractLegs = (group: BuiltLeg[]) => {
    if (tick === undefined) return [];
    return group
      .map((leg) => {
        const row = rows.find((r) => r.strikeIndex === leg.strikeIndex && r.isPut === leg.isPut);
        if (!row) return null;
        const liq = liquidityForAmount0(leg.sizeEth * 10 ** WETH_DECIMALS, row.tickLower, row.tickUpper);
        return liq > 0
          ? { strikeIndex: leg.strikeIndex, isPut: leg.isPut, liquidity: BigInt(Math.floor(liq)) }
          : null;
      })
      .filter(Boolean) as { strikeIndex: number; isPut: boolean; liquidity: bigint }[];
  };

  const sellLegs = useMemo(() => toContractLegs(sells), [sells, rows, tick]);
  const buyLegs = useMemo(() => toContractLegs(buys), [buys, rows, tick]);

  // A long is written liquidity handed over, so every bought leg is capped by the book. The
  // contract enforces this and reverts the whole structure; checking here keeps a doomed buy from
  // reaching the wallet at all.
  const overBuy = useMemo(
    () =>
      buyLegs.filter((l) => {
        const row = rows.find((r) => r.strikeIndex === l.strikeIndex && r.isPut === l.isPut);
        return !row || l.liquidity > row.shortLiquidity - row.longLiquidity;
      }),
    [buyLegs, rows],
  );

  /**
   * What the written legs will actually pull, quoted by the contract and summed.
   *
   * Summed, because every leg of a `sellStrategy` draws on the SAME offer — that is the whole
   * capital-efficiency claim, and it also means a spread needs the TOTAL backed, not the biggest
   * leg. Quoted rather than estimated, because an Aqua strategy is immutable: an offer a wei short
   * cannot be topped up, only abandoned.
   */
  const { data: quotes } = useReadContracts({
    contracts: sellLegs.map(
      (l) =>
        ({
          address: deployed.optionsManager,
          abi: optionsManagerAbi,
          functionName: "collateralFor",
          args: [l.strikeIndex, l.isPut, l.liquidity],
        }) as const,
    ),
    query: { enabled: sellLegs.length > 0 },
  });

  const need = useMemo(() => {
    let weth = 0n;
    let usdc = 0n;
    for (const q of quotes ?? []) {
      const r = q?.result as readonly [bigint, bigint] | undefined;
      if (!r) continue;
      weth += r[0];
      usdc += r[1];
    }
    return { weth, usdc };
  }, [quotes]);

  const { covering, nextFree, refetch: refetchOffers } = useAquaOffers(address, need);

  const { data: strategy } = useReadContract({
    address: deployed.optionsManager,
    abi: optionsManagerAbi,
    functionName: "encodeAquaStrategy",
    args: address && nextFree ? [address, nextFree.salt] : undefined,
    query: { enabled: !!address && !!nextFree },
  });

  const done = batch.isSuccess;
  useEffect(() => {
    if (done) refetchOffers();
  }, [done, refetchOffers]);

  if (legs.length === 0) return null;
  if (!isConnected) return <CardNote>Connect a wallet to execute.</CardNote>;

  // Ship both currencies whenever the structure touches both — one offer, two tokens.
  const shipTokens = ([] as `0x${string}`[]).concat(
    need.weth > 0n ? [deployed.weth] : [],
    need.usdc > 0n ? [deployed.usdc] : [],
  );
  // 10x the structure, so the seller can rebuild it a few times before shipping the next offer.
  const shipAmounts = ([] as bigint[]).concat(
    need.weth > 0n ? [need.weth * 10n] : [],
    need.usdc > 0n ? [need.usdc * 10n] : [],
  );

  /**
   * The entire structure as one list of calls: approvals, the Aqua offer that backs every written
   * leg, the write, and the buy.
   *
   * This is where batching earns its keep. A four-leg collar used to be an approval, a ship, a
   * write and a buy — four trips to the wallet, with the position half-open in between if the user
   * stopped answering. One list means the structure opens whole or not at all.
   */
  const calls: BatchCall[] = [];

  if (sellLegs.length > 0) {
    for (const t of [
      { token: deployed.weth, symbol: "WETH", need: need.weth, allowance: wethAllowance ?? 0n },
      { token: deployed.usdc, symbol: "USDC", need: need.usdc, allowance: usdcAllowance ?? 0n },
    ]) {
      if (t.need > 0n && t.allowance < t.need * 10n) {
        calls.push({
          label: `Approve ${t.symbol} for Aqua`,
          to: t.token,
          abi: erc20Abi,
          functionName: "approve",
          args: [deployed.aqua, maxUint256],
        });
      }
    }
    if (!covering && nextFree && strategy && shipTokens.length > 0) {
      calls.push({
        label: `Back ${sellLegs.length > 1 ? "every written leg" : "the written leg"} with one Aqua offer`,
        to: deployed.aqua,
        abi: aquaAbi,
        functionName: "ship",
        args: [deployed.optionsManager, strategy, shipTokens, shipAmounts],
      });
    }
    const salt = covering?.salt ?? nextFree?.salt;
    if (salt) {
      calls.push({
        label: `Write ${sellLegs.length} leg${sellLegs.length > 1 ? "s" : ""}`,
        to: deployed.optionsManager,
        abi: optionsManagerAbi,
        functionName: "sellStrategy",
        args: [address!, sellLegs, salt],
      });
    }
  }

  if (buyLegs.length > 0 && overBuy.length === 0) {
    for (const t of [
      { token: deployed.usdc, symbol: "USDC", allowance: mgrUsdc ?? 0n },
      { token: deployed.weth, symbol: "WETH", allowance: mgrWeth ?? 0n },
    ]) {
      if (t.allowance === 0n) {
        calls.push({
          label: `Approve ${t.symbol} as collateral`,
          to: t.token,
          abi: erc20Abi,
          functionName: "approve",
          args: [deployed.optionsManager, maxUint256],
        });
      }
    }
    calls.push({
      label: `Buy ${buyLegs.length} leg${buyLegs.length > 1 ? "s" : ""}`,
      to: deployed.optionsManager,
      abi: optionsManagerAbi,
      functionName: "buyStrategy",
      args: [buyLegs],
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <BatchPlan calls={calls} atomic={atomic} batch={batch} />

      <Button
        variant="lime"
        disabled={calls.length === 0 || batch.busy || overBuy.length > 0}
        onClick={() => batch.send(calls)}
      >
        {batch.busy ? "Opening…" : `Open the structure · ${legs.length} leg${legs.length > 1 ? "s" : ""}`}
      </Button>

      {overBuy.length > 0 ? (
        <CardNote tone="danger">
          {overBuy.length === 1 ? "One leg asks" : `${overBuy.length} legs ask`} for more than has been
          written. Resize with the cap on the leg.
        </CardNote>
      ) : (
        <CardNote>
          Written legs draw on a single Aqua offer; bought legs post collateral directly. Nothing leaves
          your wallet until the mint.
        </CardNote>
      )}

      <BatchNote batch={batch} label="Structure" />
      {batch.isSuccess && (
        <Button variant="outline" size="sm" onClick={onDone}>
          Clear builder
        </Button>
      )}
    </div>
  );
}
