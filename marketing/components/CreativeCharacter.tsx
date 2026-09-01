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
};

export function CreativeCharacter({
  role,
  state,
  label,
  className,
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
    <div className={className}>
      <BotAvatar
        model={creativeDeskModelForRole(role)}
        state={stateMap[state]}
        size={240}
        lightColor="transparent"
        ariaLabel={label}
      />
    </div>
  );
}
