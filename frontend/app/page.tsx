"use client";

import { OptionChain } from "@/components/option-chain";
import { PageHeader } from "@/components/page-header";
import { useSeries, useSpotTick } from "@/lib/useMarket";
import { tickToUsdPrice } from "@/lib/options";

export default function ChainPage() {
  const { tick } = useSpotTick();
  const { rows } = useSeries();

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
          { label: "Series listed", tone: "lime", value: `${rows.length}` },
          { label: "Utilisation", tone: "peri", value: `${utilisation.toFixed(0)}%` },
        ]}
      />

      <section className="mt-6">
        <OptionChain />
      </section>
    </>
  );
}
