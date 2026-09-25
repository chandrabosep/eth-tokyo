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
import { PayoffChart, type PayoffPoint } from "@/components/payoff-chart";
import { TxNote, useTx } from "@/components/tx";
import { cn } from "@/lib/utils";

import { aquaAbi, erc20Abi, optionsManagerAbi } from "@/lib/abi";
import { deployed, STRIKE_INDICES, strikeLabel, WETH_DECIMALS } from "@/lib/config";
import { useAquaOffers } from "@/lib/aqua";
import { fmt, legPnlAtPrice, liquidityForAmount0, tickToUsdPrice, usdPriceToTick } from "@/lib/options";
import { useSeries, useSpotTick } from "@/lib/useMarket";
import type { HlPosition, StrategyTemplate } from "@/lib/hyperliquid";

/** A concrete leg: a real strike index on this market, not an offset. */
export type BuiltLeg = {
  strikeIndex: number;
  isPut: boolean;
  side: "sell" | "buy";
  /** Size in underlying units (WETH), matched to the perp it hedges. */
  sizeEth: number;
};

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

export function materialise(template: StrategyTemplate, atm: number, sizeEth: number): BuiltLeg[] {
  return template.legs.map((l) => ({
    strikeIndex: Math.min(Math.max(atm + l.strikeOffset, 0), STRIKE_INDICES.length - 1),
    isPut: l.isPut,
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
  const spot = tick !== undefined ? tickToUsdPrice(tick) : undefined;

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
  const scenarios = useMemo<PayoffPoint[]>(() => {
    if (tick === undefined) return [];
    const ladder = deployed.strikeUsd ?? [];
    if (ladder.length === 0) return [];

    // Sweep a little past both ends of the ladder so the curve's flat wings are visible, and
    // sample densely enough that the kinks at each strike read as kinks rather than corners.
    const step = ladder.length > 1 ? ladder[1] - ladder[0] : 50;
    const lo = ladder[0] - step;
    const hi = ladder[ladder.length - 1] + step;
    const SAMPLES = 96;

    // Precompute each leg's liquidity once; it does not depend on the scenario price.
    const sized = legs
      .map((leg) => {
        const row = rows.find((r) => r.strikeIndex === leg.strikeIndex && r.isPut === leg.isPut);
        if (!row) return null;
        // Sized by the range's FULL underlying capacity, not its composition right now: an
        // out-of-the-money put holds zero WETH at spot, so sizing off the current amount0 would
        // collapse every protective leg to zero liquidity.
        const liq = liquidityForAmount0(leg.sizeEth * 10 ** WETH_DECIMALS, row.tickLower, row.tickUpper);
        return { row, liq, isLong: leg.side === "buy" };
      })
      .filter(Boolean) as { row: (typeof rows)[number]; liq: number; isLong: boolean }[];

    const out: PayoffPoint[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const price = lo + ((hi - lo) * i) / (SAMPLES - 1);
      const sTick = usdPriceToTick(price);
      const perp = position ? position.szi * (price - position.entryPx) : 0;
      let opts = 0;
      for (const l of sized) {
        opts += legPnlAtPrice(l.liq, l.row.tickLower, l.row.tickUpper, tick, sTick, price, l.isLong);
      }
      out.push({ price, perp, opts, total: perp + opts });
    }
    return out;
  }, [legs, rows, tick, position]);

  const spotNow = tick !== undefined ? tickToUsdPrice(tick) : undefined;

  /** The sweep sampled back down to just the ladder strikes, for the exact-number table. */
  const ladderRows = useMemo<PayoffPoint[]>(() => {
    const ladder = deployed.strikeUsd ?? [];
    return ladder.map((price) => {
      let best = scenarios[0];
      for (const s of scenarios) {
        if (Math.abs(s.price - price) < Math.abs(best.price - price)) best = s;
      }
      return best ? { ...best, price } : { price, perp: 0, opts: 0, total: 0 };
    });
  }, [scenarios]);

  // Quoted from the ladder rows, not the dense sweep, so the prose matches the table on screen.
  const worstUnhedged = ladderRows.length ? Math.min(...ladderRows.map((r) => r.perp), 0) : 0;
  const worstHedged = ladderRows.length ? Math.min(...ladderRows.map((r) => r.total), 0) : 0;

  return (
    <Card className="flex flex-col p-0">
      <CardHeader>
        <CardTitle>Strategy builder</CardTitle>
        <CardDescription>
          Legs execute on this options market. The perp stays on Hyperliquid — we only read it.
        </CardDescription>
      </CardHeader>

      <div className="flex flex-col gap-4 p-5 pt-0">
        {legs.length === 0 ? (
          <CardNote>
            No legs yet. Pick a preset from a position, or add one below to build your own.
          </CardNote>
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
                <span className="ml-auto font-mono text-xs text-ink-soft tnum">
                  {fmt(leg.sizeEth, 4)} ETH
                </span>
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

        {/* The integration's payoff: one curve spanning both venues. */}
        {scenarios.length > 0 && (
          <div className="rounded-md border-rule border-line bg-card p-3 shadow-xs">
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
            <div className="grid grid-cols-4 gap-2 border-b-rule border-line bg-paper-2 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-ink-soft">
              <span>ETH at</span>
              <span className="text-right">Perp</span>
              <span className="text-right">Options</span>
              <span className="text-right">Combined</span>
            </div>
            {ladderRows.map((sc) => {
              const atSpot = spotNow !== undefined && Math.abs(sc.price - spotNow) < 26;
              return (
                <div
                  key={sc.price}
                  className={cn(
                    "grid grid-cols-4 gap-2 border-b border-line px-3 py-2 font-mono text-xs tnum last:border-0",
                    atSpot && "bg-flag/35",
                  )}
                >
                  <span className="font-bold">${sc.price.toLocaleString()}</span>
                  <Money v={sc.perp} muted={!position} />
                  <Money v={sc.opts} />
                  <Money v={sc.total} strong />
                </div>
              );
            })}
          </div>
        )}

        {legs.length > 0 && position && (
          <CardNote tone={worstHedged > worstUnhedged ? "lime" : "default"}>
            {worstHedged > worstUnhedged ? (
              <>
                <strong className="font-extrabold text-ink">Worst case improves.</strong> Across the ladder the
                perp alone bottoms at ${fmt(worstUnhedged, 2)}; with these legs it bottoms at $
                {fmt(worstHedged, 2)} — about ${fmt(worstHedged - worstUnhedged, 2)} of drawdown removed.
              </>
            ) : (
              <>
                These legs do not improve the worst case across the ladder. That is fine for a yield
                structure, but it is not protection — check it is what you intended.
              </>
            )}
          </CardNote>
        )}

        <ExecuteLegs legs={legs} onDone={onClear} />
      </div>
    </Card>
  );
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
      <div className="flex flex-wrap items-end gap-2">
        <select
          aria-label="Strike"
          className="h-10 rounded-md border-rule border-line bg-card px-2.5 text-[13px] font-bold shadow-xs tnum"
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
          className="h-10 rounded-md border-rule border-line bg-card px-2.5 text-[13px] font-bold shadow-xs"
          value={isPut ? "put" : "call"}
          onChange={(e) => setIsPut(e.target.value === "put")}
        >
          <option value="put">put</option>
          <option value="call">call</option>
        </select>
        <select
          aria-label="Write or buy"
          className="h-10 rounded-md border-rule border-line bg-card px-2.5 text-[13px] font-bold shadow-xs"
          value={side}
          onChange={(e) => setSide(e.target.value as "sell" | "buy")}
        >
          <option value="sell">write</option>
          <option value="buy">buy</option>
        </select>
        <Input
          aria-label="Size in ETH"
          className="h-10 w-[104px]"
          inputMode="decimal"
          value={size}
          onChange={(e) => setSize(e.target.value)}
        />
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

  const approveUsdc = useTx();
  const approveManager = useTx();
  const ship = useTx();
  const write = useTx();
  const buy = useTx();

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

  const shipped = ship.isSuccess;
  const wrote = write.isSuccess;
  useEffect(() => {
    if (shipped || wrote) refetchOffers();
  }, [shipped, wrote, refetchOffers]);

  if (legs.length === 0) return null;
  if (!isConnected) return <CardNote>Connect a wallet to execute this structure.</CardNote>;

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

  const needsApproval =
    need.weth > 0n && (wethAllowance ?? 0n) < need.weth * 10n
      ? { token: deployed.weth, symbol: "WETH" }
      : need.usdc > 0n && (usdcAllowance ?? 0n) < need.usdc * 10n
        ? { token: deployed.usdc, symbol: "USDC" }
        : undefined;
  const needsManagerApproval =
    (mgrUsdc ?? 0n) === 0n ? deployed.usdc : (mgrWeth ?? 0n) === 0n ? deployed.weth : undefined;
  const hasBacking = !!covering;

  return (
    <div className="flex flex-col gap-3">
      {sells.length > 0 && (
        <>
          {needsApproval ? (
            <Button
              disabled={approveUsdc.busy}
              onClick={() =>
                approveUsdc.send({
                  address: needsApproval.token,
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [deployed.aqua, maxUint256],
                })
              }
            >
              {approveUsdc.busy ? "Approving…" : `Approve Aqua to draw ${needsApproval.symbol}`}
            </Button>
          ) : !hasBacking ? (
            <Button
              disabled={!strategy || ship.busy || shipTokens.length === 0}
              onClick={() =>
                ship.send({
                  address: deployed.aqua,
                  abi: aquaAbi,
                  functionName: "ship",
                  args: [deployed.optionsManager, strategy!, shipTokens, shipAmounts],
                })
              }
            >
              {ship.busy
                ? "Shipping…"
                : `Back the structure with one Aqua offer${shipTokens.length > 1 ? " (both tokens)" : ""}`}
            </Button>
          ) : (
            <Button
              variant="lime"
              disabled={sellLegs.length === 0 || write.busy}
              onClick={() =>
                write.send({
                  address: deployed.optionsManager,
                  abi: optionsManagerAbi,
                  functionName: "sellStrategy",
                  args: [address!, sellLegs, covering!.salt],
                })
              }
            >
              {write.busy
                ? "Writing…"
                : `Write ${sellLegs.length} leg${sellLegs.length > 1 ? "s" : ""} from one offer`}
            </Button>
          )}
        </>
      )}

      {buys.length > 0 && (
        <>
          {needsManagerApproval ? (
            <Button
              variant="outline"
              disabled={approveManager.busy}
              onClick={() =>
                approveManager.send({
                  address: needsManagerApproval,
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [deployed.optionsManager, maxUint256],
                })
              }
            >
              {approveManager.busy ? "Approving…" : "Approve collateral for bought legs"}
            </Button>
          ) : (
            <Button
              variant="peri"
              disabled={buyLegs.length === 0 || buy.busy}
              onClick={() =>
                buy.send({
                  address: deployed.optionsManager,
                  abi: optionsManagerAbi,
                  functionName: "buyStrategy",
                  args: [buyLegs],
                })
              }
            >
              {buy.busy ? "Buying…" : `Buy ${buyLegs.length} leg${buyLegs.length > 1 ? "s" : ""} in one transaction`}
            </Button>
          )}
          <CardNote>
            Bought legs post collateral directly rather than registering Aqua backing — but they still land
            together: any leg that cannot fill reverts the whole structure, so a half-built spread is not a
            reachable state.
          </CardNote>
        </>
      )}

      <TxNote tx={approveUsdc} label="Aqua approval" />
      <TxNote tx={approveManager} label="Collateral approval" />
      <TxNote tx={ship} label="Ship" />
      <TxNote tx={write} label="Structure" />
      <TxNote tx={buy} label="Buy" />
      {(write.isSuccess || buy.isSuccess) && (
        <Button variant="outline" size="sm" onClick={onDone}>
          Clear builder
        </Button>
      )}
    </div>
  );
}
