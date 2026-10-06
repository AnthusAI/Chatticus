import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

/** The part of an SSM client this helper uses. */
export interface ParameterReader {
	send(command: GetParameterCommand): Promise<{ Parameter?: { Value?: string } }>;
}

/**
 * Resolve the OpenAI API key into `OPENAI_API_KEY` for pi-ai. A deployed Lambda names an SSM SecureString in
 * `OPENAI_API_KEY_PARAMETER`; the value is read once at cold start. Nothing happens when the key is already set or no parameter is named (local runs).
 *
 * @param environment The environment to read and write; defaults to the process environment.
 * @param reader The SSM client; defaults to a real one.
 */
export async function resolveOpenAiApiKey(
	environment: Record<string, string | undefined> = process.env,
	reader: ParameterReader = new SSMClient({}),
): Promise<void> {
	if ((environment.OPENAI_API_KEY ?? "") !== "") return;
	const parameterName = environment.OPENAI_API_KEY_PARAMETER ?? "";
	if (parameterName === "") return;
	const response = await reader.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
	const value = response.Parameter?.Value ?? "";
	if (value === "") {
		throw new Error(`The SSM parameter ${parameterName} has no value.`);
	}
	environment.OPENAI_API_KEY = value;
}
