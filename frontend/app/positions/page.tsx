"use client";

import { Suspense } from "react";
import { useReadContracts } from "wagmi";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CardNote, PageHeader } from "@/components/page-header";
import { TxNote, useTx } from "@/components/tx";

import { optionsManagerAbi } from "@/lib/abi";
import { deployed, strikeLabel, USDC_DECIMALS, WETH_DECIMALS } from "@/lib/config";
import { fmt, fromRaw, tickToUsdPrice } from "@/lib/options";
import { useSeries, useSpotTick } from "@/lib/useMarket";
import { useViewer } from "@/lib/useViewer";

export default function PositionsPage() {
  return (
    <Suspense fallback={<div className="mt-9 text-sm text-ink-soft">Loading…</div>}>
      <Positions />
    </Suspense>
  );
}

function Positions() {
  const { address, readOnly, connected } = useViewer();
  const isConnected = connected || readOnly;
  const { rows } = useSeries();
  const { tick } = useSpotTick();

  const base = { address: deployed.optionsManager, abi: optionsManagerAbi } as const;

  const { data } = useReadContracts({
    contracts: rows.flatMap((r) => [
      { ...base, functionName: "balanceOf", args: [address ?? "0x0", r.shortId] } as const,
      { ...base, functionName: "balanceOf", args: [address ?? "0x0", r.longId] } as const,
      { ...base, functionName: "accruedPremium", args: [address ?? "0x0", r.shortId] } as const,
      { ...base, functionName: "accruedPremium", args: [address ?? "0x0", r.longId] } as const,
    ]),
    query: { enabled: !!address && rows.length > 0 },
  });

  const positions = rows.flatMap((r, i) => {
    const shortBal = (data?.[i * 4]?.result as bigint) ?? 0n;
    const longBal = (data?.[i * 4 + 1]?.result as bigint) ?? 0n;
    const shortPrem = (data?.[i * 4 + 2]?.result as readonly [bigint, bigint]) ?? [0n, 0n];
    const longPrem = (data?.[i * 4 + 3]?.result as readonly [bigint, bigint]) ?? [0n, 0n];
    const out = [];
    if (shortBal > 0n) out.push({ row: r, isLong: false, size: shortBal, premium: shortPrem });
    if (longBal > 0n) out.push({ row: r, isLong: true, size: longBal, premium: longPrem });
    return out;
  });

  const openCount = positions.length;
  const shorts = positions.filter((p) => !p.isLong).length;

  return (
    <>
      <PageHeader
        title="Your positions"
        description="Premium is read live from the pool's own feeGrowthInside — real fees paid by real swappers, not a pricing model. A short earns it; a long pays it."
        stats={[
          { label: "Open legs", tone: "lime", value: String(openCount), grow: 0.96 },
          { label: "Short", value: String(shorts), grow: 0.96 },
          { label: "Long", tone: "peri", value: String(openCount - shorts), grow: 0.96 },
          {
            label: "Spot",
            tone: "ink",
            accent: true,
            value: tick !== undefined ? `$${fmt(tickToUsdPrice(tick), 2)}` : undefined,
            grow: 1.12,
          },
        ]}
      />

      {readOnly && (
        <div className="mt-6">
          <CardNote>
            Read-only view of <span className="font-mono">{address}</span>. Connect that wallet to act on these
            positions.
          </CardNote>
        </div>
      )}

      <section className="mt-6">
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
                  <TableHead>Series</TableHead>
                  <TableHead>Strike</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Accrued premium</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p) => (
                  <PositionRow
                    key={`${p.row.strikeIndex}-${p.row.isPut}-${p.isLong}`}
                    strikeIndex={p.row.strikeIndex}
                    isPut={p.row.isPut}
                    isLong={p.isLong}
                    size={p.size}
                    premium={p.premium}
                    readOnlyMode={readOnly}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </section>

      {tick !== undefined && (
        <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-ink-soft">
          Spot is <strong className="font-bold text-ink">${fmt(tickToUsdPrice(tick), 2)}</strong> (tick {tick}).
          Premium only accrues while price is inside an option&apos;s range — an untouched strike earns nothing,
          exactly as it should.
        </p>
      )}
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-14 text-center text-sm text-ink-soft">{children}</div>;
}

function PositionRow({
  strikeIndex,
  isPut,
  isLong,
  size,
  premium,
  readOnlyMode,
}: {
  strikeIndex: number;
  isPut: boolean;
  isLong: boolean;
  size: bigint;
  premium: readonly [bigint, bigint];
  readOnlyMode: boolean;
}) {
  const close = useTx();
  const [p0, p1] = premium;
  const sign = isLong ? "−" : "+";

  return (
    <>
      <TableRow className="hover:bg-paper-2/70">
        <TableCell>
          <Badge variant={isLong ? "put" : "call"}>{isLong ? "Long" : "Short"}</Badge>
        </TableCell>
        <TableCell className="whitespace-nowrap text-sm font-semibold">
          {strikeLabel(strikeIndex)} {isPut ? "put" : "call"}
        </TableCell>
        <TableCell className="whitespace-nowrap text-[13px] font-bold tnum">{strikeLabel(strikeIndex)}</TableCell>
        <TableCell className="text-right font-mono text-xs text-ink-soft tnum">{size.toString()}</TableCell>
        <TableCell className="whitespace-nowrap text-right text-[13px] font-bold leading-snug tnum">
          <div>
            {sign}
            {fmt(fromRaw(p0, WETH_DECIMALS), 6)} <span className="text-ink-soft">WETH</span>
          </div>
          <div>
            {sign}
            {fmt(fromRaw(p1, USDC_DECIMALS), 4)} <span className="text-ink-soft">USDC</span>
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
                args: [strikeIndex, isPut, size],
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
