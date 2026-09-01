import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { botRoleLabel, creativeRoleForBot } from "./bot-role";
import type { Bot } from "./api";

function bot(role?: string, memoryRole?: string): Bot {
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
    assert.equal(creativeRoleForBot(bot(undefined, "Copy Writer")), "Copy Writer");
    assert.equal(creativeRoleForBot(bot("copywriter")), "Copy Writer");
  });

  it("does not invent a role when none is stored", () => {
    assert.equal(creativeRoleForBot(bot()), null);
    assert.equal(botRoleLabel(bot()), "Role not assigned");
  });
});
