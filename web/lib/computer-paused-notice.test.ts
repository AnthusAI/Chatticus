import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ComputerPausedNotice } from "../components/ComputerPausedNotice";
import type { MeOrganization } from "./me";

// tsx compiles JSX to React.createElement (tsconfig has jsx: preserve for Next), so the
// component needs a global React at render time. Test-only; the app build is unaffected.
(globalThis as { React?: unknown }).React = React;

/**
 * Guard for the spend-ceiling banner (chatticus-a106ea). #338 added it, the
 * workspace rewrite (#346) silently dropped it, and every test stayed green
 * because none rendered it. This renders the real component.
 */
const org = (overrides: Partial<MeOrganization>): MeOrganization => ({
  tenant_id: "anthus",
  name: "Anthus",
  status: "enabled",
  role: "owner",
  ...overrides,
});
const activeOrg = { tenantId: "anthus", userId: "user-1" };
const render = (organization: MeOrganization | undefined) =>
  renderToStaticMarkup(
    createElement(ComputerPausedNotice, { organization, activeOrg, onCeilingRaised: async () => undefined }),
  );

describe("ComputerPausedNotice", () => {
  it("tells a member computer work is paused and why", () => {
    const html = render(
      org({
        role: "member",
        computer_work_paused: true,
        computer_work_paused_reason: "monthly AWS spend ceiling exceeded",
      }),
    );
    assert.match(html, /Computer work is paused/);
    assert.match(html, /monthly AWS spend ceiling exceeded/);
    assert.match(html, /role="status"/);
  });

  it("tells a member the workspace is usable and to ask an owner, with no raise form", () => {
    const html = render(org({ role: "member", computer_work_paused: true, computer_work_paused_reason: "x" }));
    assert.match(html, /still read your channels and message bots/);
    assert.match(html, /An owner of this organization can raise the monthly AWS spend ceiling/);
    assert.doesNotMatch(html, /Raise ceiling/);
    assert.doesNotMatch(html, /<form/);
    assert.doesNotMatch(html, /operator/i);
  });

  it("gives an owner a raise form prefilled with the current ceiling", () => {
    const html = render(
      org({ computer_work_paused: true, computer_work_paused_reason: "x", monthly_aws_spend_ceiling_usd: "250.00" }),
    );
    assert.match(html, /Raise the monthly AWS spend ceiling/);
    assert.match(html, /<form/);
    assert.match(html, /value="250.00"/);
    assert.match(html, /Raise ceiling/);
    assert.doesNotMatch(html, /An owner of this organization can raise/);
  });

  it("falls back to a generic reason when the server sends none", () => {
    const html = render(org({ computer_work_paused: true, computer_work_paused_reason: null }));
    assert.match(html, /paused at the monthly AWS spend ceiling/);
  });

  it("renders nothing when work is not paused or the organization is unknown", () => {
    assert.equal(render(org({ computer_work_paused: false })), "");
    assert.equal(render(org({})), "");
    assert.equal(render(undefined), "");
  });
});

describe("EnabledWorkspace renders the notice", () => {
  it("mounts ComputerPausedNotice with the active organization", () => {
    const source = readFileSync(join(__dirname, "..", "components", "EnabledWorkspace.tsx"), "utf8");
    assert.match(source, /<ComputerPausedNotice\s+organization=\{activeOrganization\}\s+activeOrg=\{activeOrg\}\s+onCeilingRaised=\{onReloadMembership\}/);
  });
});
