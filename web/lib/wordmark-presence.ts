"use client";

/**
 * Cross-instance handoff for the animated Chatticus mark: only one
 * instance should ever be live at a time. The hero's mark (large, at the
 * top of the page) reports its own on/off-screen state here; the header's
 * mark (small, always in the sticky nav) subscribes and animates only
 * when the hero's mark is not currently visible. This is Chatticus-specific
 * page layout policy, not something Vultus needs to know about — each
 * BotAvatar instance already pauses its own gaze when it individually
 * scrolls off-screen; this module only decides which instance gets to be
 * the live one when both are technically on-screen at once (which cannot
 * happen with a top-of-page hero and a *sticky* header, but the module
 * doesn't assume that positioning).
 */
type PresenceListener = (heroVisible: boolean) => void;

let heroVisible = false;
const listeners = new Set<PresenceListener>();

export function reportHeroWordmarkVisibility(visible: boolean): void {
  if (visible === heroVisible) {
    return;
  }
  heroVisible = visible;
  listeners.forEach((listener) => listener(heroVisible));
}

/** Calls back immediately with the current value, then on every change. */
export function subscribeToHeroWordmarkVisibility(listener: PresenceListener): () => void {
  listener(heroVisible);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
