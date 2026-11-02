import type { ButtonHTMLAttributes } from "react";
import { cn } from "./utils";

/** A scoped button; the host supplies its palette through chat custom properties. */
export function ChatButton({ variant, size, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "ghost"; size?: "icon" }) {
  return <button {...props} className={cn(
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-bold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/30 disabled:pointer-events-none disabled:opacity-50",
    variant === "ghost" ? "bg-transparent text-surface-foreground hover:bg-surface-foreground/10" : "bg-signal text-ink",
    size === "icon" && "h-11 w-11 p-0", className,
  )} />;
}
