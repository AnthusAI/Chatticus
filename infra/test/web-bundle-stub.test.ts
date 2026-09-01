import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  shouldStubWebBundle,
  stubWebsiteDeploySource,
  websiteDeploySourceForApp,
} from "../lib/web-bundle-stub";
import { synthWebStackLikeApp } from "./web-stack-harness";

const ENV_VAR = "CHATTICUS_STUB_WEB_BUNDLE";

afterEach(() => {
  delete process.env[ENV_VAR];
});

describe("shouldStubWebBundle", () => {
  it("is false by default", () => {
    assert.equal(shouldStubWebBundle(), false);
  });

  it("is true when CHATTICUS_STUB_WEB_BUNDLE=1", () => {
    process.env[ENV_VAR] = "1";
    assert.equal(shouldStubWebBundle(), true);
  });
});

describe("websiteDeploySourceForApp", () => {
  it("returns the stub source when CHATTICUS_STUB_WEB_BUNDLE=1", () => {
    process.env[ENV_VAR] = "1";
    assert.equal(websiteDeploySourceForApp(), stubWebsiteDeploySource);
  });

  it("returns undefined for real deploy bundling", () => {
    assert.equal(websiteDeploySourceForApp(), undefined);
  });
});

describe("stub web bundle synth", () => {
  it("does not embed aws ssm fetch commands in the template", () => {
    process.env[ENV_VAR] = "1";
    const template = synthWebStackLikeApp("development");
    const json = JSON.stringify(template.toJSON());
    assert.doesNotMatch(json, /aws ssm get-parameter/);
  });
});
