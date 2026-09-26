"use client";

import { useQuery } from "@tanstack/react-query";

/**
 * Hyperliquid perp positions, read-only.
 *
 * The integration is deliberately one-directional: we read what a trader already holds on
 * Hyperliquid, then offer structures on OUR options market that act on that exposure. Nothing is
 * signed or traded on Hyperliquid — this is a position source, not a venue integration.
 *
 * Shape verified against the live API (`clearinghouseState`):
 *   { assetPositions: [ { type, position: { coin, szi, entryPx, positionValue,
 *                                           unrealizedPnl, liquidationPx, leverage } } ] }
 * `szi` is the SIGNED size: positive long, negative short. That sign is the whole basis for which
 * structures make sense, so it is parsed as a number rather than carried around as a string.
 */

export type HlPosition = {
  coin: string;
  /** Signed size. Positive = long, negative = short. */
  szi: number;
  entryPx: number;
  positionValue: number;
  unrealizedPnl: number;
  liquidationPx: number | null;
  leverage: number;
  /** Delta in units of the underlying — for a linear perp this is just the size. */
  delta: number;
};

export type HlAccount = {
  accountValue: number;
  totalNtlPos: number;
  positions: HlPosition[];
};

const num = (v: unknown, fallback = 0) => {
  const n =
    typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
};

export function parseAccount(raw: unknown): HlAccount {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = raw as any;
  const positions: HlPosition[] = (d?.assetPositions ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((ap: any) => {
      const p = ap?.position ?? {};
      const szi = num(p.szi);
      return {
        coin: String(p.coin ?? "?"),
        szi,
        entryPx: num(p.entryPx),
        positionValue: num(p.positionValue),
        unrealizedPnl: num(p.unrealizedPnl),
        liquidationPx: p.liquidationPx == null ? null : num(p.liquidationPx),
        leverage: num(p?.leverage?.value, 1),
        delta: szi,
      };
    })
    .filter((p: HlPosition) => p.szi !== 0)
    .sort((a: HlPosition, b: HlPosition) => b.positionValue - a.positionValue);

  return {
    accountValue: num(d?.marginSummary?.accountValue),
    totalNtlPos: num(d?.marginSummary?.totalNtlPos),
    positions,
  };
}

export function useHyperliquidAccount(address?: string) {
  return useQuery({
    queryKey: ["hl", address],
    enabled: !!address && /^0x[0-9a-fA-F]{40}$/.test(address),
    refetchInterval: 15_000,
    queryFn: async (): Promise<HlAccount> => {
      const res = await fetch(
        `/api/hyperliquid?type=clearinghouseState&user=${address}`,
      );
      const body = await res.json();
      if (body?.error) throw new Error(body.error);
      return parseAccount(body);
    },
  });
}
