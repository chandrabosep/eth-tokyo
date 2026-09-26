"use client";

import { Suspense, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { ExternalLink, Search, TrendingDown, TrendingUp, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { SegmentedItem, SegmentedList, SegmentedRoot } from "@/components/ui/toggle-group";
import { CardNote, PageHeader, type StatSpec } from "@/components/page-header";
import { TokenIcon, TokenPair } from "@/components/token-icon";
import { cn } from "@/lib/utils";

import { deployed, strikeLabel } from "@/lib/config";
import { fmt, tickToUsdPrice } from "@/lib/options";
import { useHookPricing, useSeries, useSpotTick } from "@/lib/useMarket";
import { useHyperliquidAccount, type HlPosition } from "@/lib/hyperliquid";
import {
  MARKET_VIEWS,
  strategiesFor,
  strategiesForView,
  type MarketView,
  type StrategyTemplate,
} from "@/lib/strategies";
import { atmIndex, materialise, StrategyBuilder, type BuiltLeg } from "@/components/strategy-builder";

/** The coin our options market is written on. Other perps are shown but not actionable yet. */
const MARKET_COIN = "ETH";

/** A real account carrying live perps, so an empty wallet can still see the flow. */
const EXAMPLE_ADDRESS = "0x010461c14e146ac35fe42271bdc1134ee31c703a";

/**
 * Two ways in, because there are two people here.
 *
 * "View" needs nothing but an opinion about where ETH goes next, which is the ordinary case and so
 * the one the page opens on. "Hedge" reads a live Hyperliquid perp and builds around it — the
 * original reason this page existed, now one tab rather than the whole of it.
 */
type Mode = "view" | "hedge";

export default function StrategiesPage() {
  return (
    <Suspense fallback={<div className="mt-8 text-sm text-ink-soft">Loading…</div>}>
      <Strategies />
    </Suspense>
  );
}

function Strategies() {
  const { address: connected } = useAccount();
  const [mode, setMode] = useState<Mode>("view");
  const [view, setView] = useState<MarketView>("bullish");
  const [size, setSize] = useState("1");
  const [input, setInput] = useState("");
  const address = (input.trim() || connected || "") as string;

  const { data, isLoading, error } = useHyperliquidAccount(address);
  const { tick } = useSpotTick();
  const { rows } = useSeries();
  const pricing = useHookPricing();
  const spot = tick !== undefined ? tickToUsdPrice(tick) : undefined;

  const [legs, setLegs] = useState<BuiltLeg[]>([]);

  const positions = data?.positions ?? [];
  const actionable = positions.filter((p) => p.coin === MARKET_COIN);
  const others = positions.filter((p) => p.coin !== MARKET_COIN).slice(0, 6);
  const active = actionable[0];

  const atm = useMemo(() => (tick !== undefined ? atmIndex(deployed.strikeTicks, tick) : 0), [tick]);

  const written = rows.reduce((a, r) => a + r.shortLiquidity, 0n);
  const bought = rows.reduce((a, r) => a + r.longLiquidity, 0n);
  const utilisation = written > 0n ? (Number(bought) / Number(written)) * 100 : 0;

  /**
   * The header answers whatever question the current mode is asking.
   *
   * Standing on a view, that is the market's own numbers — realised volatility is the single most
   * useful input to "should I be buying this premium or selling it", and the fee IS the premium
   * here. Hedging, it is the perp being hedged.
   */
  const stats: StatSpec[] =
    mode === "view"
      ? [
          {
            label: "Spot",
            tone: "ink",
            accent: true,
            value: spot ? `$${fmt(spot, 2)}` : undefined,
            grow: 1.1,
          },
          {
            label: "Realised vol",
            tone: "lime",
            value: `${(pricing.realisedVolBps / 100).toFixed(1)}%`,
            grow: 0.96,
          },
          {
            label: "Premium now",
            tone: "peri",
            value: `${(pricing.currentFee / 10_000).toFixed(2)}%`,
            grow: 0.96,
          },
          { label: "Book lent out", value: `${utilisation.toFixed(0)}%`, grow: 0.96 },
        ]
      : [
          { label: "HL account value", value: data ? `$${fmt(data.accountValue, 2)}` : undefined },
          {
            label: "Open perps",
            tone: "lime",
            value: data ? String(positions.length) : undefined,
            grow: 0.96,
          },
          {
            label: `${MARKET_COIN} perp delta`,
            token: MARKET_COIN,
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
        ];

  return (
    <>
      <PageHeader
        title="Strategies"
        description={
          mode === "view"
            ? "Pick a view on the market and the structures that express it. No perp needed."
            : "Read your live Hyperliquid perps, then hedge them here."
        }
        stats={stats}
      />

      <section className="mt-5">
        <SegmentedRoot
          value={mode}
          onValueChange={(v) => {
            if (!v) return;
            setMode(v as Mode);
            setLegs([]);
          }}
        >
          <SegmentedList>
            <SegmentedItem value="view">Take a view</SegmentedItem>
            <SegmentedItem value="hedge">
              Hedge a perp
              {actionable.length > 0 && (
                <span className="ml-2 rounded-pill bg-lime px-1.5 py-px text-[10px] font-extrabold text-ink">
                  {actionable.length}
                </span>
              )}
            </SegmentedItem>
          </SegmentedList>
        </SegmentedRoot>
      </section>

      {mode === "view" ? (
        <ViewMode
          view={view}
          setView={setView}
          size={size}
          setSize={setSize}
          atm={atm}
          legs={legs}
          setLegs={setLegs}
        />
      ) : (
        <HedgeMode
          input={input}
          setInput={setInput}
          connected={connected}
          data={data}
          isLoading={isLoading}
          error={error as Error | null}
          active={active}
          others={others}
          positions={positions}
          atm={atm}
          legs={legs}
          setLegs={setLegs}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Standalone: a view, a size, and the structures that fit
// ---------------------------------------------------------------------------------------------

function ViewMode({
  view,
  setView,
  size,
  setSize,
  atm,
  legs,
  setLegs,
}: {
  view: MarketView;
  setView: (v: MarketView) => void;
  size: string;
  setSize: (s: string) => void;
  atm: number;
  legs: BuiltLeg[];
  setLegs: (l: BuiltLeg[]) => void;
}) {
  const chosen = MARKET_VIEWS.find((v) => v.id === view)!;
  const sizeEth = Number(size) || 0;

  return (
    <>
      <section className="mt-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="space-y-1.5">
          <Label>Where does ETH go next?</Label>
          {/* Pills rather than a segmented rail: four labels do not divide a 430px column
              evenly, and these wrap where a rail would squeeze. */}
          <div className="flex flex-wrap gap-2">
            {MARKET_VIEWS.map((v) => (
              <button
                key={v.id}
                onClick={() => {
                  setView(v.id);
                  setLegs([]);
                }}
                className={cn(
                  "press rounded-pill border-rule border-line px-4 py-2 text-[13px] font-bold transition-colors [transition-duration:120ms]",
                  view === v.id ? "bg-ink text-paper shadow-sm" : "bg-card shadow-xs hover:bg-paper-2",
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
          <p className="pt-0.5 text-[12.5px] text-ink-soft">{chosen.blurb}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="size" className="flex items-center gap-1.5">
            Size <TokenIcon symbol="ETH" size={13} /> ETH
          </Label>
          <Input
            id="size"
            className="h-11 w-[130px] font-mono text-[13px]"
            inputMode="decimal"
            value={size}
            onChange={(e) => setSize(e.target.value)}
          />
        </div>
      </section>

      <section className="mt-5 grid items-start gap-4 lg:grid-cols-[2fr_3fr]">
        <div className="flex flex-col gap-3 lg:sticky lg:top-6">
          <PresetList
            label={`Structures for “${chosen.label}”`}
            templates={strategiesForView(view)}
            atm={atm}
            sizeEth={sizeEth}
            activeLegs={legs}
            onPick={setLegs}
          />
        </div>

        <StrategyBuilder legs={legs} setLegs={setLegs} onClear={() => setLegs([])} />
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Hedge: the original flow, now behind its own tab
// ---------------------------------------------------------------------------------------------

function HedgeMode({
  input,
  setInput,
  connected,
  data,
  isLoading,
  error,
  active,
  others,
  positions,
  atm,
  legs,
  setLegs,
}: {
  input: string;
  setInput: (s: string) => void;
  connected?: string;
  data: { accountValue: number } | undefined;
  isLoading: boolean;
  error: Error | null;
  active?: HlPosition;
  others: HlPosition[];
  positions: HlPosition[];
  atm: number;
  legs: BuiltLeg[];
  setLegs: (l: BuiltLeg[]) => void;
}) {
  return (
    <>
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
      </section>

      {error && (
        <div className="mt-4">
          <CardNote tone="danger">Hyperliquid: {error.message}</CardNote>
        </div>
      )}

      {isLoading && (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {!isLoading && !active && (
        <div className="mt-4">
          <CardNote>
            {data && positions.length === 0
              ? "No open perps on this address."
              : data
                ? `No ${MARKET_COIN} perp on this address — only ${MARKET_COIN} can be hedged here.`
                : "Paste a Hyperliquid address, or connect the wallet that holds the perp."}{" "}
            Nothing to hedge is not nothing to trade: the other tab builds a position from a view
            alone.
          </CardNote>
        </div>
      )}

      {active && (
        <section className="mt-5 grid items-start gap-4 lg:grid-cols-[2fr_3fr]">
          <div className="flex flex-col gap-3 lg:sticky lg:top-6">
            <PositionSummary p={active} />
            <PresetList
              label={`Structures for a ${active.szi > 0 ? "long" : "short"} perp`}
              templates={strategiesFor(active.szi)}
              atm={atm}
              sizeEth={Math.abs(active.szi)}
              activeLegs={legs}
              onPick={setLegs}
            />
          </div>

          <StrategyBuilder position={active} legs={legs} setLegs={setLegs} onClear={() => setLegs([])} />
        </section>
      )}

      {others.length > 0 && (
        <section className="mt-5">
          <Card className="p-5">
            <CardTitle className="text-base">Other perps on this account</CardTitle>
            <CardDescription className="mt-1 flex flex-wrap items-center gap-1.5">
              Only <TokenPair base="WETH" quote="USDC" size={15} /> WETH/USDC is deployed, so these are not
              tradable yet.
            </CardDescription>
            <div className="mt-3.5 flex flex-wrap gap-2">
              {others.map((p) => (
                <span
                  key={p.coin}
                  className="inline-flex items-center gap-1.5 rounded-pill border-rule border-line bg-paper-2 py-1.5 pl-1.5 pr-3 text-xs font-bold tnum"
                >
                  <TokenIcon symbol={p.coin} size={17} />
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

// ---------------------------------------------------------------------------------------------

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
        <CardTitle className="mt-1 flex items-center gap-2 text-[24px] tnum">
          <TokenIcon symbol={p.coin} size={22} />
          <span>
            {p.szi > 0 ? "+" : ""}
            {fmt(p.szi, 4)} {p.coin}
          </span>
        </CardTitle>
      </CardHeader>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-y-rule border-line bg-paper-2 px-4 py-3 sm:grid-cols-4">
        <Fact label="Entry" value={`$${fmt(p.entryPx, 2)}`} />
        <Fact label="Notional" value={`$${fmt(p.positionValue, 2)}`} />
        <Fact
          label="uPnL"
          value={`${p.unrealizedPnl >= 0 ? "+" : ""}$${fmt(p.unrealizedPnl, 2)}`}
          tone={p.unrealizedPnl >= 0 ? "pos" : "neg"}
        />
        <Fact label="Liq. price" value={p.liquidationPx ? `$${fmt(p.liquidationPx, 2)}` : "—"} />
      </div>
    </Card>
  );
}

/** One list of structures, whatever chose them. */
function PresetList({
  label,
  templates,
  atm,
  sizeEth,
  activeLegs,
  onPick,
}: {
  label: string;
  templates: StrategyTemplate[];
  atm: number;
  sizeEth: number;
  activeLegs: BuiltLeg[];
  onPick: (legs: BuiltLeg[]) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  function handlePick(id: string) {
    const t = templates.find((x) => x.id === id)!;
    setSelectedId(id);
    onPick(materialise(t, atm, sizeEth));
  }

  // Clear selection when legs are cleared externally
  if (activeLegs.length === 0 && selectedId !== null) {
    setSelectedId(null);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="px-0.5 text-[11px] uppercase tracking-[0.1em]">{label}</Label>
      {templates.map((t) => {
        const isActive = selectedId === t.id && activeLegs.length > 0;
        const legLine = t.legs
          .map(
            (l) =>
              `${l.side === "sell" ? "write" : "buy"} ${strikeLabel(
                Math.min(Math.max(atm + l.strikeOffset, 0), deployed.strikeTicks.length - 1),
              )} ${l.isPut ? "put" : "call"}`,
          )
          .join(" · ");

        return (
          <button
            key={t.id}
            className={cn(
              "w-full rounded-md border-rule border-line px-3.5 py-3 text-left transition-colors",
              isActive ? "border-lime-deep bg-lime-wash shadow-sm" : "bg-card shadow-xs hover:bg-lime-wash",
            )}
            onClick={() => handlePick(t.id)}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-extrabold">{t.name}</span>
              <Badge
                variant={
                  t.cost === "earns premium" ? "call" : t.cost === "costs premium" ? "put" : "itm"
                }
              >
                {t.cost}
              </Badge>
            </div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">{t.effect}</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">Needs {t.requires}.</p>
            <p className="mt-1 font-mono text-[11px] text-ink-faint">{legLine}</p>
          </button>
        );
      })}
    </div>
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
