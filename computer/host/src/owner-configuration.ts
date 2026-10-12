/** A required setting of the container owner or its supervisor is missing. */
export class OwnerConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OwnerConfigurationError";
	}
}

/**
 * Read one required setting that must be a positive whole number.
 *
 * @param environment The environment to read.
 * @param name The variable name.
 * @returns The number.
 * @throws OwnerConfigurationError If the variable is missing, blank or not a positive whole number. The message names the variable and never a value.
 */
export function requiredPositiveIntegerSetting(environment: NodeJS.ProcessEnv, name: string): number {
	const text = requiredSetting(environment, name);
	if (!/^[1-9][0-9]*$/.test(text)) throw new OwnerConfigurationError(`The environment variable ${name} must be a positive whole number.`);
	return Number.parseInt(text, 10);
}

/**
 * Read one required setting from an environment.
 *
 * @param environment The environment to read.
 * @param name The variable name.
 * @returns The trimmed, non-empty value.
 * @throws OwnerConfigurationError If the variable is missing or blank. The message names the variable and never a value.
 */
export function requiredSetting(environment: NodeJS.ProcessEnv, name: string): string {
	const value = (environment[name] ?? "").trim();
	if (value === "") throw new OwnerConfigurationError(`The environment variable ${name} is required.`);
	return value;
}
