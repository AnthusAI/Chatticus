import { User, UserManager, WebStorageStateStore, type UserManagerSettings } from "oidc-client-ts";

import {
  cognitoIssuer,
  loadCognitoConfig,
  postLogoutRedirectUri,
  silentRedirectUri,
  type CognitoConfig,
} from "./cognito-config";
import { verifyIdTokenClaims, type IdTokenClaims } from "./id-token";

const SELECT_ACCOUNT_ON_SIGNIN_KEY = "chatticus:select_account_on_signin";

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

/** Single UserManager for the SPA session. */
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

/** Return the verified Cognito id_token for the signed-in user, if any. */
export async function getIdToken(): Promise<string | null> {
  const user = await getUserManager().getUser();
  return verifiedSessionFromUser(user)?.idToken ?? null;
}

/** Return verified session claims for the signed-in user. */
export async function getVerifiedSession(): Promise<VerifiedSession | null> {
  const user = await getUserManager().getUser();
  return verifiedSessionFromUser(user);
}

function selectAccountOnSignInPending(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.sessionStorage.getItem(SELECT_ACCOUNT_ON_SIGNIN_KEY) === "1";
}

/** Cognito hosted UI logout URL (not OIDC end_session_endpoint). */
export function cognitoHostedLogoutUrl(config: CognitoConfig): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: postLogoutRedirectUri(config),
  });
  return `https://${config.authDomain}/logout?${params.toString()}`;
}

/**
 * Restore a verified session on mount: read persisted user, renew silently
 * when claims fail or no user is stored, without surfacing verify errors.
 */
export async function restoreVerifiedSession(): Promise<VerifiedSession | null> {
  if (selectAccountOnSignInPending()) {
    return null;
  }

  const manager = getUserManager();
  const user = await manager.getUser();
  if (user) {
    try {
      const session = verifiedSessionFromUser(user);
      if (session) {
        return session;
      }
    } catch {
      // Expired or invalid claims — fall through to silent sign-in.
    }
  }

  try {
    const renewed = await manager.signinSilent();
    return verifiedSessionFromUser(renewed);
  } catch {
    return null;
  }
}

function consumeSelectAccountOnSignIn(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const flag = window.sessionStorage.getItem(SELECT_ACCOUNT_ON_SIGNIN_KEY);
  if (flag !== "1") {
    return false;
  }
  window.sessionStorage.removeItem(SELECT_ACCOUNT_ON_SIGNIN_KEY);
  return true;
}

function markSelectAccountOnSignIn(): void {
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem(SELECT_ACCOUNT_ON_SIGNIN_KEY, "1");
  }
}

/** Start Google sign-in (authorization code + PKCE). */
export async function signInWithGoogle(): Promise<void> {
  const extraQueryParams: Record<string, string> = { identity_provider: "Google" };
  if (consumeSelectAccountOnSignIn()) {
    extraQueryParams.prompt = "select_account";
  }
  await getUserManager().signinRedirect({ extraQueryParams });
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

/** Complete a silent-renew iframe callback without navigating the parent frame. */
export async function completeSilentSignInCallback(): Promise<void> {
  await getUserManager().signinSilentCallback();
}

/** End the Cognito and Google SSO session, then redirect back to the SPA. */
export async function signOut(): Promise<void> {
  const user = await getUserManager().getUser();
  if (user?.id_token) {
    if (typeof window !== "undefined") {
      window.location.assign(cognitoHostedLogoutUrl(cognitoConfig()));
    }
    return;
  }
  await getUserManager().removeUser();
}

/** Complete the post-logout redirect and clear any remaining persisted state. */
export async function completeSignOutRedirect(): Promise<void> {
  await getUserManager().removeUser();
  markSelectAccountOnSignIn();
  if (typeof window !== "undefined") {
    window.history.replaceState({}, document.title, window.location.pathname);
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
export function buildUserManagerSettings(config: CognitoConfig): UserManagerSettings {
  return {
    authority: cognitoIssuer(config),
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    silent_redirect_uri: silentRedirectUri(config),
    post_logout_redirect_uri: postLogoutRedirectUri(config),
    response_type: "code",
    scope: "openid email profile",
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    automaticSilentRenew: true,
    accessTokenExpiringNotificationTimeInSeconds: 60,
  };
}
