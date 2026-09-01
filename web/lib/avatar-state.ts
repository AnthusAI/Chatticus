import type { BotAvatarState } from "anthus-vultus";
import type { TurnEvent } from "./api";

export type AvatarActivity =
  | "idle"
  | "thinking"
  | "waiting"
  | "speaking"
  | "completed";

/** Derive avatar activity from the latest turn event and terminal status. */
export function avatarActivityFromTurn(
  events: TurnEvent[],
  turnStatus: "active" | "completed" | "failed" | "reconciling" | null,
  sending: boolean,
): AvatarActivity {
  if (turnStatus === "completed") {
    return "completed";
  }
  if (turnStatus === "failed" || turnStatus === "reconciling") {
    return "idle";
  }
  if (sending) {
    return "thinking";
  }

  let activity: AvatarActivity = "idle";
  for (const event of events) {
    activity = avatarActivityAfterEvent(activity, event.kind);
  }
  if (turnStatus === "active" && activity === "idle") {
    return "thinking";
  }
  return activity;
}

export function avatarActivityAfterEvent(
  current: AvatarActivity,
  kind: string,
): AvatarActivity {
  switch (kind) {
    case "turn.started":
      return "thinking";
    case "turn.waiting":
      return "waiting";
    case "turn.token":
      return "speaking";
    case "turn.completed":
      return "completed";
    case "turn.failed":
    case "turn.reconciling":
      return "idle";
    default:
      return current;
  }
}

export function botAvatarStateFromActivity(
  activity: AvatarActivity,
): BotAvatarState {
  switch (activity) {
    case "thinking":
      return "thinking";
    case "waiting":
      return "toolCalling";
    case "speaking":
      return "speakingOpen";
    case "completed":
      return "speakingComplete";
    case "idle":
    default:
      return "neutral";
  }
}

export function botAvatarAriaLabel(
  botName: string,
  activity: AvatarActivity,
): string {
  switch (activity) {
    case "thinking":
      return `${botName} is thinking`;
    case "waiting":
      return `${botName} is waiting`;
    case "speaking":
      return `${botName} is speaking`;
    case "completed":
      return `${botName} finished speaking`;
    case "idle":
    default:
      return `${botName} avatar`;
  }
}
