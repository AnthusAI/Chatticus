"use client";

import {
  BotAvatar,
  creativeDeskModelForRole,
  type BotAvatarState,
  type CreativeRole,
} from "anthus-vultus";

type BotAvatarViewProps = {
  botName: string;
  state: BotAvatarState;
  size?: number;
  ariaLabel?: string;
  className?: string;
  modelRole?: CreativeRole | null;
};

export function BotAvatarView({
  botName,
  state,
  size = 56,
  ariaLabel,
  className,
  modelRole,
}: BotAvatarViewProps) {
  return (
    <div className={className}>
      <BotAvatar
        model={modelRole ? creativeDeskModelForRole(modelRole) : undefined}
        state={state}
        size={size}
        neutralIdleMode="bored-random"
        shadowColor="#11130f"
        lightColor="#f2efe7"
        ariaLabel={ariaLabel ?? `${botName} avatar`}
      />
    </div>
  );
}
