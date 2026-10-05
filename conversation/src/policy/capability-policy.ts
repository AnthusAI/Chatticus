import type { OvernightGatedResult } from "./overnight.ts";

export type ApprovalDecision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export const EgressClass = {
	None: "none",
	ApprovedOriginFetch: "approved_origin_fetch",
	StructuredSend: "structured_send",
	FileTransfer: "file_transfer",
} as const;
export type EgressClass = (typeof EgressClass)[keyof typeof EgressClass];

export const IngestClass = {
	None: "none",
	ApprovedOriginReference: "approved_origin_reference",
} as const;
export type IngestClass = (typeof IngestClass)[keyof typeof IngestClass];

export const BindingControl = {
	StructuredConnector: "structured_connector",
	ImmutableApproval: "immutable_approval",
	HumanTakeover: "human_takeover",
	UnboundStop: "unbound_stop",
} as const;
export type BindingControl = (typeof BindingControl)[keyof typeof BindingControl];

export const BrowserContextKind = {
	Untrusted: "untrusted",
	Privileged: "privileged",
} as const;
export type BrowserContextKind = (typeof BrowserContextKind)[keyof typeof BrowserContextKind];

export const V1_POLICY_EXCLUSIONS = new Set([
	"snapshot_cookie_integrity",
	"bot_to_bot_channel_injection",
	"approval_fatigue",
	"prompt_data_separation_as_boundary",
	"generic_browser_click_binding",
	"local_device_execution_isolation",
	"bot_as_security_boundary",
]);

const CONSEQUENTIAL_BROWSER_ALIASES: Record<string, string> = {
	send: "send",
	publish: "publish",
	purchase: "purchase",
	delete: "delete",
	"change production": "production_change",
};

/**
 * Authority a human task may grant. Page content cannot add fields.
 */
export class TaskCapabilityGrant {
	tools: ReadonlySet<string>;
	origins: ReadonlySet<string>;
	recipients: ReadonlySet<string>;
	fileScopes: ReadonlySet<string>;
	egressClasses: ReadonlySet<string>;
	ingestClasses: ReadonlySet<string>;

	constructor(
		tools: ReadonlySet<string>,
		origins: ReadonlySet<string>,
		recipients: ReadonlySet<string>,
		fileScopes: ReadonlySet<string>,
		egressClasses: ReadonlySet<string>,
		ingestClasses: ReadonlySet<string>,
	) {
		this.tools = tools;
		this.origins = origins;
		this.recipients = recipients;
		this.fileScopes = fileScopes;
		this.egressClasses = egressClasses;
		this.ingestClasses = ingestClasses;
	}
}

/**
 * One operation the model asks the worker to perform.
 */
export class RequestedCapability {
	tool: string;
	origin?: string | null;
	recipient?: string | null;
	filePath?: string | null;
	egressClass?: string | null;

	constructor(
		tool: string,
		origin?: string | null,
		recipient?: string | null,
		filePath?: string | null,
		egressClass?: string | null,
	) {
		this.tool = tool;
		this.origin = origin;
		this.recipient = recipient;
		this.filePath = filePath;
		this.egressClass = egressClass;
	}
}

/**
 * One blocked request recorded for the user without exposing secrets.
 */
export class CapabilityDenial {
	reason: string;
	request: RequestedCapability;
	recordedAt: Date;

	constructor(
		reason: string,
		request: RequestedCapability,
		recordedAt: Date,
	) {
		this.reason = reason;
		this.request = request;
		this.recordedAt = recordedAt;
	}
}

/**
 * One secret that lives on the household computer.
 */
export class HouseholdCredential {
	kind: string;
	name: string;
	value: string;

	constructor(
		kind: string,
		name: string,
		value: string,
	) {
		this.kind = kind;
		this.name = name;
		this.value = value;
	}
}

/**
 * One isolated browser context with its own storage partition.
 */
export class PolicyBrowserContext {
	kind: typeof BrowserContextKind[keyof typeof BrowserContextKind];
	pageUrl: string;
	namedSession: string | null;
	storagePartition: string;
	cookies: Map<string, string> = new Map();

	constructor(
		kind: typeof BrowserContextKind[keyof typeof BrowserContextKind],
		pageUrl: string,
		namedSession: string | null,
		storagePartition: string,
	) {
		this.kind = kind;
		this.pageUrl = pageUrl;
		this.namedSession = namedSession;
		this.storagePartition = storagePartition;
	}
}

/**
 * A structured connector operation with exact destination and payload.
 */
export class BoundConnectorOperation {
	actionType: string;
	destination: string;
	payload: string;
	approved: boolean;

	constructor(
		actionType: string,
		destination: string,
		payload: string,
		approved: boolean = false,
	) {
		this.actionType = actionType;
		this.destination = destination;
		this.payload = payload;
		this.approved = approved;
	}
}

/**
 * Return the closed grant attached when a human starts a bot turn.
 */
export function householdConversationGrant(): TaskCapabilityGrant {
	return new TaskCapabilityGrant(
		new Set(["read_workspace", "write_workspace"]),
		new Set(),
		new Set(),
		new Set(["/workspace"]),
		new Set([EgressClass.ApprovedOriginFetch]),
		new Set(),
	);
}

/**
 * Build a grant from a two-column Gherkin table.
 */
export function parseGrantTable(rows: Record<string, string>): TaskCapabilityGrant {
	const split = (fieldName: string): Set<string> => {
		const raw = rows[fieldName] ?? "";
		return new Set(
			raw
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part.length > 0),
		);
	};

	return new TaskCapabilityGrant(
		split("tools"),
		split("origins"),
		split("recipients"),
		split("file_scopes"),
		split("egress_classes"),
		split("ingest_classes"),
	);
}

/**
 * Serialize one task grant for durable storage.
 */
export function grantToPayload(grant: TaskCapabilityGrant): Record<string, string[]> {
	return {
		tools: [...grant.tools].sort(),
		origins: [...grant.origins].sort(),
		recipients: [...grant.recipients].sort(),
		file_scopes: [...grant.fileScopes].sort(),
		egress_classes: [...grant.egressClasses].sort(),
		ingest_classes: [...grant.ingestClasses].sort(),
	};
}

/**
 * Rebuild one task grant from durable storage.
 */
export function grantFromPayload(payload: Record<string, unknown>): TaskCapabilityGrant {
	const frozenset = (fieldName: string): Set<string> => {
		const raw = payload[fieldName] ?? [];
		if (!Array.isArray(raw)) {
			throw new Error(`grant field ${JSON.stringify(fieldName)} must be a list`);
		}
		return new Set(raw.map((part) => String(part)));
	};

	return new TaskCapabilityGrant(
		frozenset("tools"),
		frozenset("origins"),
		frozenset("recipients"),
		frozenset("file_scopes"),
		frozenset("egress_classes"),
		frozenset("ingest_classes"),
	);
}

function originFromUrl(url: string): string {
	const urlWithScheme = url.includes("://") ? url : `https://${url}`;
	const parsed = new URL(urlWithScheme);
	return `${parsed.protocol}//${parsed.hostname}`;
}

function fileInScopes(path: string, scopes: ReadonlySet<string>): boolean {
	for (const scope of scopes) {
		if (path === scope || path.startsWith(`${scope.replace(/\/$/, "")}/`)) {
			return true;
		}
	}
	return false;
}

/**
 * Evaluate grants, browser isolation, binding controls, and exclusions.
 */
export class CapabilityPolicy {
	grant: TaskCapabilityGrant | null = null;
	credentials: Map<string, HouseholdCredential> = new Map();
	denials: CapabilityDenial[] = [];
	egress_blocked: RequestedCapability[] = [];
	unblocked_egress: RequestedCapability[] = [];
	contexts: PolicyBrowserContext[] = [];
	last_decision: ApprovalDecision | null = null;
	last_binding: (typeof BindingControl)[keyof typeof BindingControl] | null = null;
	last_overnight: OvernightGatedResult | null = null;
	bound_operation: BoundConnectorOperation | null = null;
	recorded_exclusions: Set<string> = new Set();
	claimed_enforced_exclusions: Set<string> = new Set();
	channel_secret_accepted = false;
	worker_completed_takeover_action = false;
	sink_denial_is_control = false;
	prompt_wording_is_boundary = false;
	takeover_waiting = false;
	now: () => Date;

	constructor(now: (() => Date) | null = null) {
		this.now = now ?? (() => new Date());
	}

	/**
	 * Replace the active task grant.
	 */
	setGrant(grant: TaskCapabilityGrant): void {
		this.grant = grant;
	}

	/**
	 * Record a household secret. Untrusted browsing cannot use it.
	 */
	addCredential(credential: HouseholdCredential): void {
		this.credentials.set(credential.name, credential);
	}

	/**
	 * Open research browsing without privileged credentials.
	 */
	openUntrusted(pageUrl: string): PolicyBrowserContext {
		const context = new PolicyBrowserContext(
			"untrusted",
			pageUrl,
			null,
			"untrusted",
		);
		this.contexts.push(context);
		return context;
	}

	/**
	 * Open a named privileged session in its own partition.
	 */
	openPrivileged(pageUrl: string, service: string): PolicyBrowserContext {
		const context = new PolicyBrowserContext(
			"privileged",
			pageUrl,
			service,
			`privileged:${service}`,
		);
		this.contexts.push(context);
		return context;
	}

	/**
	 * Return whether this context may touch a named credential.
	 */
	contextMayUse(context: PolicyBrowserContext, name: string): boolean {
		const credential = this.credentials.get(name);
		if (credential === undefined) {
			return false;
		}
		if (context.kind === "untrusted") {
			return false;
		}
		if (credential.kind !== "browser_session") {
			return false;
		}
		return context.namedSession === name;
	}

	/**
	 * Untrusted browsing cannot read ambient workspace secrets.
	 */
	workspaceSecretReadable(context: PolicyBrowserContext, path: string): boolean {
		if (context.kind === "untrusted") {
			return false;
		}
		for (const cred of this.credentials.values()) {
			if (cred.kind === "workspace_secret" && cred.value === path) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Session secrets never appear in model-visible tool results.
	 */
	modelVisibleSecrets(context: PolicyBrowserContext): string[] {
		return [];
	}

	/**
	 * Write a cookie only into this context's partition.
	 */
	writeCookie(context: PolicyBrowserContext, name: string, value: string): void {
		context.cookies.set(name, value);
	}

	/**
	 * Read a cookie from this context's partition only.
	 */
	cookieInContext(context: PolicyBrowserContext, name: string): string | null {
		return context.cookies.get(name) ?? null;
	}

	/**
	 * Deny or require approval using the task grant, never page text.
	 */
	evaluate(request: RequestedCapability): ApprovalDecision {
		const grant = this.grant;
		if (grant === null) {
			return this._deny("no task grant", request);
		}
		if (!grant.tools.has(request.tool)) {
			return this._deny(`tool ${JSON.stringify(request.tool)} is not granted`, request);
		}
		if (request.origin) {
			const origin = originFromUrl(request.origin);
			if (!grant.origins.has(origin)) {
				return this._deny(`origin ${JSON.stringify(origin)} is not granted`, request);
			}
		}
		if (request.recipient && !grant.recipients.has(request.recipient)) {
			return this._deny(
				`recipient ${JSON.stringify(request.recipient)} is not granted`,
				request,
			);
		}
		if (request.filePath && !fileInScopes(request.filePath, grant.fileScopes)) {
			return this._deny(
				`file ${JSON.stringify(request.filePath)} is outside granted scopes`,
				request,
			);
		}
		if (request.egressClass && !grant.egressClasses.has(request.egressClass)) {
			return this._deny(
				`egress class ${JSON.stringify(request.egressClass)} is not granted`,
				request,
			);
		}
		if (this._isConsequentialAction(request.tool)) {
			this.last_decision = "REQUIRE_APPROVAL";
			this.last_binding = "immutable_approval";
			return "REQUIRE_APPROVAL";
		}
		this.last_decision = "ALLOW";
		return "ALLOW";
	}

	/**
	 * Refuse promoting an untrusted context to a privileged session.
	 */
	requestPrivilegedSession(context: PolicyBrowserContext, service: string): ApprovalDecision {
		const request = new RequestedCapability(
			"use_session",
			context.pageUrl,
		);
		if (context.kind === "untrusted") {
			return this._deny(
				"untrusted context cannot use privileged sessions",
				request,
			);
		}
		if (context.namedSession !== service) {
			return this._deny(
				"privileged context is bound to one named session",
				request,
			);
		}
		this.last_decision = "ALLOW";
		return "ALLOW";
	}

	/**
	 * Return the control a consequential browser or connector action needs.
	 */
	requiredBindingForBrowserAction(
		action: string,
		{ structuredConnector = false, takeoverControl = false, approved = false } = {},
	): typeof BindingControl[keyof typeof BindingControl] {
		const actionType = CONSEQUENTIAL_BROWSER_ALIASES[action] ?? action;
		if (takeoverControl) {
			this.last_binding = "human_takeover";
			return this.last_binding;
		}
		if (!structuredConnector && this._isConsequentialAction(actionType)) {
			this.last_binding = "unbound_stop";
			this.last_overnight = {
				executed: false,
				turn_status: "blocked",
				reason: "user_controlled_completion_required",
				completion_evidence: null,
				retried_unattended: false,
			};
			this.recordExclusion("generic_browser_click_binding");
			return this.last_binding;
		}
		if (structuredConnector && !approved) {
			this.last_binding = "immutable_approval";
			this.last_overnight = {
				executed: false,
				turn_status: "blocked",
				reason: "immutable_approval_required",
				completion_evidence: null,
				retried_unattended: false,
			};
			return this.last_binding;
		}
		this.last_binding = "structured_connector";
		return this.last_binding;
	}

	/**
	 * Record a structured connector operation that can bind exact arguments.
	 */
	bindConnector(actionType: string, destination: string, payload: string): BoundConnectorOperation {
		const operation = new BoundConnectorOperation(
			actionType,
			destination,
			payload,
		);
		this.bound_operation = operation;
		return operation;
	}

	/**
	 * Bind human approval to the recorded connector operation.
	 */
	approveBoundOperation(): void {
		if (this.bound_operation === null) {
			throw new Error("no bound connector operation");
		}
		this.bound_operation = new BoundConnectorOperation(
			this.bound_operation.actionType,
			this.bound_operation.destination,
			this.bound_operation.payload,
			true,
		);
	}

	/**
	 * Execute only an approved structured connector operation.
	 */
	executeBoundConnector(evidence: string = "smtp-250"): OvernightGatedResult {
		const operation = this.bound_operation;
		if (operation === null || !operation.approved) {
			this.requiredBindingForBrowserAction(
				operation?.actionType ?? "send",
				{
					structuredConnector: true,
					approved: false,
				},
			);
			const result = this.last_overnight;
			if (result === null) {
				throw new Error("last_overnight not set");
			}
			return result;
		}
		const result = {
			executed: true,
			turn_status: "completed",
			reason: null as string | null,
			completion_evidence: evidence,
			retried_unattended: false,
		};
		this.last_overnight = result;
		this.last_binding = BindingControl.StructuredConnector;
		return result;
	}

	/**
	 * Hand the computer to the human. Secrets never arrive via the channel.
	 */
	requireTakeover(reason: string): typeof BindingControl[keyof typeof BindingControl] {
		this.last_binding = "human_takeover";
		this.channel_secret_accepted = false;
		this.worker_completed_takeover_action = false;
		this.takeover_waiting = true;
		this.last_overnight = {
			executed: false,
			turn_status: "blocked",
			reason: "waiting_for_human_takeover",
			completion_evidence: null,
			retried_unattended: false,
		};
		return this.last_binding;
	}

	/**
	 * Name a v1 gap. Workers must not claim the missing control.
	 */
	recordExclusion(exclusion: string): void {
		if (!V1_POLICY_EXCLUSIONS.has(exclusion)) {
			throw new Error(`unknown v1 exclusion ${JSON.stringify(exclusion)}`);
		}
		this.recorded_exclusions.add(exclusion);
	}

	/**
	 * Return whether any worker claimed a v1 exclusion as enforced.
	 */
	workerClaimsEnforced(exclusion: string): boolean {
		return this.claimed_enforced_exclusions.has(exclusion);
	}

	/**
	 * Record that prompt/data separation did not stop the model.
	 */
	markInjectionFollowedByModel(): void {
		this.sink_denial_is_control = true;
		this.prompt_wording_is_boundary = false;
		this.recordExclusion("prompt_data_separation_as_boundary");
	}

	private _deny(reason: string, request: RequestedCapability): ApprovalDecision {
		this.denials.push(
			new CapabilityDenial(reason, request, this.now()),
		);
		if (request.origin || request.recipient || request.egressClass) {
			this.egress_blocked.push(request);
		}
		this.last_decision = "DENY";
		return "DENY";
	}

	private _isConsequentialAction(tool: string): boolean {
		const consequentialActionTypes = ["send", "publish", "purchase", "delete", "production_change"];
		return consequentialActionTypes.includes(tool);
	}
}
