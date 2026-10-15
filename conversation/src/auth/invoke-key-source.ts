import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * How long a Front Door instance keeps the invoke keys it read from Secrets Manager before it reads them again.
 * A rotated key is accepted by every warm instance within this many seconds.
 */
export const INVOKE_KEY_CACHE_SECONDS = 60;

/** The Secrets Manager stage of the key CloudFront presents today. */
export const INVOKE_KEY_CURRENT_STAGE = "AWSCURRENT";

/** The Secrets Manager stage of the key before the last rotation; it is accepted until the operator retires it. */
export const INVOKE_KEY_PREVIOUS_STAGE = "AWSPREVIOUS";

/** The invoke keys the Front Door accepts right now: the current key first, then the previous key while one is staged. */
export type InvokeKeySource = () => Promise<readonly string[]>;

/** The one Secrets Manager operation the source uses; a real client or a fake satisfies it. */
export type InvokeKeySecretReader = Pick<SecretsManagerClient, "send">;

/** The clock the cache expires against. */
export type InvokeKeyClock = { now(): Date };

/** An invoke key source that always answers the one key; for a front door under test. */
export function staticInvokeKeySource(invokeKey: string): InvokeKeySource {
	return async () => [invokeKey];
}

/** True when the presented key equals one of the accepted keys; every accepted key is compared. */
export function acceptsInvokeKey(provided: string, accepted: readonly string[], matches: (a: string, b: string) => boolean): boolean {
	let found = false;
	for (const key of accepted) {
		if (matches(provided, key)) found = true;
	}
	return found;
}

async function readStage(secrets: InvokeKeySecretReader, secretArn: string, stage: string): Promise<string | null> {
	try {
		const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn, VersionStage: stage }));
		const value = response.SecretString ?? "";
		return value === "" ? null : value;
	} catch (error) {
		if (error instanceof Error && error.name === "ResourceNotFoundException") return null;
		throw error;
	}
}

/**
 * Read the invoke key secret by ARN and keep what was read for {@link INVOKE_KEY_CACHE_SECONDS}. The source answers the
 * current key and, while the secret still stages one, the previous key, so a rotation has no moment at which the key
 * CloudFront still presents is refused. When a refresh fails the keys already held keep answering and the next request
 * tries again.
 *
 * @param secrets Reads the secret.
 * @param secretArn The ARN of the invoke key secret.
 * @param clock What the cache age is measured against.
 * @param cacheSeconds How long one read is kept.
 * @returns The source, after the first read has succeeded.
 * @throws Error If the first read finds no current key.
 */
export async function secretsManagerInvokeKeySource(
	secrets: InvokeKeySecretReader,
	secretArn: string,
	clock: InvokeKeyClock,
	cacheSeconds: number = INVOKE_KEY_CACHE_SECONDS,
): Promise<InvokeKeySource> {
	const read = async (): Promise<readonly string[]> => {
		const current = await readStage(secrets, secretArn, INVOKE_KEY_CURRENT_STAGE);
		if (current === null) throw new Error(`The secret ${secretArn} has no value.`);
		const previous = await readStage(secrets, secretArn, INVOKE_KEY_PREVIOUS_STAGE);
		return previous === null || previous === current ? [current] : [current, previous];
	};
	let keys = await read();
	let readAtMilliseconds = clock.now().getTime();
	let refresh: Promise<void> | null = null;
	return async () => {
		if (clock.now().getTime() - readAtMilliseconds < cacheSeconds * 1000) return keys;
		if (refresh === null) {
			refresh = read()
				.then((fresh) => {
					keys = fresh;
					readAtMilliseconds = clock.now().getTime();
				})
				.catch((error: unknown) => {
					console.error(`invoke_key_refresh_failed detail=${error instanceof Error ? error.message : String(error)}`);
				})
				.finally(() => {
					refresh = null;
				});
		}
		await refresh;
		return keys;
	};
}
