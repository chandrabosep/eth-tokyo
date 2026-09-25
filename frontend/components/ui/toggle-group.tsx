"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

/**
 * Two-state segmented control on Radix Tabs (keyboard behaviour comes free).
 * The active segment is a solid ink pill — the same contrast jump the
 * reference uses for its active month chip.
 */
const SegmentedRoot = TabsPrimitive.Root;

const SegmentedList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("inline-flex w-full items-center gap-1 rounded-pill border-rule border-line bg-card p-1 shadow-xs", className)}
    {...props}
  />
));
SegmentedList.displayName = TabsPrimitive.List.displayName;

const SegmentedItem = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex-1 whitespace-nowrap rounded-pill px-3 py-2 text-xs font-bold text-ink-soft",
      "transition-colors [transition-duration:120ms] ease-out hover:text-ink",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      "data-[state=active]:bg-ink data-[state=active]:text-paper",
      className,
    )}
    {...props}
  />
));
SegmentedItem.displayName = TabsPrimitive.Trigger.displayName;

export { SegmentedRoot, SegmentedList, SegmentedItem };
