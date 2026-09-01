import type { CreativeRole } from "anthus-vultus";
import type { Bot } from "./api";

const creativeRoles: CreativeRole[] = [
  "Editor",
  "Reporter",
  "Copy Writer",
  "Illustrator",
];

export function creativeRoleForBot(bot: Bot): CreativeRole | null {
  return creativeRoles.find((role) => role === bot.role) ?? null;
}

export function botRoleLabel(bot: Bot): string {
  return creativeRoleForBot(bot) ?? "Role not assigned";
}
