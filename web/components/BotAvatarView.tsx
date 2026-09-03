"use client";

import { useEffect, useState } from "react";
import {
  type BotAvatarState,
  characterColorProps,
  characterGazeConfig,
  creativeCharacterModelForRole,
  creativeCharacterSpecForRole,
  type CreativeCharacterRole,
  BotAvatar,
} from "anthus-vultus";

type BotAvatarViewProps = {
  botName: string;
  state: BotAvatarState;
  size?: number;
  ariaLabel?: string;
  className?: string;
  /** Skip name-based role inference and use this role directly (e.g. scripted demo data that wants a specific character regardless of name). */
  role?: CreativeCharacterRole;
  /**
   * A shared DOM element (a "typing…" indicator, a just-arrived message)
   * this avatar should notice and look toward instead of its usual
   * pointer-tracking/wander. Every avatar using this prop reacts on its own
   * randomized delay -- see useStochasticFocusElement -- so a whole roster
   * doesn't snap to attention on the same frame.
   */
  focusElement?: Element | null;
};

/** Delay range before an avatar "notices" a new shared focus target, and before it looks away once the target clears -- staggers a roster of avatars instead of having them all react in lockstep. */
const NOTICE_DELAY_MIN_MS = 120;
const NOTICE_DELAY_MAX_MS = 900;
const RELEASE_DELAY_MIN_MS = 80;
const RELEASE_DELAY_MAX_MS = 380;

function useStochasticFocusElement(focusElement: Element | null | undefined): Element | null {
  const [delayedFocusElement, setDelayedFocusElement] = useState<Element | null>(null);

  useEffect(() => {
    if (!focusElement) {
      const delay = RELEASE_DELAY_MIN_MS + Math.random() * (RELEASE_DELAY_MAX_MS - RELEASE_DELAY_MIN_MS);
      const timeoutId = setTimeout(() => setDelayedFocusElement(null), delay);
      return () => clearTimeout(timeoutId);
    }
    const delay = NOTICE_DELAY_MIN_MS + Math.random() * (NOTICE_DELAY_MAX_MS - NOTICE_DELAY_MIN_MS);
    const timeoutId = setTimeout(() => setDelayedFocusElement(focusElement), delay);
    return () => clearTimeout(timeoutId);
  }, [focusElement]);

  return delayedFocusElement;
}

function getRoleForBotName(name: string): CreativeCharacterRole {
  const lower = name.toLowerCase();
  if (lower.includes("edit")) return "Editor";
  if (lower.includes("research")) return "Researcher";
  if (lower.includes("report")) return "Reporter";
  if (lower.includes("copy") || lower.includes("write")) return "Copy Writer";
  if (lower.includes("produc")) return "Producer";
  if (lower.includes("archiv")) return "Archivist";
  if (lower.includes("analy")) return "Analyst";
  return "Illustrator";
}

export function BotAvatarView({
  botName,
  state,
  size = 56,
  ariaLabel,
  className,
  role: roleOverride,
  focusElement,
}: BotAvatarViewProps) {
  const role = roleOverride ?? getRoleForBotName(botName);
  const spec = creativeCharacterSpecForRole(role);
  const model = creativeCharacterModelForRole(role);
  const delayedFocusElement = useStochasticFocusElement(focusElement);

  return (
    <div className={className}>
      <BotAvatar
        model={model}
        state={state}
        size={size}
        neutralIdleMode="static"
        gaze="pointer"
        gazeConfig={characterGazeConfig(spec)}
        focusElement={delayedFocusElement}
        {...characterColorProps(spec)}
        ariaLabel={ariaLabel ?? `${botName} avatar`}
      />
    </div>
  );
}
