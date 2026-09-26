"use client";

import { useId, useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { fmt } from "@/lib/options";

export type PayoffPoint = { price: number; perp: number; opts: number; total: number };

/**
 * Payoff curve for the built structure.
 *
 * Hand-drawn SVG rather than a charting library: three polylines, a zero rule and a few markers do
 * not justify 40kB of dependency, and a library's defaults would fight the rest of the design
 * system anyway.
 *
 * Reading it: the combined line is the one that matters — it is the perp and the options together,
 * which is the whole reason the Hyperliquid position is imported. Where the combined line flattens
 * out below spot, the structure has stopped the bleeding; where it sits below the perp line, the
 * structure is costing more than it returns at that price.
 *
 * Premium is excluded, for the same reason it is excluded from the table: it depends on realised
 * swap volume between now and close. Written legs earn it on top of this curve, bought legs pay it.
 */
export function PayoffChart({
  points,
  spot,
  strikes,
  hasPerp,
}: {
  points: PayoffPoint[];
  spot?: number;
  strikes: number[];
  hasPerp: boolean;
}) {
  const gid = useId();
  const [hover, setHover] = useState<number | null>(null);

  const W = 560;
  const H = 240;
  const PAD = { t: 14, r: 14, b: 26, l: 54 };

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const xs = points.map((p) => p.price);
    const ys = points.flatMap((p) => [p.perp, p.opts, p.total]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    let minY = Math.min(...ys, 0);
    let maxY = Math.max(...ys, 0);
    // Pad the vertical range so the curve never touches the frame.
    const span = maxY - minY || 1;
    minY -= span * 0.12;
    maxY += span * 0.12;

    const x = (v: number) => PAD.l + ((v - minX) / (maxX - minX || 1)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - minY) / (maxY - minY || 1)) * (H - PAD.t - PAD.b);
    const line = (key: "perp" | "opts" | "total") =>
      points.map((p) => `${x(p.price).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");

    return { x, y, minX, maxX, minY, maxY, line };
  }, [points]);

  if (!geom) return null;

  const { x, y, minY, maxY, line } = geom;
  const zeroY = y(0);
  const active = hover !== null ? points[hover] : null;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Payoff curve across ETH prices from $${fmt(geom.minX, 0)} to $${fmt(geom.maxX, 0)}`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          {/* Fill under the combined line, clipped to whichever side of zero it sits on. */}
          <linearGradient id={`${gid}-up`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="oklch(var(--color-lime) / 0.35)" />
            <stop offset="100%" stopColor="oklch(var(--color-lime) / 0)" />
          </linearGradient>
          <linearGradient id={`${gid}-dn`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="oklch(var(--color-peri) / 0.35)" />
            <stop offset="100%" stopColor="oklch(var(--color-peri) / 0)" />
          </linearGradient>
          <clipPath id={`${gid}-above`}>
            <rect x="0" y="0" width={W} height={Math.max(zeroY, 0)} />
          </clipPath>
          <clipPath id={`${gid}-below`}>
            <rect x="0" y={zeroY} width={W} height={Math.max(H - zeroY, 0)} />
          </clipPath>
        </defs>

        {/* y grid */}
        {[maxY, (maxY + minY) / 2, minY].map((v, i) => (
          <g key={i}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(v)}
              y2={y(v)}
              stroke="oklch(var(--color-line))"
              strokeWidth="1"
            />
            <text
              x={PAD.l - 8}
              y={y(v) + 3.5}
              textAnchor="end"
              className="fill-[oklch(var(--color-ink-soft))] font-mono text-[9px]"
            >
              {v >= 0 ? "+" : "−"}
              {Math.abs(v) >= 1000 ? `${(Math.abs(v) / 1000).toFixed(1)}k` : Math.abs(v).toFixed(0)}
            </text>
          </g>
        ))}

        {/* strike ticks */}
        {strikes.map((s) => (
          <line
            key={s}
            x1={x(s)}
            x2={x(s)}
            y1={PAD.t}
            y2={H - PAD.b}
            stroke="oklch(var(--color-line))"
            strokeWidth="1"
            strokeDasharray="2 4"
          />
        ))}

        {/* breakeven rule */}
        <line
          x1={PAD.l}
          x2={W - PAD.r}
          y1={zeroY}
          y2={zeroY}
          stroke="oklch(var(--color-ink) / 0.45)"
          strokeWidth="1.5"
        />

        {/* combined, filled to the zero line */}
        <polygon
          points={`${PAD.l},${zeroY} ${line("total")} ${W - PAD.r},${zeroY}`}
          fill={`url(#${gid}-up)`}
          clipPath={`url(#${gid}-above)`}
        />
        <polygon
          points={`${PAD.l},${zeroY} ${line("total")} ${W - PAD.r},${zeroY}`}
          fill={`url(#${gid}-dn)`}
          clipPath={`url(#${gid}-below)`}
        />

        {hasPerp && (
          <polyline
            points={line("perp")}
            fill="none"
            stroke="oklch(var(--color-peri-deep))"
            strokeWidth="1.75"
            strokeDasharray="5 4"
          />
        )}
        <polyline
          points={line("opts")}
          fill="none"
          stroke="oklch(var(--color-lime-deep))"
          strokeWidth="1.75"
          strokeDasharray="5 4"
        />
        <polyline
          points={line("total")}
          fill="none"
          stroke="oklch(var(--color-ink))"
          strokeWidth="2.75"
          strokeLinejoin="round"
        />

        {/* spot marker */}
        {spot !== undefined && spot >= geom.minX && spot <= geom.maxX && (
          <g>
            <line
              x1={x(spot)}
              x2={x(spot)}
              y1={PAD.t}
              y2={H - PAD.b}
              stroke="oklch(var(--color-flag-deep))"
              strokeWidth="2"
            />
            <text
              x={x(spot)}
              y={PAD.t + 9}
              textAnchor="middle"
              className="fill-[oklch(var(--color-flag-deep))] font-mono text-[9px] font-bold"
            >
              spot
            </text>
          </g>
        )}

        {/* x labels: first, middle, last */}
        {[0, Math.floor(points.length / 2), points.length - 1].map((i) => (
          <text
            key={i}
            x={x(points[i].price)}
            y={H - 8}
            textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
            className="fill-[oklch(var(--color-ink-soft))] font-mono text-[9px]"
          >
            ${points[i].price.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </text>
        ))}

        {/* hover readout */}
        {active && (
          <g pointerEvents="none">
            <line
              x1={x(active.price)}
              x2={x(active.price)}
              y1={PAD.t}
              y2={H - PAD.b}
              stroke="oklch(var(--color-ink) / 0.35)"
              strokeWidth="1"
            />
            <circle cx={x(active.price)} cy={y(active.total)} r="4" fill="oklch(var(--color-ink))" />
          </g>
        )}

        {/* invisible hit strips, one per sample */}
        {points.map((p, i) => (
          <rect
            key={i}
            x={x(p.price) - (W - PAD.l - PAD.r) / points.length / 2}
            y={PAD.t}
            width={(W - PAD.l - PAD.r) / points.length}
            height={H - PAD.t - PAD.b}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>

      <figcaption className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <div className="flex flex-wrap items-center gap-3 text-[10px] font-bold uppercase tracking-[0.08em]">
          {hasPerp && <Key color="peri-deep" dashed label="Perp" />}
          <Key color="lime-deep" dashed label="Options" />
          <Key color="ink" label="Combined" />
        </div>
        <span className="font-mono text-[11px] text-ink-soft tnum">
          {active ? (
            <>
              ${active.price.toLocaleString(undefined, { maximumFractionDigits: 0 })} → combined{" "}
              <strong className={cn("font-bold", active.total >= 0 ? "text-lime-deep" : "text-peri-deep")}>
                {active.total >= 0 ? "+" : ""}
                {fmt(active.total, 2)}
              </strong>
            </>
          ) : (
            "hover for a readout"
          )}
        </span>
      </figcaption>
    </figure>
  );
}

function Key({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-ink-soft">
      <svg width="16" height="6" aria-hidden="true">
        <line
          x1="0"
          y1="3"
          x2="16"
          y2="3"
          stroke={`oklch(var(--color-${color}))`}
          strokeWidth={dashed ? 1.75 : 2.75}
          strokeDasharray={dashed ? "4 3" : undefined}
        />
      </svg>
      {label}
    </span>
  );
}
