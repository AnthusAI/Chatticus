#!/usr/bin/env node

/**
 * Black-box acceptance runner for the thin-turn front door.
 *
 * Speaks only HTTP to a deployed environment: sign in, create bot, create channel,
 * post, read the SSE stream, reload.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface SmokeRunResult {
	status: string;
	checks: string[];
	error: string | null;
}

class Error extends globalThis.Error {
	constructor(message: string) {
		super(message);
		this.name = this.constructor.name;
	}
}

class BaseUrlNotSetError extends Error {}

async function runSmoke(environment: string): Promise<SmokeRunResult> {
	const checks: string[] = [];

	const baseUrl = resolveBaseUrl(environment);
	if (!baseUrl) {
		return {
			status: "fail",
			checks,
			error: `base url for ${environment} not set`,
		};
	}

	try {
		await runSmokeTest(baseUrl, checks);
		return { status: "pass", checks, error: null };
	} catch (err) {
		return {
			status: "fail",
			checks,
			error: err instanceof globalThis.Error ? err.message : String(err),
		};
	}
}

function resolveBaseUrl(environment: string): string | null {
	const varName = `CHATTICUS_${environment.toUpperCase()}_BASE_URL`;
	const url = process.env[varName];
	if (url) {
		return url;
	}

	const agentsLocalPath = join(process.cwd(), "AGENTS.local.md");
	if (existsSync(agentsLocalPath)) {
		return null;
	}

	return null;
}

async function runSmokeTest(baseUrl: string, checks: string[]): Promise<void> {
	throw new Error("Smoke test not yet implemented");
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	let environment = "development";

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--environment") {
			environment = args[i + 1] || "development";
			i++;
		}
	}

	const result = await runSmoke(environment);

	if (result.error) {
		console.error(result.error);
	}

	for (const check of result.checks) {
		console.log(check);
	}

	process.exit(result.status === "pass" ? 0 : result.error?.startsWith("base url") ? 2 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
