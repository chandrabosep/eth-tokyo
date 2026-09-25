import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Pill buttons with a hard offset shadow, pressed by travelling along the
 * shadow's axis until it closes (see `.press` in globals.css). Focus is a
 * solid ring that appears instantly — never transitioned.
 */
const buttonVariants = cva(
  "press inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill border-rule border-line font-semibold " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-paper " +
    "disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none " +
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-ink text-paper shadow-sm hover:bg-ink-2",
        lime: "bg-lime text-ink shadow-sm hover:bg-lime-deep",
        peri: "bg-peri text-ink shadow-sm hover:bg-peri-deep",
        outline: "bg-card text-ink shadow-sm hover:bg-paper-2",
        ghost: "border-transparent shadow-none text-ink-soft hover:bg-paper-2 hover:text-ink",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:opacity-90",
        // Chain-side actions: tinted wash so the column reads call vs put at a glance.
        call: "bg-lime-wash text-ink shadow-xs hover:bg-lime",
        put: "bg-peri-wash text-ink shadow-xs hover:bg-peri",
      },
      size: {
        default: "h-10 px-5 text-sm",
        sm: "h-9 px-4 text-[13px]",
        xs: "h-7 px-3 text-[11px] font-bold tracking-wide",
        lg: "h-12 px-7 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
