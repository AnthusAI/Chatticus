import { cognitoIssuer, type CognitoConfig } from "./cognito-config";

export type IdTokenClaims = {
  token_use?: string;
  iss?: string;
  aud?: string | string[];
  client_id?: string;
  exp?: number;
  email?: string;
  sub?: string;
};

/** Decode a JWT payload without verifying the signature (client-side sanity checks). */
export function parseJwtPayload(token: string): IdTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT shape.");
  }
  const segment = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
  const json = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(json) as IdTokenClaims;
}

function audienceMatches(claims: IdTokenClaims, clientId: string): boolean {
  const aud = claims.aud ?? claims.client_id;
  if (typeof aud === "string") {
    return aud === clientId;
  }
  if (Array.isArray(aud)) {
    return aud.includes(clientId);
  }
  return false;
}

/** Verify iss, aud, exp, and token_use on a Cognito id_token. */
export function verifyIdTokenClaims(
  idToken: string,
  config: CognitoConfig,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): IdTokenClaims {
  const claims = parseJwtPayload(idToken);
  if (claims.token_use !== "id") {
    throw new Error("token_use must be id.");
  }
  if (claims.iss !== cognitoIssuer(config)) {
    throw new Error("Invalid token issuer.");
  }
  if (!audienceMatches(claims, config.clientId)) {
    throw new Error("Invalid token audience.");
  }
  const exp = claims.exp;
  if (typeof exp !== "number" || exp <= nowSeconds) {
    throw new Error("Token expired.");
  }
  return claims;
}
