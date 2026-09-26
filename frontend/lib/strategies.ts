/**
 * The structures this market can actually express, and what each one earns here.
 *
 * These are deliberately not the textbook book. Two facts about this protocol rule out half of it
 * and hand you something the textbook does not have:
 *
 *   1. **There is no theta.** Premium is `feeGrowthInside` — the pool's swap fee over the range —
 *      and it accrues only while spot is INSIDE that range. A written option two strikes away does
 *      not decay in the writer's favour. It earns exactly nothing until price arrives. Selling far
 *      out-of-the-money premium, the staple of every covered-call and cash-secured-put screen, is
 *      dead capital here.
 *
 *   2. **The same fact makes bought wings free to hold.** A long pays `feeGrowthInside` too, so an
 *      option whose range spot is nowhere near costs nothing to carry. You post the 10% and wait.
 *      In a market with theta that position bleeds; in this one it does not.
 *
 * So the income strategies here are about being in the live range and staying there, and the long
 * strategies are about owning the ranges price has to travel through. Where a textbook name still
 * describes the structure honestly — a call spread is a call spread — it keeps the name.
 *
 * One constraint colours every bought leg: a long is written liquidity handed over, so you can only
 * buy what someone else has already written. The builder caps a leg at the book's depth.
 */

export type LegSpec = {
  /** Strikes from the money, on the fixed ladder. 0 is the strike nearest spot. */
  strikeOffset: number;
  /**
   * `true`/`false` pick the put or the call outright. "spot" picks whichever of the pair is the
   * live one — a put covers the ticks below its strike and a call the ticks above, so which of
   * them holds spot depends on the side of the strike spot happens to be on.
   */
  isPut: boolean | "spot";
  side: "sell" | "buy";
};

/** What the trader thinks happens next. The only input a strategy needs when there is no perp. */
export type MarketView = "bullish" | "bearish" | "range" | "volatile";

export type StrategyTemplate = {
  id: string;
  /** What a trader would call it. For hedges this is plain language: a floor, not a put. */
  name: string;
  /** The textbook name, shown beside the plain one so an options trader still recognises it. */
  technical?: string;
  summary: string;
  effect: string;
  cost: "earns premium" | "costs premium" | "roughly financed";
  /** When the premium actually moves, which is the part this protocol does differently. */
  earns: string;
  /** What the trader must supply beyond the perp itself. */
  requires: string;
  legs: LegSpec[];
  /** Which perp side this structure is built for — hedges only. */
  forSide?: "long" | "short";
  /** True hedge of the perp, or a yield play that needs its own inventory. */
  kind?: "hedge" | "yield";
  /** The view this expresses — standalone structures only. */
  view?: MarketView;
};

export const MARKET_VIEWS: { id: MarketView; label: string; blurb: string }[] = [
  { id: "bullish", label: "Up", blurb: "You think ETH rises from here." },
  { id: "bearish", label: "Down", blurb: "You think ETH falls from here." },
  {
    id: "range",
    label: "Sideways",
    blurb: "You think it stays put. Own the range spot is in and collect the fee it charges.",
  },
  { id: "volatile", label: "Big move", blurb: "You think it moves hard, and do not mind which way." },
];

const TEN_PERCENT = "~10% of notional as collateral";
const IDLE = "Nothing while it sits out of range — and nothing is owed for holding it, either.";
const LIVE_NOW = "Every swap through this range, for as long as spot stays inside it.";

/** Structures a broker's builder would offer against an existing directional perp. */
export const PERP_STRATEGIES: StrategyTemplate[] = [
  {
    id: "protective-put",
    name: "Floor",
    technical: "protective put",
    forSide: "long",
    kind: "hedge",
    summary: "Buy a put below spot against the long perp.",
    effect:
      "Floors the drawdown at the strike. Gains dollar for dollar as ETH falls through it, offsetting the perp below that level.",
    cost: "costs premium",
    earns: `Costs you nothing to carry until ETH reaches the strike. ${IDLE}`,
    requires: TEN_PERCENT,
    legs: [{ strikeOffset: -2, isPut: true, side: "buy" }],
  },
  {
    id: "put-spread",
    name: "Budget floor",
    technical: "put spread",
    forSide: "long",
    kind: "hedge",
    summary: "Buy a put below spot, write one further below to fund it.",
    effect: "Cheaper protection. Covers the first leg of a drawdown, then stops.",
    cost: "roughly financed",
    earns: "Both legs are idle until ETH falls to them; the written one then pays for the bought one.",
    requires: "collateral on the bought leg, USDC backing on the written leg",
    legs: [
      { strikeOffset: -1, isPut: true, side: "buy" },
      { strikeOffset: -3, isPut: true, side: "sell" },
    ],
  },
  {
    id: "collar",
    name: "Floor paid by your upside",
    technical: "collar",
    forSide: "long",
    kind: "hedge",
    summary: "Buy a put below spot and write a call above it.",
    effect:
      "Protection funded by giving up the upside past the call. The perp keeps running between the two strikes and stops mattering outside them.",
    cost: "roughly financed",
    earns: "Neither leg is live at spot. The call starts collecting if ETH rallies into it.",
    requires: "collateral on the put, plus WETH to back the written call",
    legs: [
      { strikeOffset: -2, isPut: true, side: "buy" },
      { strikeOffset: 2, isPut: false, side: "sell" },
    ],
  },
  {
    id: "perp-rent",
    name: "Earn while you hold",
    technical: "write the live range",
    forSide: "long",
    kind: "yield",
    summary: "Write the one range spot is sitting in, alongside the perp.",
    effect:
      "Income on top of the perp, from the only range earning anything. The perp keeps the direction; this collects the fee traders pay to move through the price you are already long at.",
    cost: "earns premium",
    earns: LIVE_NOW,
    requires: "the range's own assets as backing — WETH above the strike, USDC below",
    legs: [{ strikeOffset: 0, isPut: "spot", side: "sell" }],
  },
  {
    id: "protective-call",
    name: "Squeeze cover",
    technical: "protective call",
    forSide: "short",
    kind: "hedge",
    summary: "Buy a call above spot against the short perp.",
    effect: "Caps squeeze risk. Gains as price runs through the strike, offsetting the short.",
    cost: "costs premium",
    earns: `Costs nothing to carry while the squeeze has not happened. ${IDLE}`,
    requires: TEN_PERCENT,
    legs: [{ strikeOffset: 2, isPut: false, side: "buy" }],
  },
  {
    id: "call-spread",
    name: "Budget squeeze cover",
    technical: "call spread",
    forSide: "short",
    kind: "hedge",
    summary: "Buy a call above spot, write one further above to fund it.",
    effect: "Cheaper squeeze cover. Protects the first leg of a rally, then stops.",
    cost: "roughly financed",
    earns: "Idle until a rally reaches the strikes; the written leg then funds the bought one.",
    requires: "collateral on the bought leg, WETH backing on the written leg",
    legs: [
      { strikeOffset: 1, isPut: false, side: "buy" },
      { strikeOffset: 3, isPut: false, side: "sell" },
    ],
  },
  {
    id: "reverse-collar",
    name: "Squeeze cover paid by your downside",
    technical: "reverse collar",
    forSide: "short",
    kind: "hedge",
    summary: "Buy a call above spot and write a put below it.",
    effect:
      "Squeeze cover funded by giving up the gains below the put. The short keeps working between the strikes.",
    cost: "roughly financed",
    earns: "Neither leg is live at spot. The put starts collecting if ETH falls into it.",
    requires: "collateral on the call, plus USDC to back the written put",
    legs: [
      { strikeOffset: 2, isPut: false, side: "buy" },
      { strikeOffset: -2, isPut: true, side: "sell" },
    ],
  },
  {
    id: "perp-rent-short",
    name: "Earn while you hold",
    technical: "write the live range",
    forSide: "short",
    kind: "yield",
    summary: "Write the one range spot is sitting in, alongside the perp.",
    effect:
      "Income on top of the short, from the only range earning anything. It does not hedge the perp — it charges rent on the price the perp is already positioned against.",
    cost: "earns premium",
    earns: LIVE_NOW,
    requires: "the range's own assets as backing — WETH above the strike, USDC below",
    legs: [{ strikeOffset: 0, isPut: "spot", side: "sell" }],
  },
];

/** Structures that stand on their own — a view on the market, no perp required. */
export const VIEW_STRATEGIES: StrategyTemplate[] = [
  // ---- up ----------------------------------------------------------------------------------
  {
    id: "long-call",
    name: "Long call",
    view: "bullish",
    summary: "Buy the call above spot and hold it.",
    effect:
      "Pays off once ETH trades up through the strike. The unusual part is the carry: while spot is below the range this position owes nothing at all, so waiting is free.",
    cost: "costs premium",
    earns: `You pay only once ETH reaches the strike. ${IDLE}`,
    requires: TEN_PERCENT,
    legs: [{ strikeOffset: 1, isPut: false, side: "buy" }],
  },
  {
    id: "bull-call-spread",
    name: "Bull call spread",
    view: "bullish",
    summary: "Buy the call above spot, write one further above to fund it.",
    effect: "The same first leg of a rally for less outlay, in exchange for capping the gain at the upper strike.",
    cost: "roughly financed",
    earns: "Both idle at spot. A rally lights the bought leg first, then the written one starts paying you.",
    requires: "collateral on the bought leg, WETH backing on the written leg",
    legs: [
      { strikeOffset: 1, isPut: false, side: "buy" },
      { strikeOffset: 3, isPut: false, side: "sell" },
    ],
  },
  {
    id: "bullish-rent",
    name: "Write the dip you want",
    view: "bullish",
    summary: "Write the live range below the strike, where spot already is.",
    effect:
      "Collects the fee on every swap through today's price. If ETH falls through the range you end up holding it lower, which is the trade you wanted anyway.",
    cost: "earns premium",
    earns: LIVE_NOW,
    requires: "USDC to post, since the range sits below its strike",
    legs: [{ strikeOffset: 0, isPut: "spot", side: "sell" }],
  },

  // ---- down --------------------------------------------------------------------------------
  {
    id: "long-put",
    name: "Long put",
    view: "bearish",
    summary: "Buy the put below spot and hold it.",
    effect:
      "Gains as ETH falls through the strike, and costs nothing to carry until it gets there — the range is idle, so no premium is owed on it.",
    cost: "costs premium",
    earns: `You pay only once ETH falls to the strike. ${IDLE}`,
    requires: TEN_PERCENT,
    legs: [{ strikeOffset: -1, isPut: true, side: "buy" }],
  },
  {
    id: "bear-put-spread",
    name: "Bear put spread",
    view: "bearish",
    summary: "Buy the put below spot, write one further below to fund it.",
    effect: "The first leg of a sell-off for less outlay, in exchange for the floor at the lower strike.",
    cost: "roughly financed",
    earns: "Both idle at spot. A sell-off lights the bought leg first, then the written one funds it.",
    requires: "collateral on the bought leg, USDC backing on the written leg",
    legs: [
      { strikeOffset: -1, isPut: true, side: "buy" },
      { strikeOffset: -3, isPut: true, side: "sell" },
    ],
  },
  {
    id: "bearish-rent",
    name: "Charge for the rally",
    view: "bearish",
    summary: "Write the live range, and the call above it.",
    effect:
      "Collects at today's price, and keeps collecting into the first leg up — where, being short that range, you are also positioned for the move back down.",
    cost: "earns premium",
    earns: "The live leg collects now; the call above takes over if ETH trades up into it.",
    requires: "the live range's own assets, plus WETH to back the call above",
    legs: [
      { strikeOffset: 0, isPut: "spot", side: "sell" },
      { strikeOffset: 1, isPut: false, side: "sell" },
    ],
  },

  // ---- sideways ----------------------------------------------------------------------------
  {
    id: "rent-the-range",
    name: "Rent the range",
    view: "range",
    summary: "Write the one range spot is inside.",
    effect:
      "The whole of this market's income, in one leg. Every swap through today's price pays the fee, split across whoever has written this range — so the thinner it is, the larger your share.",
    cost: "earns premium",
    earns: LIVE_NOW,
    requires: "the range's own assets as backing — WETH above the strike, USDC below",
    legs: [{ strikeOffset: 0, isPut: "spot", side: "sell" }],
  },
  {
    id: "straddle-the-strike",
    name: "Straddle the strike",
    view: "range",
    summary: "Write both sides of the nearest strike, so one of them is always live.",
    effect:
      "A single range stops earning the moment spot leaves it. Owning the pair either side of the strike means a crossing hands the income to the other leg instead of ending it.",
    cost: "earns premium",
    earns: "One leg is live now; the other is the one that keeps you earning if spot crosses.",
    requires: "both tokens: WETH backs the call side, USDC the put side",
    legs: [
      { strikeOffset: 0, isPut: true, side: "sell" },
      { strikeOffset: 0, isPut: false, side: "sell" },
    ],
  },
  {
    id: "wide-rent",
    name: "Rent a wider band",
    view: "range",
    summary: "Write the live range and its neighbours either side.",
    effect:
      "Three ranges wide, so spot has room to wander without your income stopping. The cost is that more of your collateral sits idle in the legs price is not visiting.",
    cost: "earns premium",
    earns: "One leg collects at a time — whichever spot is in. The others wait their turn.",
    requires: "both tokens: the band spans the strike on either side",
    legs: [
      { strikeOffset: -1, isPut: true, side: "sell" },
      { strikeOffset: 0, isPut: "spot", side: "sell" },
      { strikeOffset: 1, isPut: false, side: "sell" },
    ],
  },

  // ---- big move ----------------------------------------------------------------------------
  {
    id: "buy-the-live-range",
    name: "Buy the live range",
    view: "volatile",
    summary: "Take the range spot is in off the writers.",
    effect:
      "The range price is about to leave is the one that pays a long the most, because you collect exactly what the writer loses as it recomposes. You pay the fee while spot lingers, so this is a bet on it not lingering.",
    cost: "costs premium",
    earns: "You pay for every swap while spot stays inside — and stop paying the moment it leaves.",
    requires: TEN_PERCENT,
    legs: [{ strikeOffset: 0, isPut: "spot", side: "buy" }],
  },
  {
    id: "free-carry-strangle",
    name: "Both tails",
    view: "volatile",
    summary: "Buy a put below and a call above, both well away from spot.",
    effect:
      "A straddle that costs nothing to hold. Both ranges are idle, so no premium is owed until one of them is reached — the position only starts costing you at the point it starts working.",
    cost: "costs premium",
    earns: `Nothing is owed until ETH reaches one of the strikes. ${IDLE}`,
    requires: TEN_PERCENT,
    legs: [
      { strikeOffset: -2, isPut: true, side: "buy" },
      { strikeOffset: 2, isPut: false, side: "buy" },
    ],
  },
];

/** Hedges for the side of the perp actually held. */
export function strategiesFor(szi: number): StrategyTemplate[] {
  return PERP_STRATEGIES.filter((s) => s.forSide === (szi > 0 ? "long" : "short"));
}

/** Standalone structures expressing one view. */
export function strategiesForView(view: MarketView): StrategyTemplate[] {
  return VIEW_STRATEGIES.filter((s) => s.view === view);
}

/**
 * Resolve a leg's "spot" marker.
 *
 * A put owns the ticks below its strike and a call the ticks above, so the live one of the pair is
 * decided by which side of the strike spot sits on — not by anything in the template.
 */
export function resolveIsPut(spec: LegSpec, spotBelowStrike: boolean): boolean {
  return spec.isPut === "spot" ? spotBelowStrike : spec.isPut;
}
