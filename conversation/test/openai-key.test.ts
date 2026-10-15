import type { GetParameterCommand } from "@aws-sdk/client-ssm";
import { describe, expect, it } from "vitest";
import { resolveOpenAiApiKey } from "../src/lambdas/openai-key.ts";

function fakeReader(value: string | undefined) {
	const names: string[] = [];
	return {
		names,
		async send(command: GetParameterCommand) {
			names.push(command.input.Name ?? "");
			return { Parameter: value === undefined ? undefined : { Value: value } };
		},
	};
}

describe("resolveOpenAiApiKey", () => {
	it("reads the parameter once and sets OPENAI_API_KEY", async () => {
		const environment: Record<string, string | undefined> = { OPENAI_API_KEY_PARAMETER: "/chatticus/development/key" };
		const reader = fakeReader("sk-test");
		await resolveOpenAiApiKey(environment, reader);
		await resolveOpenAiApiKey(environment, reader);
		expect(environment.OPENAI_API_KEY).toBe("sk-test");
		expect(reader.names).toEqual(["/chatticus/development/key"]);
	});

	it("does nothing when the key is already set", async () => {
		const environment: Record<string, string | undefined> = { OPENAI_API_KEY: "already", OPENAI_API_KEY_PARAMETER: "/x" };
		const reader = fakeReader("other");
		await resolveOpenAiApiKey(environment, reader);
		expect(environment.OPENAI_API_KEY).toBe("already");
		expect(reader.names).toEqual([]);
	});

	it("fails clearly when the parameter is missing", async () => {
		await expect(resolveOpenAiApiKey({ OPENAI_API_KEY_PARAMETER: "/missing" }, fakeReader(undefined))).rejects.toThrow(
			"The SSM parameter /missing has no value.",
		);
	});
});
