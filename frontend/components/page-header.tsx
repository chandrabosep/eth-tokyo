"use client";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * One header shape for every page.
 *
 * The stat row sits BELOW the title block, never beside it. Crowding four
 * tiles onto the same line as the heading is what broke the spacing on
 * Positions and Hedge: at 1280px the tiles shrank to fit and the heading lost
 * its air, and below ~1100px they wrapped into a ragged second line. Stacking
 * gives the tiles a full-width grid that collapses predictably.
 */
export function PageHeader({
  title,
  description,
  stats,
}: {
  title: string;
  description?: string;
  stats?: StatSpec[];
}) {
  return (
    <section className="mt-8">
      <h2 className="font-display text-[30px] font-extrabold leading-none tracking-[-0.04em]">{title}</h2>
      {description && <p className="mt-2 max-w-lg text-[14px] leading-relaxed text-ink-soft">{description}</p>}

      {stats && stats.length > 0 && (
        // The weighted columns only make sense once there is room for them; below
        // `md` they squeeze every tile until the figures clip, so the grid falls
        // back to an even two-up.
        <div
          className="mt-5 grid grid-cols-2 gap-3 md:[grid-template-columns:var(--stat-cols)]"
          style={{ "--stat-cols": stats.map((s) => `${s.grow ?? 1}fr`).join(" ") } as React.CSSProperties}
        >
          {stats.map((s) => (
            <Stat key={s.label} {...s} />
          ))}
        </div>
      )}
    </section>
  );
}

export type StatSpec = {
  label: string;
  value?: string;
  tone?: "default" | "lime" | "peri" | "ink";
  accent?: boolean;
  mono?: boolean;
  /** flex-grow weight relative to siblings. Default 1. */
  grow?: number;
};

export function Stat({ label, value, tone = "default", accent, mono }: StatSpec) {
  return (
    <Card tone={tone} className="min-w-0 px-4 py-3.5">
      <div
        className={cn(
          "text-[10px] font-bold uppercase tracking-[0.12em]",
          tone === "ink" ? "text-paper/80" : "text-ink",
        )}
      >
        {label}
      </div>
      {value === undefined ? (
        <Skeleton className={cn("mt-2 h-7 w-24", tone === "ink" && "bg-paper/15")} />
      ) : (
        <div
          className={cn(
            // Fluid, because a two-up tile on a phone is ~130px wide and an
            // account value can run to seven figures. Truncation is the backstop,
            // not the plan: the card clips `overflow-hidden`, so without this a
            // long figure loses its last digits with no sign it was cut.
            "mt-1 truncate text-[clamp(1rem,4.3vw,1.625rem)] font-extrabold leading-none tracking-[-0.03em] tnum",
            mono && "font-mono text-[clamp(0.9rem,3.7vw,1.375rem)] tracking-normal",
            accent && "text-lime",
          )}
        >
          {value}
        </div>
      )}
    </Card>
  );
}

/** Body copy inside a card, kept on one gutter with the rest of the card. */
export function CardNote({
  tone = "default",
  children,
}: {
  tone?: "default" | "lime" | "flag" | "danger";
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "rounded-md border-rule border-line px-4 py-3 text-[13px] leading-relaxed shadow-xs",
        // Tinted backgrounds are darker than paper, so secondary ink drops
        // below 4.5:1 on them — those tones carry full-strength ink instead.
        tone === "default" && "bg-paper-2 text-ink-soft",
        tone === "lime" && "bg-lime-wash text-ink-soft",
        tone === "flag" && "bg-flag text-ink",
        tone === "danger" && "bg-destructive/12 text-ink",
      )}
    >
      {children}
    </p>
  );
}
