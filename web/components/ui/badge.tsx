import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-3 py-1 font-mono text-[0.68rem] font-medium uppercase tracking-[0.12em]",
  {
    variants: {
      variant: {
        default: "border-ink bg-ink text-paper",
        signal: "border-ink bg-signal text-ink",
        clay: "border-clay bg-clay/10 text-ink",
        outline: "border-line bg-transparent text-ink-soft",
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
