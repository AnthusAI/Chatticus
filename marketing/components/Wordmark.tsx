import { cn } from "@/lib/utils";

type WordmarkProps = {
  className?: string;
  inverse?: boolean;
};

export function Wordmark({ className, inverse = false }: WordmarkProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 font-body text-[1.05rem] font-extrabold tracking-[-0.055em]",
        inverse ? "text-paper" : "text-ink",
        className,
      )}
    >
      <span aria-hidden="true" className="relative inline-flex h-7 w-7 items-center justify-center">
        <span className={cn("absolute left-0 top-1 h-4 w-5 rounded-[0.65rem_0.65rem_0.65rem_0.15rem]", inverse ? "bg-paper" : "bg-ink")} />
        <span className={cn("absolute bottom-1 right-0 h-4 w-5 rounded-[0.65rem_0.65rem_0.15rem_0.65rem]", inverse ? "bg-signal" : "bg-clay")} />
        <span className={cn("relative z-10 h-1 w-1 rounded-full", inverse ? "bg-ink" : "bg-paper")} />
        <span className={cn("relative z-10 ml-1 h-1 w-1 rounded-full", inverse ? "bg-ink" : "bg-paper")} />
      </span>
      <span>
        chatticus<span className="text-clay">.</span>
      </span>
    </span>
  );
}
