import { randomBytes } from "node:crypto";
import { ParameterAlreadyExists, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

/** The shortest generated key the handler writes; the model gateway token code needs at least this many characters. */
export const GENERATED_SECURE_STRING_MINIMUM_LENGTH = 32;

/** What the handler reports as the version of a parameter it found and left alone. */
export const ADOPTED_PARAMETER_VERSION = "adopted";

/** The properties the GeneratedSecureString construct hands the custom resource. CloudFormation delivers every value as a string. */
export type GeneratedSecureStringProperties = {
	readonly ParameterName: string;
	readonly ValueLength: string | number;
	readonly Description?: string;
	readonly ParameterTags?: Readonly<Record<string, string>>;
};

/** The part of a Provider-framework onEvent request the handler reads. */
export type GeneratedSecureStringEvent = {
	readonly RequestType: "Create" | "Update" | "Delete";
	readonly PhysicalResourceId?: string;
	readonly ResourceProperties: GeneratedSecureStringProperties;
};

/** What the handler answers: the parameter name and its version, and never the value. */
export type GeneratedSecureStringResult = {
	readonly PhysicalResourceId: string;
	readonly Data?: { readonly Name: string; readonly Version: string };
};

/** The one SSM operation the handler uses; a real client or a fake satisfies it. */
export type GeneratedSecureStringParameterWriter = Pick<SSMClient, "send">;

/**
 * Generate a random key of letters and digits.
 *
 * @param length How many characters.
 * @returns The key; drawn from the operating system random source.
 */
export function generateKey(length: number): string {
	let key = "";
	while (key.length < length) {
		key += randomBytes(length).toString("base64url").replaceAll(/[^A-Za-z0-9]/g, "");
	}
	return key.slice(0, length);
}

function valueLengthOf(properties: GeneratedSecureStringProperties): number {
	const length = Number(properties.ValueLength);
	if (!Number.isInteger(length) || length < GENERATED_SECURE_STRING_MINIMUM_LENGTH) {
		throw new Error(`ValueLength must be an integer of at least ${GENERATED_SECURE_STRING_MINIMUM_LENGTH}.`);
	}
	return length;
}

function nameOf(properties: GeneratedSecureStringProperties): string {
	if (typeof properties.ParameterName !== "string" || !properties.ParameterName.startsWith("/")) {
		throw new Error("ParameterName must be an absolute parameter name.");
	}
	return properties.ParameterName;
}

/**
 * The onEvent handler of the GeneratedSecureString custom resource. Create writes a fresh random key as a standard-tier
 * SecureString under the default aws/ssm key and never overwrites; a parameter that already exists is adopted unchanged.
 * Update and Delete do nothing, because the parameter is retained and a key is replaced only on purpose. The answer and
 * every error carry the parameter name and never the key, and the handler prints nothing.
 *
 * @param ssm Writes the parameter.
 * @returns The handler.
 */
export function createGeneratedSecureStringHandler(
	ssm: GeneratedSecureStringParameterWriter,
): (event: GeneratedSecureStringEvent) => Promise<GeneratedSecureStringResult> {
	return async (event) => {
		const name = nameOf(event.ResourceProperties);
		if (event.RequestType !== "Create") return { PhysicalResourceId: event.PhysicalResourceId ?? name };
		const length = valueLengthOf(event.ResourceProperties);
		const tags = Object.entries(event.ResourceProperties.ParameterTags ?? {}).map(([Key, Value]) => ({ Key, Value }));
		try {
			const response = await ssm.send(
				new PutParameterCommand({
					Name: name,
					Value: generateKey(length),
					Type: "SecureString",
					Tier: "Standard",
					Overwrite: false,
					...(event.ResourceProperties.Description === undefined ? {} : { Description: event.ResourceProperties.Description }),
					...(tags.length === 0 ? {} : { Tags: tags }),
				}),
			);
			return { PhysicalResourceId: name, Data: { Name: name, Version: String(response.Version ?? 1) } };
		} catch (error) {
			if (error instanceof ParameterAlreadyExists || (error instanceof Error && error.name === "ParameterAlreadyExists")) {
				return { PhysicalResourceId: name, Data: { Name: name, Version: ADOPTED_PARAMETER_VERSION } };
			}
			throw new Error(`Writing the parameter ${name} failed with ${error instanceof Error ? error.name : "an unknown error"}.`);
		}
	};
}

/** The deployed handler, built from the Lambda's own role. */
export const handler = createGeneratedSecureStringHandler(new SSMClient({}));
