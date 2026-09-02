import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryWebStorage,
  SignoutResponse,
  User,
  UserManager,
  WebStorageStateStore,
} from "oidc-client-ts";

import {
  buildUserManagerSettings,
  completeSignOutRedirect,
  resetAuthForTests,
  setUserManagerFactoryForTests,
  signInWithGoogle,
  signOut,
} from "../lib/auth";
import type { CognitoConfig } from "../lib/cognito-config";

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

type HarnessState = {
  signoutRedirectCalled: boolean;
  signoutRedirectArgs: Record<string, unknown> | null;
  removeUserBeforeRedirect: boolean;
  signinRedirectCalled: boolean;
  signinExtraQueryParams: Record<string, string> | null;
  sessionCleared: boolean;
  signoutCallbackHandled: boolean;
  seededUser: User | null;
};

function emptyState(): HarnessState {
  return {
    signoutRedirectCalled: false,
    signoutRedirectArgs: null,
    removeUserBeforeRedirect: false,
    signinRedirectCalled: false,
    signinExtraQueryParams: null,
    sessionCleared: false,
    signoutCallbackHandled: false,
    seededUser: null,
  };
}

function loadState(): HarnessState {
  try {
    const raw = readFileSync(statePath, "utf8");
    return JSON.parse(raw) as HarnessState;
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

function configureEnv(): void {
  process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID = testConfig.userPoolId;
  process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID = testConfig.clientId;
  process.env.NEXT_PUBLIC_COGNITO_AUTH_DOMAIN = testConfig.authDomain;
  process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI = testConfig.redirectUri;
}

function installMockUserManager(state: HarnessState): void {
  setUserManagerFactoryForTests(() => {
    const settings = buildUserManagerSettings(testConfig);
    const manager = new UserManager({
      ...settings,
      userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    });

    manager.signoutRedirect = async (args?: Record<string, unknown>) => {
      state.signoutRedirectCalled = true;
      state.signoutRedirectArgs = args ?? null;
    };
    manager.signinRedirect = async () => {
      state.signinRedirectCalled = true;
      state.signinExtraQueryParams = settings.extraQueryParams ?? null;
    };
    manager.getUser = async () => state.seededUser;
    manager.removeUser = async () => {
      state.seededUser = null;
      state.sessionCleared = true;
    };
    manager.signoutRedirectCallback = async () => {
      state.signoutCallbackHandled = true;
      state.seededUser = null;
      state.sessionCleared = true;
      return {} as SignoutResponse;
    };

    return manager;
  });
}

function prepareHarness(state: HarnessState): HarnessState {
  resetAuthForTests();
  configureEnv();
  installMockUserManager(state);
  return state;
}

function resetHarness(): HarnessState {
  clearStateFile();
  const state = prepareHarness(emptyState());
  saveState(state);
  return state;
}

function seedSession(idToken: string): HarnessState {
  const state = prepareHarness(emptyState());
  state.seededUser = {
    id_token: idToken,
    session_state: null,
    token_type: "Bearer",
    scope: "openid email profile",
    profile: { email: "person@example.com" },
    expires_at: 4_000_000_000,
  } as User;
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
  const state = prepareHarness(emptyState());
  await signInWithGoogle();
  saveState(state);
  return state;
}

function seedSignOutCallback(): HarnessState {
  const state = prepareHarness(emptyState());
  state.seededUser = {
    id_token: "session-token",
    session_state: null,
    token_type: "Bearer",
    scope: "openid email profile",
    profile: { email: "person@example.com" },
    expires_at: 4_000_000_000,
  } as User;
  saveState(state);
  return state;
}

async function runCompleteSignOut(): Promise<HarnessState> {
  const state = prepareHarness(loadState());
  await completeSignOutRedirect();
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
      result = seedSession(payload.id_token ?? "session-token");
      break;
    }
    case "sign-out":
      result = await runSignOut();
      break;
    case "sign-in":
      result = await runSignIn();
      break;
    case "seed-signout-callback":
      result = seedSignOutCallback();
      break;
    case "complete-sign-out":
      result = await runCompleteSignOut();
      break;
    default:
      throw new Error(`Unknown auth harness command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main();
