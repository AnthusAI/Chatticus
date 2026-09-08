import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SignoutResponse,
  User,
  UserManager,
} from "oidc-client-ts";

import {
  buildUserManagerSettings,
  completeSignOutRedirect,
  getUserManager,
  resetAuthForTests,
  restoreVerifiedSession,
  setUserManagerFactoryForTests,
  signInWithGoogle,
  signOut,
} from "../lib/auth";
import { cognitoIssuer, type CognitoConfig } from "../lib/cognito-config";

const testConfig: CognitoConfig = {
  userPoolId: "us-east-1_TestPool",
  clientId: "test-client-id",
  authDomain: "auth-dev.chattic.us",
  redirectUri: "https://dev.chattic.us/auth/callback",
  region: "us-east-1",
};

const statePath =
  process.env.CHATTICUS_AUTH_HARNESS_STATE ??
  join(tmpdir(), "chatticus-auth-harness-state.json");

const oidcStorePath =
  process.env.CHATTICUS_AUTH_HARNESS_OIDC_STORE ??
  join(tmpdir(), "chatticus-auth-harness-oidc-store.json");

const sessionStorePath =
  process.env.CHATTICUS_AUTH_HARNESS_SESSION_STORE ??
  join(tmpdir(), "chatticus-auth-harness-session-store.json");

type HarnessState = {
  signoutRedirectCalled: boolean;
  signoutRedirectArgs: Record<string, unknown> | null;
  removeUserBeforeRedirect: boolean;
  signinRedirectCalled: boolean;
  signinExtraQueryParams: Record<string, string> | null;
  signinSilentCalled: boolean;
  sessionCleared: boolean;
  signoutCallbackHandled: boolean;
  sessionPresent: boolean;
  idpSessionValid: boolean;
  expiredSessionWithRefresh: boolean;
};

function emptyState(): HarnessState {
  return {
    signoutRedirectCalled: false,
    signoutRedirectArgs: null,
    removeUserBeforeRedirect: false,
    signinRedirectCalled: false,
    signinExtraQueryParams: null,
    signinSilentCalled: false,
    sessionCleared: false,
    signoutCallbackHandled: false,
    sessionPresent: false,
    idpSessionValid: false,
    expiredSessionWithRefresh: false,
  };
}

function loadState(): HarnessState {
  try {
    const raw = readFileSync(statePath, "utf8");
    return { ...emptyState(), ...(JSON.parse(raw) as Partial<HarnessState>) };
  } catch {
    return emptyState();
  }
}

function saveState(state: HarnessState): void {
  writeFileSync(statePath, JSON.stringify(state));
}

function clearStateFile(): void {
  try {
    unlinkSync(statePath);
  } catch {
    // no prior state
  }
}

function loadOidcStore(): Record<string, string> {
  try {
    const raw = readFileSync(oidcStorePath, "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveOidcStore(store: Record<string, string>): void {
  writeFileSync(oidcStorePath, JSON.stringify(store));
}

function clearOidcStoreFile(): void {
  try {
    unlinkSync(oidcStorePath);
  } catch {
    // no prior store
  }
}

function loadSessionStore(): Record<string, string> {
  try {
    const raw = readFileSync(sessionStorePath, "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveSessionStore(store: Record<string, string>): void {
  writeFileSync(sessionStorePath, JSON.stringify(store));
}

function clearSessionStoreFile(): void {
  try {
    unlinkSync(sessionStorePath);
  } catch {
    // no prior store
  }
}

class FileBackedStorage implements Storage {
  private readonly data: Record<string, string>;
  private readonly persist: (store: Record<string, string>) => void;

  constructor(
    initial: Record<string, string>,
    persist: (store: Record<string, string>) => void,
  ) {
    this.data = initial;
    this.persist = persist;
  }

  get length(): number {
    return Object.keys(this.data).length;
  }

  clear(): void {
    for (const key of Object.keys(this.data)) {
      delete this.data[key];
    }
    this.persist(this.data);
  }

  getItem(key: string): string | null {
    return this.data[key] ?? null;
  }

  key(index: number): string | null {
    return Object.keys(this.data)[index] ?? null;
  }

  removeItem(key: string): void {
    delete this.data[key];
    this.persist(this.data);
  }

  setItem(key: string, value: string): void {
    this.data[key] = value;
    this.persist(this.data);
  }
}

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

function verifiedSessionToken(): string {
  return fakeIdToken({
    token_use: "id",
    iss: cognitoIssuer(testConfig),
    aud: testConfig.clientId,
    exp: 4_000_000_000,
    email: "person@example.com",
    sub: "person-subject",
  });
}

function expiredSessionToken(): string {
  return fakeIdToken({
    token_use: "id",
    iss: cognitoIssuer(testConfig),
    aud: testConfig.clientId,
    exp: 1,
    email: "person@example.com",
    sub: "person-subject",
  });
}

function ensureHarnessWindow(): void {
  if (typeof globalThis.window === "undefined") {
    globalThis.document = { title: "Chatticus" } as Document;
    globalThis.window = {
      localStorage: new FileBackedStorage(loadOidcStore(), saveOidcStore),
      sessionStorage: new FileBackedStorage(loadSessionStore(), saveSessionStore),
      history: { replaceState: () => undefined },
      location: { pathname: "/chat" },
    } as Window & typeof globalThis;
  }
}

function configureEnv(): void {
  process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID = testConfig.userPoolId;
  process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID = testConfig.clientId;
  process.env.NEXT_PUBLIC_COGNITO_AUTH_DOMAIN = testConfig.authDomain;
  process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI = testConfig.redirectUri;
}

function harnessOidcMetadata() {
  const issuer = cognitoIssuer(testConfig);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    end_session_endpoint: `${issuer}/logout`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
  };
}

function installMockUserManager(state: HarnessState): void {
  ensureHarnessWindow();
  setUserManagerFactoryForTests(() => {
    const settings = buildUserManagerSettings(testConfig);
    const manager = new UserManager({
      ...settings,
      metadata: harnessOidcMetadata(),
      automaticSilentRenew: false,
    });

    const originalRemoveUser = manager.removeUser.bind(manager);
    const originalStoreUser = manager.storeUser.bind(manager);

    manager.signoutRedirect = async (args?: Record<string, unknown>) => {
      state.signoutRedirectCalled = true;
      state.signoutRedirectArgs = args ?? null;
    };
    manager.signinRedirect = async (args?: { extraQueryParams?: Record<string, string> }) => {
      state.signinRedirectCalled = true;
      state.signinExtraQueryParams = args?.extraQueryParams ?? null;
    };
    manager.signinSilent = async () => {
      state.signinSilentCalled = true;
      if (!state.idpSessionValid && !state.expiredSessionWithRefresh) {
        throw new Error("Silent sign-in failed.");
      }
      const user = buildSeededUser(verifiedSessionToken());
      await originalStoreUser(user);
      state.sessionPresent = true;
      return user;
    };
    manager.removeUser = async () => {
      await originalRemoveUser();
      state.sessionCleared = true;
      state.sessionPresent = false;
    };
    manager.signoutRedirectCallback = async () => {
      state.signoutCallbackHandled = true;
      return {} as SignoutResponse;
    };

    return manager;
  });
}

function prepareHarness(state: HarnessState): HarnessState {
  resetAuthForTests();
  configureEnv();
  ensureHarnessWindow();
  installMockUserManager(state);
  return state;
}

function resetHarness(): HarnessState {
  clearStateFile();
  clearOidcStoreFile();
  clearSessionStoreFile();
  delete (globalThis as { window?: Window; document?: Document }).window;
  delete (globalThis as { window?: Window; document?: Document }).document;
  const state = prepareHarness(emptyState());
  saveState(state);
  return state;
}

function buildSeededUser(idToken: string, refreshToken?: string, expiresAt?: number): User {
  return new User({
    id_token: idToken,
    access_token: "test-access-token",
    refresh_token: refreshToken,
    session_state: null,
    token_type: "Bearer",
    scope: "openid email profile",
    profile: { email: "person@example.com", sub: "person-subject" },
    expires_at: expiresAt ?? 4_000_000_000,
  });
}

async function seedSession(idToken?: string): Promise<HarnessState> {
  const state = prepareHarness(emptyState());
  const token = idToken ?? verifiedSessionToken();
  await getUserManager().storeUser(buildSeededUser(token));
  state.sessionPresent = true;
  saveState(state);
  return state;
}

async function seedNoSession(): Promise<HarnessState> {
  const state = prepareHarness(emptyState());
  saveState(state);
  return state;
}

async function seedIdpSessionOnly(): Promise<HarnessState> {
  const state = prepareHarness(emptyState());
  state.idpSessionValid = true;
  saveState(state);
  return state;
}

async function seedExpiredWithRefresh(): Promise<HarnessState> {
  const state = prepareHarness(emptyState());
  await getUserManager().storeUser(
    buildSeededUser(expiredSessionToken(), "test-refresh-token", 1),
  );
  state.expiredSessionWithRefresh = true;
  saveState(state);
  return state;
}

async function runSignOut(): Promise<HarnessState> {
  const state = prepareHarness(loadState());
  await signOut();
  saveState(state);
  return state;
}

async function runSignIn(): Promise<HarnessState> {
  const state = prepareHarness(loadState());
  await signInWithGoogle();
  saveState(state);
  return state;
}

async function seedSignOutCallback(): Promise<HarnessState> {
  return seedSession("session-token");
}

async function runCompleteSignOut(): Promise<HarnessState> {
  const state = prepareHarness(loadState());
  await completeSignOutRedirect();
  saveState(state);
  return state;
}

async function runReloadWorkspace(): Promise<HarnessState> {
  const state = loadState();
  resetAuthForTests();
  configureEnv();
  installMockUserManager(state);
  const session = await restoreVerifiedSession();
  state.sessionPresent = session !== null;
  saveState(state);
  return state;
}

async function main(): Promise<void> {
  const [command, payloadJson] = process.argv.slice(2);
  let result: HarnessState;

  switch (command) {
    case "reset":
      result = resetHarness();
      break;
    case "seed-session": {
      const payload = JSON.parse(payloadJson ?? "{}") as { id_token?: string };
      result = await seedSession(payload.id_token);
      break;
    }
    case "seed-no-session":
      result = await seedNoSession();
      break;
    case "seed-idp-session-only":
      result = await seedIdpSessionOnly();
      break;
    case "seed-expired-with-refresh":
      result = await seedExpiredWithRefresh();
      break;
    case "sign-out":
      result = await runSignOut();
      break;
    case "sign-in":
      result = await runSignIn();
      break;
    case "seed-signout-callback":
      result = await seedSignOutCallback();
      break;
    case "complete-sign-out":
      result = await runCompleteSignOut();
      break;
    case "reload-workspace":
      result = await runReloadWorkspace();
      break;
    default:
      throw new Error(`Unknown auth harness command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

void main();
