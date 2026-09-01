import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { botRoleLabel, creativeRoleForBot } from "./bot-role";
import type { Bot } from "./api";

function bot(role?: Bot["role"], memoryRole?: string): Bot {
  return {
    bot_id: "bot-1",
    tenant_id: "tenant-1",
    user_id: "user-1",
    name: "Nell",
    role,
    memory: memoryRole ? { role: memoryRole } : {},
  };
}

describe("bot roles", () => {
  it("uses explicit creative roles to select a Vultus model", () => {
    assert.equal(creativeRoleForBot(bot("Reporter")), "Reporter");
    assert.equal(creativeRoleForBot(bot("Copy Writer")), "Copy Writer");
  });

  it("uses only the persisted role and does not infer one from memory", () => {
    assert.equal(creativeRoleForBot(bot(undefined, "Copy Writer")), null);
    assert.equal(botRoleLabel(bot()), "Role not assigned");
  });
});
