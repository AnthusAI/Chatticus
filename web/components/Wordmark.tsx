"use client";

import { useEffect, useRef, useState } from "react";
import { BotAvatar, CHATTICUS_MARK_MODEL } from "anthus-vultus";
import { cn } from "@/lib/utils";
import { reportHeroWordmarkVisibility, subscribeToHeroWordmarkVisibility } from "@/lib/wordmark-presence";

type WordmarkProps = {
  className?: string;
  /**
   * Force a colorway regardless of the system color scheme -- for a mark
   * placed on a deliberately fixed-dark block (e.g. FinalCta's bg-ink
   * card) that should always render inverse even in light mode. Omit this
   * on a normal page surface: the mark then follows prefers-color-scheme
   * automatically, matching the surface tokens it sits on.
   */
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
  /** Set to false to render just the mark, without the "Chatticus" text. */
  showText?: boolean;
};

const PAPER = "#f2efe7";
const CLAY = "#ef6a47";
/* Mirrors --surface-2 (see app/globals.css): the flat "most-attention"
   background step, already designed to be a gentle light/dark-mirrored
   pair rather than a stark black/white extreme. */
const SHADOW_BUBBLE_LIGHT = "#d9d3c1";
const SHADOW_BUBBLE_DARK = "#2a2e22";

function useSystemPrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    setPrefersDark(query.matches);
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return prefersDark;
}

export function Wordmark({
  className,
  inverse,
  size = 28,
  animated = false,
  reportsPresenceAsHero = false,
  showText = true,
}: WordmarkProps) {
  const rootElementRef = useRef<HTMLSpanElement>(null);
  const [heroIsVisible, setHeroIsVisible] = useState(false);
  const systemPrefersDark = useSystemPrefersDark();
  const resolvedInverse = inverse ?? systemPrefersDark;

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
        resolvedInverse ? "text-paper" : "text-ink",
        className,
      )}
    >
      <span aria-hidden="true" className="inline-flex">
        <BotAvatar
          model={CHATTICUS_MARK_MODEL}
          size={size}
          shadowColor={resolvedInverse ? SHADOW_BUBBLE_DARK : SHADOW_BUBBLE_LIGHT}
          accentColor={CLAY}
          lightColor={PAPER}
          neutralIdleMode="static"
          gaze={isAnimated ? "pointer" : "none"}
        />
      </span>
      {showText ? <span>Chatticus</span> : null}
    </span>
  );
}
