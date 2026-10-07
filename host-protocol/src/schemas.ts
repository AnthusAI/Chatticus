import { z } from "zod";

/** The kind of the action that opens a page in the host browser. The control plane emits it and the host runs it. */
export const BROWSE_ACTION_KIND = "browse";

/** The kind of the action that asks the host for a capability, such as a browser session. */
export const REQUEST_COMPUTER_CAPABILITY_ACTION_KIND = "request_computer_capability";

/** The action kinds the host browser runs. */
export const BROWSER_ACTION_KINDS: ReadonlySet<string> = new Set([BROWSE_ACTION_KIND, REQUEST_COMPUTER_CAPABILITY_ACTION_KIND]);

/** The header that names the member a host serves, sent with every host request. */
export const HOST_USER_HEADER = "X-Chatticus-Host-User-Id";

/** The capability gates a host reports ready, one at a time. */
export const hostCapabilitySchema = z.enum(["model", "workspace", "browser"]);

/** The kinds of regate a host asks for when a tool reaches past the envelope of its action. */
export const regateKindSchema = z.enum(["browse", "read", "write", "edit", "terminal"]);

/** The capability a computer image may leave out and report unavailable instead of failing to boot. */
export const hostOptionalCapabilitySchema = z.literal("browser");

/** POST /orgs/{tenant}/host/computer/state: the host says the computer runs or stopped, and which capability cleared or is unavailable. */
export const computerStateRequestSchema = z
	.object({
		stopped: z.boolean().optional(),
		capability_ready: hostCapabilitySchema.optional(),
		capability_unavailable: hostOptionalCapabilitySchema.optional(),
	})
	.strict()
	.refine((body) => body.stopped !== undefined || body.capability_ready !== undefined || body.capability_unavailable !== undefined, {
		message: "stopped, capability_ready or capability_unavailable is required",
	});

/** POST /orgs/{tenant}/host/snapshot/hydrated: the host hydrated the published snapshot onto its disk. */
export const snapshotHydratedRequestSchema = z.object({ worker_id: z.string().min(1) }).strict();

/** POST /orgs/{tenant}/host/snapshot/published: the host packed its disk, uploaded it, and reports where. */
export const snapshotPublishedRequestSchema = z
	.object({
		worker_id: z.string().min(1),
		checksum: z.string().min(1),
		snapshot_uri: z.string().min(1).optional(),
	})
	.strict();

/** POST /orgs/{tenant}/host/actions/claim: the host asks for the next action; the worker is the one the token names. */
export const claimActionRequestSchema = z.object({}).strict();

/** POST /orgs/{tenant}/host/actions/{id}/renew: the host extends the lease of the action it holds. */
export const renewActionRequestSchema = z.object({}).strict();

/** POST /orgs/{tenant}/host/actions/{id}/result: what the tool answered, or the error it failed with; never both. */
export const actionResultRequestSchema = z.union([
	z.object({ result: z.string() }).strict(),
	z.object({ error: z.string() }).strict(),
]);

/** POST /orgs/{tenant}/host/actions/{id}/regate: ask whether the action may reach one more origin or path. */
export const regateActionRequestSchema = z
	.object({
		kind: regateKindSchema,
		target: z.string().min(1),
	})
	.strict();

/** POST /orgs/{tenant}/host/heartbeat: the host is alive; the worker is the one the token names. */
export const heartbeatRequestSchema = z.object({}).strict();

/** The envelope of an action: what the host may do for the tool call, written by the executor before the action exists. */
export const actionEnvelopeSchema = z.looseObject({
	tool: z.string(),
	idempotent: z.boolean(),
	path: z.string().optional(),
	cwd: z.string().optional(),
	origin: z.string().optional(),
});

/** One action as the host reads it: what to run, where, what it may touch, and how long it holds the action. */
export const hostActionSchema = z.object({
	action_id: z.string(),
	turn_id: z.string(),
	call_id: z.string(),
	tool_name: z.string(),
	arguments: z.record(z.string(), z.string()),
	gate: z.string(),
	envelope: actionEnvelopeSchema,
	status: z.string(),
	lease_expires_at: z.string().nullable(),
});

/** The answer of POST .../actions/claim: the next action under a lease, or null when nothing waits for this host. */
export const claimActionResponseSchema = z.object({ action: hostActionSchema.nullable() });

/** The answer of POST .../actions/{id}/renew. */
export const renewActionResponseSchema = z.object({ action: hostActionSchema });

/** The answer of POST .../actions/{id}/result. */
export const actionResultResponseSchema = z.object({
	status: z.literal("ok"),
	action_id: z.string(),
	turn_id: z.string(),
	turn_resumed: z.boolean(),
});

/** The answer of POST .../actions/{id}/regate when the target is allowed; a refusal is a 403 with a detail. */
export const regateActionResponseSchema = z.object({ status: z.literal("ok") });

/** The computer as the host reads it. */
export const hostComputerSchema = z.object({
	computer_id: z.string(),
	tenant_id: z.string(),
	stopped: z.boolean(),
	policy: z.string(),
	host_start_generation: z.number(),
	model_ready: z.boolean(),
	workspace_ready: z.boolean(),
	browser_ready: z.boolean(),
	browser_unavailable: z.boolean().optional(),
	snapshot_generation: z.number(),
	disk_dirty: z.boolean(),
	hydrate_required: z.boolean(),
	snapshot_uri: z.string().optional(),
	snapshot_checksum: z.string().optional(),
	intended_host_worker_id: z.string().optional(),
});

/** The answer of the snapshot routes and the heartbeat. */
export const hostStatusResponseSchema = z.object({ status: z.string() });

export type ComputerStateRequest = z.infer<typeof computerStateRequestSchema>;
export type SnapshotHydratedRequest = z.infer<typeof snapshotHydratedRequestSchema>;
export type SnapshotPublishedRequest = z.infer<typeof snapshotPublishedRequestSchema>;
export type ActionResultRequest = z.infer<typeof actionResultRequestSchema>;
export type RegateActionRequest = z.infer<typeof regateActionRequestSchema>;
export type HostAction = z.infer<typeof hostActionSchema>;
export type HostComputer = z.infer<typeof hostComputerSchema>;
