"use client";

import { BotAvatar, type BotAvatarState, creativeDeskModelForRole, type CreativeRole } from "anthus-vultus";

type BotAvatarViewProps = {
  botName: string;
  state: BotAvatarState;
  size?: number;
  ariaLabel?: string;
  className?: string;
};

function getRoleForBotName(name: string): CreativeRole {
  const lower = name.toLowerCase();
  if (lower.includes("edit")) return "Editor";
  if (lower.includes("report") || lower.includes("research")) return "Reporter";
  if (lower.includes("copy") || lower.includes("write")) return "Copy Writer";
  return "Illustrator";
}

export function BotAvatarView({
  botName,
  state,
  size = 56,
  ariaLabel,
  className,
}: BotAvatarViewProps) {
  const model = creativeDeskModelForRole(getRoleForBotName(botName));

  return (
    <div className={className}>
      <BotAvatar
        model={model}
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
