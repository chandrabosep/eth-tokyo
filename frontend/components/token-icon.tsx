"use client";

import { useId } from "react";

import { cn } from "@/lib/utils";

/**
 * Token marks, drawn in ink.
 *
 * The brand colours are deliberately dropped. Every other icon in the app is a
 * monochrome glyph, and the two logos this market needs are both blue — Ethereum's
 * landing almost exactly on periwinkle, which already means "put" on every other
 * surface here. The silhouette is what carries recognition anyway: Ethereum's
 * faceted diamond, and USDC's dollar knocked out of a filled disc, which is how
 * both marks are drawn whenever they are printed in one colour.
 *
 * Tokens we have no mark for are an open set — the perps on someone's Hyperliquid
 * account can be anything — so those fall back to a monogram disc rather than a
 * stand-in logo. The ticker is always in text beside the mark, so the icons are
 * decorative and stay out of the accessibility tree.
 */

type Mark = "eth" | "usdc";

const MARKS: Record<string, Mark> = {
  ETH: "eth",
  WETH: "eth",
  USDC: "usdc",
};

/** Shared placement for the glyph-in-a-disc marks: optically centred, Outfit 800. */
const GLYPH = {
  x: 12,
  y: 12,
  textAnchor: "middle",
  dominantBaseline: "central",
  fontWeight: 800,
} as const;

export function TokenIcon({
  symbol,
  size = 18,
  className,
  style,
}: {
  symbol: string;
  /** Rendered edge length in px. The mark is vector, so any size is crisp. */
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  // The knockout is a mask, not a paper-coloured glyph, so the dollar shows
  // whatever surface the disc happens to sit on — card, paper-2 or a wash.
  // `useId` hands back punctuation (`:r3:`), which some engines refuse inside a
  // `url(#…)` reference, so the id is stripped down to word characters.
  const maskId = `usdc-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const mark = MARKS[symbol.toUpperCase()];

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {mark === "usdc" ? (
        <>
          <mask id={maskId}>
            <circle cx="12" cy="12" r="12" fill="#fff" />
            <text {...GLYPH} fontSize="14.5" fill="#000">
              $
            </text>
          </mask>
          <circle cx="12" cy="12" r="11.25" className="fill-ink" mask={`url(#${maskId})`} />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="11.25" className="fill-paper-2 stroke-ink/25" strokeWidth="1.5" />
          {mark === "eth" ? (
            // Official geometry, scaled into the disc. The face opacities are the
            // logo's own greys read as one colour — without them the diamond
            // flattens into a lozenge and stops being the Ethereum mark.
            <g transform="translate(7.03 3.9) scale(0.0388)" className="fill-ink">
              <path opacity=".85" d="M127.96 0l-2.79 9.5v275.67l2.79 2.79 127.96-75.64z" />
              <path opacity=".45" d="M127.96 0L0 212.32l127.96 75.64V0z" />
              <path opacity=".8" d="M127.96 312.19l-1.57 1.92v98.2l1.57 4.6L256 236.59z" />
              <path opacity=".45" d="M127.96 416.91V312.19L0 236.59z" />
              <path d="M127.96 287.96l127.96-75.64-127.96-58.16z" />
              <path opacity=".8" d="M0 212.32l127.96 75.64V154.16z" />
            </g>
          ) : (
            <text {...GLYPH} fontSize="12.5" className="fill-ink">
              {monogram(symbol)}
            </text>
          )}
        </>
      )}
    </svg>
  );
}

/**
 * A market, as two overlapping coins.
 *
 * Base sits on top of quote, in the order the pair is written, so the stack
 * reads left to right the same way the label does.
 */
export function TokenPair({
  base,
  quote,
  size = 20,
  className,
}: {
  base: string;
  quote: string;
  size?: number;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex shrink-0 items-center", className)}>
      <TokenIcon symbol={base} size={size} className="relative z-10" />
      <TokenIcon symbol={quote} size={size} style={{ marginInlineStart: -size * 0.3 }} />
    </span>
  );
}

/** A ticker with its mark — the shape every amount, label and chip uses. */
export function TokenLabel({
  symbol,
  size = 14,
  className,
}: {
  symbol: string;
  size?: number;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap align-middle", className)}>
      <TokenIcon symbol={symbol} size={size} />
      {symbol}
    </span>
  );
}

/**
 * One letter, not two: at 14px a pair of characters inside a 14px disc is mush,
 * and the ticker itself is never more than a few pixels away.
 */
function monogram(symbol: string) {
  const letters = symbol.replace(/[^a-z]/gi, "");
  return (letters[0] ?? symbol[0] ?? "?").toUpperCase();
}
