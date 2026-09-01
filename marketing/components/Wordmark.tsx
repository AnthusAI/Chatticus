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
      <span
        aria-hidden="true"
        className={cn(
          "relative inline-flex h-7 w-7 items-center justify-center rounded-[45%_55%_48%_52%] border-2",
          inverse ? "border-paper" : "border-ink",
        )}
      >
        <span
          className={cn(
            "h-2.5 w-2.5 rounded-full",
            inverse ? "bg-signal" : "bg-ink",
          )}
        />
        <span className="absolute -top-1 right-0 h-2 w-2 rounded-full border-2 border-ink bg-signal" />
      </span>
      <span>
        chatticus<span className="text-clay">.</span>
      </span>
    </span>
  );
}
