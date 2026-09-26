"use client";

import { Suspense, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { ExternalLink, Search, TrendingDown, TrendingUp, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { CardNote, PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";

import { deployed, strikeLabel } from "@/lib/config";
import { fmt, tickToUsdPrice } from "@/lib/options";
import { useSpotTick } from "@/lib/useMarket";
import {
  strategiesFor,
  useHyperliquidAccount,
  type HlPosition,
} from "@/lib/hyperliquid";
import {
  atmIndex,
  materialise,
  StrategyBuilder,
  type BuiltLeg,
} from "@/components/strategy-builder";

/** The coin our options market is written on. Other perps are shown but not actionable yet. */
const MARKET_COIN = "ETH";

/** A real account carrying live perps, so an empty wallet can still see the flow. */
const EXAMPLE_ADDRESS = "0x010461c14e146ac35fe42271bdc1134ee31c703a";

export default function StrategiesPage() {
  return (
    <Suspense
      fallback={<div className="mt-8 text-sm text-ink-soft">Loading…</div>}
    >
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
        description="Read your live Hyperliquid perps, then hedge them here."
        stats={[
          {
            label: "HL account value",
            value: data ? `$${fmt(data.accountValue, 2)}` : undefined,
          },
          {
            label: "Open perps",
            tone: "lime",
            value: data ? String(positions.length) : undefined,
            grow: 0.96,
          },
          {
            label: `${MARKET_COIN} perp delta`,
            tone: "peri",
            value: active ? `${fmt(active.delta, 4)}` : "—",
            grow: 0.96,
          },
          {
            label: "Spot",
            tone: "ink",
            accent: true,
            value: spot ? `$${fmt(spot, 2)}` : undefined,
            grow: 1.04,
          },
        ]}
      />

      {/* An address lookup, not a form field: the search affordance and the
          placeholder carry the labelling, so the example shortcut can drop to a
          quiet link instead of matching the input's weight. */}
      <section className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-2.5">
        <Label htmlFor="hl" className="sr-only">
          Hyperliquid address
        </Label>
        <div className="relative min-w-[17rem] flex-1 sm:max-w-[28rem]">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
            aria-hidden="true"
          />
          <Input
            id="hl"
            spellCheck={false}
            autoComplete="off"
            className="h-11 pl-10 pr-10 font-mono text-[13px] font-medium"
            placeholder={connected ?? "Hyperliquid address (0x…)"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          {input && (
            <button
              type="button"
              aria-label="Clear address"
              onClick={() => setInput("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-pill p-1 text-ink-faint transition-colors hover:bg-paper-2 hover:text-ink"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        {/* Lime is the app's action colour in chrome (see the nav's connect
            button) — a ghost link here read as static text, not a control. */}
        <Button variant="lime" size="sm" onClick={() => setInput(EXAMPLE_ADDRESS)}>
          Try an example
        </Button>
        {data && positions.length === 0 && (
          <p className="text-[12.5px] text-ink-soft sm:ml-auto">No open perps on this address</p>
        )}
      </section>

      {error && (
        <div className="mt-4">
          <CardNote tone="danger">
            Hyperliquid: {(error as Error).message}
          </CardNote>
        </div>
      )}

      {isLoading && (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {actionable.length > 0 && (
        <section className="mt-5 grid items-start gap-4 lg:grid-cols-[260px_1fr]">
          {/* Sticky left sidebar — stays visible while the builder scrolls */}
          <div className="flex flex-col gap-3 lg:sticky lg:top-6">
            {active && <PositionSummary p={active} />}
            {active && (
              <PresetSidebar
                p={active}
                atm={atm}
                activeLegs={legs}
                onPick={setLegs}
              />
            )}
          </div>

          <StrategyBuilder
            position={active}
            legs={legs}
            setLegs={setLegs}
            onClear={() => setLegs([])}
          />
        </section>
      )}

      {others.length > 0 && (
        <section className="mt-5">
          <Card className="p-5">
            <CardTitle className="text-base">Other perps on this account</CardTitle>
            <CardDescription className="mt-1">
              Only WETH/USDC is deployed, so these are not tradable yet.
            </CardDescription>
            <div className="mt-3.5 flex flex-wrap gap-2">
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

function PositionSummary({ p }: { p: HlPosition }) {
  const long = p.szi > 0;
  return (
    <Card className="p-0" tone="default">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Badge variant={long ? "call" : "put"}>
            {long ? (
              <TrendingUp className="mr-1 !size-3" aria-hidden="true" />
            ) : (
              <TrendingDown className="mr-1 !size-3" aria-hidden="true" />
            )}
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
        <CardTitle className="mt-1 text-[24px] tnum">
          {p.szi > 0 ? "+" : ""}
          {fmt(p.szi, 4)} {p.coin}
        </CardTitle>
      </CardHeader>
      <div className="grid grid-cols-2 gap-x-4 border-y-rule border-line bg-paper-2 px-4 py-2.5">
        <Fact label="Entry" value={`$${fmt(p.entryPx, 2)}`} />
        <Fact label="Notional" value={`$${fmt(p.positionValue, 2)}`} />
        <Fact
          label="uPnL"
          value={`${p.unrealizedPnl >= 0 ? "+" : ""}$${fmt(p.unrealizedPnl, 2)}`}
          tone={p.unrealizedPnl >= 0 ? "pos" : "neg"}
        />
        <Fact
          label="Liq. price"
          value={p.liquidationPx ? `$${fmt(p.liquidationPx, 2)}` : "—"}
        />
      </div>
    </Card>
  );
}

function PresetSidebar({
  p,
  atm,
  activeLegs,
  onPick,
}: {
  p: HlPosition;
  atm: number;
  activeLegs: BuiltLeg[];
  onPick: (legs: BuiltLeg[]) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const long = p.szi > 0;
  const templates = strategiesFor(p.szi);

  function handlePick(id: string) {
    const t = templates.find((x) => x.id === id)!;
    setSelectedId(id);
    onPick(materialise(t, atm, Math.abs(p.szi)));
  }

  // Clear selection when legs are cleared externally
  if (activeLegs.length === 0 && selectedId !== null) {
    setSelectedId(null);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="px-0.5 text-[11px] uppercase tracking-[0.1em]">
        Structures for a {long ? "long" : "short"} perp
      </Label>
      {templates.map((t) => {
        const isActive = selectedId === t.id && activeLegs.length > 0;
        const legLine = t.legs
          .map(
            (l) =>
              `${l.side === "sell" ? "write" : "buy"} ${strikeLabel(
                Math.min(
                  Math.max(atm + l.strikeOffset, 0),
                  deployed.strikeTicks.length - 1,
                ),
              )} ${l.isPut ? "put" : "call"}`,
          )
          .join(" · ");

        return (
          <div key={t.id} className="group relative">
            <button
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-md border-rule border-line px-3 py-2.5 text-left transition-colors",
                isActive
                  ? "border-lime-deep bg-lime-wash shadow-sm"
                  : "bg-card shadow-xs hover:bg-lime-wash",
              )}
              onClick={() => handlePick(t.id)}
            >
              <span className="text-[13px] font-extrabold">{t.name}</span>
              <Badge
                variant={
                  t.cost === "earns premium"
                    ? "call"
                    : t.cost === "costs premium"
                      ? "put"
                      : "itm"
                }
              >
                {t.cost}
              </Badge>
            </button>

            {/* Hover tooltip — floats to the right of the sidebar */}
            <div
              className={cn(
                "pointer-events-none absolute left-full top-0 z-50 ml-3 w-60 rounded-md border-rule border-line bg-card p-3.5 shadow-lg",
                "opacity-0 invisible transition-all duration-150",
                "group-hover:visible group-hover:opacity-100",
              )}
            >
              <p className="text-[12.5px] leading-relaxed text-ink">
                {t.effect}
              </p>
              <p className="mt-2 font-mono text-[11px] text-ink-soft">
                {legLine}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-soft">
        {label}
      </div>
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
