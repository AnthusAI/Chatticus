import { timingSafeEqual } from "node:crypto";
import { parseBearerToken, PrincipalHttpError, type Principal } from "./principal.ts";

const OPERATOR_KEY_UNCONFIGURED = "operator credential required";

/** Return whether an operator bearer secret is configured. */
export function operatorKeyConfigured(operatorKey: string): boolean {
	return operatorKey.trim() !== "";
}

/** Return whether `token` matches the configured operator bearer secret, comparing in constant time. */
export function verifyOperatorBearer(token: string, operatorKey: string): boolean {
	if (!operatorKeyConfigured(operatorKey)) {
		return false;
	}
	const expected = Buffer.from(operatorKey.trim());
	const actual = Buffer.from(token);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Return the HTTP detail when operator authentication fails. */
export function operatorAuthFailureDetail(): string {
	return OPERATOR_KEY_UNCONFIGURED;
}

/** Extract the operator bearer token from an Authorization header value. */
export function parseOperatorBearer(authorization: string | null): string | null {
	return parseBearerToken(authorization);
}

/** Map one bearer token to a deployment-wide operator principal. */
export function resolveOperatorPrincipalFromToken(token: string, operatorKey: string): Principal {
	if (!operatorKeyConfigured(operatorKey)) {
		throw new PrincipalHttpError(403, operatorAuthFailureDetail());
	}
	if (!verifyOperatorBearer(token, operatorKey)) {
		throw new PrincipalHttpError(403, operatorAuthFailureDetail());
	}
	return { kind: "operator", tenantId: "", userId: null, workerId: null, organizationStatus: null, role: null };
}

/** Require a valid operator bearer credential for one operator route. */
export function enforceOperatorPrincipal(request: Request, operatorKey: string): Principal {
	if (!operatorKeyConfigured(operatorKey)) {
		throw new PrincipalHttpError(403, operatorAuthFailureDetail());
	}
	const token = parseOperatorBearer(request.headers.get("Authorization"));
	if (token === null) {
		throw new PrincipalHttpError(403, operatorAuthFailureDetail());
	}
	return resolveOperatorPrincipalFromToken(token, operatorKey);
}
