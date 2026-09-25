"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useReadContracts, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";
import type { Address, Hex } from "viem";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CardNote, PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";

import { optionsManagerAbi } from "@/lib/abi";
import { deployed, strikeLabel, USDC_DECIMALS, WETH_DECIMALS } from "@/lib/config";
import { fmt, positionDelta, tickToUsdPrice } from "@/lib/options";
import { useSeries, useSpotTick } from "@/lib/useMarket";
import { useViewer } from "@/lib/useViewer";

type Leg = { label: string; delta: number };

export default function HedgePage() {
  return (
    <Suspense fallback={<div className="mt-9 text-sm text-ink-soft">Loading…</div>}>
      <Hedge />
    </Suspense>
  );
}

function Hedge() {
  const { address, readOnly, connected } = useViewer();
  const isConnected = connected || readOnly;
  const { rows } = useSeries();
  const { tick } = useSpotTick();

  const base = { address: deployed.optionsManager, abi: optionsManagerAbi } as const;

  const { data } = useReadContracts({
    contracts: rows.flatMap((r) => [
      { ...base, functionName: "balanceOf", args: [address ?? "0x0", r.shortId] } as const,
      { ...base, functionName: "balanceOf", args: [address ?? "0x0", r.longId] } as const,
    ]),
    query: { enabled: !!address && rows.length > 0 },
  });

  const { legs, netDelta } = useMemo(() => {
    if (tick === undefined) return { legs: [] as Leg[], netDelta: 0 };
    const out: Leg[] = [];
    rows.forEach((r, i) => {
      const shortBal = (data?.[i * 2]?.result as bigint) ?? 0n;
      const longBal = (data?.[i * 2 + 1]?.result as bigint) ?? 0n;
      const name = `${strikeLabel(r.strikeIndex)} ${r.isPut ? "put" : "call"}`;
      if (shortBal > 0n) {
        out.push({ label: `Short ${name}`, delta: positionDelta(Number(shortBal), r.tickLower, r.tickUpper, tick, false) });
      }
      if (longBal > 0n) {
        out.push({ label: `Long ${name}`, delta: positionDelta(Number(longBal), r.tickLower, r.tickUpper, tick, true) });
      }
    });
    return { legs: out, netDelta: out.reduce((a, l) => a + l.delta, 0) };
  }, [rows, data, tick]);

  const spot = tick !== undefined ? tickToUsdPrice(tick) : undefined;

  return (
    <>
      <PageHeader
        title="Delta & hedge"
        description="Net WETH exposure across your open options, computed from on-chain reads and flattened with a single 1inch-routed spot swap."
        stats={[
          {
            label: "Net delta",
            tone: netDelta >= 0 ? "lime" : "peri",
            value: `${netDelta >= 0 ? "+" : ""}${fmt(netDelta, 5)}`,
          },
          { label: "Notional", value: spot ? `$${fmt(Math.abs(netDelta) * spot, 2)}` : undefined },
          { label: "Open legs", value: String(legs.length) },
          { label: "Spot", tone: "ink", accent: true, value: spot ? `$${fmt(spot, 2)}` : undefined },
        ]}
      />

      <section className="mt-7 grid gap-5 lg:grid-cols-2">
        <Card className="flex flex-col overflow-hidden p-0">
          <CardHeader>
            <CardTitle>Exposure breakdown</CardTitle>
            <CardDescription>A written option holds the exposure; a bought one has inverted it.</CardDescription>
          </CardHeader>

          {!isConnected ? (
            <Empty>Connect a wallet.</Empty>
          ) : legs.length === 0 ? (
            <Empty>No open positions, so no delta to hedge.</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-y-rule border-line bg-paper-2">
                  <TableHead>Leg</TableHead>
                  <TableHead className="text-right">Delta (WETH)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {legs.map((l) => (
                  <TableRow key={l.label} className="hover:bg-paper-2/70">
                    <TableCell className="text-sm font-semibold">{l.label}</TableCell>
                    <TableCell className="text-right text-[13px] font-bold tnum">
                      {l.delta >= 0 ? "+" : ""}
                      {fmt(l.delta, 5)}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-rule border-line bg-paper-2 hover:bg-paper-2">
                  <TableCell className="text-sm font-extrabold">Net</TableCell>
                  <TableCell className="text-right text-[15px] font-extrabold tnum">
                    {netDelta >= 0 ? "+" : ""}
                    {fmt(netDelta, 5)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          )}

          <div className="mt-auto p-5 pt-5">
            <CardNote tone="flag">
              <strong className="font-extrabold text-ink">Simplification, stated plainly.</strong> This is position
              delta at the current price, not a Black–Scholes greek — it ignores gamma, so it is a snapshot hedge.
              The full design&apos;s Hyperliquid perps hedge vault is roadmap, not built.
            </CardNote>
          </div>
        </Card>

        <HedgePanel netDelta={netDelta} account={readOnly ? undefined : address} spotPrice={spot} />
      </section>
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-14 text-center text-sm text-ink-soft">{children}</div>;
}

type QuoteState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "quote"; dstAmount: string }
  | { kind: "ready"; dstAmount: string; tx: { to: Address; data: Hex; value: string } };

function HedgePanel({
  netDelta,
  account,
  spotPrice,
}: {
  netDelta: number;
  account?: Address;
  spotPrice?: number;
}) {
  const [state, setState] = useState<QuoteState>({ kind: "idle" });
  const { sendTransaction, data: hash, isPending, error: sendError } = useSendTransaction();
  const { isLoading: mining, isSuccess } = useWaitForTransactionReceipt({ hash });

  const sellingWeth = netDelta > 0;
  const size = Math.abs(netDelta);

  useEffect(() => {
    setState({ kind: "idle" });
  }, [netDelta]);

  async function fetchRoute(mode: "quote" | "swap") {
    if (size <= 0) return;
    setState({ kind: "loading" });

    const src = sellingWeth ? deployed.weth : deployed.usdc;
    const dst = sellingWeth ? deployed.usdc : deployed.weth;
    // Sized in the SOURCE token. Buying WETH means spending roughly
    // `size x spot` USDC, so the delta is converted at the pool price first.
    if (!sellingWeth && !spotPrice) return setState({ kind: "error", message: "waiting for spot price" });
    const amount = sellingWeth
      ? BigInt(Math.floor(size * 10 ** WETH_DECIMALS)).toString()
      : BigInt(Math.floor(size * spotPrice! * 10 ** USDC_DECIMALS)).toString();

    const qs = new URLSearchParams({ mode, src, dst, amount });
    if (mode === "swap" && account) {
      qs.set("from", account);
      qs.set("slippage", "1");
    }

    try {
      const res = await fetch(`/api/oneinch?${qs}`);
      const body = await res.json();
      if (body.unavailable) return setState({ kind: "unavailable", reason: body.reason });
      if (body.error) return setState({ kind: "error", message: body.error });
      if (mode === "quote") return setState({ kind: "quote", dstAmount: body.dstAmount ?? "?" });
      setState({
        kind: "ready",
        dstAmount: body.dstAmount ?? "?",
        tx: { to: body.tx.to, data: body.tx.data, value: body.tx.value ?? "0" },
      });
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    }
  }

  const srcSym = sellingWeth ? "WETH" : "USDC";
  const dstSym = sellingWeth ? "USDC" : "WETH";

  return (
    <Card className="flex flex-col p-0">
      <CardHeader>
        <CardTitle>One-click flatten</CardTitle>
        <CardDescription>Routed through the 1inch Aggregation API (Classic Swap v6.1) on Base.</CardDescription>
      </CardHeader>

      <div className="flex flex-col gap-4 p-5 pt-0">
        <div className="rounded-md border-rule border-line bg-card px-4 py-1 shadow-xs">
          <Row label="Action" value={size === 0 ? "Already flat" : `${sellingWeth ? "Sell" : "Buy"} ${fmt(size, 5)} WETH`} />
          <Row
            label="Route"
            value={
              <span className="flex items-center gap-1.5">
                {srcSym} <ArrowRight className="size-3" aria-hidden="true" /> {dstSym}
              </span>
            }
          />
        </div>

        <div className="flex flex-wrap gap-2.5">
          <Button
            variant="outline"
            className="flex-1"
            disabled={size === 0 || state.kind === "loading"}
            onClick={() => fetchRoute("quote")}
          >
            {state.kind === "loading" ? "Fetching…" : "Get quote"}
          </Button>
          <Button
            variant="lime"
            className="flex-1"
            disabled={size === 0 || !account || state.kind === "loading"}
            onClick={() => fetchRoute("swap")}
          >
            Build hedge tx
          </Button>
        </div>

        {state.kind === "unavailable" && (
          <CardNote tone="flag">
            <strong className="font-extrabold text-ink">1inch key not configured.</strong> {state.reason}
          </CardNote>
        )}
        {state.kind === "error" && <CardNote tone="danger">{state.message}</CardNote>}
        {(state.kind === "quote" || state.kind === "ready") && (
          <CardNote>
            1inch quotes <strong className="font-mono font-bold text-ink">{state.dstAmount}</strong> {dstSym} (raw
            units) for this hedge.
          </CardNote>
        )}

        {state.kind === "ready" && (
          <Button
            className="w-full"
            disabled={isPending || mining}
            onClick={() => sendTransaction({ to: state.tx.to, data: state.tx.data, value: BigInt(state.tx.value) })}
          >
            {isPending || mining ? "Sending…" : "Sign & send hedge"}
          </Button>
        )}

        {sendError && <CardNote tone="danger">{(sendError as Error).message.split("\n")[0]}</CardNote>}
        {isSuccess && hash && (
          <CardNote tone="lime">
            Hedge confirmed · <span className="font-mono">{hash.slice(0, 18)}…</span>
          </CardNote>
        )}

        <div className="mt-auto">
          <CardNote>
            <strong className="font-extrabold text-ink">Note for the fork.</strong> 1inch returns calldata for Base
            mainnet. It executes against the real 1inch router, which exists on the fork — but routing was computed
            against live mainnet state, so a stale fork block can make a route revert.
          </CardNote>
        </div>
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-0">
      <span className="shrink-0 text-xs text-ink-soft">{label}</span>
      <span className={cn("truncate text-right text-[13px] font-bold tnum")}>{value}</span>
    </div>
  );
}
