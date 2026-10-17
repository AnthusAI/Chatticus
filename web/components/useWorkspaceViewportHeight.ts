"use client";

import { useEffect } from "react";

export const WORKSPACE_VIEWPORT_HEIGHT_CSS_VARIABLE = "--workspace-viewport-height";
const ON_SCREEN_KEYBOARD_ANIMATION_MILLISECONDS = 500;

/**
 * Safari on iPad and iPhone can leave 100dvh at a stale, shorter value after the on-screen keyboard closes, the
 * toolbar resizes, the device rotates or the page returns from the back-forward cache, which cuts the workspace off
 * partway down the screen. The shell sizes itself from the measured inner height instead, re-measured on every one of
 * those events, and falls back to 100dvh before the first measurement.
 */
export function useWorkspaceViewportHeight(): void {
  useEffect(() => {
    const rootStyle = document.documentElement.style;
    let pendingAnimationFrame = 0;
    let pendingKeyboardAnimationTimeout = 0;
    const measureViewportHeight = () => {
      rootStyle.setProperty(WORKSPACE_VIEWPORT_HEIGHT_CSS_VARIABLE, `${window.innerHeight}px`);
    };
    const remeasureAfterLayoutSettles = () => {
      cancelAnimationFrame(pendingAnimationFrame);
      pendingAnimationFrame = requestAnimationFrame(measureViewportHeight);
      window.clearTimeout(pendingKeyboardAnimationTimeout);
      pendingKeyboardAnimationTimeout = window.setTimeout(measureViewportHeight, ON_SCREEN_KEYBOARD_ANIMATION_MILLISECONDS);
    };
    measureViewportHeight();
    const windowEventsThatChangeViewportHeight = ["resize", "orientationchange", "pageshow", "focusout"] as const;
    for (const eventName of windowEventsThatChangeViewportHeight) window.addEventListener(eventName, remeasureAfterLayoutSettles);
    window.visualViewport?.addEventListener("resize", remeasureAfterLayoutSettles);
    return () => {
      cancelAnimationFrame(pendingAnimationFrame);
      window.clearTimeout(pendingKeyboardAnimationTimeout);
      for (const eventName of windowEventsThatChangeViewportHeight) window.removeEventListener(eventName, remeasureAfterLayoutSettles);
      window.visualViewport?.removeEventListener("resize", remeasureAfterLayoutSettles);
      rootStyle.removeProperty(WORKSPACE_VIEWPORT_HEIGHT_CSS_VARIABLE);
    };
  }, []);
}
