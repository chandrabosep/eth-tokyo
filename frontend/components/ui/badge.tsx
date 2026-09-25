import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-pill border-rule border-line px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em]",
  {
    variants: {
      variant: {
        default: "bg-lime text-ink",
        secondary: "bg-paper-2 text-ink",
        outline: "bg-card text-ink",
        call: "bg-lime text-ink",
        put: "bg-peri text-ink",
        itm: "bg-flag text-ink",
        ink: "bg-ink text-paper",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
