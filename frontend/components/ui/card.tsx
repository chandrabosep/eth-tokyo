import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The tactile surface. `tone` maps a card onto the palette's three roles:
 * paper (default), a coloured stat block, or ink used as a surface — the
 * reference's black panel, tinted off pure black.
 */
type Tone = "default" | "lime" | "peri" | "ink";

const toneClass: Record<Tone, string> = {
  default: "bg-card text-ink",
  lime: "bg-lime text-ink",
  peri: "bg-peri text-ink",
  ink: "bg-ink text-paper",
};

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { tone?: Tone }>(
  ({ className, tone = "default", ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "overflow-hidden rounded-lg border-rule border-line shadow-md",
        toneClass[tone],
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col gap-1 p-5", className)} {...props} />
  ),
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("font-display text-lg font-extrabold tracking-tight", className)} {...props} />
  ),
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-[13px] leading-relaxed text-ink-soft", className)} {...props} />
  ),
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("p-5 pt-0", className)} {...props} />,
);
CardContent.displayName = "CardContent";

export { Card, CardHeader, CardTitle, CardDescription, CardContent };
