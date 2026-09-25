"use client";

import { OptionChain } from "@/components/option-chain";
import { PageHeader } from "@/components/page-header";
import { useHookPricing, useSeries, useSpotTick } from "@/lib/useMarket";
import { tickToUsdPrice } from "@/lib/options";

export default function ChainPage() {
  const { tick } = useSpotTick();
  const { rows } = useSeries();
  const pricing = useHookPricing();

  const spot = tick !== undefined ? tickToUsdPrice(tick) : undefined;
  const written = rows.reduce((a, r) => a + r.shortLiquidity, 0n);
  const bought = rows.reduce((a, r) => a + r.longLiquidity, 0n);
  const utilisation = written > 0n ? (Number(bought) / Number(written)) * 100 : 0;

  return (
    <>
      <PageHeader
        title="WETH / USDC"
        description="Every option here is a Uniswap v4 liquidity position. Writing mints it, buying removes it."
        stats={[
          {
            label: "Spot",
            tone: "ink",
            accent: true,
            value: spot ? `$${spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : undefined,
          },
          { label: "Pool tick", mono: true, value: tick !== undefined ? String(tick) : undefined },
          { label: "Realised vol", tone: "lime", value: `${(pricing.realisedVolBps / 100).toFixed(1)}%` },
          { label: "Utilisation", tone: "peri", value: `${utilisation.toFixed(0)}%` },
        ]}
      />

      <section className="mt-6">
        <PricingBar {...pricing} />
      </section>

      <section className="mt-6">
        <OptionChain />
      </section>
    </>
  );
}

/**
 * What the next swap will be charged, and why.
 *
 * Worth showing on its own rather than as a stat chip, because the fee IS the premium in this
 * protocol — and both of its inputs are measured on-chain from this pool. Nothing here is quoted.
 */
function PricingBar({
  realisedVolBps,
  utilisationBps,
  volFee,
  currentFee,
}: {
  realisedVolBps: number;
  utilisationBps: number;
  volFee: number;
  currentFee: number;
}) {
  const pct = (bps: number) => `${(bps / 10_000).toFixed(2)}%`;

  return (
    <div className="rounded-md border-rule border-line bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-3">
        <Term
          label="Realised volatility"
          value={`${(realisedVolBps / 100).toFixed(1)}%`}
          note="annualised, from this pool's tick path"
        />
        <Op>{"\u2192"}</Op>
        <Term label="Fair value fee" value={pct(volFee)} note="what the option is worth" />
        <Op>+</Op>
        <Term
          label="Utilisation spread"
          value={pct(currentFee - volFee)}
          note={`${(utilisationBps / 100).toFixed(0)}% of the book is lent out`}
        />
        <Op>=</Op>
        <Term label="LP fee now" value={pct(currentFee)} accent note="the premium writers earn" />
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-ink-soft">
        Premium is this pool&apos;s swap fee, and the hook sets it from two measurements: realised
        volatility from the tick path, and how much of the written book longs have bought out. No
        oracle, no pricing model, no signed quote.
      </p>
    </div>
  );
}

function Term({
  label,
  value,
  note,
  accent,
}: {
  label: string;
  value: string;
  note: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-soft">{label}</div>
      <div className={`mt-0.5 text-[19px] font-extrabold tnum ${accent ? "text-lime-deep" : ""}`}>{value}</div>
      <div className="text-[11px] text-ink-faint">{note}</div>
    </div>
  );
}

function Op({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-lg text-ink-faint">{children}</span>;
}
