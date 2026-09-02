import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-3 py-1 font-mono text-[0.68rem] font-medium uppercase tracking-[0.12em]",
  {
    variants: {
      variant: {
        default: "bg-ink text-paper",
        signal: "bg-signal text-ink",
        clay: "bg-clay/15 text-surface-foreground",
        outline: "bg-surface-high text-surface-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { badgeVariants };
