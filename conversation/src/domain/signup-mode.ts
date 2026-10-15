/** Deployment signup mode for organization creation. */
export type SignupMode = "open" | "invitation_only";

/**
 * Parse one deployment signup mode string.
 */
export function parseSignupMode(value: string | null | undefined): SignupMode {
	if (value === null || value === undefined || !value.trim()) {
		return "invitation_only";
	}
	const normalized = value.trim().toLowerCase().replace(/-/g, "_");
	if (normalized === "open") {
		return "open";
	}
	if (normalized === "invitation_only" || normalized === "invitationonly") {
		return "invitation_only";
	}
	throw new Error(`Unsupported signup mode: ${JSON.stringify(value)}`);
}

/**
 * Read signup mode from CHATTICUS_SIGNUP_MODE environment variable.
 */
export function signupModeFromEnv(): SignupMode {
	return parseSignupMode(process.env.CHATTICUS_SIGNUP_MODE);
}
