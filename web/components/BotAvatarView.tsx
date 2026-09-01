"use client";

import { BotAvatar, type BotAvatarState } from "anthus-vultus";

type BotAvatarViewProps = {
  botName: string;
  state: BotAvatarState;
  size?: number;
  ariaLabel?: string;
  className?: string;
};

export function BotAvatarView({
  botName,
  state,
  size = 56,
  ariaLabel,
  className,
}: BotAvatarViewProps) {
  return (
    <div className={className}>
      <BotAvatar
        state={state}
        size={size}
        neutralIdleMode="static"
        shadowColor="#2a3441"
        lightColor="#e7ecf3"
        ariaLabel={ariaLabel ?? `${botName} avatar`}
      />
    </div>
  );
}
