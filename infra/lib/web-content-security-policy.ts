export interface WebContentSecurityPolicyInputs {
  cognitoRegion: string;
  authDomainName: string;
}

export const CONTENT_SECURITY_POLICY_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";

/**
 * Directives sized for the static Next.js site: inline bootstrap scripts, the
 * on-device voice WASM and its blob workers, future Monaco blob workers, and
 * Cognito discovery plus token exchange. Shipped report-only first so a missed
 * origin shows up in browser consoles instead of breaking sign-in.
 */
export function webContentSecurityPolicy(inputs: WebContentSecurityPolicyInputs): string {
  const cognitoIssuerOrigin = `https://cognito-idp.${inputs.cognitoRegion}.amazonaws.com`;
  const cognitoHostedUiOrigin = `https://${inputs.authDomainName}`;
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", "blob:"],
    "worker-src": ["'self'", "blob:"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "media-src": ["'self'", "blob:"],
    "connect-src": ["'self'", "blob:", cognitoIssuerOrigin, cognitoHostedUiOrigin],
    "frame-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'", cognitoHostedUiOrigin],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources.join(" ")}`)
    .join("; ");
}
