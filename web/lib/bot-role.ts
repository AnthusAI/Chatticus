import type { CreativeRole } from "anthus-vultus";
import type { Bot } from "./api";

const creativeRoles: CreativeRole[] = [
  "Editor",
  "Reporter",
  "Copy Writer",
  "Illustrator",
];

export function creativeRoleForBot(bot: Bot): CreativeRole | null {
  const candidate = (bot.role ?? bot.memory.role ?? "").trim().toLowerCase();
  return (
    creativeRoles.find((role) => role.toLowerCase() === candidate) ??
    (candidate === "copywriter" ? "Copy Writer" : null)
  );
}

export function botRoleLabel(bot: Bot): string {
  return creativeRoleForBot(bot) ?? bot.role ?? bot.memory.role ?? "Role not assigned";
}
