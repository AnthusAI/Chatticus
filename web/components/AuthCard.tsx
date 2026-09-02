import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type AuthCardProps = {
  title?: string;
  children: ReactNode;
  className?: string;
};

export function AuthCard({ title, children, className }: AuthCardProps) {
  return (
    <section className={cn("rounded-2xl bg-surface-raised p-4 text-surface-foreground sm:p-5", className)}>
      {title ? <h2 className="font-body text-sm font-extrabold">{title}</h2> : null}
      <div className="mt-2 grid gap-2">{children}</div>
    </section>
  );
}

export const authFieldClassName =
  "w-full rounded-full bg-surface px-4 py-2.5 font-body text-sm text-surface-foreground placeholder:text-surface-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal";

export const authButtonClassName =
  "w-fit rounded-full bg-ink px-4 py-2 font-body text-xs font-bold text-paper transition disabled:opacity-40";

export const authStatusClassName = "font-mono text-[0.7rem] text-surface-foreground/70";

export const authErrorClassName = "font-mono text-[0.7rem] text-clay";

export const authOkClassName = "font-mono text-[0.7rem] text-sea";
