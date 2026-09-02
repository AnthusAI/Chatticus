"use client";

import {
  type BotAvatarState,
  characterColorProps,
  characterGazeConfig,
  creativeCharacterModelForRole,
  creativeCharacterSpecForRole,
  type CreativeRole,
  BotAvatar,
} from "anthus-vultus";

type BotAvatarViewProps = {
  botName: string;
  state: BotAvatarState;
  size?: number;
  ariaLabel?: string;
  className?: string;
  /** Skip name-based role inference and use this role directly (e.g. scripted demo data that wants a specific character regardless of name). */
  role?: CreativeRole;
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
  role: roleOverride,
}: BotAvatarViewProps) {
  const role = roleOverride ?? getRoleForBotName(botName);
  const spec = creativeCharacterSpecForRole(role);
  const model = creativeCharacterModelForRole(role);

  return (
    <div className={className}>
      <BotAvatar
        model={model}
        state={state}
        size={size}
        neutralIdleMode="static"
        gaze="pointer"
        gazeConfig={characterGazeConfig(spec)}
        {...characterColorProps(spec)}
        ariaLabel={ariaLabel ?? `${botName} avatar`}
      />
    </div>
  );
}
