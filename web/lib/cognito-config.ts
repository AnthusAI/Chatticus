/** Public Cognito SPA settings baked in at build time. */

export type CognitoConfig = {
  userPoolId: string;
  clientId: string;
  authDomain: string;
  redirectUri: string;
  region: string;
};

function requiredPublicEnv(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Missing required build-time env var ${name}.`);
  }
  return trimmed;
}

function regionFromUserPoolId(userPoolId: string): string {
  const region = userPoolId.split("_")[0]?.trim();
  if (!region) {
    throw new Error("Invalid Cognito user pool id.");
  }
  return region;
}

/** Load Cognito config from NEXT_PUBLIC_* vars (build-time / .env.local for dev). */
export function loadCognitoConfig(): CognitoConfig {
  const userPoolId = requiredPublicEnv(
    process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID,
    "NEXT_PUBLIC_COGNITO_USER_POOL_ID",
  );
  const clientId = requiredPublicEnv(
    process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
    "NEXT_PUBLIC_COGNITO_CLIENT_ID",
  );
  const authDomain = requiredPublicEnv(
    process.env.NEXT_PUBLIC_COGNITO_AUTH_DOMAIN,
    "NEXT_PUBLIC_COGNITO_AUTH_DOMAIN",
  );
  const redirectUri = requiredPublicEnv(
    process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI,
    "NEXT_PUBLIC_COGNITO_REDIRECT_URI",
  );
  return {
    userPoolId,
    clientId,
    authDomain,
    redirectUri,
    region: regionFromUserPoolId(userPoolId),
  };
}

/** Cognito JWT issuer for the configured user pool. */
export function cognitoIssuer(config: CognitoConfig): string {
  return `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
}

/** Post-logout redirect registered on the Cognito SPA client. */
export function postLogoutRedirectUri(config: CognitoConfig): string {
  return new URL("/auth/signout-callback", new URL(config.redirectUri).origin).href;
}
