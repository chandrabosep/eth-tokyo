/**
 * The structures the builder offers, and what each one actually costs on THIS protocol.
 *
 * Two catalogues, because there are two reasons to be here.
 *
 * `PERP_STRATEGIES` hedge a position that already exists on Hyperliquid. `VIEW_STRATEGIES` need no
 * perp at all — they are the ordinary options trades anyone takes when they have a view on where
 * the market goes next, which is most people who open this page.
 *
 * A note on what is and is not a hedge here, because it is easy to get wrong.
 *
 * In this protocol you BUY an option by removing written liquidity, and you WRITE one by posting
 * the range's own assets. Writing is therefore collateral-funded: writing a call means posting
 * WETH, writing a put means posting USDC. A perp is not deliverable WETH inventory, so "covered
 * call against a long perp" does not hedge anything — you would have to buy spot WETH to write it,
 * which ADDS delta rather than removing it. Those structures are still listed, because they are
 * real trades people want, but they are labelled `yield` and state the inventory they need.
 *
 * The genuine perp hedges are the bought legs: buy puts under a long, buy calls over a short, and
 * write a further-out leg against them to cheapen the protection.
 *
 * One constraint colours every bought leg: a long is written liquidity handed over, so you can only
 * buy what someone else has already written. The builder caps a leg at the book's depth and says
 * so; a structure that is all bought legs can simply be unfillable on a thin strike.
 */

export type LegSpec = {
  /** Strikes from the money, on the fixed ladder. 0 is the strike nearest spot. */
  strikeOffset: number;
  isPut: boolean;
  side: "sell" | "buy";
};

/** What the trader thinks happens next. The only input a strategy needs when there is no perp. */
export type MarketView = "bullish" | "bearish" | "range" | "volatile";

export type StrategyTemplate = {
  id: string;
  name: string;
  summary: string;
  effect: string;
  cost: "earns premium" | "costs premium" | "roughly financed";
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
  { id: "range", label: "Sideways", blurb: "You think it stays where it is. Sell the premium." },
  { id: "volatile", label: "Big move", blurb: "You think it moves hard, and do not mind which way." },
];

const TEN_PERCENT = "~10% of notional as collateral";

/** Structures a broker's builder would offer against an existing directional perp. */
export const PERP_STRATEGIES: StrategyTemplate[] = [
  {
    id: "protective-put",
    name: "Protective put",
    forSide: "long",
    kind: "hedge",
    summary: "Buy a put below spot against the long perp.",
    effect:
      "Floors the drawdown at the strike. Gains dollar for dollar as ETH falls through it, offsetting the perp below that level.",
    cost: "costs premium",
    requires: TEN_PERCENT,
    legs: [{ strikeOffset: -2, isPut: true, side: "buy" }],
  },
  {
    id: "put-spread",
    name: "Put spread",
    forSide: "long",
    kind: "hedge",
    summary: "Buy a put below spot, write one further below to fund it.",
    effect: "Cheaper protection. Covers the first leg of a drawdown, then stops.",
    cost: "roughly financed",
    requires: "collateral on the bought leg, USDC backing on the written leg",
    legs: [
      { strikeOffset: -1, isPut: true, side: "buy" },
      { strikeOffset: -3, isPut: true, side: "sell" },
    ],
  },
  {
    id: "collar",
    name: "Collar",
    forSide: "long",
    kind: "hedge",
    summary: "Buy a put below spot and write a call above it to pay for the put.",
    effect:
      "Protection funded by giving up the upside past the call. The perp keeps running between the two strikes and stops mattering outside them.",
    cost: "roughly financed",
    requires: "collateral on the put, plus WETH to back the written call",
    legs: [
      { strikeOffset: -2, isPut: true, side: "buy" },
      { strikeOffset: 2, isPut: false, side: "sell" },
    ],
  },
  {
    id: "covered-call",
    name: "Covered call",
    forSide: "long",
    kind: "yield",
    summary: "Write a call above spot. A yield play, not a perp hedge.",
    effect: "Earns premium on WETH you hold. It does not offset the perp; writing it needs posted WETH.",
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
    requires: TEN_PERCENT,
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
    id: "reverse-collar",
    name: "Reverse collar",
    forSide: "short",
    kind: "hedge",
    summary: "Buy a call above spot and write a put below it to pay for the call.",
    effect:
      "Squeeze cover funded by giving up the gains below the put. The short keeps working between the strikes.",
    cost: "roughly financed",
    requires: "collateral on the call, plus USDC to back the written put",
    legs: [
      { strikeOffset: 2, isPut: false, side: "buy" },
      { strikeOffset: -2, isPut: true, side: "sell" },
    ],
  },
  {
    id: "cash-secured-put",
    name: "Cash-secured put",
    forSide: "short",
    kind: "yield",
    summary: "Write a put below spot. A yield play, not a perp hedge.",
    effect: "Earns premium and sets the level you would take assignment at. Adds long exposure on a drawdown.",
    cost: "earns premium",
    requires: "USDC to post",
    legs: [{ strikeOffset: -2, isPut: true, side: "sell" }],
  },
];

/** Structures that stand on their own — a view on the market, no perp required. */
export const VIEW_STRATEGIES: StrategyTemplate[] = [
  // ---- up ----------------------------------------------------------------------------------
  {
    id: "long-call",
    name: "Long call",
    view: "bullish",
    summary: "Buy a call above spot.",
    effect:
      "Pays off once ETH clears the strike, and the premium is the whole of what you can lose. Needs someone to have written that strike.",
    cost: "costs premium",
    requires: TEN_PERCENT,
    legs: [{ strikeOffset: 1, isPut: false, side: "buy" }],
  },
  {
    id: "bull-call-spread",
    name: "Bull call spread",
    view: "bullish",
    summary: "Buy a call above spot, write one further above to fund it.",
    effect: "The same first leg of the rally for less outlay, in exchange for capping the gain at the upper strike.",
    cost: "roughly financed",
    requires: "collateral on the bought leg, WETH backing on the written leg",
    legs: [
      { strikeOffset: 1, isPut: false, side: "buy" },
      { strikeOffset: 3, isPut: false, side: "sell" },
    ],
  },
  {
    id: "csp-bullish",
    name: "Cash-secured put",
    view: "bullish",
    summary: "Write a put below spot and hold the USDC behind it.",
    effect:
      "Paid to wait. You keep the premium if ETH holds above the strike, and take on long exposure at that level if it does not.",
    cost: "earns premium",
    requires: "USDC to post",
    legs: [{ strikeOffset: -2, isPut: true, side: "sell" }],
  },

  // ---- down --------------------------------------------------------------------------------
  {
    id: "long-put",
    name: "Long put",
    view: "bearish",
    summary: "Buy a put below spot.",
    effect:
      "Gains as ETH falls through the strike, with the premium as the most you can lose. Needs someone to have written that strike.",
    cost: "costs premium",
    requires: TEN_PERCENT,
    legs: [{ strikeOffset: -1, isPut: true, side: "buy" }],
  },
  {
    id: "bear-put-spread",
    name: "Bear put spread",
    view: "bearish",
    summary: "Buy a put below spot, write one further below to fund it.",
    effect: "The first leg of a sell-off for less outlay, in exchange for the floor at the lower strike.",
    cost: "roughly financed",
    requires: "collateral on the bought leg, USDC backing on the written leg",
    legs: [
      { strikeOffset: -1, isPut: true, side: "buy" },
      { strikeOffset: -3, isPut: true, side: "sell" },
    ],
  },
  {
    id: "cc-bearish",
    name: "Covered call",
    view: "bearish",
    summary: "Write a call above spot against WETH you already hold.",
    effect:
      "Earns premium on inventory you are not expecting to run. The WETH is what backs it, so a rally through the strike is given up.",
    cost: "earns premium",
    requires: "WETH inventory to post",
    legs: [{ strikeOffset: 2, isPut: false, side: "sell" }],
  },

  // ---- sideways ----------------------------------------------------------------------------
  {
    id: "short-strangle",
    name: "Short strangle",
    view: "range",
    summary: "Write a put below spot and a call above it.",
    effect:
      "Collects on both sides while ETH stays between the strikes. The exposure outside them is open-ended, which is what the premium pays for.",
    cost: "earns premium",
    requires: "USDC to back the put, WETH to back the call",
    legs: [
      { strikeOffset: -2, isPut: true, side: "sell" },
      { strikeOffset: 2, isPut: false, side: "sell" },
    ],
  },
  {
    id: "iron-condor",
    name: "Iron condor",
    view: "range",
    summary: "A short strangle with bought wings outside it.",
    effect:
      "The same range income as the strangle, with the far strikes capping what a break costs. Four legs, so the wings need depth on the book.",
    cost: "earns premium",
    requires: "backing on both written legs, collateral on both wings",
    legs: [
      { strikeOffset: -3, isPut: true, side: "buy" },
      { strikeOffset: -1, isPut: true, side: "sell" },
      { strikeOffset: 1, isPut: false, side: "sell" },
      { strikeOffset: 3, isPut: false, side: "buy" },
    ],
  },
  {
    id: "short-straddle",
    name: "Short straddle",
    view: "range",
    summary: "Write both the put and the call at the strike nearest spot.",
    effect:
      "The most premium on offer, and the least room for error — spot is already at the strike, so any move at all eats into it.",
    cost: "earns premium",
    requires: "both tokens: the range at spot is funded in WETH and USDC",
    legs: [
      { strikeOffset: 0, isPut: true, side: "sell" },
      { strikeOffset: 0, isPut: false, side: "sell" },
    ],
  },

  // ---- big move ----------------------------------------------------------------------------
  {
    id: "long-straddle",
    name: "Long straddle",
    view: "volatile",
    summary: "Buy both the put and the call at the strike nearest spot.",
    effect:
      "Pays off on a move in either direction, and loses the premium if one never comes. Both legs need written depth at that strike.",
    cost: "costs premium",
    requires: TEN_PERCENT,
    legs: [
      { strikeOffset: 0, isPut: true, side: "buy" },
      { strikeOffset: 0, isPut: false, side: "buy" },
    ],
  },
  {
    id: "long-strangle",
    name: "Long strangle",
    view: "volatile",
    summary: "Buy a put below spot and a call above it.",
    effect:
      "The same bet as the straddle for less outlay, because both strikes start out of the money — so the move has to be bigger to pay.",
    cost: "costs premium",
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
