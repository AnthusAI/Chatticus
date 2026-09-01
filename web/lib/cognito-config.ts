/** Public Cognito SPA settings baked in at build time. */

export type CognitoConfig = {
  userPoolId: string;
  clientId: string;
  authDomain: string;
  redirectUri: string;
  region: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required build-time env var ${name}.`);
  }
  return value;
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
  const userPoolId = requiredEnv("NEXT_PUBLIC_COGNITO_USER_POOL_ID");
  const clientId = requiredEnv("NEXT_PUBLIC_COGNITO_CLIENT_ID");
  const authDomain = requiredEnv("NEXT_PUBLIC_COGNITO_AUTH_DOMAIN");
  const redirectUri = requiredEnv("NEXT_PUBLIC_COGNITO_REDIRECT_URI");
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

/** OIDC authority URL on the custom auth domain. */
export function cognitoAuthority(config: CognitoConfig): string {
  return `https://${config.authDomain}`;
}
