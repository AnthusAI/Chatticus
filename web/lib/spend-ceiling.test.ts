import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MeOrganization } from "./me";
import {
  SPEND_CEILING_FORM_TITLE,
  SPEND_CEILING_INVALID_MESSAGE,
  SPEND_CEILING_MEMBER_GUIDANCE,
  canRaiseSpendCeiling,
  parseSpendCeilingInput,
  spendCeilingConfirmationText,
  spendCeilingErrorText,
  spendCeilingViewText,
} from "./spend-ceiling";

const org = (overrides: Partial<MeOrganization>): MeOrganization => ({
  tenant_id: "acme",
  name: "Acme Labs",
  status: "enabled",
  role: "owner",
  ...overrides,
});

describe("parseSpendCeilingInput", () => {
  it("accepts whole and two-decimal dollar amounts and trims spaces", () => {
    assert.deepEqual(parseSpendCeilingInput("500"), { ok: true, amount: "500" });
    assert.deepEqual(parseSpendCeilingInput(" 250.50 "), { ok: true, amount: "250.50" });
  });

  it("rejects zero, negatives, words, empties and too many decimals", () => {
    for (const raw of ["0", "0.00", "-5", "lots", "", "  ", "1.234", "$5", "1e3", "5,000"]) {
      assert.deepEqual(parseSpendCeilingInput(raw), { ok: false, message: SPEND_CEILING_INVALID_MESSAGE }, raw);
    }
  });
});

describe("who sees the ceiling control", () => {
  it("offers the raise form to an owner only while computer work is paused", () => {
    assert.equal(canRaiseSpendCeiling(org({ computer_work_paused: true })), true);
    assert.equal(canRaiseSpendCeiling(org({ computer_work_paused: false })), false);
    assert.equal(canRaiseSpendCeiling(org({})), false);
  });

  it("never offers it to a member or when the organization is unknown", () => {
    assert.equal(canRaiseSpendCeiling(org({ role: "member", computer_work_paused: true })), false);
    assert.equal(canRaiseSpendCeiling(undefined), false);
  });

  it("shows owners the form title, members the guidance, and nobody anything when not paused", () => {
    assert.equal(spendCeilingViewText(org({ computer_work_paused: true })), SPEND_CEILING_FORM_TITLE);
    assert.equal(
      spendCeilingViewText(org({ role: "member", computer_work_paused: true })),
      SPEND_CEILING_MEMBER_GUIDANCE,
    );
    assert.equal(spendCeilingViewText(org({})), null);
    assert.equal(spendCeilingViewText(undefined), null);
  });
});

describe("spendCeilingConfirmationText", () => {
  it("states the new ceiling", () => {
    assert.equal(spendCeilingConfirmationText("500"), "Monthly AWS spend ceiling is now $500.");
  });
});

describe("spendCeilingErrorText", () => {
  it("explains a refusal for a non-owner", () => {
    assert.equal(
      spendCeilingErrorText(new Error('HTTP 403: {"detail":"User is not an owner"}')),
      "Only an owner of this organization can change the ceiling.",
    );
  });

  it("surfaces the server's own reason for a rejected amount", () => {
    assert.equal(
      spendCeilingErrorText(new Error('HTTP 400: {"detail":"monthly_aws_spend_ceiling_usd must be a positive USD amount."}')),
      "monthly_aws_spend_ceiling_usd must be a positive USD amount.",
    );
  });

  it("falls back to a plain retry message for anything else", () => {
    assert.equal(spendCeilingErrorText(new Error("network down")), "The ceiling could not be changed. Try again.");
    assert.equal(spendCeilingErrorText(new Error("HTTP 500: not json")), "The ceiling could not be changed. Try again.");
    assert.equal(spendCeilingErrorText("x"), "The ceiling could not be changed. Try again.");
  });
});
