"use client";

import { Suspense } from "react";
import { useReadContracts } from "wagmi";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CardNote, PageHeader } from "@/components/page-header";
import { TokenIcon } from "@/components/token-icon";
import { TxNote, useTx } from "@/components/tx";
import { cn } from "@/lib/utils";

import { optionsManagerAbi } from "@/lib/abi";
import { deployed, strikeLabel, USDC_DECIMALS, WETH_DECIMALS } from "@/lib/config";
import { amount0ForLiquidity, amountsForLiquidity, fmt, fromRaw, isLive, tickToUsdPrice } from "@/lib/options";
import { useSeries, useSpotTick, type SeriesRow } from "@/lib/useMarket";
import { useViewer } from "@/lib/useViewer";

export default function PositionsPage() {
  return (
    <Suspense fallback={<div className="mt-8 text-sm text-ink-soft">Loading…</div>}>
      <Positions />
    </Suspense>
  );
}

/** The contract's per-owner record: what a short paid in, or what a long took out. */
type OnChainPosition = { amount0: bigint; amount1: bigint };

type Held = {
  row: SeriesRow;
  isLong: boolean;
  size: bigint;
  premium: readonly [bigint, bigint];
  pos?: OnChainPosition;
};

/** Reads per series, in this order. */
const PER_ROW = 6;

function Positions() {
  const { address, readOnly, connected } = useViewer();
  const isConnected = connected || readOnly;
  const { rows } = useSeries();
  const { tick } = useSpotTick();
  const spot = tick !== undefined ? tickToUsdPrice(tick) : undefined;

  const base = { address: deployed.optionsManager, abi: optionsManagerAbi } as const;
  const who = address ?? "0x0";

  const { data } = useReadContracts({
    contracts: rows.flatMap((r) => [
      { ...base, functionName: "balanceOf", args: [who, r.shortId] } as const,
      { ...base, functionName: "balanceOf", args: [who, r.longId] } as const,
      { ...base, functionName: "accruedPremium", args: [who, r.shortId] } as const,
      { ...base, functionName: "accruedPremium", args: [who, r.longId] } as const,
      { ...base, functionName: "getPosition", args: [who, r.shortId] } as const,
      { ...base, functionName: "getPosition", args: [who, r.longId] } as const,
    ]),
    query: { enabled: !!address && rows.length > 0 },
  });

  const positions: Held[] = rows.flatMap((r, i) => {
    const at = (k: number) => data?.[i * PER_ROW + k]?.result;
    const shortBal = (at(0) as bigint) ?? 0n;
    const longBal = (at(1) as bigint) ?? 0n;
    const out: Held[] = [];
    if (shortBal > 0n) {
      out.push({
        row: r,
        isLong: false,
        size: shortBal,
        premium: (at(2) as readonly [bigint, bigint]) ?? [0n, 0n],
        pos: at(4) as OnChainPosition | undefined,
      });
    }
    if (longBal > 0n) {
      out.push({
        row: r,
        isLong: true,
        size: longBal,
        premium: (at(3) as readonly [bigint, bigint]) ?? [0n, 0n],
        pos: at(5) as OnChainPosition | undefined,
      });
    }
    return out;
  });

  // Premium in dollars, split by side: what the shorts have earned and what the longs owe.
  const premiumUsd = (p: Held) =>
    spot === undefined ? 0 : fromRaw(p.premium[0], WETH_DECIMALS) * spot + fromRaw(p.premium[1], USDC_DECIMALS);
  const earned = positions.filter((p) => !p.isLong).reduce((a, p) => a + premiumUsd(p), 0);
  const paid = positions.filter((p) => p.isLong).reduce((a, p) => a + premiumUsd(p), 0);
  // With no wallet there is nothing to total, and nothing to wait for either — the reads are
  // disabled, so `data` never arrives and the tiles would sit on their loading skeletons forever.
  // Zero is both true and the answer the page already gives for open legs.
  const priced = spot !== undefined && (data !== undefined || !address);

  return (
    <>
      <PageHeader
        title="Your positions"
        description="Premium comes from real swap fees. Shorts earn it, longs pay it."
        stats={[
          { label: "Open legs", tone: "lime", value: String(positions.length), grow: 0.96 },
          { label: "Premium earned", value: priced ? `$${fmt(earned, 2)}` : undefined, grow: 0.96 },
          { label: "Rent paid", tone: "peri", value: priced ? `$${fmt(paid, 2)}` : undefined, grow: 0.96 },
          {
            label: "Spot",
            tone: "ink",
            accent: true,
            value: spot !== undefined ? `$${fmt(spot, 2)}` : undefined,
            grow: 1.12,
          },
        ]}
      />

      {readOnly && (
        <div className="mt-5">
          <CardNote>
            Read-only view of <span className="font-mono">{address}</span>. Connect that wallet to trade.
          </CardNote>
        </div>
      )}

      <section className="mt-5">
        <Card className="overflow-hidden p-0">
          {!isConnected ? (
            <Empty>Connect a wallet to see your positions.</Empty>
          ) : positions.length === 0 ? (
            <Empty>No open positions. Write or buy one on the Chain tab.</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-b-rule border-line bg-paper-2">
                  <TableHead>Side</TableHead>
                  <TableHead>Position</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Payoff now</TableHead>
                  <TableHead className="text-right">Premium</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p) => (
                  <PositionRow
                    key={`${p.row.strikeIndex}-${p.row.isPut}-${p.isLong}`}
                    held={p}
                    tick={tick}
                    spot={spot}
                    readOnlyMode={readOnly}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </section>

      {positions.length > 0 && (
        <p className="mt-4 text-[13px] text-ink-soft">
          Premium accrues only while spot sits inside an option&apos;s range. Payoff is what the position is
          worth now against what it opened with, before premium.
        </p>
      )}
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-14 text-center text-sm text-ink-soft">{children}</div>;
}

/** Signed dollars with the sign outside the symbol: −$19.96, +$384.12, $0.00. */
function signedUsd(v: number): string {
  const rounded = Math.abs(v) < 0.005 ? 0 : v;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}$${fmt(Math.abs(rounded), 2)}`;
}

/**
 * What the position does, in the words a trader would use.
 *
 * A put's range sits just below its strike and a call's just above, so a long put covers the ETH
 * below the strike and a short put is a standing bid across that range — which is all a trader
 * needs to know to read the row, without the word "put" doing any of the work.
 */
function plainly(isLong: boolean, isPut: boolean, sizeEth: number, lo: number, hi: number, strike: string) {
  const eth = `${fmt(sizeEth, 4)} ETH`;
  const band = `$${fmt(lo, 0)}–$${fmt(hi, 0)}`;
  if (isLong) return isPut ? `Covers ${eth} below ${strike}` : `Covers ${eth} above ${strike}`;
  return isPut ? `Buys ${eth} across ${band} if ETH falls` : `Sells ${eth} across ${band} if ETH rallies`;
}

function PositionRow({
  held,
  tick,
  spot,
  readOnlyMode,
}: {
  held: Held;
  tick?: number;
  spot?: number;
  readOnlyMode: boolean;
}) {
  const close = useTx();
  const { row, isLong, size, premium, pos } = held;
  const [p0, p1] = premium;

  const liq = Number(size);
  // The range's full ETH capacity — the same unit the strategy builder sizes legs in.
  const sizeEth = amount0ForLiquidity(liq, row.tickLower, row.tickUpper) / 10 ** WETH_DECIMALS;
  const lo = tickToUsdPrice(row.tickLower);
  const hi = tickToUsdPrice(row.tickUpper);
  const notional = sizeEth * Math.sqrt(lo * hi);
  const live = tick !== undefined ? isLive(row.tickLower, row.tickUpper, tick) : undefined;

  /**
   * Payoff at today's price, premium aside — the same formula the builder charts.
   *
   * A long took (a0, a1) out of the pool and owes back what the range holds now; a short paid
   * (a0, a1) in and holds what the range holds now. Both are valued at the current price, so the
   * number is the option's payoff and not the price move on the collateral.
   */
  let payoff: number | undefined;
  if (pos && tick !== undefined && spot !== undefined) {
    const now = amountsForLiquidity(liq, row.tickLower, row.tickUpper, tick);
    const opened = fromRaw(pos.amount0, WETH_DECIMALS) * spot + fromRaw(pos.amount1, USDC_DECIMALS);
    const current = (now.amount0 / 10 ** WETH_DECIMALS) * spot + now.amount1 / 10 ** USDC_DECIMALS;
    payoff = isLong ? opened - current : current - opened;
  }

  const premiumUsd =
    spot !== undefined ? fromRaw(p0, WETH_DECIMALS) * spot + fromRaw(p1, USDC_DECIMALS) : undefined;

  return (
    <>
      <TableRow className="hover:bg-paper-2/70">
        <TableCell>
          <Badge variant={isLong ? "put" : "call"}>{isLong ? "Long" : "Short"}</Badge>
        </TableCell>
        <TableCell className="whitespace-nowrap">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold tnum">
              {strikeLabel(row.strikeIndex)} {row.isPut ? "put" : "call"}
            </span>
            {live !== undefined && (
              <span
                className={cn(
                  "rounded-pill border-rule px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.08em]",
                  live ? "border-lime-deep bg-lime-wash text-ink" : "border-line bg-paper-2 text-ink-faint",
                )}
                title={
                  live
                    ? "Spot is inside this range, so premium is accruing on it now."
                    : "Spot is outside this range. No premium accrues either way until price reaches it."
                }
              >
                {live ? (isLong ? "paying" : "collecting") : "idle"}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[12px] text-ink-soft tnum">
            {plainly(isLong, row.isPut, sizeEth, lo, hi, strikeLabel(row.strikeIndex))}
          </div>
        </TableCell>
        <TableCell className="whitespace-nowrap text-right tnum">
          <div className="flex items-center justify-end gap-1.5 text-[13px] font-bold">
            {fmt(sizeEth, 4)} <TokenIcon symbol="ETH" size={13} />
          </div>
          <div className="text-[11px] text-ink-faint">≈ ${fmt(notional, 0)}</div>
        </TableCell>
        <TableCell
          className={cn(
            "whitespace-nowrap text-right text-[13px] font-bold tnum",
            payoff === undefined || Math.abs(payoff) < 0.005
              ? "text-ink-soft"
              : payoff > 0
                ? "text-lime-deep"
                : "text-peri-deep",
          )}
        >
          {payoff === undefined ? "—" : signedUsd(payoff)}
        </TableCell>
        <TableCell className="whitespace-nowrap text-right tnum">
          <div
            className={cn(
              "text-[13px] font-bold",
              premiumUsd === undefined || premiumUsd < 0.005
                ? "text-ink-soft"
                : isLong
                  ? "text-peri-deep"
                  : "text-lime-deep",
            )}
          >
            {premiumUsd === undefined ? "—" : signedUsd(isLong ? -premiumUsd : premiumUsd)}
          </div>
          <div className="text-[11px] text-ink-faint">
            {fmt(fromRaw(p0, WETH_DECIMALS), 6)} WETH · {fmt(fromRaw(p1, USDC_DECIMALS), 2)} USDC
          </div>
        </TableCell>
        <TableCell className="text-right">
          <Button
            variant="destructive"
            size="sm"
            disabled={close.busy || readOnlyMode}
            onClick={() =>
              close.send({
                address: deployed.optionsManager,
                abi: optionsManagerAbi,
                functionName: isLong ? "closeLong" : "closeShort",
                args: [row.strikeIndex, row.isPut, size],
              })
            }
          >
            {close.busy ? "Closing…" : "Close"}
          </Button>
        </TableCell>
      </TableRow>
      {(close.error || close.hash) && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="pb-4 pt-0">
            <TxNote tx={close} label="Close" />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
