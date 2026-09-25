"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { STRIKE_INDICES, strikeLabel, USDC_DECIMALS, WETH_DECIMALS } from "@/lib/config";
import { amountsForLiquidity, tickToUsdPrice } from "@/lib/options";
import { useSeries, useSpotTick, type SeriesRow } from "@/lib/useMarket";
import { PositionSheet, type Side } from "@/components/position-sheet";

type ChainRow = {
  strikeIndex: number;
  label: string;
  strikePrice: number;
  call: SeriesRow;
  put: SeriesRow;
  /** Calls are in the money below spot; puts above it. */
  callItm: boolean;
  putItm: boolean;
};

/** Open interest in USD, so the call and put columns compare directly. */
function notionalUsd(liquidity: bigint, row: SeriesRow, tick: number, spot: number): number {
  if (liquidity === 0n) return 0;
  const { amount0, amount1 } = amountsForLiquidity(Number(liquidity), row.tickLower, row.tickUpper, tick);
  return (amount0 / 10 ** WETH_DECIMALS) * spot + amount1 / 10 ** USDC_DECIMALS;
}

export function OptionChain() {
  const { rows, isLoading } = useSeries();
  const { tick } = useSpotTick();
  const [sheet, setSheet] = useState<{ side: Side; strikeIndex: number } | null>(null);

  const spot = tick !== undefined ? tickToUsdPrice(tick) : undefined;

  const chain: ChainRow[] = useMemo(() => {
    if (tick === undefined) return [];
    const spotPrice = tickToUsdPrice(tick);
    return STRIKE_INDICES.map((i) => {
      const call = rows.find((r) => r.strikeIndex === i && !r.isPut);
      const put = rows.find((r) => r.strikeIndex === i && r.isPut);
      if (!call || !put) return null;
      // A put's strike is the top of its range, a call's the bottom. Same number.
      const strikePrice = tickToUsdPrice(put.tickUpper);
      return {
        strikeIndex: i,
        label: strikeLabel(i),
        strikePrice,
        call,
        put,
        callItm: strikePrice < spotPrice,
        putItm: strikePrice > spotPrice,
      };
    }).filter(Boolean) as ChainRow[];
  }, [rows, tick]);

  if (isLoading || tick === undefined || spot === undefined) {
    return (
      <Card className="p-5">
        <Skeleton className="h-9 w-full" />
        <div className="mt-3 space-y-2">
          {STRIKE_INDICES.map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            {/* Calls own the left half, puts the right, the strike is the spine. */}
            <TableRow className="border-b-heavy border-line-2">
              <TableHead
                colSpan={3}
                className="bg-lime text-center text-[11px] font-extrabold tracking-[0.18em] text-ink"
              >
                Calls
              </TableHead>
              <TableHead className="border-x-rule border-line-2 bg-ink text-center text-[11px] font-extrabold tracking-[0.18em] text-paper">
                Strike
              </TableHead>
              <TableHead
                colSpan={3}
                className="bg-peri text-center text-[11px] font-extrabold tracking-[0.18em] text-ink"
              >
                Puts
              </TableHead>
            </TableRow>
            <TableRow className="border-b-rule border-line">
              <TableHead className="w-[108px] text-center">Actions</TableHead>
              <TableHead className="text-right">Bought</TableHead>
              <TableHead className="text-right">Written</TableHead>
              <TableHead className="w-[128px] border-x-rule border-line bg-paper-2 text-center">Price</TableHead>
              <TableHead className="text-left">Written</TableHead>
              <TableHead className="text-left">Bought</TableHead>
              <TableHead className="w-[108px] text-center">Actions</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {chain.map((r, idx) => {
              const prev = chain[idx - 1];
              // Drop a spot marker into the ladder wherever the live price sits.
              const spotAbove = prev && prev.strikePrice < spot && r.strikePrice >= spot;
              return (
                <Fragment key={r.strikeIndex}>
                  {spotAbove && <SpotMarker spot={spot} tick={tick} />}
                  <TableRow className="group hover:bg-paper-2/70">
                    <TableCell className={cn("text-center", r.callItm && "bg-lime-wash")}>
                      <Button
                        variant="call"
                        size="xs"
                        className="w-full"
                        onClick={() => setSheet({ side: "call", strikeIndex: r.strikeIndex })}
                      >
                        Trade <ChevronRight className="!size-3" aria-hidden="true" />
                      </Button>
                    </TableCell>
                    <OiCell
                      value={notionalUsd(r.call.longLiquidity, r.call, tick, spot)}
                      align="right"
                      itm={r.callItm}
                      tone="call"
                    />
                    <OiCell
                      value={notionalUsd(r.call.shortLiquidity, r.call, tick, spot)}
                      align="right"
                      itm={r.callItm}
                      tone="call"
                      strong
                    />

                    <TableCell className="border-x-rule border-line bg-paper-2 text-center">
                      <span className="font-display text-[17px] font-extrabold tracking-tight tnum">{r.label}</span>
                    </TableCell>

                    <OiCell
                      value={notionalUsd(r.put.shortLiquidity, r.put, tick, spot)}
                      align="left"
                      itm={r.putItm}
                      tone="put"
                      strong
                    />
                    <OiCell
                      value={notionalUsd(r.put.longLiquidity, r.put, tick, spot)}
                      align="left"
                      itm={r.putItm}
                      tone="put"
                    />
                    <TableCell className={cn("text-center", r.putItm && "bg-peri-wash")}>
                      <Button
                        variant="put"
                        size="xs"
                        className="w-full"
                        onClick={() => setSheet({ side: "put", strikeIndex: r.strikeIndex })}
                      >
                        <ChevronLeft className="!size-3" aria-hidden="true" /> Trade
                      </Button>
                    </TableCell>
                  </TableRow>
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-ink-soft">
        Open interest is shown as USD notional so calls and puts compare directly. Tinted cells are in the money.
        Every unit of this pool&apos;s liquidity is a written option — the v4 hook enforces it.
      </p>

      <PositionSheet
        open={sheet !== null}
        side={sheet?.side ?? "put"}
        strikeIndex={sheet?.strikeIndex ?? 0}
        onOpenChange={(o) => !o && setSheet(null)}
      />
    </>
  );
}

function OiCell({
  value,
  align,
  itm,
  tone,
  strong,
}: {
  value: number;
  align: "left" | "right";
  itm: boolean;
  tone: "call" | "put";
  strong?: boolean;
}) {
  return (
    <TableCell
      className={cn(
        "text-[13px] tnum",
        align === "right" ? "text-right" : "text-left",
        itm && (tone === "call" ? "bg-lime-wash" : "bg-peri-wash"),
        value === 0 ? "text-ink-soft" : strong ? "font-extrabold text-ink" : "font-semibold text-ink-soft",
      )}
    >
      {value === 0 ? "–" : `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
    </TableCell>
  );
}

/**
 * The live-price marker.
 *
 * Amber, not ink: this band was the darkest thing on the page and pulled the
 * eye away from the ladder it is supposed to annotate. It is also the one row
 * that belongs to neither side, so it must not borrow lime (calls) or
 * periwinkle (puts) — either would read as taking a side.
 */
function SpotMarker({ spot, tick }: { spot: number; tick: number }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={7} className="border-y-rule border-flag-deep bg-flag px-3 py-2">
        <div className="flex items-center gap-3">
          <div className="h-[2px] flex-1 rounded-pill bg-flag-deep/45" />
          <span className="whitespace-nowrap font-display text-[12.5px] font-extrabold tracking-[0.08em] text-ink tnum">
            SPOT ${spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            <span className="ml-2 font-mono text-[11px] font-normal tracking-normal text-ink/85">tick {tick}</span>
          </span>
          <div className="h-[2px] flex-1 rounded-pill bg-flag-deep/45" />
        </div>
      </TableCell>
    </TableRow>
  );
}
