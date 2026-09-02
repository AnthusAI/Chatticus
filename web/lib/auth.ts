import {
  InMemoryWebStorage,
  User,
  UserManager,
  WebStorageStateStore,
} from "oidc-client-ts";

import {
  cognitoIssuer,
  loadCognitoConfig,
  postLogoutRedirectUri,
  type CognitoConfig,
} from "./cognito-config";
import { verifyIdTokenClaims, type IdTokenClaims } from "./id-token";

let userManager: UserManager | null = null;
let cachedConfig: CognitoConfig | null = null;
let userManagerFactory: ((config: CognitoConfig) => UserManager) | null = null;

function cognitoConfig(): CognitoConfig {
  if (!cachedConfig) {
    cachedConfig = loadCognitoConfig();
  }
  return cachedConfig;
}

function createUserManager(config: CognitoConfig): UserManager {
  if (userManagerFactory) {
    return userManagerFactory(config);
  }
  return new UserManager(buildUserManagerSettings(config));
}

/** Single in-memory UserManager for the SPA session. */
export function getUserManager(): UserManager {
  if (!userManager) {
    userManager = createUserManager(cognitoConfig());
  }
  return userManager;
}

export type VerifiedSession = {
  idToken: string;
  claims: IdTokenClaims;
  email: string | null;
};

function verifiedSessionFromUser(user: User | null): VerifiedSession | null {
  if (!user?.id_token) {
    return null;
  }
  const claims = verifyIdTokenClaims(user.id_token, cognitoConfig());
  return {
    idToken: user.id_token,
    claims,
    email: typeof claims.email === "string" ? claims.email : null,
  };
}

/** Return the verified Cognito id_token held in memory, if any. */
export async function getIdToken(): Promise<string | null> {
  const user = await getUserManager().getUser();
  return verifiedSessionFromUser(user)?.idToken ?? null;
}

/** Return verified session claims for the signed-in user. */
export async function getVerifiedSession(): Promise<VerifiedSession | null> {
  const user = await getUserManager().getUser();
  return verifiedSessionFromUser(user);
}

/** Start Google sign-in (authorization code + PKCE). */
export async function signInWithGoogle(): Promise<void> {
  await getUserManager().signinRedirect();
}

/** Complete the OAuth redirect callback and strip query params. */
export async function completeSignInRedirect(): Promise<VerifiedSession> {
  const user = await getUserManager().signinRedirectCallback();
  if (typeof window !== "undefined") {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  const session = verifiedSessionFromUser(user);
  if (!session) {
    throw new Error("Sign-in did not return a verified id_token.");
  }
  return session;
}

/** End the Cognito and Google SSO session, then redirect back to the SPA. */
export async function signOut(): Promise<void> {
  const user = await getUserManager().getUser();
  if (user?.id_token) {
    await getUserManager().signoutRedirect({ id_token_hint: user.id_token });
    return;
  }
  await getUserManager().removeUser();
}

/** Complete the post-logout redirect and clear any remaining in-memory state. */
export async function completeSignOutRedirect(): Promise<void> {
  try {
    await getUserManager().signoutRedirectCallback();
  } finally {
    await getUserManager().removeUser();
    if (typeof window !== "undefined") {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }
}

/** Subscribe to auth lifecycle events (silent renew, sign-out, errors). */
export function bindAuthEvents(handlers: {
  onSessionChanged: () => void;
  onError?: (error: Error) => void;
}): () => void {
  const manager = getUserManager();
  const onUserLoaded = () => handlers.onSessionChanged();
  const onUserUnloaded = () => handlers.onSessionChanged();
  const onSilentRenewError = (error: Error) => handlers.onError?.(error);

  manager.events.addUserLoaded(onUserLoaded);
  manager.events.addUserUnloaded(onUserUnloaded);
  manager.events.addSilentRenewError(onSilentRenewError);

  return () => {
    manager.events.removeUserLoaded(onUserLoaded);
    manager.events.removeUserUnloaded(onUserUnloaded);
    manager.events.removeSilentRenewError(onSilentRenewError);
  };
}

/** Test-only reset for singleton state. */
export function resetAuthForTests(): void {
  userManager = null;
  cachedConfig = null;
  userManagerFactory = null;
}

/** Test-only hook to inject a UserManager factory. */
export function setUserManagerFactoryForTests(
  factory: ((config: CognitoConfig) => UserManager) | null,
): void {
  userManagerFactory = factory;
  userManager = null;
}

/** Test-only UserManager settings builder. */
export function buildUserManagerSettings(config: CognitoConfig) {
  return {
    authority: cognitoIssuer(config),
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    post_logout_redirect_uri: postLogoutRedirectUri(config),
    response_type: "code",
    scope: "openid email profile",
    extraQueryParams: { identity_provider: "Google", prompt: "select_account" },
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    automaticSilentRenew: true,
    accessTokenExpiringNotificationTimeInSeconds: 60,
  };
}
