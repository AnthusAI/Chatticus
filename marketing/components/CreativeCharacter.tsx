"use client";

import {
  BotAvatar,
  creativeDeskModelForRole,
  type CreativeMotionState,
  type CreativeRole,
  type BotAvatarState,
} from "anthus-vultus";

type CreativeCharacterProps = {
  role: CreativeRole;
  state: CreativeMotionState;
  label: string;
  className?: string;
  paused?: boolean;
  decorative?: boolean;
};

export function CreativeCharacter({
  role,
  state,
  label,
  className,
  paused = false,
  decorative = false,
}: CreativeCharacterProps) {
  const stateMap: Record<CreativeMotionState, BotAvatarState> = {
    ready: "neutral",
    gathering: "thinking",
    drafting: "speakingOpen",
    drawing: "toolCalling",
    editing: "toolResponse",
    complete: "speakingComplete",
  };

  return (
    <div className={className} aria-hidden={decorative || undefined}>
      <BotAvatar
        model={creativeDeskModelForRole(role)}
        state={stateMap[state]}
        size={240}
        lightColor="transparent"
        ariaLabel={decorative ? undefined : label}
        paused={paused}
      />
    </div>
  );
}
