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
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
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
      const res = await fetch(`/api/hyperliquid?type=clearinghouseState&user=${address}`);
      const body = await res.json();
      if (body?.error) throw new Error(body.error);
      return parseAccount(body);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Strategy templates
// ---------------------------------------------------------------------------------------------

export type LegSpec = {
  /** Offset from the at-the-money strike, in ladder steps. -2 = two strikes below spot. */
  strikeOffset: number;
  isPut: boolean;
  /** Writing the leg (short) or buying it (long). */
  side: "sell" | "buy";
};

export type StrategyTemplate = {
  id: string;
  name: string;
  /** Which perp side this structure is built for. */
  forSide: "long" | "short";
  /** True hedge of the perp, or a yield play that needs its own inventory. */
  kind: "hedge" | "yield";
  summary: string;
  effect: string;
  cost: "earns premium" | "costs premium" | "roughly financed";
  /** What the trader must supply beyond the perp itself. */
  requires: string;
  legs: LegSpec[];
};

/**
 * Structures a broker's builder would offer against an existing directional perp.
 *
 * A note on what is and is not a hedge here, because it is easy to get wrong.
 *
 * In this protocol you BUY an option by removing written liquidity, and you WRITE one by posting
 * the range's own assets. Writing is therefore collateral-funded: writing a call means posting
 * WETH. A perp is not deliverable WETH inventory, so "covered call against a long perp" does not
 * hedge anything — you would have to buy spot WETH to write it, which ADDS delta rather than
 * removing it. Those structures are still listed, because they are real trades people want, but
 * they are labelled `yield` and state the inventory they need.
 *
 * The genuine perp hedges are the bought legs: buy puts under a long, buy calls over a short, and
 * write a further-out leg against them to cheapen the protection.
 */
export const STRATEGIES: StrategyTemplate[] = [
  {
    id: "protective-put",
    name: "Protective put",
    forSide: "long",
    kind: "hedge",
    summary: "Buy a put below spot against the long perp.",
    effect: "Floors the drawdown. Gains as price falls through the strike, offsetting the perp.",
    cost: "costs premium",
    requires: "~10% of notional as collateral",
    legs: [{ strikeOffset: -2, isPut: true, side: "buy" }],
  },
  {
    id: "put-spread",
    name: "Put spread",
    forSide: "long",
    kind: "hedge",
    summary: "Buy a put below spot, write one further below to fund it.",
    effect: "Cheaper protection. Covers the first leg of a drawdown; stops helping past the lower strike.",
    cost: "roughly financed",
    requires: "collateral on the bought leg, USDC backing on the written leg",
    legs: [
      { strikeOffset: -1, isPut: true, side: "buy" },
      { strikeOffset: -3, isPut: true, side: "sell" },
    ],
  },
  {
    id: "covered-call",
    name: "Covered call",
    forSide: "long",
    kind: "yield",
    summary: "Write a call above spot. A yield play, not a perp hedge.",
    effect: "Earns premium on WETH you hold. It does not offset the perp — writing it requires posting WETH.",
    cost: "earns premium",
    requires: "WETH inventory to post",
    legs: [{ strikeOffset: 2, isPut: false, side: "sell" }],
  },
  {
    id: "protective-call",
    name: "Protective call",
    forSide: "short",
    kind: "hedge",
    summary: "Buy a call above spot against the short perp.",
    effect: "Caps squeeze risk. Gains as price runs through the strike, offsetting the short.",
    cost: "costs premium",
    requires: "~10% of notional as collateral",
    legs: [{ strikeOffset: 2, isPut: false, side: "buy" }],
  },
  {
    id: "call-spread",
    name: "Call spread",
    forSide: "short",
    kind: "hedge",
    summary: "Buy a call above spot, write one further above to fund it.",
    effect: "Cheaper squeeze cover. Protects the first leg of a rally, then stops.",
    cost: "roughly financed",
    requires: "collateral on the bought leg, WETH backing on the written leg",
    legs: [
      { strikeOffset: 1, isPut: false, side: "buy" },
      { strikeOffset: 3, isPut: false, side: "sell" },
    ],
  },
  {
    id: "cash-secured-put",
    name: "Cash-secured put",
    forSide: "short",
    kind: "yield",
    summary: "Write a put below spot. A yield play, not a perp hedge.",
    effect: "Earns premium and sets the level you would accept assignment at. Adds long exposure on a drawdown.",
    cost: "earns premium",
    requires: "USDC to post",
    legs: [{ strikeOffset: -2, isPut: true, side: "sell" }],
  },
];

export function strategiesFor(szi: number): StrategyTemplate[] {
  return STRATEGIES.filter((s) => s.forSide === (szi > 0 ? "long" : "short"));
}
