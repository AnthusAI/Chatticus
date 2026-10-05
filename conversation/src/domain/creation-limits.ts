import { OrganizationNameTooLongError } from "../http/errors.ts";

export const ORGANIZATION_NAME_MAX_LENGTH = 128;
export const ORGANIZATION_CREATION_RATE_LIMIT = 5;
export const ORGANIZATION_CREATION_RATE_WINDOW_HOURS = 1;

/**
 * Validate organization name and return stripped version or throw when too long.
 */
export function validateOrganizationName(name: string): string {
	const stripped = name.trim();
	if (stripped.length > ORGANIZATION_NAME_MAX_LENGTH) {
		throw new OrganizationNameTooLongError(
			`Organization name must be at most ${ORGANIZATION_NAME_MAX_LENGTH} characters after trimming whitespace.`,
		);
	}
	return stripped;
}
