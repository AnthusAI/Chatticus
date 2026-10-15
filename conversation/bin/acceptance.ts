#!/usr/bin/env node

/**
 * Black-box acceptance runner for the thin-turn front door.
 *
 * Speaks only HTTP to a deployed environment: exchange the caller's IAM identity for an integration bearer, create a
 * bot and a channel, post, read the SSE stream, reload, and steer. The AWS credentials come from the ambient chain
 * (AWS_PROFILE); the invoke key is read from Secrets Manager at runtime and never printed.
 */

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { runSmokeTest } from "../src/acceptance/smoke-test.ts";

interface SmokeRunResult {
	status: "pass" | "fail";
	environment: string;
	checks: string[];
	error: string | null;
}

class BaseUrlNotSetError extends Error {}

class InvokeKeyUnavailableError extends Error {}

const REGION = "us-east-1";

function resolveBaseUrl(environment: string): string {
	const variableName = `CHATTICUS_${environment.toUpperCase()}_BASE_URL`;
	const url = process.env[variableName];
	if (!url) {
		throw new BaseUrlNotSetError(`base url for ${environment} not set (${variableName})`);
	}
	return url;
}

async function readInvokeKey(environment: string): Promise<string> {
	const parameter = `/chatticus/${environment}/thin-turn/invoke-key-secret-arn`;
	const secretArn = (await new SSMClient({ region: REGION }).send(new GetParameterCommand({ Name: parameter }))).Parameter?.Value;
	if (!secretArn) {
		throw new InvokeKeyUnavailableError(`SSM parameter ${parameter} has no value`);
	}
	const secret = (await new SecretsManagerClient({ region: REGION }).send(new GetSecretValueCommand({ SecretId: secretArn }))).SecretString;
	if (!secret) {
		throw new InvokeKeyUnavailableError("the invoke key secret has no value");
	}
	return secret;
}

async function runSmoke(environment: string): Promise<SmokeRunResult> {
	const checks: string[] = [];
	try {
		const baseUrl = resolveBaseUrl(environment);
		const credentials = await new STSClient({ region: REGION }).config.credentials();
		const invokeKey = await readInvokeKey(environment);
		await runSmokeTest({ baseUrl, invokeKey, credentials }, checks);
		return { status: "pass", environment, checks, error: null };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { status: "fail", environment, checks, error: message };
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	let environment = "development";
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--environment") {
			environment = args[index + 1] || "development";
			index++;
		}
	}
	const result = await runSmoke(environment);
	console.log(JSON.stringify(result, null, 2));
	if (result.status === "pass") {
		process.exit(0);
	}
	process.exit(result.error?.startsWith("base url") ? 2 : 1);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
