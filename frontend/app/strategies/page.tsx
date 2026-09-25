"use client";

import { Suspense, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { ExternalLink, TrendingDown, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { CardNote, PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";

import { deployed, strikeLabel } from "@/lib/config";
import { fmt, tickToUsdPrice } from "@/lib/options";
import { useSpotTick } from "@/lib/useMarket";
import { strategiesFor, useHyperliquidAccount, type HlPosition } from "@/lib/hyperliquid";
import { atmIndex, materialise, StrategyBuilder, type BuiltLeg } from "@/components/strategy-builder";

/** The coin our options market is written on. Other perps are shown but not actionable yet. */
const MARKET_COIN = "ETH";

export default function StrategiesPage() {
  return (
    <Suspense fallback={<div className="mt-9 text-sm text-ink-soft">Loading…</div>}>
      <Strategies />
    </Suspense>
  );
}

function Strategies() {
  const { address: connected } = useAccount();
  const [input, setInput] = useState("");
  const address = (input.trim() || connected || "") as string;

  const { data, isLoading, error } = useHyperliquidAccount(address);
  const { tick } = useSpotTick();
  const spot = tick !== undefined ? tickToUsdPrice(tick) : undefined;

  const [legs, setLegs] = useState<BuiltLeg[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const positions = data?.positions ?? [];
  const actionable = positions.filter((p) => p.coin === MARKET_COIN);
  const others = positions.filter((p) => p.coin !== MARKET_COIN).slice(0, 6);
  const active = actionable.find((p) => p.coin === selected) ?? actionable[0];

  const atm = useMemo(
    () => (tick !== undefined ? atmIndex(deployed.strikeTicks, tick) : 0),
    [tick],
  );

  return (
    <>
      <PageHeader
        title="Strategies"
        description="Read your live Hyperliquid perps, then act on them here. Hyperliquid is the position source; every structure below executes on this options market."
        stats={[
          { label: "HL account value", value: data ? `$${fmt(data.accountValue, 2)}` : undefined },
          { label: "Open perps", tone: "lime", value: data ? String(positions.length) : undefined },
          { label: `${MARKET_COIN} perp delta`, tone: "peri", value: active ? `${fmt(active.delta, 4)}` : "—" },
          { label: "Spot", tone: "ink", accent: true, value: spot ? `$${fmt(spot, 2)}` : undefined },
        ]}
      />

      <section className="mt-6">
        <Card className="p-5">
          <Label htmlFor="hl">Hyperliquid address</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            <Input
              id="hl"
              className="min-w-[280px] flex-1"
              placeholder={connected ?? "0x…"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <Button
              variant="outline"
              onClick={() => setInput("0x010461c14e146ac35fe42271bdc1134ee31c703a")}
            >
              Use a live example
            </Button>
          </div>
          <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-soft">
            Defaults to your connected wallet. Read-only — we never sign anything on Hyperliquid. If your
            wallet has no perps, the example button loads a real account with live positions so you can see
            the flow.
          </p>
        </Card>
      </section>

      {error && (
        <div className="mt-5">
          <CardNote tone="danger">Hyperliquid: {(error as Error).message}</CardNote>
        </div>
      )}

      {isLoading && (
        <div className="mt-5 space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {data && positions.length === 0 && (
        <div className="mt-5">
          <CardNote>
            No open perps on this address. Paste one that has positions, or hit{" "}
            <strong className="font-extrabold text-ink">Use a live example</strong>.
          </CardNote>
        </div>
      )}

      {actionable.length > 0 && (
        <section className="mt-6 grid gap-5 lg:grid-cols-2">
          <div className="flex flex-col gap-5">
            {actionable.map((p) => (
              <PositionCard
                key={p.coin}
                p={p}
                selected={active?.coin === p.coin}
                onSelect={() => setSelected(p.coin)}
                onPick={(legsForTemplate) => setLegs(legsForTemplate)}
                atm={atm}
              />
            ))}
          </div>

          <StrategyBuilder position={active} legs={legs} setLegs={setLegs} onClear={() => setLegs([])} />
        </section>
      )}

      {others.length > 0 && (
        <section className="mt-6">
          <Card className="p-5">
            <CardTitle className="text-base">Other perps on this account</CardTitle>
            <CardDescription className="mt-1">
              No options market is deployed for these yet — this build ships one market, WETH/USDC. The
              strike ladder and hook are per-market, so adding another is a deployment, not a redesign.
            </CardDescription>
            <div className="mt-4 flex flex-wrap gap-2">
              {others.map((p) => (
                <span
                  key={p.coin}
                  className="rounded-pill border-rule border-line bg-paper-2 px-3 py-1.5 text-xs font-bold tnum"
                >
                  {p.coin} {p.szi > 0 ? "+" : ""}
                  {fmt(p.szi, 3)}
                </span>
              ))}
            </div>
          </Card>
        </section>
      )}
    </>
  );
}

function PositionCard({
  p,
  selected,
  onSelect,
  onPick,
  atm,
}: {
  p: HlPosition;
  selected: boolean;
  onSelect: () => void;
  onPick: (legs: BuiltLeg[]) => void;
  atm: number;
}) {
  const long = p.szi > 0;
  const templates = strategiesFor(p.szi);

  return (
    <Card
      className={cn("p-0 transition-shadow", selected && "shadow-lg")}
      onClick={onSelect}
      tone="default"
    >
      <CardHeader>
        <div className="flex items-center gap-2">
          <Badge variant={long ? "call" : "put"}>
            {long ? <TrendingUp className="mr-1 !size-3" aria-hidden="true" /> : <TrendingDown className="mr-1 !size-3" aria-hidden="true" />}
            {long ? "Long" : "Short"} {p.coin}
          </Badge>
          <Badge variant="secondary">{p.leverage}× cross</Badge>
          <a
            href={`https://app.hyperliquid.xyz/trade/${p.coin}`}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-ink-soft hover:text-ink"
          >
            Hyperliquid <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </div>
        <CardTitle className="mt-1 text-[26px] tnum">
          {p.szi > 0 ? "+" : ""}
          {fmt(p.szi, 4)} {p.coin}
        </CardTitle>
      </CardHeader>

      <div className="grid grid-cols-2 gap-x-4 border-y-rule border-line bg-paper-2 px-5 py-3 sm:grid-cols-4">
        <Fact label="Entry" value={`$${fmt(p.entryPx, 2)}`} />
        <Fact label="Notional" value={`$${fmt(p.positionValue, 2)}`} />
        <Fact
          label="uPnL"
          value={`${p.unrealizedPnl >= 0 ? "+" : ""}$${fmt(p.unrealizedPnl, 2)}`}
          tone={p.unrealizedPnl >= 0 ? "pos" : "neg"}
        />
        <Fact label="Liq. price" value={p.liquidationPx ? `$${fmt(p.liquidationPx, 2)}` : "—"} />
      </div>

      <div className="p-5">
        <Label>Structures for a {long ? "long" : "short"} perp</Label>
        <div className="mt-3 flex flex-col gap-2.5">
          {templates.map((t) => (
            <button
              key={t.id}
              className="group rounded-md border-rule border-line bg-card p-3.5 text-left shadow-xs transition-colors hover:bg-lime-wash"
              onClick={(e) => {
                e.stopPropagation();
                onSelect();
                onPick(materialise(t, atm, Math.abs(p.szi)));
              }}
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-extrabold">{t.name}</span>
                <Badge variant={t.cost === "earns premium" ? "call" : t.cost === "costs premium" ? "put" : "itm"}>
                  {t.cost}
                </Badge>
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">{t.effect}</p>
              <p className="mt-1.5 font-mono text-[11px] text-ink-soft">
                {t.legs
                  .map(
                    (l) =>
                      `${l.side === "sell" ? "write" : "buy"} ${strikeLabel(
                        Math.min(Math.max(atm + l.strikeOffset, 0), deployed.strikeTicks.length - 1),
                      )} ${l.isPut ? "put" : "call"}`,
                  )
                  .join("  ·  ")}
              </p>
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-soft">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-[13px] font-extrabold tnum",
          tone === "pos" && "text-lime-deep",
          tone === "neg" && "text-peri-deep",
        )}
      >
        {value}
      </div>
    </div>
  );
}
