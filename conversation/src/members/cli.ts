/**
 * Administrator CLI: list, inspect, and mutate organization records.
 * Ported from python/src/chatticus/members/__main__.py (lines 1-327).
 */

import { parseArgs } from "node:util";
import { DomainError } from "../http/errors.ts";
import { validateOrganizationName } from "../domain/creation-limits.ts";
import { OrganizationsKernelImpl } from "../domain/organizations.ts";
import type { IdSource, MemberRole, Organization, OrganizationStatus } from "../domain/organizations.ts";
import type { Clock } from "../storage/storage-support.ts";
import type { MessagingStore } from "../store/messaging-store.ts";

const ORGANIZATION_STATUSES: readonly OrganizationStatus[] = ["pending", "enabled", "suspended"];
const MEMBER_ROLES: readonly MemberRole[] = ["owner", "member"];

const PROGRAM_NAME = "members";
const COMMAND_CHOICES = "{list,show,enable,suspend,reinstate,set-role,create,seed}";

/** Raised when the process environment cannot support the command; exit code 2. */
export class MembersCliConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MembersCliConfigurationError";
	}
}

/** Raised for a malformed command line; exit code 2 with a usage line. */
export class MembersCliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MembersCliUsageError";
	}
}

/** Everything the CLI needs from its process. */
export interface MembersCliDependencies {
	/** Builds the store; throws MembersCliConfigurationError when the environment is incomplete. */
	buildStore: () => MessagingStore;
	clock: Clock;
	ids: IdSource;
	/** True when stdin is a terminal, which waives the --yes requirement. */
	stdinIsTerminal: boolean;
	/** The AWS account id of the operator credentials running the command; seed, enable and reinstate record it as the home of an organization that chose no setup path. */
	callerAwsAccountId: () => Promise<string>;
}

/** Captured result of one CLI invocation. */
export interface MembersCliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const kernel = new OrganizationsKernelImpl();

const CONFIRMATION_FLAG_HELP = "  --yes       Required when stdin is not a TTY";

const TOP_LEVEL_HELP = `usage: ${PROGRAM_NAME} [-h] ${COMMAND_CHOICES} ...

Inspect and mutate Chatticus organization records. Reads the messaging table from CHATTICUS_MESSAGING_TABLE.

positional arguments:
  ${COMMAND_CHOICES}
    list                List organizations filtered by lifecycle status
    show                Show one organization
    enable              Enable one pending organization without provisioning a computer
    suspend             Suspend one enabled organization
    reinstate           Reinstate one suspended organization without provisioning a computer
    set-role            Set one member role on the admin path
    create              Create one pending organization for a cold bootstrap path
    seed                Seed one tenant enabled for one owner without provisioning a computer

options:
  -h, --help            show this help message and exit
`;

function lifecycleHelp(command: string): string {
	return `usage: ${PROGRAM_NAME} ${command} [-h] [--yes] tenant_id

positional arguments:
  tenant_id   tenant_id

options:
  -h, --help  show this help message and exit
${CONFIRMATION_FLAG_HELP}
`;
}

const COMMAND_HELP: Record<string, string> = {
	list: `usage: ${PROGRAM_NAME} list [-h] --status {pending,enabled,suspended}

options:
  -h, --help  show this help message and exit
  --status    Organization lifecycle status to list
`,
	show: `usage: ${PROGRAM_NAME} show [-h] tenant_id

positional arguments:
  tenant_id   tenant_id

options:
  -h, --help  show this help message and exit
`,
	enable: lifecycleHelp("enable"),
	suspend: lifecycleHelp("suspend"),
	reinstate: lifecycleHelp("reinstate"),
	"set-role": `usage: ${PROGRAM_NAME} set-role [-h] [--yes] tenant_id user_id {owner,member}

positional arguments:
  tenant_id       tenant_id
  user_id         member user_id
  {owner,member}  member role

options:
  -h, --help      show this help message and exit
${CONFIRMATION_FLAG_HELP}
`,
	create: `usage: ${PROGRAM_NAME} create [-h] --owner-email OWNER_EMAIL --name NAME [--yes]

options:
  -h, --help            show this help message and exit
  --owner-email OWNER_EMAIL
                        Verified owner email; normalized to lowercase
  --name NAME           Organization display name
${CONFIRMATION_FLAG_HELP}
`,
	seed: `usage: ${PROGRAM_NAME} seed [-h] --tenant-id TENANT_ID --owner-email OWNER_EMAIL [--name NAME] [--yes]

options:
  -h, --help            show this help message and exit
  --tenant-id TENANT_ID
                        tenant_id to seed, for example anthus
  --owner-email OWNER_EMAIL
                        Verified owner email; normalized to lowercase
  --name NAME           Organization display name (default: tenant id)
${CONFIRMATION_FLAG_HELP}
`,
};

interface ParsedCommand {
	command: string;
	positionals: string[];
	flags: Record<string, string | boolean | undefined>;
}

interface CommandShape {
	positionalNames: string[];
	options: Record<string, { type: "string" | "boolean" }>;
	required: string[];
}

const YES_OPTION = { yes: { type: "boolean" } } as const;

const COMMAND_SHAPES: Record<string, CommandShape> = {
	list: { positionalNames: [], options: { status: { type: "string" } }, required: ["status"] },
	show: { positionalNames: ["tenant_id"], options: {}, required: [] },
	enable: { positionalNames: ["tenant_id"], options: YES_OPTION, required: [] },
	suspend: { positionalNames: ["tenant_id"], options: YES_OPTION, required: [] },
	reinstate: { positionalNames: ["tenant_id"], options: YES_OPTION, required: [] },
	"set-role": { positionalNames: ["tenant_id", "user_id", "role"], options: YES_OPTION, required: [] },
	create: {
		positionalNames: [],
		options: { "owner-email": { type: "string" }, name: { type: "string" }, ...YES_OPTION },
		required: ["owner-email", "name"],
	},
	seed: {
		positionalNames: [],
		options: {
			"tenant-id": { type: "string" },
			"owner-email": { type: "string" },
			name: { type: "string" },
			...YES_OPTION,
		},
		required: ["tenant-id", "owner-email"],
	},
};

type HelpRequest = { help: string };

function parseCommandLine(argv: string[]): ParsedCommand | HelpRequest {
	if (argv.length === 0) {
		throw new MembersCliUsageError("the following arguments are required: command");
	}
	const [command, ...rest] = argv;
	if (command === "-h" || command === "--help") {
		return { help: TOP_LEVEL_HELP };
	}
	const shape = COMMAND_SHAPES[command];
	if (shape === undefined) {
		throw new MembersCliUsageError(
			`argument command: invalid choice: ${JSON.stringify(command)} (choose from ${Object.keys(COMMAND_SHAPES).join(", ")})`,
		);
	}
	if (rest.includes("-h") || rest.includes("--help")) {
		return { help: COMMAND_HELP[command] };
	}
	let parsed;
	try {
		parsed = parseArgs({ args: rest, options: shape.options, allowPositionals: true, strict: true });
	} catch (error) {
		throw new MembersCliUsageError((error as Error).message);
	}
	if (parsed.positionals.length < shape.positionalNames.length) {
		const missing = shape.positionalNames.slice(parsed.positionals.length);
		throw new MembersCliUsageError(`the following arguments are required: ${missing.join(", ")}`);
	}
	if (parsed.positionals.length > shape.positionalNames.length) {
		throw new MembersCliUsageError(
			`unrecognized arguments: ${parsed.positionals.slice(shape.positionalNames.length).join(" ")}`,
		);
	}
	const missingFlags = shape.required.filter((name) => parsed.values[name] === undefined);
	if (missingFlags.length > 0) {
		throw new MembersCliUsageError(
			`the following arguments are required: ${missingFlags.map((name) => `--${name}`).join(", ")}`,
		);
	}
	return { command, positionals: parsed.positionals, flags: parsed.values };
}

class OutputBuffer {
	stdout = "";
	stderr = "";

	printLine(line: string): void {
		this.stdout += `${line}\n`;
	}
}

function requireYes(yes: boolean, action: string, dependencies: MembersCliDependencies): void {
	if (dependencies.stdinIsTerminal || yes) {
		return;
	}
	throw new MembersCliConfigurationError(`Refusing ${action} without --yes (stdin is not a TTY).`);
}

function printOrganizationLine(output: OutputBuffer, organization: Organization): void {
	output.printLine(
		`${organization.tenantId}\t${organization.name}\t${organization.status}\t${organization.ownerUserId}`,
	);
}

function printOrganizationSummary(output: OutputBuffer, organization: Organization): void {
	output.printLine(`tenant_id=${organization.tenantId}`);
	output.printLine(`name=${organization.name}`);
	output.printLine(`status=${organization.status}`);
	output.printLine(`owner=${organization.ownerUserId}`);
}

async function runLifecycleCommand(
	command: "enable" | "suspend" | "reinstate",
	tenantId: string,
	yes: boolean,
	store: MessagingStore,
	output: OutputBuffer,
	dependencies: MembersCliDependencies,
): Promise<number> {
	const organization = await kernel.getOrganization(tenantId, { store });
	requireYes(yes, command, dependencies);
	printOrganizationSummary(output, organization);
	const updated =
		command === "enable"
			? await kernel.enableOrganization(tenantId, { store, callerAwsAccountId: dependencies.callerAwsAccountId })
			: command === "suspend"
				? await kernel.suspendOrganization(tenantId, { store })
				: await kernel.reinstateOrganization(tenantId, { store, callerAwsAccountId: dependencies.callerAwsAccountId });
	const pastTense = command === "enable" ? "enabled" : command === "suspend" ? "suspended" : "reinstated";
	output.printLine(`${pastTense} tenant_id=${updated.tenantId} status=${updated.status}`);
	return 0;
}

async function dispatch(
	parsed: ParsedCommand,
	store: MessagingStore,
	output: OutputBuffer,
	dependencies: MembersCliDependencies,
): Promise<number> {
	const yes = parsed.flags.yes === true;
	const { command, positionals, flags } = parsed;
	if (command === "list") {
		const status = flags.status as string;
		if (!ORGANIZATION_STATUSES.includes(status as OrganizationStatus)) {
			throw new MembersCliUsageError(
				`argument --status: invalid choice: ${JSON.stringify(status)} (choose from ${ORGANIZATION_STATUSES.join(", ")})`,
			);
		}
		const organizations = await kernel.listOrganizationsByStatus(status as OrganizationStatus, { store });
		for (const organization of organizations) {
			printOrganizationLine(output, organization);
		}
		return 0;
	}
	if (command === "show") {
		printOrganizationLine(output, await kernel.getOrganization(positionals[0], { store }));
		return 0;
	}
	if (command === "enable" || command === "suspend" || command === "reinstate") {
		return runLifecycleCommand(command, positionals[0], yes, store, output, dependencies);
	}
	if (command === "create") {
		requireYes(yes, "create", dependencies);
		const creationDependencies = { store, clock: dependencies.clock, ids: dependencies.ids };
		const owner = await kernel.signIn(flags["owner-email"] as string, creationDependencies);
		const organization = await kernel.adminCreateOrganization(
			owner,
			validateOrganizationName(flags.name as string),
			creationDependencies,
		);
		output.printLine(
			`created tenant_id=${organization.tenantId} status=${organization.status} owner=${owner.userId}`,
		);
		return 0;
	}
	if (command === "seed") {
		requireYes(yes, "seed", dependencies);
		const tenantId = flags["tenant-id"] as string;
		const ownerEmail = flags["owner-email"] as string;
		const name = (flags.name as string | undefined) || tenantId;
		const organization = await kernel.adminSeedOrganization(tenantId, ownerEmail, name, {
			store,
			clock: dependencies.clock,
			ids: dependencies.ids,
			callerAwsAccountId: dependencies.callerAwsAccountId,
		});
		output.printLine(
			`seeded tenant_id=${organization.tenantId} status=${organization.status} owner=${organization.ownerUserId} email=${ownerEmail.trim().toLowerCase()}`,
		);
		return 0;
	}
	const [tenantId, userId, role] = positionals;
	if (!MEMBER_ROLES.includes(role as MemberRole)) {
		throw new MembersCliUsageError(
			`argument role: invalid choice: ${JSON.stringify(role)} (choose from ${MEMBER_ROLES.join(", ")})`,
		);
	}
	const organization = await kernel.getOrganization(tenantId, { store });
	requireYes(yes, "set-role", dependencies);
	printOrganizationSummary(output, organization);
	const membership = await kernel.adminSetMemberRole(tenantId, userId, role as MemberRole, { store });
	output.printLine(`set-role tenant_id=${membership.tenantId} user_id=${membership.userId} role=${membership.role}`);
	return 0;
}

/**
 * Run one members administrator command.
 * Exit code 0 on success, 1 for a domain failure, 2 for a usage or configuration failure.
 */
export async function runMembersCli(argv: string[], dependencies: MembersCliDependencies): Promise<MembersCliResult> {
	const output = new OutputBuffer();
	let exitCode: number;
	try {
		const parsed = parseCommandLine(argv);
		if ("help" in parsed) {
			return { exitCode: 0, stdout: parsed.help, stderr: "" };
		}
		const store = dependencies.buildStore();
		exitCode = await dispatch(parsed, store, output, dependencies);
	} catch (error) {
		if (error instanceof MembersCliUsageError) {
			output.stderr += `usage: ${PROGRAM_NAME} [-h] ${COMMAND_CHOICES} ...\n`;
			output.stderr += `${PROGRAM_NAME}: error: ${error.message}\n`;
			exitCode = 2;
		} else if (error instanceof MembersCliConfigurationError) {
			output.stderr += `${error.message}\n`;
			exitCode = 2;
		} else if (error instanceof DomainError) {
			output.stderr += `${error.message}\n`;
			exitCode = 1;
		} else {
			throw error;
		}
	}
	return { exitCode, stdout: output.stdout, stderr: output.stderr };
}
