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
    <section className="mt-9">
      <h2 className="font-display text-[30px] font-extrabold leading-none tracking-[-0.04em]">{title}</h2>
      {description && <p className="mt-2.5 max-w-xl text-[15px] leading-relaxed text-ink-soft">{description}</p>}

      {stats && stats.length > 0 && (
        <div
          className="mt-6 grid gap-3.5"
          style={{ gridTemplateColumns: stats.map((s) => `${s.grow ?? 1}fr`).join(" ") }}
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
            "mt-1 text-[26px] font-extrabold leading-none tracking-[-0.03em] tnum",
            mono && "font-mono text-[22px] tracking-normal",
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
        "rounded-md border-rule border-line p-3.5 text-[12.5px] leading-relaxed shadow-xs",
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
