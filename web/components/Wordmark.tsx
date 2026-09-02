"use client";

import { useEffect, useRef, useState } from "react";
import { BotAvatar, CHATTICUS_MARK_MODEL } from "anthus-vultus";
import { cn } from "@/lib/utils";
import { reportHeroWordmarkVisibility, subscribeToHeroWordmarkVisibility } from "@/lib/wordmark-presence";

type WordmarkProps = {
  className?: string;
  inverse?: boolean;
  size?: number;
  /**
   * Live gaze/idle motion. `false` (default): always static. `true`:
   * always animated. `"auto"`: animated only while the hero mark (see
   * `reportsPresenceAsHero`) is not itself visible, so at most one
   * instance on the page is ever animating at a time.
   */
  animated?: boolean | "auto";
  /**
   * Marks this instance as "the hero mark": it reports its own on/off-
   * screen state so `animated="auto"` instances elsewhere know when to
   * take over, and it is itself always animated while visible (a
   * BotAvatar already pauses its own gaze once it individually scrolls
   * off-screen, so this doesn't need to track that separately).
   */
  reportsPresenceAsHero?: boolean;
  /** Set to false to render just the mark, without the "chatticus." text. */
  showText?: boolean;
};

const INK = "#11130f";
const PAPER = "#f2efe7";
const CLAY = "#ef6a47";
const SIGNAL = "#b8f34a";

export function Wordmark({
  className,
  inverse = false,
  size = 28,
  animated = false,
  reportsPresenceAsHero = false,
  showText = true,
}: WordmarkProps) {
  const rootElementRef = useRef<HTMLSpanElement>(null);
  const [heroIsVisible, setHeroIsVisible] = useState(false);

  useEffect(() => {
    if (animated !== "auto") {
      return undefined;
    }
    return subscribeToHeroWordmarkVisibility(setHeroIsVisible);
  }, [animated]);

  useEffect(() => {
    if (!reportsPresenceAsHero) {
      return undefined;
    }
    const element = rootElementRef.current;
    if (!element || typeof IntersectionObserver !== "function") {
      reportHeroWordmarkVisibility(true);
      return () => reportHeroWordmarkVisibility(false);
    }
    const observer = new IntersectionObserver(
      ([entry]) => reportHeroWordmarkVisibility(entry?.isIntersecting ?? false),
      { threshold: 0 },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      reportHeroWordmarkVisibility(false);
    };
  }, [reportsPresenceAsHero]);

  const isAnimated = reportsPresenceAsHero || animated === true || (animated === "auto" && !heroIsVisible);

  return (
    <span
      ref={rootElementRef}
      className={cn(
        "inline-flex items-center gap-2 font-body text-[1.05rem] font-extrabold tracking-[-0.055em]",
        inverse ? "text-paper" : "text-ink",
        className,
      )}
    >
      <span aria-hidden="true" className="inline-flex">
        <BotAvatar
          model={CHATTICUS_MARK_MODEL}
          size={size}
          shadowColor={inverse ? PAPER : INK}
          accentColor={inverse ? SIGNAL : CLAY}
          lightColor={inverse ? INK : PAPER}
          neutralIdleMode="static"
          gaze={isAnimated ? "pointer" : "none"}
        />
      </span>
      {showText ? (
        <span>
          chatticus<span className="text-clay">.</span>
        </span>
      ) : null}
    </span>
  );
}
