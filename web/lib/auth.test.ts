import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cognitoAuthority,
  cognitoIssuer,
  loadCognitoConfig,
  type CognitoConfig,
} from "./cognito-config";
import { parseJwtPayload, verifyIdTokenClaims } from "./id-token";
import { buildUserManagerSettings } from "./auth";

const testConfig: CognitoConfig = {
  userPoolId: "us-east-1_TestPool",
  clientId: "test-client-id",
  authDomain: "auth-dev.chattic.us",
  redirectUri: "https://dev.chattic.us/auth/callback",
  region: "us-east-1",
};

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fakeIdToken(claims: Record<string, unknown>): string {
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson(claims);
  return `${header}.${payload}.signature`;
}

describe("loadCognitoConfig", () => {
  it("reads required NEXT_PUBLIC Cognito env vars", () => {
    process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID = testConfig.userPoolId;
    process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID = testConfig.clientId;
    process.env.NEXT_PUBLIC_COGNITO_AUTH_DOMAIN = testConfig.authDomain;
    process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI = testConfig.redirectUri;

    assert.deepEqual(loadCognitoConfig(), testConfig);

    delete process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
    delete process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
    delete process.env.NEXT_PUBLIC_COGNITO_AUTH_DOMAIN;
    delete process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI;
  });
});

describe("cognitoAuthority", () => {
  it("uses the custom auth domain", () => {
    assert.equal(cognitoAuthority(testConfig), "https://auth-dev.chattic.us");
  });
});

describe("buildUserManagerSettings", () => {
  it("always sends identity_provider=Google", () => {
    const settings = buildUserManagerSettings(testConfig);
    assert.equal(settings.extraQueryParams?.identity_provider, "Google");
    assert.equal(settings.response_type, "code");
    assert.equal(settings.redirect_uri, testConfig.redirectUri);
  });
});

describe("verifyIdTokenClaims", () => {
  it("accepts a valid Cognito id_token", () => {
    const token = fakeIdToken({
      token_use: "id",
      iss: cognitoIssuer(testConfig),
      aud: testConfig.clientId,
      exp: 4_000_000_000,
      email: "person@example.com",
    });
    const claims = verifyIdTokenClaims(token, testConfig, 1_700_000_000);
    assert.equal(claims.email, "person@example.com");
  });

  it("rejects wrong audience", () => {
    const token = fakeIdToken({
      token_use: "id",
      iss: cognitoIssuer(testConfig),
      aud: "other-client",
      exp: 4_000_000_000,
    });
    assert.throws(
      () => verifyIdTokenClaims(token, testConfig, 1_700_000_000),
      /audience/i,
    );
  });

  it("rejects expired tokens", () => {
    const token = fakeIdToken({
      token_use: "id",
      iss: cognitoIssuer(testConfig),
      aud: testConfig.clientId,
      exp: 1,
    });
    assert.throws(
      () => verifyIdTokenClaims(token, testConfig, 1_700_000_000),
      /expired/i,
    );
  });

  it("rejects access tokens", () => {
    const token = fakeIdToken({
      token_use: "access",
      iss: cognitoIssuer(testConfig),
      client_id: testConfig.clientId,
      exp: 4_000_000_000,
    });
    assert.throws(
      () => verifyIdTokenClaims(token, testConfig, 1_700_000_000),
      /token_use/i,
    );
  });
});

describe("parseJwtPayload", () => {
  it("decodes base64url payloads", () => {
    const token = fakeIdToken({ sub: "abc" });
    assert.deepEqual(parseJwtPayload(token), { sub: "abc" });
  });
});
