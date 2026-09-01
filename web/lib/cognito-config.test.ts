import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { loadCognitoConfig } from "./cognito-config";

const testDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(testDir, "cognito-config.ts"), "utf8");

const requiredStaticEnvAccess = [
  "process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID",
  "process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID",
  "process.env.NEXT_PUBLIC_COGNITO_AUTH_DOMAIN",
  "process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI",
] as const;

describe("cognito-config source", () => {
  it("reads NEXT_PUBLIC vars via static property access for Next.js inlining", () => {
    for (const access of requiredStaticEnvAccess) {
      assert.match(source, new RegExp(access.replace(/\./g, "\\.")));
    }
    assert.doesNotMatch(source, /process\.env\[[^\]]+\]/);
  });
});

describe("loadCognitoConfig", () => {
  it("throws when a required NEXT_PUBLIC var is missing", () => {
    delete process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
    assert.throws(
      () => loadCognitoConfig(),
      /Missing required build-time env var NEXT_PUBLIC_COGNITO_USER_POOL_ID/,
    );
  });
});
