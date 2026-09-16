import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";

import { WebStorageStateStore } from "oidc-client-ts";

import {
  cognitoIssuer,
  loadCognitoConfig,
  silentRedirectUri,
  type CognitoConfig,
} from "./cognito-config";
import { parseJwtPayload, verifyIdTokenClaims } from "./id-token";
import {
  buildUserManagerSettings,
  resetAuthForTests,
  restoreVerifiedSession,
  setUserManagerFactoryForTests,
} from "./auth";

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

describe("buildUserManagerSettings", () => {
  const backing: Record<string, string> = {};
  const localStorage = {
    get length() {
      return Object.keys(backing).length;
    },
    clear() {
      for (const key of Object.keys(backing)) {
        delete backing[key];
      }
    },
    getItem(key: string) {
      return backing[key] ?? null;
    },
    key(index: number) {
      return Object.keys(backing)[index] ?? null;
    },
    removeItem(key: string) {
      delete backing[key];
    },
    setItem(key: string, value: string) {
      backing[key] = value;
    },
  };
  const previousWindow = globalThis.window;

  before(() => {
    globalThis.window = { localStorage } as Window & typeof globalThis;
  });

  after(() => {
    if (previousWindow === undefined) {
      delete (globalThis as { window?: Window }).window;
    } else {
      globalThis.window = previousWindow;
    }
  });

  it("uses the Cognito issuer for OIDC discovery", () => {
    const settings = buildUserManagerSettings(testConfig);
    assert.equal(
      settings.authority,
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool",
    );
  });

  it("does not attach identity_provider or account picker prompt globally", () => {
    const settings = buildUserManagerSettings(testConfig);
    assert.equal(settings.extraQueryParams, undefined);
    assert.equal(settings.response_type, "code");
    assert.equal(settings.redirect_uri, testConfig.redirectUri);
    assert.equal(
      settings.silent_redirect_uri,
      silentRedirectUri(testConfig),
    );
    assert.equal(
      settings.post_logout_redirect_uri,
      "https://dev.chattic.us/auth/signout-callback",
    );
    assert.equal(settings.scope, "openid email profile");
  });

  it("persists the OIDC user in localStorage", () => {
    const settings = buildUserManagerSettings(testConfig);
    assert.ok(settings.userStore instanceof WebStorageStateStore);
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

describe("restoreVerifiedSession", () => {
  const localStorageBacking: Record<string, string> = {};
  const localStorage = {
    get length() {
      return Object.keys(localStorageBacking).length;
    },
    clear() {
      for (const key of Object.keys(localStorageBacking)) {
        delete localStorageBacking[key];
      }
    },
    getItem(key: string) {
      return localStorageBacking[key] ?? null;
    },
    key(index: number) {
      return Object.keys(localStorageBacking)[index] ?? null;
    },
    removeItem(key: string) {
      delete localStorageBacking[key];
    },
    setItem(key: string, value: string) {
      localStorageBacking[key] = value;
    },
  };

  const sessionStorageBacking: Record<string, string> = {};
  const sessionStorage = {
    get length() {
      return Object.keys(sessionStorageBacking).length;
    },
    clear() {
      for (const key of Object.keys(sessionStorageBacking)) {
        delete sessionStorageBacking[key];
      }
    },
    getItem(key: string) {
      return sessionStorageBacking[key] ?? null;
    },
    key(index: number) {
      return Object.keys(sessionStorageBacking)[index] ?? null;
    },
    removeItem(key: string) {
      delete sessionStorageBacking[key];
    },
    setItem(key: string, value: string) {
      sessionStorageBacking[key] = value;
    },
  };

  const previousWindow = globalThis.window;

  before(() => {
    globalThis.window = { localStorage, sessionStorage } as Window & typeof globalThis;
    process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID = testConfig.userPoolId;
    process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID = testConfig.clientId;
    process.env.NEXT_PUBLIC_COGNITO_AUTH_DOMAIN = testConfig.authDomain;
    process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI = testConfig.redirectUri;
  });

  after(() => {
    if (previousWindow === undefined) {
      delete (globalThis as { window?: Window }).window;
    } else {
      globalThis.window = previousWindow;
    }
    delete process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
    delete process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
    delete process.env.NEXT_PUBLIC_COGNITO_AUTH_DOMAIN;
    delete process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI;
  });

  // Must be a hook, not a trailing call in each test body: a thrown assertion
  // would otherwise skip cleanup and leak the mock factory and the
  // select-account flag into the next test, turning one failure into four.
  afterEach(() => {
    resetAuthForTests();
    setUserManagerFactoryForTests(null);
    localStorage.clear();
    sessionStorage.clear();
  });

  it("branch 1: returns null when selectAccountOnSignInPending is true, without calling getUser or signinSilent", async () => {
    sessionStorage.setItem("chatticus:select_account_on_signin", "1");

    const calls = { getUser: 0, signinSilent: 0 };
    const mockUserManager = {
      getUser: async () => {
        calls.getUser++;
        throw new Error("getUser should not be called");
      },
      signinSilent: async () => {
        calls.signinSilent++;
        throw new Error("signinSilent should not be called");
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setUserManagerFactoryForTests(() => mockUserManager as any);

    const result = await restoreVerifiedSession();

    assert.equal(result, null, "should return null");
    assert.equal(calls.getUser, 0, "getUser should not be called");
    assert.equal(calls.signinSilent, 0, "signinSilent should not be called");
  });

  it("branch 2: returns verified session when stored user verifies fine, without calling signinSilent", async () => {
    const validToken = fakeIdToken({
      token_use: "id",
      iss: cognitoIssuer(testConfig),
      aud: testConfig.clientId,
      exp: 4_000_000_000,
      email: "user@example.com",
    });

    const calls = { signinSilent: 0 };
    const mockUser = { id_token: validToken };
    const mockUserManager = {
      getUser: async () => mockUser,
      signinSilent: async () => {
        calls.signinSilent++;
        throw new Error("signinSilent should not be called");
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setUserManagerFactoryForTests(() => mockUserManager as any);

    const result = await restoreVerifiedSession();

    assert.ok(result, "should return a session");
    assert.equal(result.idToken, validToken, "should return the same id_token");
    assert.equal(result.claims.email, "user@example.com", "should have email claim");
    assert.equal(calls.signinSilent, 0, "signinSilent should not be called");
  });

  it("branch 3: calls signinSilent when stored user's claims throw Token expired", async () => {
    const expiredToken = fakeIdToken({
      token_use: "id",
      iss: cognitoIssuer(testConfig),
      aud: testConfig.clientId,
      exp: 1,
    });

    const renewedToken = fakeIdToken({
      token_use: "id",
      iss: cognitoIssuer(testConfig),
      aud: testConfig.clientId,
      exp: 4_000_000_000,
      email: "renewed@example.com",
    });

    const calls = { signinSilent: 0 };
    const mockUser = { id_token: expiredToken };
    const renewedUser = { id_token: renewedToken };

    const mockUserManager = {
      getUser: async () => mockUser,
      signinSilent: async () => {
        calls.signinSilent++;
        return renewedUser;
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setUserManagerFactoryForTests(() => mockUserManager as any);

    const result = await restoreVerifiedSession();

    assert.ok(result, "should return a renewed session");
    assert.equal(result.idToken, renewedToken, "should return renewed id_token");
    assert.equal(result.claims.email, "renewed@example.com", "should have renewed email");
    assert.equal(calls.signinSilent, 1, "signinSilent should be called once");
  });

  it("branch 4: calls signinSilent when getUser resolves null", async () => {
    const renewedToken = fakeIdToken({
      token_use: "id",
      iss: cognitoIssuer(testConfig),
      aud: testConfig.clientId,
      exp: 4_000_000_000,
      email: "newuser@example.com",
    });

    const calls = { signinSilent: 0 };
    const renewedUser = { id_token: renewedToken };

    const mockUserManager = {
      getUser: async () => null,
      signinSilent: async () => {
        calls.signinSilent++;
        return renewedUser;
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setUserManagerFactoryForTests(() => mockUserManager as any);

    const result = await restoreVerifiedSession();

    assert.ok(result, "should return a session from signinSilent");
    assert.equal(result.idToken, renewedToken, "should return renewed id_token");
    assert.equal(result.claims.email, "newuser@example.com", "should have email");
    assert.equal(calls.signinSilent, 1, "signinSilent should be called once");
  });

  it("branch 6: calls signinSilent when the stored user has no id_token", async () => {
    const renewedToken = fakeIdToken({
      token_use: "id",
      iss: cognitoIssuer(testConfig),
      aud: testConfig.clientId,
      exp: 4_000_000_000,
      email: "fallthrough@example.com",
    });

    const calls = { signinSilent: 0 };
    const mockUserManager = {
      // verifiedSessionFromUser returns null here rather than throwing, so this
      // exercises the implicit fallthrough, not the catch.
      getUser: async () => ({}),
      signinSilent: async () => {
        calls.signinSilent++;
        return { id_token: renewedToken };
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setUserManagerFactoryForTests(() => mockUserManager as any);

    const result = await restoreVerifiedSession();

    assert.ok(result, "should return a session from signinSilent");
    assert.equal(result.claims.email, "fallthrough@example.com");
    assert.equal(calls.signinSilent, 1, "signinSilent should be called once");
  });

  it("branch 5: returns null when signinSilent rejects, without throwing", async () => {
    const mockUserManager = {
      getUser: async () => null,
      signinSilent: async () => {
        throw new Error("Silent sign-in failed");
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setUserManagerFactoryForTests(() => mockUserManager as any);

    const result = await restoreVerifiedSession();

    assert.equal(result, null, "should return null on signinSilent error");
  });
});
