import { OWNER_CHILD_ENVIRONMENT_NAMES, type OwnerDispatch } from "@chatticus/host-protocol/supervisor";

/** The parts of a dispatch the per-turn child's environment is built from. */
export type ChildEnvironmentDispatch = Pick<OwnerDispatch, "dispatch_id" | "turn_id" | "bot_id" | "user_id" | "gateway_token" | "aws_credentials">;

type ChildEnvironmentName = (typeof OWNER_CHILD_ENVIRONMENT_NAMES)[number];

const SUPERVISOR_VALUE_NAMES: readonly ChildEnvironmentName[] = [
	"PATH",
	"HOME",
	"CHATTICUS_TENANT_ID",
	"CHATTICUS_OWNER_ID",
	"CHATTICUS_OWNER_START_GENERATION",
	"CHATTICUS_MESSAGING_TABLE",
	"CHATTICUS_CONVERSATIONS_TABLE",
	"CHATTICUS_PI_SESSIONS_BUCKET",
	"CHATTICUS_ENVIRONMENT",
	"CHATTICUS_MODEL_GATEWAY_URL",
	"CHATTICUS_WORKSPACE_ROOT",
	"CHATTICUS_SHELL_LAUNCHER",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
];

/**
 * Build the environment of one per-turn child from nothing: the names of {@link OWNER_CHILD_ENVIRONMENT_NAMES} and no other
 * key. Settings the supervisor shares come from its own environment; the member, the turn, the bot, the gateway token and
 * the per-turn AWS credentials come from the dispatch. Nothing of the supervisor's secrets can pass through, because a name
 * that is not listed is never copied.
 *
 * @param supervisorEnvironment The supervisor's environment. Names it does not set are left out of the child's.
 * @param dispatch The dispatch the child serves.
 * @returns A new environment object.
 */
export function buildOwnerChildEnvironment(supervisorEnvironment: NodeJS.ProcessEnv, dispatch: ChildEnvironmentDispatch): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const name of SUPERVISOR_VALUE_NAMES) {
		const value = supervisorEnvironment[name];
		if (value !== undefined && value !== "") environment[name] = value;
	}
	environment["CHATTICUS_USER_ID"] = dispatch.user_id;
	environment["CHATTICUS_DISPATCH_ID"] = dispatch.dispatch_id;
	environment["CHATTICUS_TAKEOVER_TURN_ID"] = dispatch.turn_id;
	environment["CHATTICUS_TAKEOVER_BOT_ID"] = dispatch.bot_id;
	environment["CHATTICUS_MODEL_GATEWAY_TOKEN"] = dispatch.gateway_token;
	environment["AWS_ACCESS_KEY_ID"] = dispatch.aws_credentials.access_key_id;
	environment["AWS_SECRET_ACCESS_KEY"] = dispatch.aws_credentials.secret_access_key;
	environment["AWS_SESSION_TOKEN"] = dispatch.aws_credentials.session_token;
	return environment;
}
