// conversation/src/turn/executor.ts
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT3 } from "@earendil-works/chord/context";
import {
  watchEvents
} from "@earendil-works/pi-durable";

// conversation/src/http/errors.ts
var DomainError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = this.constructor.name;
  }
};
var ActorNotInChannelError = class extends DomainError {
  constructor(message) {
    super("actor_not_in_channel", message);
  }
};
var TurnNotFoundError = class extends DomainError {
  constructor(message) {
    super("turn_not_found", message);
  }
};
var StaleAttemptError = class extends DomainError {
  constructor(message) {
    super("stale_attempt", message);
  }
};
var TurnTerminalError = class extends DomainError {
  constructor(message) {
    super("turn_terminal", message);
  }
};
var TaskNotFoundError = class extends DomainError {
  constructor(message) {
    super("task_not_found", message);
  }
};
var TaskEvidenceRequiredError = class extends DomainError {
  constructor(message) {
    super("task_evidence_required", message);
  }
};
var TaskCloseReasonRequiredError = class extends DomainError {
  constructor(message) {
    super("task_close_reason_required", message);
  }
};
var MemberStandingRequiredError = class extends DomainError {
  constructor(message) {
    super("member_standing_required", message);
  }
};

// conversation/src/budget/calendar.ts
var MILLISECONDS_PER_DAY = 864e5;
function utcDayOf(moment) {
  return moment.toISOString().slice(0, 10);
}
function addDays(isoDay, days) {
  const moment = /* @__PURE__ */ new Date(`${isoDay}T00:00:00Z`);
  return utcDayOf(new Date(moment.getTime() + days * MILLISECONDS_PER_DAY));
}
function firstDayOfMonth(isoDay) {
  return `${isoDay.slice(0, 8)}01`;
}

// conversation/src/budget/decimal.ts
var TEN = 10n;
var DECIMAL_PATTERN = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
function powerOfTen(exponent) {
  return TEN ** BigInt(exponent);
}
var Decimal = class _Decimal {
  units;
  scale;
  constructor(units, scale) {
    this.units = units;
    this.scale = scale;
  }
  static parse(text3) {
    const match = DECIMAL_PATTERN.exec(text3.trim());
    if (match === null) {
      throw new Error(`Not a decimal number: ${JSON.stringify(text3)}`);
    }
    const [, sign, whole = "", fraction = "", exponentText] = match;
    const digits = `${whole}${fraction}`;
    if (digits.length === 0) {
      throw new Error(`Not a decimal number: ${JSON.stringify(text3)}`);
    }
    let units = BigInt(digits);
    let scale = fraction.length - (exponentText === void 0 ? 0 : Number(exponentText));
    if (scale < 0) {
      units *= powerOfTen(-scale);
      scale = 0;
    }
    return new _Decimal(sign === "-" ? -units : units, scale);
  }
  static zero() {
    return new _Decimal(0n, 0);
  }
  add(other) {
    const scale = Math.max(this.scale, other.scale);
    return new _Decimal(this.alignedTo(scale) + other.alignedTo(scale), scale);
  }
  multiplyByInteger(factor) {
    return new _Decimal(this.units * BigInt(factor), this.scale);
  }
  divideByPowerOfTen(exponent) {
    return new _Decimal(this.units, this.scale + exponent);
  }
  /** Divide by a positive integer and round half to even at `scale` fraction digits. */
  divideByInteger(divisor, scale) {
    if (!Number.isInteger(divisor) || divisor <= 0) {
      throw new Error(`Cannot divide a decimal by ${divisor}.`);
    }
    const negative = this.units < 0n;
    const magnitude = negative ? -this.units : this.units;
    const numerator = scale >= this.scale ? magnitude * powerOfTen(scale - this.scale) : magnitude;
    const denominator = BigInt(divisor) * (scale >= this.scale ? 1n : powerOfTen(this.scale - scale));
    let quotient = numerator / denominator;
    const doubledRemainder = numerator % denominator * 2n;
    if (doubledRemainder > denominator || doubledRemainder === denominator && quotient % 2n === 1n) {
      quotient += 1n;
    }
    return new _Decimal(negative ? -quotient : quotient, scale);
  }
  /** Round half to even at `scale` fraction digits, like Python `quantize`. */
  quantize(scale) {
    if (scale >= this.scale) {
      return new _Decimal(this.alignedTo(scale), scale);
    }
    const divisor = powerOfTen(this.scale - scale);
    const negative = this.units < 0n;
    const magnitude = negative ? -this.units : this.units;
    let quotient = magnitude / divisor;
    const remainder = magnitude % divisor;
    const doubled = remainder * 2n;
    if (doubled > divisor || doubled === divisor && quotient % 2n === 1n) {
      quotient += 1n;
    }
    return new _Decimal(negative ? -quotient : quotient, scale);
  }
  compare(other) {
    const scale = Math.max(this.scale, other.scale);
    const left = this.alignedTo(scale);
    const right = other.alignedTo(scale);
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  }
  equals(other) {
    return this.compare(other) === 0;
  }
  isPositive() {
    return this.units > 0n;
  }
  toString() {
    const negative = this.units < 0n;
    const digits = (negative ? -this.units : this.units).toString().padStart(this.scale + 1, "0");
    const whole = digits.slice(0, digits.length - this.scale);
    const fraction = digits.slice(digits.length - this.scale);
    const body = this.scale === 0 ? whole : `${whole}.${fraction}`;
    return negative ? `-${body}` : body;
  }
  alignedTo(scale) {
    return this.units * powerOfTen(scale - this.scale);
  }
};

// conversation/src/budget/computer-runtime.ts
var COMPUTER_TASK_USD_PER_HOUR = Decimal.parse("0.009875");
var MOST_A_HOSTED_COMPUTER_COSTS_IN_ONE_DAY_USD = COMPUTER_TASK_USD_PER_HOUR.multiplyByInteger(24);

// conversation/src/budget/models.ts
var BILLED_VIA_VENDOR = "vendor";
var CE_STATUS_OK = "ok";
function organizationRunsInItsOwnAwsAccount(organization) {
  return organization.awsCrossAccountRole !== null && organization.awsCrossAccountRole !== "";
}

// conversation/src/domain/organization-spend.ts
var SPEND_CEILING_EXCEEDED_REASON = "monthly AWS spend ceiling exceeded";
var SPEND_CEILING_METER_UNAVAILABLE_REASON = "monthly AWS spend cannot be read right now";
async function monthToDateCombinedSpendUsd(rollups, organization, environment, asOf) {
  const unreadDaysAreBounded = !organizationRunsInItsOwnAwsAccount(organization);
  let monthToDateUsd = Decimal.zero();
  let mostUnreadDaysCouldCostUsd = Decimal.zero();
  let meterUnknown = false;
  let current = firstDayOfMonth(asOf);
  while (current <= asOf) {
    const row = await rollups.getBudgetRollupRow(organization.tenantId, environment, current);
    if (row !== null) {
      if (row.ceStatus === CE_STATUS_OK && row.combinedReportUsd !== null) {
        monthToDateUsd = monthToDateUsd.add(row.combinedReportUsd);
      } else if (unreadDaysAreBounded) {
        mostUnreadDaysCouldCostUsd = mostUnreadDaysCouldCostUsd.add(row.vendorCostUsd).add(MOST_A_HOSTED_COMPUTER_COSTS_IN_ONE_DAY_USD);
      } else {
        meterUnknown = true;
      }
    }
    current = addDays(current, 1);
  }
  return { monthToDateUsd, mostUnreadDaysCouldCostUsd, meterUnknown };
}
async function organizationComputerWorkPaused(organization, rollups, environment, asOf) {
  const ceiling = organization.monthlyAwsSpendCeilingUsd;
  if (ceiling === null) {
    return { paused: false, reason: null };
  }
  const meter = await monthToDateCombinedSpendUsd(rollups, organization, environment, asOf);
  if (meter.meterUnknown) {
    return { paused: true, reason: SPEND_CEILING_METER_UNAVAILABLE_REASON };
  }
  if (meter.monthToDateUsd.compare(ceiling) >= 0) {
    return { paused: true, reason: SPEND_CEILING_EXCEEDED_REASON };
  }
  if (meter.monthToDateUsd.add(meter.mostUnreadDaysCouldCostUsd).compare(ceiling) >= 0) {
    return { paused: true, reason: SPEND_CEILING_METER_UNAVAILABLE_REASON };
  }
  return { paused: false, reason: null };
}
async function organizationComputerWorkPausedFor(organization, deps, asOf = utcDayOf(deps.clock.now())) {
  return organizationComputerWorkPaused(organization, deps.rollups, deps.environment, asOf);
}
async function computerWorkPauseReason(tenantId, deps) {
  const organization = await deps.store.getOrganization(tenantId);
  if (organization === null) {
    return null;
  }
  if (organization.monthlyAwsSpendCeilingUsd === null) {
    return null;
  }
  const pause = await organizationComputerWorkPausedFor(organization, deps);
  if (!pause.paused) {
    return null;
  }
  return pause.reason ?? SPEND_CEILING_EXCEEDED_REASON;
}

// conversation/src/domain/computers.ts
async function ensureComputer(tenantId, deps, computerId = null) {
  const existing = await deps.store.getComputer(tenantId);
  if (existing !== null) {
    return existing;
  }
  return deps.store.createComputerIfAbsent(newComputerRecord(tenantId, computerId ?? deps.ids.next()));
}
function newComputerRecord(tenantId, computerId) {
  return {
    computerId,
    tenantId,
    policy: "prefer_local",
    stopped: false,
    modelReady: true,
    workspaceReady: false,
    browserReady: false,
    hostStartGeneration: 0,
    hostStartDispatchedGeneration: 0,
    snapshotGeneration: 0,
    diskDirty: false,
    hydrateRequired: false
  };
}
function liveOwnerOf(computer, worker, now, timeoutSeconds) {
  return computer.ownerId !== void 0 && computer.ownerGeneration === computer.hostStartGeneration && worker !== null && worker.workerId === computer.ownerId && worker.computerId === computer.computerId && now.getTime() - worker.lastHeartbeatAt.getTime() <= timeoutSeconds * 1e3;
}
async function liveOwnerOfOrganization(tenantId, deps) {
  const computer = await deps.store.getComputer(tenantId);
  if (computer === null || computer.ownerId === void 0) return null;
  const worker = await deps.store.getWorker(tenantId, computer.ownerId);
  return liveOwnerOf(computer, worker, deps.clock.now(), deps.heartbeatTimeoutSeconds) ? { computer, ownerId: computer.ownerId } : null;
}
var BROWSER_UNAVAILABLE_TEXT = "The browser capability is not available on this computer.";

// conversation/src/domain/bots.ts
var BotNotFoundError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "BotNotFoundError";
  }
};
function pythonRepr(value) {
  if (value.includes("'") && !value.includes('"')) {
    return `"${value}"`;
  }
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
async function botById(tenantId, botId, deps) {
  const bot = await deps.store.getBot(tenantId, botId);
  if (bot === null || bot.tenantId !== tenantId) {
    throw new BotNotFoundError(botId);
  }
  return bot;
}

// conversation/src/domain/turns.ts
var ATTEMPT_LEASE_SECONDS = 60;
var TURN_DEADLINE_SECONDS = 120;
var TURN_EVENT_TTL_SECONDS = 24 * 60 * 60;
var addSeconds = (moment, seconds) => new Date(moment.getTime() + seconds * 1e3);
async function getTurn(deps, tenantId, turnId) {
  const turn = await deps.store.getTurn(tenantId, turnId);
  if (turn === null) {
    throw new TurnNotFoundError(`Turn ${pythonRepr(turnId)} does not exist.`);
  }
  return turn;
}
async function claimTurn(deps, tenantId, turnId, attemptId, claimedBy = null) {
  await getTurn(deps, tenantId, turnId);
  const now = deps.clock.now();
  const leaseExpiresAt = addSeconds(now, ATTEMPT_LEASE_SECONDS);
  const deadlineAt = addSeconds(now, TURN_DEADLINE_SECONDS);
  const turn = await deps.store.claimTurn({ tenantId, turnId, attemptId, claimedBy, now, leaseExpiresAt, deadlineAt });
  if (turn === null || turn.attemptId === null) {
    return null;
  }
  return { turn, attemptId: turn.attemptId, attempt: turn.attempt, leaseExpiresAt, deadlineAt };
}
async function renewTurn(deps, tenantId, turnId, attemptId) {
  const now = deps.clock.now();
  const leaseExpiresAt = addSeconds(now, ATTEMPT_LEASE_SECONDS);
  const deadlineAt = addSeconds(now, TURN_DEADLINE_SECONDS);
  const turn = await deps.store.renewTurn({ tenantId, turnId, attemptId, leaseExpiresAt, deadlineAt });
  if (turn === null || turn.attemptId === null) {
    return null;
  }
  return { turn, attemptId: turn.attemptId, attempt: turn.attempt, leaseExpiresAt, deadlineAt };
}
async function recordStorageFence(deps, tenantId, turnId, attemptId, storageFence) {
  await deps.store.recordStorageFence(tenantId, turnId, attemptId, storageFence);
}
async function appendTurnEvent(deps, tenantId, turnId, attemptId, draft) {
  return deps.store.appendEvent({
    tenantId,
    turnId,
    attemptId,
    draft,
    eventId: deps.ids.next(),
    expiresAt: addSeconds(deps.clock.now(), TURN_EVENT_TTL_SECONDS)
  });
}
async function beginClosing(deps, tenantId, turnId, attemptId) {
  await deps.store.beginClosing(tenantId, turnId, attemptId);
}
async function reconcileTurn(deps, tenantId, turnId, attemptId, reason) {
  return deps.store.reconcileTurn({
    tenantId,
    turnId,
    attemptId,
    reason,
    eventId: deps.ids.next(),
    expiresAt: addSeconds(deps.clock.now(), TURN_EVENT_TTL_SECONDS)
  });
}
async function releaseForWaiting(deps, tenantId, turnId, attemptId, gate, pendingComputerTool) {
  return deps.store.parkTurn({
    tenantId,
    turnId,
    attemptId,
    gate,
    pendingComputerTool,
    now: deps.clock.now(),
    eventId: deps.ids.next(),
    expiresAt: addSeconds(deps.clock.now(), TURN_EVENT_TTL_SECONDS)
  });
}
async function clearWaiting(deps, tenantId, turnId) {
  return deps.store.resumeTurn(tenantId, turnId);
}
async function relinquishTurn(deps, tenantId, turnId, attemptId) {
  return deps.store.relinquishTurn({
    tenantId,
    turnId,
    attemptId,
    eventId: deps.ids.next(),
    expiresAt: addSeconds(deps.clock.now(), TURN_EVENT_TTL_SECONDS)
  });
}
async function failTurn(deps, tenantId, turnId, attemptId, reason) {
  return deps.store.failTurn({
    tenantId,
    turnId,
    attemptId,
    reason,
    eventId: deps.ids.next(),
    expiresAt: addSeconds(deps.clock.now(), TURN_EVENT_TTL_SECONDS)
  });
}
async function completeTurn(deps, tenantId, turnId, attemptId, messageSeq, body) {
  const current = await getTurn(deps, tenantId, turnId);
  if (current.status === "completed") {
    if (current.attemptId !== attemptId) {
      throw new StaleAttemptError(
        `Turn ${pythonRepr(turnId)} rejected attempt ${pythonRepr(attemptId)} (current ${pythonRepr(current.attemptId ?? "")}).`
      );
    }
    const events = await deps.store.listEvents(tenantId, turnId, 0);
    const completion = events.findLast((event) => event.kind === "turn.completed");
    if (completion === void 0) {
      throw new TurnTerminalError(`Turn ${pythonRepr(turnId)} is completed but has no completion event.`);
    }
    return completion;
  }
  return deps.store.completeTurn({
    tenantId,
    turnId,
    attemptId,
    messageSeq,
    body,
    eventId: deps.ids.next(),
    expiresAt: addSeconds(deps.clock.now(), TURN_EVENT_TTL_SECONDS)
  });
}

// conversation/src/pi/channel-log.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createSession,
  defineDoc,
  ROOT_CONVERSATION_ID,
  UserEntry
} from "@earendil-works/pi-durable";
var ChannelLogDoc = defineDoc({
  kind: "chatticus.channel-log",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ lines: [] })
});
var draftLine = (draft, entryId) => ({
  seq: draft.seq,
  messageId: draft.messageId,
  authorKind: draft.authorKind,
  authorId: draft.authorId,
  addressedToBotId: draft.addressedToBotId,
  createdAt: draft.createdAt,
  entryId
});
async function appendLine(session, line, context = BACKGROUND_CONTEXT) {
  return session.commit(async (tx) => {
    const log = await tx.doc(ChannelLogDoc, ROOT_CONVERSATION_ID);
    if (log.lines.some((existing) => existing.messageId === line.messageId)) return false;
    log.lines.push(line);
    return true;
  }, context);
}
var attributedWriteEntryDraft = (draft) => ({
  kind: UserEntry.kind,
  model: [
    {
      role: "user",
      content: [{ type: "text", text: `${draft.authorId}: ${draft.body}` }],
      timestamp: Date.parse(draft.createdAt)
    }
  ],
  data: {
    messageId: draft.messageId,
    authorKind: draft.authorKind,
    authorId: draft.authorId,
    body: draft.body
  }
});
async function writeAttributedMessage(session, draft, context = BACKGROUND_CONTEXT) {
  return session.commit(async (tx) => {
    const log = await tx.doc(ChannelLogDoc, ROOT_CONVERSATION_ID);
    const existing = log.lines.find((line) => line.messageId === draft.messageId);
    if (existing) return existing.entryId;
    const entry = await tx.appendEntry(ROOT_CONVERSATION_ID, attributedWriteEntryDraft(draft));
    log.lines.push(draftLine(draft, entry.id));
    return entry.id;
  }, context);
}
async function recordInputLine(session, draft, requestId, context = BACKGROUND_CONTEXT) {
  return session.commit(async (tx) => {
    const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId);
    if (submission?.entry === void 0) return "pending";
    const log = await tx.doc(ChannelLogDoc, ROOT_CONVERSATION_ID);
    if (log.lines.some((existing) => existing.messageId === draft.messageId)) return "present";
    log.lines.push(draftLine({ ...draft, body: "" }, submission.entry));
    return "added";
  }, context);
}
async function readEntryBody(storage, entryId, context = BACKGROUND_CONTEXT) {
  const found = await storage.entry(entryId, context);
  if (found === void 0) return void 0;
  const data = found.entry.data;
  if (typeof data === "object" && data !== null && !Array.isArray(data) && typeof data.body === "string") return data.body;
  const message = found.entry.model?.[0];
  if (message === void 0) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.type === "text" ? part.text : "").join("");
}

// conversation/src/storage/storage-support.ts
import { createHash } from "node:crypto";
var TRANSACTION_ITEM_LIMIT = 100;
var TRANSACTION_ATTEMPTS = 4;
var RETRYABLE_ERRORS = /* @__PURE__ */ new Set([
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "InternalServerError",
  "ServiceUnavailable",
  "TransactionInProgressException",
  "TimeoutError",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE"
]);
var TRANSIENT_CANCELLATIONS = /* @__PURE__ */ new Set(["TransactionConflict", "ThrottlingError", "ProvisionedThroughputExceeded"]);
var backoff = (attempt) => new Promise((resolve) => setTimeout(resolve, Math.min(1e3, 25 * 2 ** attempt) * (0.5 + Math.random())));
var OwnershipLost = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "OwnershipLost";
  }
};
var CommitOutcomeUnknown = class extends OwnershipLost {
  constructor(message, options) {
    super(message, options);
    this.name = "CommitOutcomeUnknown";
  }
};
var storageIdFor = (tenantId, botId, channelId) => `${tenantId}#${botId}#${channelId}`;
var commitKey = (storageId, seq, fence) => `conversations/${encodeURIComponent(storageId)}/commits/${String(seq).padStart(12, "0")}-${String(fence).padStart(8, "0")}.json`;
var parseCommitKey = (key) => {
  const match = /\/commits\/(\d{12})-(\d{8})\.json$/.exec(key);
  return match === null ? void 0 : { seq: Number(match[1]), fence: Number(match[2]) };
};
var snapshotPrefix = (storageId) => `conversations/${encodeURIComponent(storageId)}/snapshots/`;
var snapshotKey = (storageId, seq, fence) => `${snapshotPrefix(storageId)}${String(seq).padStart(12, "0")}-${String(fence).padStart(8, "0")}.json`;
var pad = (value) => String(value).padStart(16, "0");
var digest = (value) => createHash("sha256").update(value).digest("base64url");
var parse = (text3) => JSON.parse(text3);
var encode = (value) => JSON.stringify(value);
var scopeKey = (scope) => {
  switch (scope.kind) {
    case "session":
      return encode(["session"]);
    case "conversation":
      return encode(["conversation", scope.conversationId]);
    case "task":
      return encode(["task", scope.taskId]);
  }
};
var addressKey = (address) => encode([address.kind, scopeKey(address.scope), address.key === void 0 ? ["singleton"] : ["family", address.key]]);
var recordAddressKey = (record) => addressKey({ kind: record.kind, scope: record.scope, key: record.key });
var isAliveAt = (record, at) => {
  if (at === "current") return record.retiredAt === void 0;
  return record.createdAt <= at && (record.retiredAt === void 0 || at < record.retiredAt);
};
var isCurrentOnly = (record) => record.scope.kind !== "conversation" || record.history === "latest";
var cursorAfter = (cursor) => {
  const after = cursor?.after;
  if (after === void 0) return void 0;
  if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new TypeError("Invalid storage cursor");
  return after;
};
var page = (values, limit) => {
  const items = values.slice(0, limit);
  if (values.length <= limit) return { items };
  return { items, next: { after: items.at(-1).id } };
};
var text = (item, name) => item[name]?.S;
var number = (item, name) => item[name]?.N === void 0 ? void 0 : Number(item[name].N);

// conversation/src/pi/errors.ts
var MAXIMUM_CAUSE_DEPTH = 8;
function findStorageFailure(error) {
  let current = error;
  for (let depth = 0; depth < MAXIMUM_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current instanceof OwnershipLost) return current;
    current = current.cause;
  }
  return null;
}

// conversation/src/pi/extension.ts
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
function chatticusExtensions(options) {
  const noteTool = defineTool({
    name: "note_to_channel",
    description: "Record a short note for the channel and return an acknowledgement.",
    parameters: Type.Object({ note: Type.String() }),
    replay: "safe",
    execute: async (args) => {
      options.onChannelNote?.(args.note);
      return { content: [{ type: "text", text: `noted: ${args.note}` }] };
    }
  });
  return [
    defineExtension({
      name: "chatticus",
      sections: [section("chatticus-system", options.systemPrompt, { tag: false })],
      tools: [noteTool]
    })
  ];
}

// host-protocol/src/schemas.ts
import { z } from "zod";
var BROWSE_ACTION_KIND = "browse";
var REQUEST_COMPUTER_CAPABILITY_ACTION_KIND = "request_computer_capability";
var BROWSER_ACTION_KINDS = /* @__PURE__ */ new Set([BROWSE_ACTION_KIND, REQUEST_COMPUTER_CAPABILITY_ACTION_KIND]);
var hostCapabilitySchema = z.enum(["model", "workspace", "browser"]);
var regateKindSchema = z.enum(["browse", "read", "write", "edit", "terminal"]);
var hostOptionalCapabilitySchema = z.literal("browser");
var computerStateRequestSchema = z.object({
  stopped: z.boolean().optional(),
  start_generation: z.number().int().positive().optional(),
  disk_matches_published: z.boolean().optional(),
  capability_ready: hostCapabilitySchema.optional(),
  capability_unavailable: hostOptionalCapabilitySchema.optional()
}).strict().refine((body) => body.start_generation === void 0 || body.stopped === true, {
  message: "start_generation is only valid with stopped true"
}).refine((body) => body.disk_matches_published === void 0 || body.stopped === true, {
  message: "disk_matches_published is only valid with stopped true"
}).refine((body) => body.stopped !== void 0 || body.capability_ready !== void 0 || body.capability_unavailable !== void 0, {
  message: "stopped, capability_ready or capability_unavailable is required"
});
var snapshotHydratedRequestSchema = z.object({ worker_id: z.string().min(1) }).strict();
var snapshotPublishedRequestSchema = z.object({
  worker_id: z.string().min(1),
  checksum: z.string().min(1),
  snapshot_uri: z.string().min(1).optional()
}).strict();
var claimActionRequestSchema = z.object({}).strict();
var renewActionRequestSchema = z.object({}).strict();
var actionResultRequestSchema = z.union([
  z.object({ result: z.string() }).strict(),
  z.object({ error: z.string() }).strict()
]);
var regateActionRequestSchema = z.object({
  kind: regateKindSchema,
  target: z.string().min(1)
}).strict();
var heartbeatRequestSchema = z.object({}).strict();
var actionEnvelopeSchema = z.looseObject({
  tool: z.string(),
  idempotent: z.boolean(),
  path: z.string().optional(),
  cwd: z.string().optional(),
  origin: z.string().optional()
});
var hostActionSchema = z.object({
  action_id: z.string(),
  turn_id: z.string(),
  call_id: z.string(),
  tool_name: z.string(),
  arguments: z.record(z.string(), z.string()),
  gate: z.string(),
  envelope: actionEnvelopeSchema,
  status: z.string(),
  lease_expires_at: z.string().nullable()
});
var claimActionResponseSchema = z.object({ action: hostActionSchema.nullable() });
var renewActionResponseSchema = z.object({ action: hostActionSchema });
var actionResultResponseSchema = z.object({
  status: z.literal("ok"),
  action_id: z.string(),
  turn_id: z.string(),
  turn_resumed: z.boolean()
});
var regateActionResponseSchema = z.object({ status: z.literal("ok") });
var hostComputerSchema = z.object({
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
  intended_host_worker_id: z.string().optional()
});
var hostStatusResponseSchema = z.object({ status: z.string() });

// conversation/src/pi/computer-tools.ts
import { Type as Type2 } from "@earendil-works/pi-ai";
import { defineExtension as defineExtension2, defineTool as defineTool2 } from "@earendil-works/pi-durable";
var stringArguments = (value) => {
  const result = {};
  if (typeof value === "object" && value !== null) {
    for (const [name, entry] of Object.entries(value)) result[name] = typeof entry === "string" ? entry : JSON.stringify(entry);
  }
  return result;
};
var computerWorkPausedText = (reason) => `Computer work is paused: ${reason}.`;
var READ_WORKSPACE_PARAMETERS = Type2.Object({ path: Type2.String({ description: "Absolute path of the file under /workspace." }) });
var WRITE_WORKSPACE_PARAMETERS = Type2.Object({
  path: Type2.String({ description: "Absolute path of the file under /workspace." }),
  content: Type2.String({ description: "The full text to write." })
});
var EDIT_WORKSPACE_PARAMETERS = Type2.Object({
  path: Type2.String({ description: "Absolute path of the existing file under /workspace." }),
  old_text: Type2.String({ description: "The exact text to replace. It must occur once in the file." }),
  new_text: Type2.String({ description: "The text to put in its place." })
});
var RUN_TERMINAL_PARAMETERS = Type2.Object({
  command: Type2.String({ description: "The shell command to run." }),
  cwd: Type2.Optional(Type2.String({ description: "Working directory; defaults to /workspace." }))
});
var BROWSE_PARAMETERS = Type2.Object({ url: Type2.String({ description: "The page to open." }) });
var REQUEST_COMPUTER_CAPABILITY_PARAMETERS = Type2.Object({
  capability: Type2.String({ description: "What the computer should be able to do, such as a browser session." }),
  url: Type2.Optional(Type2.String({ description: "The page the capability is needed for, when there is one." }))
});
var SEND_PARAMETERS = Type2.Object({
  recipient: Type2.String({ description: "Who receives the message." }),
  body: Type2.Optional(Type2.String({ description: "The message text." }))
});
var PURCHASE_PARAMETERS = Type2.Object({
  item: Type2.String({ description: "What to buy." }),
  origin: Type2.Optional(Type2.String({ description: "The store the item is bought from." }))
});
function computerToolsExtension(handoff) {
  const computerTool = (name, description, parameters) => defineTool2({
    name,
    description,
    parameters,
    replay: "safe",
    executionMode: "sequential",
    execute: async (args, api, toolContext) => {
      const call = { toolName: name, arguments: stringArguments(args), callId: api.callId };
      const action = await handoff.lookup(call);
      if (action?.status === "done") {
        const text3 = action.result ?? "";
        if (action.resultIsError) throw new Error(text3);
        return { content: [{ type: "text", text: text3 }] };
      }
      if (action === null) {
        const unavailableText = await handoff.unavailable(call);
        if (unavailableText !== null) return { content: [{ type: "text", text: unavailableText }] };
        const reason = await handoff.refusal(call);
        if (reason !== null) return { content: [{ type: "text", text: computerWorkPausedText(reason) }] };
      }
      return handoff.park(call, toolContext.abortSignal);
    }
  });
  const sendTool = defineTool2({
    name: "send",
    description: "Send a message to a person outside the channel. A human approves the exact message first.",
    parameters: SEND_PARAMETERS,
    replay: "unsafe",
    execute: async () => {
      throw new Error("send runs only after a human approved its exact arguments.");
    }
  });
  const purchaseTool = defineTool2({
    name: "purchase",
    description: "Buy an item for the organization. A human approves the exact purchase first.",
    parameters: PURCHASE_PARAMETERS,
    replay: "unsafe",
    execute: async () => {
      throw new Error("purchase runs only after a human approved its exact arguments.");
    }
  });
  return defineExtension2({
    name: "computer",
    tools: [
      computerTool("read_workspace", "Read a file in /workspace, the persistent workspace of the organization.", READ_WORKSPACE_PARAMETERS),
      computerTool(
        "write_workspace",
        "Write a new file in /workspace. This replaces the whole file. To change part of an existing file, use edit_workspace.",
        WRITE_WORKSPACE_PARAMETERS
      ),
      computerTool(
        "edit_workspace",
        "Change an existing file in /workspace. It replaces one exact piece of text. It fails if the text is not found or occurs more than once. It never creates a file.",
        EDIT_WORKSPACE_PARAMETERS
      ),
      computerTool(
        "run_terminal",
        "Run a shell command on the organization's computer. The default directory is /workspace. Git, gcc, g++ and make are installed.",
        RUN_TERMINAL_PARAMETERS
      ),
      computerTool(BROWSE_ACTION_KIND, "Open a web page in an isolated browser.", BROWSE_PARAMETERS),
      computerTool(
        REQUEST_COMPUTER_CAPABILITY_ACTION_KIND,
        "Ask for a capability of the organization's computer, such as a browser session.",
        REQUEST_COMPUTER_CAPABILITY_PARAMETERS
      ),
      sendTool,
      purchaseTool
    ]
  });
}

// conversation/src/pi/gate.ts
import { defineExtension as defineExtension5, hook, ToolTask } from "@earendil-works/pi-durable";

// conversation/src/pi/bot-board-tool.ts
import { Type as Type3 } from "@earendil-works/pi-ai";
import { defineExtension as defineExtension3, defineTool as defineTool3 } from "@earendil-works/pi-durable";
var BOARD_TOOL_NAME = "board";
var BOARD_TOOL_ACTIONS = [
  "create",
  "get",
  "list",
  "update",
  "comment",
  "complete",
  "close",
  "reopen",
  "set_parent",
  "add_dependency",
  "remove_dependency"
];
function cardOf(entry) {
  return { ...entry.issue, revision: entry.revision };
}
function summaryOf(entry) {
  const { id, title, type, status, priority, parent, labels, updated_at } = entry.issue;
  return { id, title, type, status, priority, parent: parent ?? null, labels: labels ?? [], updated_at, revision: entry.revision };
}
function describeFailure(failure) {
  switch (failure.kind) {
    case "forbidden":
      return { outcome: "denied", message: failure.message };
    case "not_found":
      return { outcome: "not_found", message: "The card was not found on your board." };
    case "conflict":
      return { outcome: "conflict", message: `Someone else changed the card first, so your change was not applied. ${failure.message}` };
    case "operation_conflict":
      return { outcome: "operation_conflict", message: "An earlier attempt with this operation_key may already have been applied, and this call differs from it (for example it names another revision), so nothing more was applied. Read the card again before deciding; to repeat the earlier change exactly pass its revision_used, otherwise use a new operation_key." };
    case "invalid":
      return { outcome: "validation_failed", message: failure.message };
    case "refused":
      return { outcome: "refused", message: failure.message };
    case "archived":
      return { outcome: "archived", message: "This board is archived and cannot be changed." };
    case "unavailable":
      return { outcome: "not_saved", message: failure.message };
    case "service_unreachable_route":
      return { outcome: "service_unreachable", message: failure.message };
  }
}
function failureOutcome(failure, operationKey, revisionUsed) {
  const { outcome, message } = describeFailure(failure);
  const body = { outcome, saved: false, message };
  if (failure.code !== void 0) body.code = failure.code;
  if (failure.currentCard !== void 0) {
    body.current_revision = failure.currentCard.revision;
    body.current_card = cardOf(failure.currentCard);
  }
  if (failure.kind === "unavailable" || failure.message.includes("saved but")) {
    body.operation_key = operationKey;
    if (revisionUsed !== void 0) body.revision_used = revisionUsed;
  }
  return { text: JSON.stringify(body), isError: true };
}
function writeOutcome(result, operationKey, revisionUsed) {
  if (!result.ok) return failureOutcome(result.failure, operationKey, revisionUsed);
  const message = result.listingMayBeBehind ? "The change is saved: the board store confirmed the record. The listing of the board may be behind and may not show it yet; reading the card by its id returns it." : "The change is saved: the board store confirmed the record.";
  return {
    text: JSON.stringify({ outcome: "saved", saved: true, message, listing_may_be_behind: result.listingMayBeBehind, card: cardOf(result.value) }),
    isError: false
  };
}
function refusalOutcome(message) {
  return { text: JSON.stringify({ outcome: "refused", saved: false, message }), isError: true };
}
var REQUIRES_CARD = /* @__PURE__ */ new Set([
  "get",
  "update",
  "comment",
  "complete",
  "close",
  "reopen",
  "set_parent",
  "add_dependency",
  "remove_dependency"
]);
async function runBoardToolCall(scope, service, args, callId, rememberRevision = async (revision) => revision) {
  const address = { organizationId: scope.organizationId, botId: scope.botId };
  const actor = { kind: "bot", botId: scope.botId };
  const operationKey = args.operation_key ?? `${scope.turnId}/${callId}`;
  const cardId = args.card_id;
  if (REQUIRES_CARD.has(args.action) && (cardId === void 0 || cardId.trim() === "")) {
    return refusalOutcome(`card_id is required for ${args.action}.`);
  }
  if (args.action === "list") {
    const result = await service.listCards(address, actor, {
      ...args.status === void 0 ? {} : { status: args.status },
      ...args.limit === void 0 ? {} : { limit: args.limit }
    });
    if (!result.ok) return failureOutcome(result.failure, operationKey);
    return {
      text: JSON.stringify({ outcome: "ok", cards: result.value.cards.map(summaryOf), next_cursor: result.value.nextCursor }),
      isError: false
    };
  }
  if (args.action === "get") {
    const result = await service.getCard(address, actor, cardId);
    if (!result.ok) return failureOutcome(result.failure, operationKey);
    return { text: JSON.stringify({ outcome: "ok", card: cardOf(result.value) }), isError: false };
  }
  const needsRead = args.action !== "create" && args.revision === void 0;
  let revision = args.revision;
  if (needsRead) {
    const read = await service.getCard(address, actor, cardId);
    if (!read.ok) return failureOutcome(read.failure, operationKey);
    revision = await rememberRevision(read.value.revision);
  }
  const context = revision === void 0 ? { operationKey } : { operationKey, revision };
  switch (args.action) {
    case "create":
      return writeOutcome(
        await service.createCard(
          address,
          actor,
          {
            title: args.title ?? "",
            ...args.type === void 0 ? {} : { type: args.type },
            ...args.description === void 0 ? {} : { description: args.description },
            ...args.priority === void 0 ? {} : { priority: args.priority },
            ...args.labels === void 0 ? {} : { labels: args.labels },
            ...args.parent_id === void 0 ? {} : { parent: args.parent_id }
          },
          context
        ),
        operationKey
      );
    case "update":
      return writeOutcome(
        await service.updateCard(
          address,
          actor,
          cardId,
          {
            ...args.title === void 0 ? {} : { title: args.title },
            ...args.description === void 0 ? {} : { description: args.description },
            ...args.priority === void 0 ? {} : { priority: args.priority },
            ...args.labels === void 0 ? {} : { labels: args.labels },
            ...args.status === void 0 ? {} : { status: args.status }
          },
          context
        ),
        operationKey,
        revision
      );
    case "comment":
      return writeOutcome(await service.commentOnCard(address, actor, cardId, args.text ?? "", context), operationKey, revision);
    case "complete":
      return writeOutcome(await service.completeCard(address, actor, cardId, args.evidence ?? "", context), operationKey, revision);
    case "close":
      return writeOutcome(await service.closeCard(address, actor, cardId, args.reason ?? "", context), operationKey, revision);
    case "reopen":
      return writeOutcome(await service.reopenCard(address, actor, cardId, context), operationKey, revision);
    case "set_parent":
      return writeOutcome(await service.setParent(address, actor, cardId, args.parent_id ?? null, context), operationKey, revision);
    case "add_dependency":
      if (args.depends_on_id === void 0) return refusalOutcome("depends_on_id is required for add_dependency.");
      return writeOutcome(
        await service.addDependency(address, actor, cardId, args.depends_on_id, args.dependency_type ?? "blocked-by", context),
        operationKey,
        revision
      );
    case "remove_dependency":
      if (args.depends_on_id === void 0) return refusalOutcome("depends_on_id is required for remove_dependency.");
      return writeOutcome(await service.removeDependency(address, actor, cardId, args.depends_on_id, context), operationKey, revision);
    default:
      return refusalOutcome(`The action ${String(args.action)} is not a board action.`);
  }
}
function botBoardToolExtensions(scope, service) {
  const boardTool = defineTool3({
    name: BOARD_TOOL_NAME,
    description: "Keep your own work board: create, read, list, update, comment on, complete, close and reopen cards, set a card's parent and record dependencies. A card completes only with evidence from the system you acted on and closes only with a reason. You never delete cards. The result says saved only after the board store confirmed the change; anything else was not saved. A change that was not confirmed may still have been applied: its result gives operation_key and revision_used, and the only safe retry is the same call with that operation_key and revision. Works without summoning the computer.",
    parameters: Type3.Object({
      action: Type3.Union(BOARD_TOOL_ACTIONS.map((action) => Type3.Literal(action))),
      card_id: Type3.Optional(Type3.String({ description: "The card's id. Required for every action except create and list." })),
      title: Type3.Optional(Type3.String({ description: "Required for create. Optional for update." })),
      description: Type3.Optional(Type3.String()),
      type: Type3.Optional(Type3.String({ description: "Card type for create. Defaults to task." })),
      priority: Type3.Optional(Type3.Integer()),
      labels: Type3.Optional(Type3.Array(Type3.String(), { description: "On update, replaces the card's labels." })),
      status: Type3.Optional(Type3.String({ description: "On update, move the card to this status. Use complete or close to close a card. On list, show only cards in this status." })),
      revision: Type3.Optional(Type3.String({ description: "The revision you last saw. When omitted, the card is read first and the change applies to the revision read." })),
      text: Type3.Optional(Type3.String({ description: "Required for comment." })),
      evidence: Type3.Optional(Type3.String({ description: "Required for complete: evidence from the system you acted on." })),
      reason: Type3.Optional(Type3.String({ description: "Required for close." })),
      parent_id: Type3.Optional(Type3.String({ description: "For set_parent: the parent card. Omit to clear the parent. For create: the parent card." })),
      depends_on_id: Type3.Optional(Type3.String({ description: "For add_dependency and remove_dependency: the card this one waits on." })),
      dependency_type: Type3.Optional(Type3.Union([Type3.Literal("blocked-by"), Type3.Literal("relates-to")])),
      limit: Type3.Optional(Type3.Integer({ description: "For list: how many cards, 1 to 100." })),
      operation_key: Type3.Optional(Type3.String({ description: "To repeat a change that was not confirmed exactly as before, pass the operation_key the failed result gave." }))
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const outcome = await runBoardToolCall(
        scope,
        service,
        args,
        api.callId,
        (revision) => api.memo("revision", revision, context)
      );
      return { content: [{ type: "text", text: outcome.text }], isError: outcome.isError };
    }
  });
  return [defineExtension3({ name: "chatticus-board", tools: [boardTool] })];
}

// conversation/src/pi/task-tool.ts
import { Type as Type4 } from "@earendil-works/pi-ai";
import { defineExtension as defineExtension4, defineTool as defineTool4 } from "@earendil-works/pi-durable";

// conversation/src/domain/tasks.ts
var TaskStatus = {
  Open: "open",
  Blocked: "blocked",
  Completed: "completed",
  Closed: "closed"
};
var TASK_TOOL_ACTIONS = ["create", "get", "complete", "close"];
var TaskToolRequestError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskToolRequestError";
  }
};
async function createTask(tenantId, userId, title, options, deps) {
  const task = {
    taskId: deps.ids.next(),
    tenantId,
    userId,
    title,
    status: TaskStatus.Open,
    createdByBotId: options.createdByBotId,
    updatedByBotId: options.createdByBotId
  };
  await deps.store.putTask(task);
  return task;
}
async function taskById(tenantId, taskId, deps) {
  const record = await deps.store.getTask(tenantId, taskId);
  if (record === null || record.tenantId !== tenantId) {
    throw new TaskNotFoundError(`Task ${pythonRepr(taskId)} is unknown to tenant ${pythonRepr(tenantId)}.`);
  }
  return record;
}
async function completeTask(tenantId, taskId, options, deps) {
  if (options.evidence.trim() === "") {
    throw new TaskEvidenceRequiredError(`Task ${pythonRepr(taskId)} cannot reach completed without evidence.`);
  }
  const record = await taskById(tenantId, taskId, deps);
  const completed = {
    ...record,
    status: TaskStatus.Completed,
    evidence: options.evidence,
    updatedByBotId: options.updatedByBotId
  };
  await deps.store.putTask(completed);
  return completed;
}
async function closeTask(tenantId, taskId, options, deps) {
  if (options.reason.trim() === "") {
    throw new TaskCloseReasonRequiredError(`Task ${pythonRepr(taskId)} cannot close without a reason.`);
  }
  const record = await taskById(tenantId, taskId, deps);
  const closed = {
    ...record,
    status: TaskStatus.Closed,
    closeReason: options.reason,
    updatedByBotId: options.updatedByBotId
  };
  await deps.store.putTask(closed);
  return closed;
}
async function invokeTaskTool(tenantId, userId, botId, action, arguments_, deps) {
  await botById(tenantId, botId, deps);
  if (action === "create") {
    const title = (arguments_["title"] ?? "").trim();
    if (title === "") {
      throw new TaskToolRequestError("Task create requires a title.");
    }
    return createTask(tenantId, userId, title, { createdByBotId: botId }, deps);
  }
  const taskId = (arguments_["task_id"] ?? "").trim();
  if (taskId === "") {
    throw new TaskToolRequestError(`Task action ${pythonRepr(action)} requires task_id.`);
  }
  if (action === "get") {
    return taskById(tenantId, taskId, deps);
  }
  if (action === "complete") {
    return completeTask(tenantId, taskId, { evidence: arguments_["evidence"] ?? "", updatedByBotId: botId }, deps);
  }
  if (action === "close") {
    return closeTask(tenantId, taskId, { reason: arguments_["reason"] ?? "", updatedByBotId: botId }, deps);
  }
  throw new TaskToolRequestError(`Unsupported task tool action ${pythonRepr(action)}.`);
}

// conversation/src/pi/task-tool.ts
var TASK_TOOL_NAME = "task";
function taskToolExtensions(scope, deps) {
  const taskTool = defineTool4({
    name: TASK_TOOL_NAME,
    description: "Create, read, complete, or close a durable household task. Use for job tracking without summoning the computer.",
    parameters: Type4.Object({
      action: Type4.Union(TASK_TOOL_ACTIONS.map((action) => Type4.Literal(action))),
      title: Type4.Optional(Type4.String({ description: "Required for create." })),
      task_id: Type4.Optional(Type4.String({ description: "Required for get, complete, and close." })),
      evidence: Type4.Optional(Type4.String({ description: "Required for complete." })),
      reason: Type4.Optional(Type4.String({ description: "Required for close." }))
    }),
    replay: "unsafe",
    execute: async (args) => {
      const { action, ...rest } = args;
      const stringArguments2 = {};
      for (const [name, value] of Object.entries(rest)) {
        if (typeof value === "string") stringArguments2[name] = value;
      }
      const task = await invokeTaskTool(scope.tenantId, scope.userId, scope.botId, action, stringArguments2, deps);
      return { content: [{ type: "text", text: JSON.stringify(task) }] };
    }
  });
  return [defineExtension4({ name: "chatticus-task", tools: [taskTool] })];
}

// conversation/src/policy/capability-policy.ts
var EgressClass = {
  None: "none",
  ApprovedOriginFetch: "approved_origin_fetch",
  StructuredSend: "structured_send",
  FileTransfer: "file_transfer"
};
var BindingControl = {
  StructuredConnector: "structured_connector",
  ImmutableApproval: "immutable_approval",
  HumanTakeover: "human_takeover",
  UnboundStop: "unbound_stop"
};
var V1_POLICY_EXCLUSIONS = /* @__PURE__ */ new Set([
  "snapshot_cookie_integrity",
  "bot_to_bot_channel_injection",
  "approval_fatigue",
  "prompt_data_separation_as_boundary",
  "generic_browser_click_binding",
  "local_device_execution_isolation",
  "bot_as_security_boundary"
]);
var CONSEQUENTIAL_BROWSER_ALIASES = {
  send: "send",
  publish: "publish",
  purchase: "purchase",
  delete: "delete",
  "change production": "production_change"
};
function probeGrantForOrigin(origin) {
  return new TaskCapabilityGrant(
    /* @__PURE__ */ new Set(["browse"]),
    /* @__PURE__ */ new Set([origin]),
    /* @__PURE__ */ new Set(),
    /* @__PURE__ */ new Set(),
    /* @__PURE__ */ new Set(),
    /* @__PURE__ */ new Set()
  );
}
function probeDecisionDiffersByAttribution(probe, attributionField, firstAttribution, secondAttribution) {
  probe.setGrant(probeGrantForOrigin("https://probe.example"));
  const decisionFor = (attribution) => probe.evaluate(
    Object.assign(new RequestedCapability("browse", "https://probe.example/page", null, null, null), {
      [attributionField]: attribution
    })
  );
  return decisionFor(firstAttribution) !== decisionFor(secondAttribution);
}
var SECRET_ENTRY_ACTIONS = /* @__PURE__ */ new Set(["password", "passkey", "one_time_code"]);
var TaskCapabilityGrant = class {
  tools;
  origins;
  recipients;
  fileScopes;
  egressClasses;
  ingestClasses;
  constructor(tools, origins, recipients, fileScopes, egressClasses, ingestClasses) {
    this.tools = tools;
    this.origins = origins;
    this.recipients = recipients;
    this.fileScopes = fileScopes;
    this.egressClasses = egressClasses;
    this.ingestClasses = ingestClasses;
  }
};
var RequestedCapability = class {
  tool;
  origin;
  recipient;
  filePath;
  egressClass;
  constructor(tool, origin, recipient, filePath, egressClass) {
    this.tool = tool;
    this.origin = origin;
    this.recipient = recipient;
    this.filePath = filePath;
    this.egressClass = egressClass;
  }
};
var CapabilityDenial = class {
  reason;
  request;
  recordedAt;
  constructor(reason, request, recordedAt) {
    this.reason = reason;
    this.request = request;
    this.recordedAt = recordedAt;
  }
};
var PolicyBrowserContext = class {
  kind;
  pageUrl;
  namedSession;
  storagePartition;
  cookies = /* @__PURE__ */ new Map();
  constructor(kind, pageUrl, namedSession, storagePartition) {
    this.kind = kind;
    this.pageUrl = pageUrl;
    this.namedSession = namedSession;
    this.storagePartition = storagePartition;
  }
};
var BoundConnectorOperation = class {
  actionType;
  destination;
  payload;
  approved;
  constructor(actionType, destination, payload, approved = false) {
    this.actionType = actionType;
    this.destination = destination;
    this.payload = payload;
    this.approved = approved;
  }
};
function parseGrantTable(rows) {
  const split = (fieldName) => {
    const raw = rows[fieldName] ?? "";
    return new Set(
      raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0)
    );
  };
  return new TaskCapabilityGrant(
    split("tools"),
    split("origins"),
    split("recipients"),
    split("file_scopes"),
    split("egress_classes"),
    split("ingest_classes")
  );
}
function originFromUrl(url) {
  const urlWithScheme = url.includes("://") ? url : `https://${url}`;
  const parsed = new URL(urlWithScheme);
  return `${parsed.protocol}//${parsed.hostname}`;
}
function fileInScopes(path, scopes) {
  for (const scope of scopes) {
    if (path === scope || path.startsWith(`${scope.replace(/\/$/, "")}/`)) {
      return true;
    }
  }
  return false;
}
var CapabilityPolicy = class _CapabilityPolicy {
  grant = null;
  credentials = /* @__PURE__ */ new Map();
  denials = [];
  egress_blocked = [];
  unblocked_egress = [];
  contexts = [];
  last_decision = null;
  last_binding = null;
  last_overnight = null;
  bound_operation = null;
  recorded_exclusions = /* @__PURE__ */ new Set();
  injection_followed_by_model = false;
  takeover_waiting = false;
  now;
  constructor(now = null) {
    this.now = now ?? (() => /* @__PURE__ */ new Date());
  }
  /**
   * Replace the active task grant.
   */
  setGrant(grant) {
    this.grant = grant;
  }
  /**
   * Record a household secret. Untrusted browsing cannot use it.
   */
  addCredential(credential) {
    this.credentials.set(credential.name, credential);
  }
  /**
   * Open research browsing without privileged credentials.
   */
  openUntrusted(pageUrl) {
    const context = new PolicyBrowserContext(
      "untrusted",
      pageUrl,
      null,
      "untrusted"
    );
    this.contexts.push(context);
    return context;
  }
  /**
   * Open a named privileged session in its own partition.
   */
  openPrivileged(pageUrl, service) {
    const context = new PolicyBrowserContext(
      "privileged",
      pageUrl,
      service,
      `privileged:${service}`
    );
    this.contexts.push(context);
    return context;
  }
  /**
   * Return whether this context may touch a named credential.
   */
  contextMayUse(context, name) {
    const credential = this.credentials.get(name);
    if (credential === void 0) {
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
  workspaceSecretReadable(context, path) {
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
  modelVisibleSecrets(context) {
    const visible = this.modelVisibleToolResult(context);
    const candidates = [
      ...[...this.credentials.values()].map((credential) => credential.value),
      ...context.cookies.values()
    ];
    return candidates.filter((secret) => secret.length > 0 && visible.includes(secret));
  }
  /**
   * Render what a browser tool result shows the model: context identity and cookie names, never values.
   */
  modelVisibleToolResult(context) {
    return JSON.stringify({
      kind: context.kind,
      pageUrl: context.pageUrl,
      session: context.namedSession,
      cookieNames: [...context.cookies.keys()]
    });
  }
  /**
   * Write a cookie only into this context's partition.
   */
  writeCookie(context, name, value) {
    context.cookies.set(name, value);
  }
  /**
   * Read a cookie from this context's partition only.
   */
  cookieInContext(context, name) {
    return context.cookies.get(name) ?? null;
  }
  /**
   * Deny or require approval using the task grant, never page text.
   */
  evaluate(request) {
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
        request
      );
    }
    if (request.filePath && !fileInScopes(request.filePath, grant.fileScopes)) {
      return this._deny(
        `file ${JSON.stringify(request.filePath)} is outside granted scopes`,
        request
      );
    }
    if (request.egressClass && !grant.egressClasses.has(request.egressClass)) {
      return this._deny(
        `egress class ${JSON.stringify(request.egressClass)} is not granted`,
        request
      );
    }
    if (this._isConsequentialAction(request.tool)) {
      this._auditEgressOutsideGrant(request, grant);
      this.last_decision = "REQUIRE_APPROVAL";
      this.last_binding = "immutable_approval";
      return "REQUIRE_APPROVAL";
    }
    this._auditEgressOutsideGrant(request, grant);
    this.last_decision = "ALLOW";
    return "ALLOW";
  }
  /**
   * Refuse promoting an untrusted context to a privileged session.
   */
  requestPrivilegedSession(context, service) {
    const request = new RequestedCapability(
      "use_session",
      context.pageUrl
    );
    if (context.namedSession !== service) {
      return this._deny(
        "a context is bound to its one named session, and an untrusted context has none",
        request
      );
    }
    this.last_decision = "ALLOW";
    return "ALLOW";
  }
  /**
   * Return the control a consequential browser or connector action needs.
   */
  requiredBindingForBrowserAction(action, { structuredConnector = false, takeoverControl = false, approved = false } = {}) {
    const actionType = CONSEQUENTIAL_BROWSER_ALIASES[action] ?? action;
    if (takeoverControl || SECRET_ENTRY_ACTIONS.has(actionType)) {
      return this.requireTakeover();
    }
    if (!structuredConnector && this._isConsequentialAction(actionType)) {
      this.last_binding = "unbound_stop";
      this.last_overnight = {
        executed: false,
        turn_status: "blocked",
        reason: "user_controlled_completion_required",
        completion_evidence: null
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
        completion_evidence: null
      };
      return this.last_binding;
    }
    this.last_binding = "structured_connector";
    return this.last_binding;
  }
  /**
   * Record a structured connector operation that can bind exact arguments.
   */
  bindConnector(actionType, destination, payload) {
    const operation = new BoundConnectorOperation(
      actionType,
      destination,
      payload
    );
    this.bound_operation = operation;
    return operation;
  }
  /**
   * Bind human approval to the recorded connector operation.
   */
  approveBoundOperation() {
    if (this.bound_operation === null) {
      throw new Error("no bound connector operation");
    }
    this.bound_operation = new BoundConnectorOperation(
      this.bound_operation.actionType,
      this.bound_operation.destination,
      this.bound_operation.payload,
      true
    );
  }
  /**
   * Execute only an approved structured connector operation.
   */
  executeBoundConnector(evidence = "smtp-250") {
    const operation = this.bound_operation;
    if (operation === null || !operation.approved) {
      this.requiredBindingForBrowserAction(
        operation?.actionType ?? "send",
        {
          structuredConnector: true,
          approved: false
        }
      );
      const result2 = this.last_overnight;
      if (result2 === null) {
        throw new Error("last_overnight not set");
      }
      return result2;
    }
    const result = {
      executed: true,
      turn_status: "completed",
      reason: null,
      completion_evidence: evidence
    };
    this.last_overnight = result;
    this.last_binding = BindingControl.StructuredConnector;
    return result;
  }
  /**
   * Hand the computer to the human. Secrets never arrive via the channel.
   */
  requireTakeover() {
    this.last_binding = "human_takeover";
    this.takeover_waiting = true;
    this.last_overnight = {
      executed: false,
      turn_status: "blocked",
      reason: "waiting_for_human_takeover",
      completion_evidence: null
    };
    return this.last_binding;
  }
  /**
   * Name a v1 gap. Workers must not claim the missing control.
   */
  recordExclusion(exclusion) {
    if (!V1_POLICY_EXCLUSIONS.has(exclusion)) {
      throw new Error(`unknown v1 exclusion ${JSON.stringify(exclusion)}`);
    }
    this.recorded_exclusions.add(exclusion);
  }
  /**
   * Answer a reviewer: probe the control and record the exclusion when the kernel does not enforce it.
   */
  reviewExclusion(exclusion) {
    if (!this.workerClaimsEnforced(exclusion)) {
      this.recordExclusion(exclusion);
    }
  }
  /**
   * Return whether the kernel actually enforces the control behind a v1 exclusion, by exercising it.
   */
  workerClaimsEnforced(exclusion) {
    if (!V1_POLICY_EXCLUSIONS.has(exclusion)) {
      throw new Error(`unknown v1 exclusion ${JSON.stringify(exclusion)}`);
    }
    const probe = new _CapabilityPolicy(this.now);
    switch (exclusion) {
      case "snapshot_cookie_integrity": {
        const context = probe.openUntrusted("https://probe.example");
        probe.writeCookie(context, "probe", "genuine");
        context.cookies.set("probe", "tampered");
        return probe.cookieInContext(context, "probe") !== "tampered";
      }
      case "generic_browser_click_binding":
        return probe.requiredBindingForBrowserAction("send") !== BindingControl.UnboundStop;
      case "approval_fatigue": {
        probe.setGrant(
          new TaskCapabilityGrant(
            /* @__PURE__ */ new Set(["send"]),
            /* @__PURE__ */ new Set(),
            /* @__PURE__ */ new Set(["probe@example.com"]),
            /* @__PURE__ */ new Set(),
            /* @__PURE__ */ new Set([EgressClass.StructuredSend]),
            /* @__PURE__ */ new Set()
          )
        );
        for (let attempt = 0; attempt < 25; attempt++) {
          const decision = probe.evaluate(
            new RequestedCapability("send", null, "probe@example.com", null, EgressClass.StructuredSend)
          );
          if (decision !== "REQUIRE_APPROVAL") {
            return true;
          }
        }
        return false;
      }
      case "prompt_data_separation_as_boundary": {
        probe.setGrant(new TaskCapabilityGrant(/* @__PURE__ */ new Set(), /* @__PURE__ */ new Set(), /* @__PURE__ */ new Set(), /* @__PURE__ */ new Set(), /* @__PURE__ */ new Set(), /* @__PURE__ */ new Set()));
        probe.markInjectionFollowedByModel();
        probe.evaluate(new RequestedCapability("send", null, "probe@example.com", null, EgressClass.StructuredSend));
        return probe.prompt_wording_is_boundary;
      }
      case "bot_to_bot_channel_injection":
        return probeDecisionDiffersByAttribution(probe, "instructionSource", "human_message", "other_bot_channel_text");
      case "local_device_execution_isolation": {
        probe.setGrant(probeGrantForOrigin("http://127.0.0.1"));
        return probe.evaluate(new RequestedCapability("browse", "http://127.0.0.1:9222/json", null, null, null)) !== "ALLOW";
      }
      case "bot_as_security_boundary":
        return probeDecisionDiffersByAttribution(probe, "actingBotId", "bot_a", "bot_b");
      default:
        throw new Error(`no enforcement probe for v1 exclusion ${JSON.stringify(exclusion)}`);
    }
  }
  /**
   * Record that prompt/data separation did not stop the model.
   */
  markInjectionFollowedByModel() {
    this.injection_followed_by_model = true;
    this.recordExclusion("prompt_data_separation_as_boundary");
  }
  /**
   * True when the last evaluation of a model-followed injection ended in a sink denial.
   */
  get sink_denial_is_control() {
    return this.injection_followed_by_model && this.last_decision === "DENY" && this.denials.length > 0;
  }
  /**
   * True when a model-followed injection got past evaluation, so only the prompt wording stood in the way.
   */
  get prompt_wording_is_boundary() {
    return this.injection_followed_by_model && this.last_decision !== "DENY";
  }
  _auditEgressOutsideGrant(request, grant) {
    const originOutside = Boolean(request.origin) && !grant.origins.has(originFromUrl(request.origin));
    const recipientOutside = Boolean(request.recipient) && !grant.recipients.has(request.recipient);
    const egressClassOutside = Boolean(request.egressClass) && !grant.egressClasses.has(request.egressClass);
    if (originOutside || recipientOutside || egressClassOutside) {
      this.unblocked_egress.push(request);
    }
  }
  _deny(reason, request) {
    this.denials.push(
      new CapabilityDenial(reason, request, this.now())
    );
    if (request.origin || request.recipient || request.egressClass) {
      this.egress_blocked.push(request);
    }
    this.last_decision = "DENY";
    return "DENY";
  }
  _isConsequentialAction(tool) {
    const consequentialActionTypes = ["send", "publish", "purchase", "delete", "production_change"];
    return consequentialActionTypes.includes(tool);
  }
};

// conversation/src/domain/roles.ts
var CONSEQUENTIAL_ACTION_TYPES = /* @__PURE__ */ new Set([
  "send",
  "publish",
  "purchase",
  "delete",
  "production_change"
]);
var MEMBER_EXCLUDED_ACTION_TYPES = /* @__PURE__ */ new Set(["purchase", "production_change"]);
var FULL_ROLE_CEILING = {
  actionTypes: CONSEQUENTIAL_ACTION_TYPES,
  origins: /* @__PURE__ */ new Set(),
  recipients: /* @__PURE__ */ new Set(),
  fileScopes: /* @__PURE__ */ new Set(),
  egressClasses: /* @__PURE__ */ new Set(),
  ingestClasses: /* @__PURE__ */ new Set(),
  spendLimit: null
};
var MEMBER_ROLE_CEILING = {
  actionTypes: new Set(
    [...CONSEQUENTIAL_ACTION_TYPES].filter((actionType) => !MEMBER_EXCLUDED_ACTION_TYPES.has(actionType))
  ),
  origins: /* @__PURE__ */ new Set(),
  recipients: /* @__PURE__ */ new Set(),
  fileScopes: /* @__PURE__ */ new Set(),
  egressClasses: /* @__PURE__ */ new Set(),
  ingestClasses: /* @__PURE__ */ new Set(),
  spendLimit: null
};
var ROLE_CEILINGS = {
  owner: FULL_ROLE_CEILING,
  member: MEMBER_ROLE_CEILING
};
function ceilingForMemberRole(role) {
  return ROLE_CEILINGS[role];
}

// conversation/src/policy/ceiling.ts
var Ceiling = class {
  actionTypes;
  origins;
  recipients;
  fileScopes;
  egressClasses;
  ingestClasses;
  spendLimit;
  constructor(actionTypes, origins, recipients, fileScopes, egressClasses, ingestClasses, spendLimit) {
    this.actionTypes = actionTypes;
    this.origins = origins;
    this.recipients = recipients;
    this.fileScopes = fileScopes;
    this.egressClasses = egressClasses;
    this.ingestClasses = ingestClasses;
    this.spendLimit = spendLimit;
  }
};
function clipSpendLimit(left, right) {
  if (left === null || left === void 0) {
    return right;
  }
  if (right === null || right === void 0) {
    return left;
  }
  return Math.min(left, right);
}
function clip(grant, ceiling) {
  if (grant instanceof Ceiling) {
    return new Ceiling(
      new Set([...grant.actionTypes].filter((x) => ceiling.actionTypes.has(x))),
      new Set([...grant.origins].filter((x) => ceiling.origins.has(x))),
      new Set([...grant.recipients].filter((x) => ceiling.recipients.has(x))),
      new Set([...grant.fileScopes].filter((x) => ceiling.fileScopes.has(x))),
      new Set([...grant.egressClasses].filter((x) => ceiling.egressClasses.has(x))),
      new Set([...grant.ingestClasses].filter((x) => ceiling.ingestClasses.has(x))),
      clipSpendLimit(grant.spendLimit, ceiling.spendLimit)
    );
  }
  return {
    tools: new Set([...grant.tools].filter((x) => ceiling.actionTypes.has(x))),
    origins: new Set([...grant.origins].filter((x) => ceiling.origins.has(x))),
    recipients: new Set([...grant.recipients].filter((x) => ceiling.recipients.has(x))),
    fileScopes: new Set([...grant.fileScopes].filter((x) => ceiling.fileScopes.has(x))),
    egressClasses: new Set([...grant.egressClasses].filter((x) => ceiling.egressClasses.has(x))),
    ingestClasses: new Set([...grant.ingestClasses].filter((x) => ceiling.ingestClasses.has(x)))
  };
}
function grantExceedsCeiling(grant, ceiling) {
  const clipped = clip(grant, ceiling);
  if (clipped instanceof Ceiling) {
    return false;
  }
  return !setsEqual(clipped.tools, grant.tools) || !setsEqual(clipped.origins, grant.origins) || !setsEqual(clipped.recipients, grant.recipients) || !setsEqual(clipped.fileScopes, grant.fileScopes) || !setsEqual(clipped.egressClasses, grant.egressClasses) || !setsEqual(clipped.ingestClasses, grant.ingestClasses);
}
function setsEqual(a, b) {
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
}

// conversation/src/policy/models.ts
var CONNECTION_STANDING_ACTION_TYPE = "connection";
var KERNEL_HUMAN_AUTHOR = "kernel";
var AutoReviewRuleKind = {
  RequireApproval: "require_approval",
  AlwaysAllow: "always_allow",
  NeverAllow: "never_allow"
};
var ActorKind = {
  Human: "human",
  Bot: "bot"
};
function humanIdentity(userId) {
  return { kind: ActorKind.Human, actorId: userId };
}
function botIdentity(botId) {
  return { kind: ActorKind.Bot, actorId: botId };
}
function sortedBindingPairs(bindings) {
  return Object.entries(bindings).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, value]) => [key, value]);
}

// conversation/src/policy/authorization-ceiling.ts
var STRUCTURED_ARGUMENT_ALIASES = {
  recipient: "destination",
  destination: "destination",
  body: "payload",
  payload: "payload"
};
var GRANT_STANDING_ACTION_TYPE = "_grant_bounds";
var MemberStanding = class _MemberStanding {
  roleCeiling;
  perActionCeiling;
  constructor(roleCeiling, perActionCeiling = null) {
    this.roleCeiling = roleCeiling;
    this.perActionCeiling = perActionCeiling;
  }
  /** Return unrestricted owner standing for kernel-only sink tests. */
  static owner() {
    return new _MemberStanding(ceilingForMemberRole("owner"));
  }
};
function emptyOrSingle(value) {
  return value ? /* @__PURE__ */ new Set([value]) : /* @__PURE__ */ new Set();
}
function taskGrantForRequestedCapability(request) {
  return new TaskCapabilityGrant(
    emptyOrSingle(request.tool),
    emptyOrSingle(request.origin),
    emptyOrSingle(request.recipient),
    emptyOrSingle(request.filePath),
    emptyOrSingle(request.egressClass),
    /* @__PURE__ */ new Set()
  );
}
function requestExceedsMemberStanding(request, standing, structuredArguments = null) {
  if (CONSEQUENTIAL_ACTION_TYPES.has(request.tool)) {
    if (!standing.roleCeiling.actionTypes.has(request.tool)) {
      return true;
    }
  }
  const perAction = standing.perActionCeiling;
  if (perAction === null) {
    return false;
  }
  const grant = taskGrantForRequestedCapability(request);
  if (grantExceedsMemberAuthorityCeiling(grant, perAction)) {
    return true;
  }
  if (perAction.structuredArgumentBindings.length > 0 && structuredArguments !== null && Object.keys(structuredArguments).length > 0) {
    const ceilingBindings = Object.fromEntries(perAction.structuredArgumentBindings);
    return !structuredBindingsWithinCeilingBindings(structuredArguments, ceilingBindings);
  }
  return false;
}
function normalizeStructuredArguments(arguments_) {
  const normalized = {};
  for (const [key, value] of Object.entries(arguments_)) {
    const canonical = STRUCTURED_ARGUMENT_ALIASES[key] ?? key;
    normalized[canonical] = value;
  }
  return normalized;
}
function egressForAction(actionType) {
  if (actionType === "send") {
    return EgressClass.StructuredSend;
  }
  if (CONSEQUENTIAL_ACTION_TYPES.has(actionType)) {
    return EgressClass.FileTransfer;
  }
  return null;
}
function taskGrantForStructuredArguments(actionType, arguments_) {
  const normalized = normalizeStructuredArguments(arguments_);
  const recipient = normalized["destination"];
  const egress = egressForAction(actionType);
  const tools = CONSEQUENTIAL_ACTION_TYPES.has(actionType) ? /* @__PURE__ */ new Set([actionType]) : /* @__PURE__ */ new Set();
  return new TaskCapabilityGrant(
    tools,
    /* @__PURE__ */ new Set(),
    emptyOrSingle(recipient),
    /* @__PURE__ */ new Set(),
    emptyOrSingle(egress),
    /* @__PURE__ */ new Set()
  );
}
function taskGrantForStructuredOperation(operation) {
  return taskGrantForStructuredArguments(operation.actionType, {
    destination: operation.destination,
    payload: operation.payload
  });
}
function structuredBindingsWithinCeilingBindings(attempted, ceilingBindings) {
  if (Object.keys(ceilingBindings).length === 0) {
    return true;
  }
  const normalizedAttempted = normalizeStructuredArguments(attempted);
  const normalizedCeiling = normalizeStructuredArguments(ceilingBindings);
  return Object.entries(normalizedCeiling).every(([key, value]) => normalizedAttempted[key] === value);
}
function sortedPairs(arguments_) {
  return Object.entries(arguments_).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, value]) => [key, value]);
}
function memberAuthorityCeilingFromStructuredArguments(actionType, arguments_) {
  if (actionType === CONNECTION_STANDING_ACTION_TYPE) {
    return {
      grantCeiling: new Ceiling(
        /* @__PURE__ */ new Set([CONNECTION_STANDING_ACTION_TYPE]),
        /* @__PURE__ */ new Set(),
        /* @__PURE__ */ new Set(),
        /* @__PURE__ */ new Set(),
        /* @__PURE__ */ new Set(),
        /* @__PURE__ */ new Set()
      ),
      structuredArgumentBindings: sortedPairs(arguments_)
    };
  }
  const normalized = normalizeStructuredArguments(arguments_);
  const recipient = normalized["destination"];
  const egress = egressForAction(actionType);
  return {
    grantCeiling: new Ceiling(
      /* @__PURE__ */ new Set([actionType]),
      /* @__PURE__ */ new Set(),
      emptyOrSingle(recipient),
      /* @__PURE__ */ new Set(),
      emptyOrSingle(egress),
      /* @__PURE__ */ new Set()
    ),
    structuredArgumentBindings: sortedPairs(arguments_)
  };
}
function connectionProposalExceedsMemberAuthorityCeiling(channelName, receivingTenantId, memberCeiling) {
  if (memberCeiling === null) {
    return true;
  }
  const attempted = {
    channel: channelName,
    receiving_tenant: receivingTenantId
  };
  const ceilingBindings = Object.fromEntries(memberCeiling.structuredArgumentBindings);
  return !structuredBindingsWithinCeilingBindings(attempted, ceilingBindings);
}
function grantExceedsMemberAuthorityCeiling(grant, memberCeiling) {
  if (memberCeiling === null) {
    return false;
  }
  return grantExceedsCeiling(grant, memberCeiling.grantCeiling);
}
function autoReviewRuleExceedsMemberAuthorityCeiling(actionType, argumentBindings, memberCeiling) {
  if (memberCeiling === null) {
    return false;
  }
  const grant = taskGrantForStructuredArguments(actionType, argumentBindings);
  if (grantExceedsMemberAuthorityCeiling(grant, memberCeiling)) {
    return true;
  }
  if (memberCeiling.structuredArgumentBindings.length > 0) {
    const ceilingBindings = Object.fromEntries(memberCeiling.structuredArgumentBindings);
    return !structuredBindingsWithinCeilingBindings(argumentBindings, ceilingBindings);
  }
  return false;
}
function structuredOperationExceedsMemberAuthorityCeiling(operation, memberCeiling) {
  if (memberCeiling === null) {
    return false;
  }
  const grant = taskGrantForStructuredOperation(operation);
  if (grantExceedsMemberAuthorityCeiling(grant, memberCeiling)) {
    return true;
  }
  if (memberCeiling.structuredArgumentBindings.length > 0) {
    const attempted = {
      destination: operation.destination,
      payload: operation.payload
    };
    const ceilingBindings = Object.fromEntries(memberCeiling.structuredArgumentBindings);
    return !structuredBindingsWithinCeilingBindings(attempted, ceilingBindings);
  }
  return false;
}
function memberAuthorityCeilingFromGrantTable(rows) {
  const grant = parseGrantTable(rows);
  return {
    grantCeiling: new Ceiling(
      new Set(grant.tools),
      grant.origins,
      grant.recipients,
      grant.fileScopes,
      grant.egressClasses,
      grant.ingestClasses
    ),
    structuredArgumentBindings: []
  };
}

// conversation/src/policy/overnight.ts
var WAITING_FOR_HUMAN = "waiting_for_human";
var USER_CONTROLLED_COMPLETION_REQUIRED = "user_controlled_completion_required";
var CHANNEL_BROWSER = "browser";
function bindingsEqual(bindings, arguments_) {
  const bound = Object.fromEntries(bindings);
  const boundKeys = Object.keys(bound);
  const argumentKeys = Object.keys(arguments_);
  return boundKeys.length === argumentKeys.length && boundKeys.every((key) => bound[key] === arguments_[key]);
}
function resolveUnattendedGatedAction(options) {
  const userId = options.userId ?? null;
  const completionEvidence = options.completionEvidence ?? "system-accepted";
  if (!CONSEQUENTIAL_ACTION_TYPES.has(options.actionType)) {
    return { executed: true, turn_status: "completed", reason: null, completion_evidence: null };
  }
  if (options.channel === CHANNEL_BROWSER) {
    return {
      executed: false,
      turn_status: "blocked",
      reason: USER_CONTROLLED_COMPLETION_REQUIRED,
      completion_evidence: null
    };
  }
  const matching = options.rules.filter(
    (rule) => rule.kind === AutoReviewRuleKind.AlwaysAllow && rule.creator.kind === ActorKind.Human && rule.actionType === options.actionType && rule.tenantId === options.tenantId && (rule.userId === null || rule.userId === userId) && rule.argumentBindings.length > 0 && bindingsEqual(rule.argumentBindings, options.arguments)
  );
  if (matching.length > 0) {
    return { executed: true, turn_status: "completed", reason: null, completion_evidence: completionEvidence };
  }
  return { executed: false, turn_status: "blocked", reason: WAITING_FOR_HUMAN, completion_evidence: null };
}

// conversation/src/policy/sinks.ts
var POLICY_KERNEL_TENANT = "policy-tenant";
var POLICY_KERNEL_TURN = "policy-turn";
var MEMBER_STANDING_DENIAL = "exceeds member authority standing";
var CapabilitySinkDenied = class extends Error {
  constructor(message) {
    super(message);
    this.name = "CapabilitySinkDenied";
  }
};
var CapabilitySinkApprovalRequired = class extends Error {
  constructor(message) {
    super(message);
    this.name = "CapabilitySinkApprovalRequired";
  }
};
function structuredActionRequest(actionType, arguments_) {
  const recipient = arguments_["recipient"] ?? arguments_["destination"] ?? void 0;
  let egressClass = null;
  if (actionType === "send") {
    egressClass = "structured_send";
  } else if (["publish", "purchase", "delete", "production_change"].includes(actionType)) {
    egressClass = "file_transfer";
  }
  return new RequestedCapability(
    actionType,
    arguments_["origin"] ?? void 0,
    recipient,
    arguments_["file_path"] ?? void 0,
    egressClass
  );
}
function denyIfExceedsMemberStanding(policy, request, memberStanding, { structuredArguments } = {}) {
  if (requestExceedsMemberStanding(request, memberStanding, structuredArguments)) {
    policy["_deny"](MEMBER_STANDING_DENIAL, request);
    throw new CapabilitySinkDenied(MEMBER_STANDING_DENIAL);
  }
}
function requireAllow(policy, request, memberStanding, { structuredArguments } = {}) {
  denyIfExceedsMemberStanding(policy, request, memberStanding, { structuredArguments });
  const decision = policy.evaluate(request);
  if (decision === "DENY") {
    const reason = policy.denials.length > 0 ? policy.denials[policy.denials.length - 1].reason : "denied";
    throw new CapabilitySinkDenied(reason);
  }
  if (decision === "REQUIRE_APPROVAL") {
    throw new CapabilitySinkApprovalRequired("immutable approval required");
  }
}
function requireGranted(policy, request, memberStanding, { structuredArguments } = {}) {
  denyIfExceedsMemberStanding(policy, request, memberStanding, { structuredArguments });
  const decision = policy.evaluate(request);
  if (decision === "DENY") {
    const reason = policy.denials.length > 0 ? policy.denials[policy.denials.length - 1].reason : "denied";
    throw new CapabilitySinkDenied(reason);
  }
}
var CHANNEL_BROWSER2 = "browser";
var CONSEQUENTIAL_ACTION_TYPES2 = ["send", "publish", "purchase", "delete", "production_change"];
function attemptAuthenticatedBrowserActionAtSink(policy, action, { structuredConnector = false, takeoverControl = false } = {}) {
  if (structuredConnector) {
    throw new Error("a structured connector binds through the approval path, not this one");
  }
  policy.requiredBindingForBrowserAction(action, { takeoverControl });
  let result = policy.last_overnight;
  if (result !== null) {
    return result;
  }
  const actionType = action;
  if (!CONSEQUENTIAL_ACTION_TYPES2.includes(actionType)) {
    return {
      executed: true,
      turn_status: "completed",
      reason: null,
      completion_evidence: null
    };
  }
  return {
    executed: false,
    turn_status: "blocked",
    reason: "user_controlled_completion_required",
    completion_evidence: null
  };
}
function resolveUnattendedGatedActionAtSink(policy, {
  actionType,
  arguments: arguments_,
  channel,
  rules,
  tenantId,
  memberStanding,
  userId,
  completionEvidence = "system-accepted"
}) {
  const request = structuredActionRequest(actionType, arguments_);
  try {
    denyIfExceedsMemberStanding(
      policy,
      request,
      memberStanding,
      { structuredArguments: arguments_ }
    );
  } catch (error) {
    if (error instanceof CapabilitySinkDenied) {
      return {
        executed: false,
        turn_status: "blocked",
        reason: error.message,
        completion_evidence: null
      };
    }
    throw error;
  }
  if (policy.grant === null) {
    if (CONSEQUENTIAL_ACTION_TYPES2.includes(actionType)) {
      policy.evaluate(request);
      return {
        executed: false,
        turn_status: "blocked",
        reason: "no task grant",
        completion_evidence: null
      };
    }
  } else {
    const decision = policy.evaluate(request);
    if (decision === "DENY") {
      const reason = policy.denials.length > 0 ? policy.denials[policy.denials.length - 1].reason : "denied";
      return {
        executed: false,
        turn_status: "blocked",
        reason,
        completion_evidence: null
      };
    }
  }
  if (channel === CHANNEL_BROWSER2 && CONSEQUENTIAL_ACTION_TYPES2.includes(actionType)) {
    return attemptAuthenticatedBrowserActionAtSink(policy, actionType);
  }
  return resolveUnattendedGatedAction({
    actionType,
    arguments: arguments_,
    channel,
    rules,
    tenantId,
    userId,
    completionEvidence
  });
}
async function executeApprovedOperationAtSink(policy, gate, approval, attempted, completionEvidence, memberStanding) {
  const request = new RequestedCapability(
    attempted.actionType,
    void 0,
    attempted.destination,
    void 0,
    EgressClass.StructuredSend
  );
  const structuredArguments = {
    destination: attempted.destination,
    payload: attempted.payload
  };
  try {
    requireGranted(policy, request, memberStanding, { structuredArguments });
  } catch (error) {
    if (error instanceof CapabilitySinkDenied) {
      return {
        executed: false,
        reason: error.message,
        completionEvidence: null,
        requiresNewApproval: true
      };
    }
    throw error;
  }
  const bindingResult = await gate.executeApprovedOperation(approval, attempted, completionEvidence);
  if (bindingResult.executed) {
    policy.bindConnector(attempted.actionType, attempted.destination, attempted.payload);
    policy.approveBoundOperation();
    policy.executeBoundConnector(completionEvidence);
  }
  return bindingResult;
}

// conversation/src/pi/gate.ts
var APPROVAL_REQUIRED_REASON = "immutable approval required";
function requestedCapabilityForModelTool(toolName, arguments_) {
  if (toolName === "read_workspace") {
    return new RequestedCapability(toolName, void 0, void 0, arguments_["path"], EgressClass.ApprovedOriginFetch);
  }
  if (toolName === "write_workspace" || toolName === "edit_workspace") {
    return new RequestedCapability(toolName, void 0, void 0, arguments_["path"]);
  }
  if (toolName === "browse") {
    return new RequestedCapability(toolName, arguments_["url"], void 0, void 0, EgressClass.ApprovedOriginFetch);
  }
  if (toolName === "run_terminal") {
    const cwd = (arguments_["cwd"] ?? "/workspace").trim() || "/workspace";
    return new RequestedCapability(toolName, void 0, void 0, cwd);
  }
  if (CONSEQUENTIAL_ACTION_TYPES.has(toolName)) {
    return structuredActionRequest(toolName, { ...arguments_ });
  }
  return new RequestedCapability(toolName);
}
async function evaluateModelToolRequest(deps, toolName, arguments_) {
  const consequential = CONSEQUENTIAL_ACTION_TYPES.has(toolName);
  const policy = new CapabilityPolicy(deps.now);
  const grant = await deps.readGrant();
  if (grant !== null) {
    policy.setGrant(grant);
  }
  try {
    requireAllow(
      policy,
      requestedCapabilityForModelTool(toolName, arguments_),
      await deps.resolveStanding(consequential ? toolName : null),
      { structuredArguments: consequential ? { ...arguments_ } : null }
    );
  } catch (error) {
    if (error instanceof CapabilitySinkApprovalRequired) {
      return { allowed: false, reason: APPROVAL_REQUIRED_REASON };
    }
    if (error instanceof CapabilitySinkDenied || error instanceof MemberStandingRequiredError) {
      return { allowed: false, reason: error.message };
    }
    throw error;
  }
  return { allowed: true };
}
var UNGATED_TOOL_NAMES = /* @__PURE__ */ new Set([TASK_TOOL_NAME, BOARD_TOOL_NAME]);
function toolGateExtension(deps) {
  return defineExtension5({
    name: "chatticus-tool-gate",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) => {
          if (UNGATED_TOOL_NAMES.has(call.name)) return void 0;
          const verdict = await evaluateModelToolRequest(deps, call.name, stringArguments(call.arguments));
          return verdict.allowed ? void 0 : { block: verdict.reason };
        }
      })
    ]
  });
}

// conversation/src/domain/channels.ts
function primaryHumanParticipant(channel) {
  for (const participant of channel.participants) {
    if (participant.kind === "human") {
      return participant.actorId;
    }
  }
  throw new ActorNotInChannelError(`Channel ${pythonRepr(channel.channelId)} has no human participants.`);
}

// conversation/src/store/policy-store.ts
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
  QueryCommand
} from "@aws-sdk/client-dynamodb";

// conversation/src/store/keys.ts
function approvalKey(tenantId, approvalId) {
  return {
    pk: `${tenantId}#approvals`,
    sk: `APPROVAL#${approvalId}`
  };
}
function ruleKey(tenantId, ruleId) {
  return {
    pk: `${tenantId}#rules`,
    sk: `RULE#${ruleId}`
  };
}
function connectionKey(grantingTenantId, proposalId) {
  return {
    pk: `${grantingTenantId}#connections`,
    sk: `CONN#${proposalId}`
  };
}
function memberCeilingKey(tenantId, memberUserId, actionType) {
  return {
    pk: `${tenantId}#rules`,
    sk: `CEILING#${memberUserId}#${actionType}`
  };
}
function tenantConnectionEgressKey(tenantId) {
  return {
    pk: `${tenantId}#rules`,
    sk: "EGRESS#connection"
  };
}
function refusalKey(tenantId, refusalId) {
  return {
    pk: `${tenantId}#rules`,
    sk: `REFUSAL#${refusalId}`
  };
}

// conversation/src/store/codecs/list-util.ts
function encodeStringSet(values) {
  return { L: [...values].sort().map((value) => ({ S: value })) };
}
function decodeStringSet(attribute) {
  return new Set((attribute?.L ?? []).map((entry) => entry.S ?? ""));
}
function encodePairs(pairs) {
  return { L: pairs.map(([key, value]) => ({ L: [{ S: key }, { S: value }] })) };
}
function decodePairs(attribute) {
  return (attribute?.L ?? []).map((entry) => [entry.L?.[0]?.S ?? "", entry.L?.[1]?.S ?? ""]);
}
function requireString(item, attribute, kind) {
  const value = item[attribute]?.S;
  if (value === void 0 || value === "") {
    throw new Error(`malformed ${kind} item: ${attribute}`);
  }
  return value;
}

// conversation/src/store/codecs/approval.ts
function encode2(value) {
  const key = approvalKey(value.tenantId, value.approvalId);
  const item = {
    pk: { S: key.pk },
    sk: { S: key.sk },
    tenant_id: { S: value.tenantId },
    approval_id: { S: value.approvalId },
    kind: { S: value.kind },
    action_type: { S: value.actionType },
    destination: { S: value.destination },
    payload: { S: value.payload }
  };
  if (value.approverKind !== null) {
    item.approver_kind = { S: value.approverKind };
  }
  if (value.approverId !== null) {
    item.approver_id = { S: value.approverId };
  }
  return item;
}
function decode(item) {
  const kind = requireString(item, "kind", "approval");
  if (kind !== "proposal" && kind !== "approval") {
    throw new Error("malformed approval item: kind");
  }
  return {
    approvalId: requireString(item, "approval_id", "approval"),
    tenantId: requireString(item, "tenant_id", "approval"),
    kind,
    actionType: requireString(item, "action_type", "approval"),
    destination: item.destination?.S ?? "",
    payload: item.payload?.S ?? "",
    approverKind: item.approver_kind?.S ?? null,
    approverId: item.approver_id?.S ?? null
  };
}

// conversation/src/store/codecs/util.ts
function formatIsoDateTime(date) {
  const iso = date.toISOString();
  const withoutZ = iso.slice(0, -1);
  const noMillis = withoutZ.replace(/\.\d{3}$/, "");
  return noMillis + "+00:00";
}

// conversation/src/store/codecs/connection.ts
function encode3(value) {
  const proposal = value.proposal;
  const key = connectionKey(proposal.grantingTenantId, proposal.proposalId);
  const item = {
    pk: { S: key.pk },
    sk: { S: key.sk },
    proposal_id: { S: proposal.proposalId },
    granting_tenant_id: { S: proposal.grantingTenantId },
    receiving_tenant_id: { S: proposal.receivingTenantId },
    channel_id: { S: proposal.channelId },
    channel_name: { S: proposal.channelName },
    permission: { S: proposal.permission },
    proposer_user_id: { S: proposal.proposerUserId }
  };
  if (value.status !== null) {
    item.status = { S: value.status };
  }
  if (value.escalationTargetUserId !== null) {
    item.escalation_target_user_id = { S: value.escalationTargetUserId };
  }
  if (value.authorized !== null) {
    item.connection_id = { S: value.authorized.connectionId };
    item.clipped_by_user_id = { S: value.authorized.clippedByUserId };
    item.created_at = { S: formatIsoDateTime(value.authorized.createdAt) };
  }
  return item;
}
function decode2(item) {
  const proposal = {
    proposalId: requireString(item, "proposal_id", "connection"),
    grantingTenantId: requireString(item, "granting_tenant_id", "connection"),
    receivingTenantId: requireString(item, "receiving_tenant_id", "connection"),
    channelId: requireString(item, "channel_id", "connection"),
    channelName: requireString(item, "channel_name", "connection"),
    permission: requireString(item, "permission", "connection"),
    proposerUserId: requireString(item, "proposer_user_id", "connection")
  };
  const connectionId = item.connection_id?.S;
  const authorized = connectionId === void 0 ? null : {
    connectionId,
    grantingTenantId: proposal.grantingTenantId,
    receivingTenantId: proposal.receivingTenantId,
    channelId: proposal.channelId,
    channelName: proposal.channelName,
    permission: proposal.permission,
    clippedByUserId: requireString(item, "clipped_by_user_id", "connection"),
    createdAt: new Date(requireString(item, "created_at", "connection"))
  };
  return {
    proposal,
    status: item.status?.S ?? null,
    escalationTargetUserId: item.escalation_target_user_id?.S ?? null,
    authorized
  };
}

// conversation/src/store/codecs/rule.ts
function encode4(value) {
  const key = ruleKey(value.tenantId, value.ruleId);
  const item = {
    pk: { S: key.pk },
    sk: { S: key.sk },
    tenant_id: { S: value.tenantId },
    rule_id: { S: value.ruleId },
    kind: { S: value.kind },
    action_type: { S: value.actionType },
    argument_bindings: encodePairs(value.argumentBindings),
    creator_kind: { S: value.creator.kind },
    creator_id: { S: value.creator.actorId }
  };
  if (value.userId !== null) {
    item.user_id = { S: value.userId };
  }
  return item;
}
function decode3(item) {
  return {
    ruleId: requireString(item, "rule_id", "rule"),
    tenantId: requireString(item, "tenant_id", "rule"),
    kind: requireString(item, "kind", "rule"),
    actionType: requireString(item, "action_type", "rule"),
    userId: item.user_id?.S ?? null,
    argumentBindings: decodePairs(item.argument_bindings),
    creator: {
      kind: requireString(item, "creator_kind", "rule"),
      actorId: requireString(item, "creator_id", "rule")
    }
  };
}
function encodeRefusal(value) {
  const key = refusalKey(value.tenantId, value.refusalId);
  return {
    pk: { S: key.pk },
    sk: { S: key.sk },
    tenant_id: { S: value.tenantId },
    refusal_id: { S: value.refusalId },
    kind: { S: value.kind },
    fields: { L: value.fields.map((field) => ({ S: field })) }
  };
}
function decodeRefusal(item) {
  return {
    refusalId: requireString(item, "refusal_id", "refusal"),
    tenantId: requireString(item, "tenant_id", "refusal"),
    kind: requireString(item, "kind", "refusal"),
    fields: (item.fields?.L ?? []).map((entry) => entry.S ?? "")
  };
}

// conversation/src/store/codecs/standing.ts
function encodeBody(value) {
  const ceiling = value.grantCeiling;
  const item = {
    action_types: encodeStringSet(ceiling.actionTypes),
    origins: encodeStringSet(ceiling.origins),
    recipients: encodeStringSet(ceiling.recipients),
    file_scopes: encodeStringSet(ceiling.fileScopes),
    egress_classes: encodeStringSet(ceiling.egressClasses),
    ingest_classes: encodeStringSet(ceiling.ingestClasses),
    structured_argument_bindings: encodePairs(value.structuredArgumentBindings)
  };
  if (ceiling.spendLimit !== null && ceiling.spendLimit !== void 0) {
    item.spend_limit = { N: String(ceiling.spendLimit) };
  }
  return item;
}
function encodeMemberCeiling(tenantId, memberUserId, actionType, value) {
  const key = memberCeilingKey(tenantId, memberUserId, actionType);
  return {
    pk: { S: key.pk },
    sk: { S: key.sk },
    tenant_id: { S: tenantId },
    member_user_id: { S: memberUserId },
    action_type: { S: actionType },
    ...encodeBody(value)
  };
}
function encodeTenantConnectionEgress(tenantId, value) {
  const key = tenantConnectionEgressKey(tenantId);
  return {
    pk: { S: key.pk },
    sk: { S: key.sk },
    tenant_id: { S: tenantId },
    ...encodeBody(value)
  };
}
function decodeCeiling(item) {
  const spend = item.spend_limit?.N;
  return {
    grantCeiling: new Ceiling(
      decodeStringSet(item.action_types),
      decodeStringSet(item.origins),
      decodeStringSet(item.recipients),
      decodeStringSet(item.file_scopes),
      decodeStringSet(item.egress_classes),
      decodeStringSet(item.ingest_classes),
      spend === void 0 ? void 0 : Number(spend)
    ),
    structuredArgumentBindings: decodePairs(item.structured_argument_bindings)
  };
}

// conversation/src/store/policy-store.ts
var PolicyItemAlreadyExistsError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PolicyItemAlreadyExistsError";
  }
};
var PolicyItemNotFoundError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PolicyItemNotFoundError";
  }
};
var DynamoPolicyStore = class {
  client;
  tableName;
  constructor(client, tableName) {
    this.client = client;
    this.tableName = tableName;
  }
  async createApproval(approval) {
    await this.create(encode2(approval), `approval ${JSON.stringify(approval.approvalId)}`);
  }
  async getApproval(tenantId, approvalId) {
    const item = await this.get(approvalKey(tenantId, approvalId));
    return item === null ? null : decode(item);
  }
  async createRule(rule) {
    await this.create(encode4(rule), `rule ${JSON.stringify(rule.ruleId)}`);
  }
  async listRules(tenantId) {
    const items = await this.list(`${tenantId}#rules`, "RULE#");
    return items.map(decode3);
  }
  async createConnectionRecord(record) {
    await this.create(encode3(record), `connection ${JSON.stringify(record.proposal.proposalId)}`);
  }
  async replaceConnectionRecord(record) {
    await this.replace(encode3(record), `connection ${JSON.stringify(record.proposal.proposalId)}`);
  }
  async getConnectionRecord(grantingTenantId, proposalId) {
    const item = await this.get(connectionKey(grantingTenantId, proposalId));
    return item === null ? null : decode2(item);
  }
  async listConnectionRecords(grantingTenantId) {
    const items = await this.list(`${grantingTenantId}#connections`, "CONN#");
    return items.map(decode2);
  }
  async putMemberCeiling(tenantId, memberUserId, actionType, ceiling) {
    await this.put(encodeMemberCeiling(tenantId, memberUserId, actionType, ceiling));
  }
  async getMemberCeiling(tenantId, memberUserId, actionType) {
    const item = await this.get(memberCeilingKey(tenantId, memberUserId, actionType));
    return item === null ? null : decodeCeiling(item);
  }
  async putTenantConnectionEgress(tenantId, ceiling) {
    await this.put(encodeTenantConnectionEgress(tenantId, ceiling));
  }
  async getTenantConnectionEgress(tenantId) {
    const item = await this.get(tenantConnectionEgressKey(tenantId));
    return item === null ? null : decodeCeiling(item);
  }
  async createRefusal(refusal) {
    await this.create(encodeRefusal(refusal), `refusal ${JSON.stringify(refusal.refusalId)}`);
  }
  async listRefusals(tenantId, kind) {
    const items = await this.list(`${tenantId}#rules`, "REFUSAL#");
    return items.map(decodeRefusal).filter((refusal) => refusal.kind === kind);
  }
  async create(item, description) {
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)"
        })
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new PolicyItemAlreadyExistsError(`The ${description} already exists.`);
      }
      throw error;
    }
  }
  async replace(item, description) {
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_exists(pk)"
        })
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new PolicyItemNotFoundError(`The ${description} does not exist.`);
      }
      throw error;
    }
  }
  async put(item) {
    await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: item }));
  }
  async get(key) {
    const response = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: key.pk }, sk: { S: key.sk } },
        ConsistentRead: true
      })
    );
    return response.Item ?? null;
  }
  async list(partitionKey, sortKeyPrefix) {
    const items = [];
    let exclusiveStartKey;
    do {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": { S: partitionKey }, ":prefix": { S: sortKeyPrefix } },
          ConsistentRead: true,
          ExclusiveStartKey: exclusiveStartKey
        })
      );
      items.push(...response.Items ?? []);
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey !== void 0);
    return items;
  }
};

// conversation/src/policy/approval-binding.ts
var DESTINATION_CHANGED = "destination_changed";
var PAYLOAD_CHANGED = "payload_changed";
var NOT_APPROVED = "not_approved";
function operationsEqual(left, right) {
  return left.actionType === right.actionType && left.destination === right.destination && left.payload === right.payload;
}
function notExecuted(reason) {
  return { executed: false, reason, completionEvidence: null, requiresNewApproval: true };
}
var ApprovalBindingGate = class {
  tenantId;
  store;
  ids;
  lastExecutionResult = null;
  constructor(tenantId, deps) {
    this.tenantId = tenantId;
    this.store = deps.store;
    this.ids = deps.ids;
  }
  /** Return the most recent execution attempt. */
  get lastExecution() {
    return this.lastExecutionResult;
  }
  /** Record a bot proposal with concrete destination and payload. */
  async proposeStructuredOperation(actionType, destination, payload) {
    if (!CONSEQUENTIAL_ACTION_TYPES.has(actionType)) {
      throw new Error(`Action type ${JSON.stringify(actionType)} is not consequential.`);
    }
    const operation = { actionType, destination, payload };
    const proposalId = this.ids.next();
    await this.store.createApproval({
      approvalId: proposalId,
      tenantId: this.tenantId,
      kind: "proposal",
      actionType,
      destination,
      payload,
      approverKind: null,
      approverId: null
    });
    return { proposalId, operation };
  }
  /** Bind human approval to the reviewed proposal. */
  async approveOperation(proposal, approver = null) {
    const stored = await this.store.getApproval(this.tenantId, proposal.proposalId);
    if (stored === null || stored.kind !== "proposal" || !operationsEqual(stored, proposal.operation)) {
      throw new Error(`Unknown or stale proposal ${JSON.stringify(proposal.proposalId)}.`);
    }
    const approvalId = this.ids.next();
    const resolvedApprover = approver ?? humanIdentity(KERNEL_HUMAN_AUTHOR);
    try {
      await this.store.createApproval({
        approvalId,
        tenantId: this.tenantId,
        kind: "approval",
        actionType: stored.actionType,
        destination: stored.destination,
        payload: stored.payload,
        approverKind: resolvedApprover.kind,
        approverId: resolvedApprover.actorId
      });
    } catch (error) {
      if (error instanceof PolicyItemAlreadyExistsError) {
        throw new Error(`Approval ${JSON.stringify(approvalId)} already exists.`);
      }
      throw error;
    }
    return {
      approvalId,
      operation: { actionType: stored.actionType, destination: stored.destination, payload: stored.payload },
      approver: resolvedApprover
    };
  }
  /** Execute only when the attempt matches the approved binding. */
  async executeApprovedOperation(approval, attempted, completionEvidence) {
    const stored = await this.store.getApproval(this.tenantId, approval.approvalId);
    const bound = stored === null || stored.kind !== "approval" ? null : { actionType: stored.actionType, destination: stored.destination, payload: stored.payload };
    if (bound === null || !operationsEqual(bound, approval.operation)) {
      return this.remember(notExecuted(NOT_APPROVED));
    }
    if (attempted.actionType !== bound.actionType) {
      return this.remember(notExecuted(NOT_APPROVED));
    }
    if (attempted.destination !== bound.destination) {
      return this.remember(notExecuted(DESTINATION_CHANGED));
    }
    if (attempted.payload !== bound.payload) {
      return this.remember(notExecuted(PAYLOAD_CHANGED));
    }
    return this.remember({
      executed: true,
      reason: null,
      completionEvidence,
      requiresNewApproval: false
    });
  }
  remember(result) {
    this.lastExecutionResult = result;
    return result;
  }
};

// conversation/src/policy/connections.ts
var CONNECTION_PERMISSION_READ = "read";
var ConnectionProposalStatus = {
  Authorized: "authorized",
  Refused: "refused",
  PendingEscalation: "pending_escalation",
  Blocked: "blocked"
};
var InvalidConnectionTargetError = class extends DomainError {
  constructor(message) {
    super("invalid_connection_target", message);
  }
};
function connectionArgumentBindings(options) {
  return {
    channel: options.channelName,
    receiving_tenant: options.receivingTenantId
  };
}
function validateConnectionTarget(options) {
  if (options.permission !== CONNECTION_PERMISSION_READ) {
    throw new InvalidConnectionTargetError(`Unsupported connection permission ${pythonRepr2(options.permission)}.`);
  }
  if (options.channelName.startsWith("/")) {
    throw new InvalidConnectionTargetError("Connections may reach a channel only, never the workplace.");
  }
}
function pythonRepr2(value) {
  return `'${value}'`;
}
function memberCoversConnectionProposal(proposal, memberCeiling) {
  if (memberCeiling === null) {
    return false;
  }
  const bindings = connectionArgumentBindings({
    channelName: proposal.channelName,
    receivingTenantId: proposal.receivingTenantId
  });
  const ceilingBindings = Object.fromEntries(memberCeiling.structuredArgumentBindings);
  return structuredBindingsWithinCeilingBindings(bindings, ceilingBindings);
}
function orgEgressAllowsConnection(proposal, orgEgressCeiling) {
  if (orgEgressCeiling === null) {
    return true;
  }
  return memberCoversConnectionProposal(proposal, orgEgressCeiling);
}
async function findEscalationTargetUserId(proposal, options) {
  const covering = [];
  for (const userId of options.memberUserIds) {
    const ceiling = await options.ceilingForMember(userId);
    if (memberCoversConnectionProposal(proposal, ceiling)) {
      covering.push(userId);
    }
  }
  if (covering.length === 0) {
    return null;
  }
  const others = covering.filter((userId) => userId !== proposal.proposerUserId).sort(compareStrings);
  if (others.length > 0) {
    return others[0];
  }
  return [...covering].sort(compareStrings)[0];
}
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function newConnectionProposal(options, ids) {
  validateConnectionTarget({ permission: options.permission, channelName: options.channelName });
  return {
    proposalId: ids.next(),
    grantingTenantId: options.grantingTenantId,
    receivingTenantId: options.receivingTenantId,
    channelId: options.channelId,
    channelName: options.channelName,
    permission: options.permission,
    proposerUserId: options.proposerUserId
  };
}
function authorizeConnectionFromProposal(proposal, options, ids) {
  return {
    connectionId: ids.next(),
    grantingTenantId: proposal.grantingTenantId,
    receivingTenantId: proposal.receivingTenantId,
    channelId: proposal.channelId,
    channelName: proposal.channelName,
    permission: proposal.permission,
    clippedByUserId: options.clippedByUserId,
    createdAt: options.createdAt
  };
}
function proposerMayAuthorizeImmediately(proposal, proposerCeiling, orgEgressCeiling) {
  if (connectionProposalExceedsMemberAuthorityCeiling(
    proposal.channelName,
    proposal.receivingTenantId,
    proposerCeiling
  )) {
    return false;
  }
  return orgEgressAllowsConnection(proposal, orgEgressCeiling);
}

// conversation/src/policy/policy-control.ts
var PolicyControl = class {
  deps;
  capabilityPolicies = /* @__PURE__ */ new Map();
  constructor(deps) {
    this.deps = deps;
  }
  /** Return the capability policy for one turn, creating it if needed. */
  capabilityPolicyFor(tenantId, turnId) {
    const key = `${tenantId}\0${turnId}`;
    let policy = this.capabilityPolicies.get(key);
    if (policy === void 0) {
      policy = new CapabilityPolicy(() => this.deps.clock.now());
      this.capabilityPolicies.set(key, policy);
    }
    return policy;
  }
  /** Attach one closed task grant to a turn for sink enforcement. */
  setTurnCapabilityGrant(tenantId, turnId, grant) {
    this.capabilityPolicyFor(tenantId, turnId).setGrant(grant);
  }
  /** Return the approval binding gate for one tenant. */
  approvalBinding(tenantId) {
    return new ApprovalBindingGate(tenantId, { store: this.deps.policyStore, ids: this.deps.ids });
  }
  /** Evaluate a proposed action against defaults and tenant rules. */
  async evaluateAction(actionType, tenantId, userId = null) {
    const rules = await this.deps.policyStore.listRules(tenantId);
    const matching = rules.filter(
      (rule) => rule.actionType === actionType && rule.tenantId === tenantId && (rule.userId === null || rule.userId === userId)
    );
    if (matching.some((rule) => rule.kind === AutoReviewRuleKind.NeverAllow)) {
      return "DENY";
    }
    if (matching.some((rule) => rule.kind === AutoReviewRuleKind.RequireApproval)) {
      return "REQUIRE_APPROVAL";
    }
    if (matching.some((rule) => rule.kind === AutoReviewRuleKind.AlwaysAllow)) {
      return "ALLOW";
    }
    if (CONSEQUENTIAL_ACTION_TYPES.has(actionType)) {
      return "REQUIRE_APPROVAL";
    }
    return "ALLOW";
  }
  /**
   * Add an auto-review rule scoped to a tenant, optionally one user.
   *
   * A bot cannot create an always-allow that loosens a consequential
   * action. A human cannot write a rule broader than their standing
   * ceiling. Returns whether the rule was recorded.
   */
  async addAutoReviewRule(kind, actionType, tenantId, userId = null, options = {}) {
    const createdBy = options.createdBy ?? "human";
    let resolvedCreator = options.creator ?? null;
    if (resolvedCreator === null) {
      if (createdBy === "bot") {
        resolvedCreator = botIdentity(options.creatorBotId ?? "bot");
      } else {
        resolvedCreator = humanIdentity(KERNEL_HUMAN_AUTHOR);
      }
    }
    if (resolvedCreator.kind === ActorKind.Bot && kind === AutoReviewRuleKind.AlwaysAllow) {
      await this.recordRefusal(tenantId, "bot_auto_review", [tenantId, actionType]);
      return false;
    }
    const bindings = options.arguments ?? {};
    const memberCeiling = await this.memberAuthorityCeiling(tenantId, resolvedCreator.actorId, actionType);
    if (autoReviewRuleExceedsMemberAuthorityCeiling(actionType, bindings, memberCeiling)) {
      await this.recordRefusal(tenantId, "authority_ceiling", [tenantId, actionType, resolvedCreator.actorId]);
      return false;
    }
    await this.deps.policyStore.createRule({
      ruleId: this.deps.ids.next(),
      kind,
      actionType,
      tenantId,
      userId,
      argumentBindings: sortedBindingPairs(bindings),
      creator: resolvedCreator
    });
    return true;
  }
  /** Record one member's standing authority for a structured action. */
  async setMemberAuthorityCeiling(tenantId, memberUserId, actionType, options) {
    await this.deps.policyStore.putMemberCeiling(
      tenantId,
      memberUserId,
      actionType,
      memberAuthorityCeilingFromStructuredArguments(actionType, options.arguments)
    );
  }
  /** Record one member's closed grant-table standing for replacement checks. */
  async setMemberGrantBoundsCeiling(tenantId, memberUserId, options) {
    await this.deps.policyStore.putMemberCeiling(
      tenantId,
      memberUserId,
      GRANT_STANDING_ACTION_TYPE,
      memberAuthorityCeilingFromGrantTable(options.grantTable)
    );
  }
  /** Return the recorded standing ceiling for one member and action. */
  async memberAuthorityCeiling(tenantId, memberUserId, actionType) {
    return this.deps.policyStore.getMemberCeiling(tenantId, memberUserId, actionType);
  }
  /** Approve one structured operation when the approver is within standing. */
  async approveStructuredOperation(tenantId, proposal, options) {
    const approver = options.approver;
    if (approver.kind !== ActorKind.Human) {
      await this.recordRefusal(tenantId, "authority_ceiling", [
        tenantId,
        proposal.operation.actionType,
        approver.actorId
      ]);
      return null;
    }
    const memberCeiling = await this.memberAuthorityCeiling(tenantId, approver.actorId, proposal.operation.actionType);
    if (structuredOperationExceedsMemberAuthorityCeiling(proposal.operation, memberCeiling)) {
      await this.recordRefusal(tenantId, "authority_ceiling", [
        tenantId,
        proposal.operation.actionType,
        approver.actorId
      ]);
      return null;
    }
    return this.approvalBinding(tenantId).approveOperation(proposal, approver);
  }
  /** Return always-allow attempts the kernel rejected from a bot, as tenant and action pairs. */
  async refusedBotAutoReview(tenantId) {
    const refusals = await this.deps.policyStore.listRefusals(tenantId, "bot_auto_review");
    return refusals.map((refusal) => [refusal.fields[0], refusal.fields[1]]);
  }
  /** Return rule or approval attempts refused outside standing, as tenant, action and member triples. */
  async refusedAuthorityCeiling(tenantId) {
    const refusals = await this.deps.policyStore.listRefusals(tenantId, "authority_ceiling");
    return refusals.map((refusal) => [refusal.fields[0], refusal.fields[1], refusal.fields[2]]);
  }
  /** Return connection proposals refused outside standing. */
  async refusedConnections(tenantId) {
    const refusals = await this.deps.policyStore.listRefusals(tenantId, "connection");
    return refusals.map((refusal) => [refusal.fields[0], refusal.fields[1], refusal.fields[2], refusal.fields[3]]);
  }
  /** Propose one connection; authorize when the proposer is within standing. */
  async proposeConnection(grantingTenantId, proposerUserId, receivingTenantId, channelId, channelName, permission = "read") {
    const proposal = newConnectionProposal(
      { grantingTenantId, receivingTenantId, channelId, channelName, permission, proposerUserId },
      this.deps.ids
    );
    const proposerCeiling = await this.memberAuthorityCeiling(
      grantingTenantId,
      proposerUserId,
      CONNECTION_STANDING_ACTION_TYPE
    );
    const orgEgress = await this.deps.policyStore.getTenantConnectionEgress(grantingTenantId);
    if (proposerMayAuthorizeImmediately(proposal, proposerCeiling, orgEgress)) {
      return this.authorizeAndRecord(proposal, proposerUserId);
    }
    await this.deps.policyStore.createConnectionRecord({
      proposal,
      status: null,
      escalationTargetUserId: null,
      authorized: null
    });
    return { proposal, route: null, authorized: null, refused: false };
  }
  /** Try to propose one connection; refuse synchronously when outside standing. */
  async tryProposeConnection(grantingTenantId, proposerUserId, receivingTenantId, channelId, channelName, permission = "read") {
    const proposal = newConnectionProposal(
      { grantingTenantId, receivingTenantId, channelId, channelName, permission, proposerUserId },
      this.deps.ids
    );
    const proposerCeiling = await this.memberAuthorityCeiling(
      grantingTenantId,
      proposerUserId,
      CONNECTION_STANDING_ACTION_TYPE
    );
    const orgEgress = await this.deps.policyStore.getTenantConnectionEgress(grantingTenantId);
    if (!proposerMayAuthorizeImmediately(proposal, proposerCeiling, orgEgress)) {
      await this.recordRefusal(grantingTenantId, "connection", [
        grantingTenantId,
        proposerUserId,
        channelName,
        receivingTenantId
      ]);
      const route = {
        proposalId: proposal.proposalId,
        status: ConnectionProposalStatus.Refused,
        escalationTargetUserId: null
      };
      await this.deps.policyStore.createConnectionRecord({
        proposal,
        status: route.status,
        escalationTargetUserId: null,
        authorized: null
      });
      return { proposal, route, authorized: null, refused: true };
    }
    return this.authorizeAndRecord(proposal, proposerUserId);
  }
  /** Escalate or block one pending connection proposal. */
  async routeConnectionProposal(grantingTenantId, proposalId) {
    const record = await this.deps.policyStore.getConnectionRecord(grantingTenantId, proposalId);
    if (record === null) {
      throw new Error(`Unknown connection proposal ${pythonRepr3(proposalId)}.`);
    }
    const proposal = record.proposal;
    const memberships = await this.deps.store.listMemberships(proposal.grantingTenantId);
    const memberUserIds = memberships.map((membership) => membership.userId);
    const targetUserId = await findEscalationTargetUserId(proposal, {
      memberUserIds,
      ceilingForMember: (userId) => this.memberAuthorityCeiling(proposal.grantingTenantId, userId, CONNECTION_STANDING_ACTION_TYPE)
    });
    const route = targetUserId === null ? { proposalId, status: ConnectionProposalStatus.Blocked, escalationTargetUserId: null } : {
      proposalId,
      status: ConnectionProposalStatus.PendingEscalation,
      escalationTargetUserId: targetUserId
    };
    await this.deps.policyStore.replaceConnectionRecord({
      proposal,
      status: route.status,
      escalationTargetUserId: route.escalationTargetUserId,
      authorized: record.authorized
    });
    return route;
  }
  /** Return every authorized connection clip one granting tenant holds. */
  async authorizedConnections(grantingTenantId) {
    const records = await this.deps.policyStore.listConnectionRecords(grantingTenantId);
    return records.flatMap((record) => record.authorized === null ? [] : [record.authorized]);
  }
  /** Return the routing outcome for one connection proposal. */
  async connectionRoute(grantingTenantId, proposalId) {
    const record = await this.deps.policyStore.getConnectionRecord(grantingTenantId, proposalId);
    if (record === null || record.status === null) {
      return null;
    }
    return { proposalId, status: record.status, escalationTargetUserId: record.escalationTargetUserId };
  }
  /** Record what one granting tenant permits to leave via connections. */
  async setTenantConnectionEgress(tenantId, options) {
    await this.deps.policyStore.putTenantConnectionEgress(
      tenantId,
      memberAuthorityCeilingFromStructuredArguments(CONNECTION_STANDING_ACTION_TYPE, options.arguments)
    );
  }
  /** Execute one human-approved connector operation at the sink. */
  async executeApprovedStructuredOperation(tenantId, turnId, approval, attempted, completionEvidence) {
    const memberStanding = await this.memberStandingForTurn(tenantId, turnId, attempted.actionType);
    return executeApprovedOperationAtSink(
      this.capabilityPolicyFor(tenantId, turnId),
      this.approvalBinding(tenantId),
      approval,
      attempted,
      completionEvidence,
      memberStanding
    );
  }
  /** Stop or pre-authorize a consequential action with no screen. */
  async resolveUnattendedGatedAction(actionType, tenantId, options) {
    const userId = options.userId ?? null;
    const turnId = options.turnId ?? POLICY_KERNEL_TURN;
    const memberStanding = userId !== null ? await this.memberStandingForUser(tenantId, userId, actionType) : await this.memberStandingForTurn(tenantId, turnId, actionType);
    return resolveUnattendedGatedActionAtSink(this.capabilityPolicyFor(tenantId, turnId), {
      actionType,
      arguments: options.arguments,
      channel: options.channel,
      rules: await this.deps.policyStore.listRules(tenantId),
      tenantId,
      memberStanding,
      userId,
      completionEvidence: options.completionEvidence ?? "system-accepted"
    });
  }
  /** Refuse unbound consequential browser actions. */
  attemptAuthenticatedBrowserAction(action, options = {}) {
    return attemptAuthenticatedBrowserActionAtSink(
      this.capabilityPolicyFor(options.tenantId ?? POLICY_KERNEL_TENANT, options.turnId ?? POLICY_KERNEL_TURN),
      action,
      {
        structuredConnector: options.structuredConnector ?? false,
        takeoverControl: options.takeoverControl ?? false
      }
    );
  }
  /** Resolve one member's standing at a sink; a tenant that is not an organization is the kernel-only owner. */
  async memberStandingForUser(tenantId, userId, actionType = null) {
    const organization = await this.deps.store.getOrganization(tenantId);
    if (organization === null) {
      return MemberStanding.owner();
    }
    const membership = await this.deps.store.getMembership(tenantId, userId);
    if (membership === null) {
      throw new MemberStandingRequiredError(
        `Member ${pythonRepr3(userId)} has no standing in tenant ${pythonRepr3(tenantId)}.`
      );
    }
    const perAction = actionType === null ? null : await this.memberAuthorityCeiling(tenantId, userId, actionType);
    return new MemberStanding(ceilingForMemberRole(membership.role), perAction);
  }
  /** Resolve the standing of the member who posted the turn prompt. */
  async memberStandingForTurn(tenantId, turnId, actionType = null) {
    const organization = await this.deps.store.getOrganization(tenantId);
    if (organization === null) {
      return MemberStanding.owner();
    }
    const resolver = this.deps.actingMemberUserIdForTurn;
    if (resolver === void 0) {
      throw new Error(`Turn ${pythonRepr3(turnId)} has no prompt message.`);
    }
    return this.memberStandingForUser(tenantId, await resolver(tenantId, turnId), actionType);
  }
  async authorizeAndRecord(proposal, proposerUserId) {
    const authorized = authorizeConnectionFromProposal(
      proposal,
      { clippedByUserId: proposerUserId, createdAt: this.deps.clock.now() },
      this.deps.ids
    );
    const route = {
      proposalId: proposal.proposalId,
      status: ConnectionProposalStatus.Authorized,
      escalationTargetUserId: null
    };
    await this.deps.policyStore.createConnectionRecord({
      proposal,
      status: route.status,
      escalationTargetUserId: null,
      authorized
    });
    return { proposal, route, authorized, refused: false };
  }
  async recordRefusal(tenantId, kind, fields) {
    await this.deps.policyStore.createRefusal({ refusalId: this.deps.ids.next(), tenantId, kind, fields });
  }
};
function pythonRepr3(value) {
  return `'${value}'`;
}

// conversation/src/policy/turn-grant.ts
async function turnCapabilityGrant(deps, tenantId, turnId) {
  return deps.turns.store.getGrant(tenantId, turnId);
}

// conversation/src/pi/mailbox.ts
import {
  ConditionalCheckFailedException as ConditionalCheckFailedException2,
  DeleteItemCommand,
  PutItemCommand as PutItemCommand2,
  QueryCommand as QueryCommand2,
  UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
var mailboxPartitionKey = (tenantId, botId, channelId) => `MB#${tenantId}#${botId}#${channelId}`;
var mailboxSortKey = (seq) => String(seq).padStart(10, "0");
async function allocateSeq(store, tenantId, channelId) {
  const result = await store.client.send(
    new UpdateItemCommand({
      TableName: store.tableName,
      Key: { pk: { S: `${tenantId}#channel#${channelId}` }, sk: { S: "meta" } },
      UpdateExpression: "SET next_seq = if_not_exists(next_seq, :one) + :one",
      ExpressionAttributeValues: { ":one": { N: "1" } },
      ReturnValues: "UPDATED_NEW"
    })
  );
  const updated = result.Attributes?.next_seq?.N;
  if (updated === void 0) throw new Error(`seq allocation returned no value for channel ${channelId}`);
  return Number(updated) - 1;
}
var mailboxItemAttributes = (item) => ({
  pk: { S: mailboxPartitionKey(item.tenantId, item.botId, item.channelId) },
  sk: { S: mailboxSortKey(item.seq) },
  tenant_id: { S: item.tenantId },
  bot_id: { S: item.botId },
  channel_id: { S: item.channelId },
  seq: { N: String(item.seq) },
  message_id: { S: item.messageId },
  author_kind: { S: item.authorKind },
  author_id: { S: item.authorId },
  addressed_to_bot_id: { S: item.addressedToBotId ?? "" },
  body: { S: item.body },
  created_at: { S: item.createdAt }
});
var MAILBOX_PUT_CONDITION = "attribute_not_exists(sk) OR message_id = :messageId";
async function put(store, item) {
  try {
    await store.client.send(
      new PutItemCommand2({
        TableName: store.tableName,
        Item: mailboxItemAttributes(item),
        ConditionExpression: MAILBOX_PUT_CONDITION,
        ExpressionAttributeValues: { ":messageId": { S: item.messageId } }
      })
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException2) {
      throw new Error(`mailbox seq ${item.seq} already holds a different message`, { cause: error });
    }
    throw error;
  }
}
async function list(store, tenantId, botId, channelId, afterSeq = 0) {
  const items = [];
  let startKey;
  do {
    const page2 = await store.client.send(
      new QueryCommand2({
        TableName: store.tableName,
        KeyConditionExpression: "pk = :pk AND sk > :after",
        ExpressionAttributeValues: {
          ":pk": { S: mailboxPartitionKey(tenantId, botId, channelId) },
          ":after": { S: mailboxSortKey(afterSeq) }
        },
        ConsistentRead: true,
        ExclusiveStartKey: startKey
      })
    );
    for (const raw of page2.Items ?? []) {
      const addressed = raw.addressed_to_bot_id?.S ?? "";
      items.push({
        tenantId,
        botId,
        channelId,
        seq: Number(raw.seq?.N),
        messageId: raw.message_id?.S ?? "",
        authorKind: raw.author_kind?.S ?? "",
        authorId: raw.author_id?.S ?? "",
        addressedToBotId: addressed === "" ? null : addressed,
        body: raw.body?.S ?? "",
        createdAt: raw.created_at?.S ?? ""
      });
    }
    startKey = page2.LastEvaluatedKey;
  } while (startKey !== void 0);
  return items;
}
async function remove(store, item) {
  await store.client.send(
    new DeleteItemCommand({
      TableName: store.tableName,
      Key: { pk: { S: mailboxPartitionKey(item.tenantId, item.botId, item.channelId) }, sk: { S: mailboxSortKey(item.seq) } }
    })
  );
}

// conversation/src/pi/session.ts
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";

// conversation/src/storage/indexed-storage.ts
import { randomUUID } from "node:crypto";
import {
  BatchGetItemCommand,
  GetItemCommand as GetItemCommand3,
  PutItemCommand as PutItemCommand3,
  QueryCommand as QueryCommand4,
  TransactWriteItemsCommand,
  UpdateItemCommand as UpdateItemCommand3
} from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, GetObjectCommand as GetObjectCommand2, PutObjectCommand as PutObjectCommand2 } from "@aws-sdk/client-s3";
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT2 } from "@earendil-works/chord/context";
import { applyImmutableBatches } from "@earendil-works/chord/delta";
import {
  StorageRejected
} from "@earendil-works/pi-durable";

// conversation/src/storage/snapshot-object.ts
import {
  GetItemCommand as GetItemCommand2,
  QueryCommand as QueryCommand3,
  UpdateItemCommand as UpdateItemCommand2
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
var SNAPSHOT_FORMAT = 1;
var SNAPSHOT_FETCH_CONCURRENCY = 16;
var commitSuffix = (seq, fence) => `${String(seq).padStart(12, "0")}-${String(fence).padStart(8, "0")}`;
async function readSnapshotReference(client, tableName, storageId) {
  const response = await client.send(
    new GetItemCommand2({
      TableName: tableName,
      Key: { pk: { S: `PI#${storageId}` }, sk: { S: "SNAPSHOT" } },
      ConsistentRead: true
    })
  );
  return response.Item === void 0 ? void 0 : { seq: number(response.Item, "seq"), fence: number(response.Item, "fence") };
}
async function readSnapshotObject(s3, bucket, storageId, reference) {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: snapshotKey(storageId, reference.seq, reference.fence) })
  );
  const snapshot = parse(await response.Body.transformToString());
  if (snapshot.format !== SNAPSHOT_FORMAT) throw new Error(`Unknown snapshot format ${String(snapshot.format)}`);
  return snapshot;
}
function unpackCommitObject(storageId, suffix, packed) {
  const parts = parseCommitKey(`/commits/${suffix}.json`);
  if (parts === void 0) throw new Error(`Malformed snapshot commit suffix ${suffix} for ${storageId}`);
  const writes = [];
  for (const [position, write] of Object.entries(packed)) writes[Number(position)] = write;
  return { seq: parts.seq, fence: parts.fence, token: "", writes };
}
async function queryAll(client, tableName, storageId, prefix, projection) {
  const items = [];
  let startKey;
  do {
    const response = await client.send(
      new QueryCommand3({
        TableName: tableName,
        ConsistentRead: true,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": { S: `PI#${storageId}` }, ":prefix": { S: prefix } },
        ProjectionExpression: projection,
        ExclusiveStartKey: startKey
      })
    );
    items.push(...response.Items ?? []);
    startKey = response.LastEvaluatedKey;
  } while (startKey !== void 0);
  return items;
}
async function referencedPointers(dependencies, storageId, throughSeq) {
  const pointers = [];
  const asPointer = (item) => ({
    seq: number(item, "c"),
    fence: number(item, "f"),
    position: number(item, "p")
  });
  const records = await queryAll(dependencies.client, dependencies.tableName, storageId, "R#", "t, c, f, p");
  for (const item of records) {
    const kind = text(item, "t");
    if (kind !== "entry" && kind !== "task" && kind !== "submission") continue;
    if (number(item, "c") > throughSeq) continue;
    pointers.push(asPointer(item));
  }
  const revisions = await queryAll(dependencies.client, dependencies.tableName, storageId, "V#", "sk, b, c, f, p");
  const byDocument = /* @__PURE__ */ new Map();
  for (const item of revisions) {
    if (number(item, "c") > throughSeq) continue;
    const document = text(item, "sk").split("#")[1];
    const list2 = byDocument.get(document) ?? [];
    list2.push(item);
    byDocument.set(document, list2);
  }
  for (const list2 of byDocument.values()) {
    let newestBase = list2.length - 1;
    while (newestBase > 0 && number(list2[newestBase], "b") !== 1) newestBase--;
    for (const item of list2.slice(newestBase)) pointers.push(asPointer(item));
  }
  return pointers;
}
async function mapWithConcurrency(values, limit, work) {
  const results = new Array(values.length);
  let next = 0;
  const lane = async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await work(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, lane));
  return results;
}
async function writeSnapshotObject(dependencies, storageId) {
  const { client, s3, tableName, bucket } = dependencies;
  const fence = dependencies.fence ?? 0;
  const metaResponse = await client.send(
    new GetItemCommand2({
      TableName: tableName,
      Key: { pk: { S: `PI#${storageId}` }, sk: { S: "META" } },
      ConsistentRead: true
    })
  );
  const throughSeq = metaResponse.Item === void 0 ? 0 : number(metaResponse.Item, "seq");
  const previous = await readSnapshotReference(client, tableName, storageId);
  if (throughSeq === 0 || previous !== void 0 && previous.seq >= throughSeq) {
    return { seq: previous?.seq ?? 0, written: false, commits: 0 };
  }
  const pointers = await referencedPointers(dependencies, storageId, throughSeq);
  const positionsByCommit = /* @__PURE__ */ new Map();
  for (const pointer of pointers) {
    const suffix = commitSuffix(pointer.seq, pointer.fence);
    const positions = positionsByCommit.get(suffix) ?? /* @__PURE__ */ new Set();
    positions.add(pointer.position);
    positionsByCommit.set(suffix, positions);
  }
  const earlier = previous === void 0 ? void 0 : await readSnapshotObject(s3, bucket, storageId, previous);
  const readCommitObject = dependencies.readCommitObject ?? (async (key) => {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return parse(await response.Body.transformToString());
  });
  const packed = await mapWithConcurrency([...positionsByCommit], SNAPSHOT_FETCH_CONCURRENCY, async ([suffix, positions]) => {
    const writes = {};
    const carried = earlier?.commits[suffix];
    const parts = parseCommitKey(`/commits/${suffix}.json`);
    const object = carried === void 0 ? await readCommitObject(commitKey(storageId, parts.seq, parts.fence)) : void 0;
    for (const position of positions) {
      const write = carried?.[String(position)] ?? object?.writes[position];
      if (write === void 0) throw new Error(`Commit ${suffix} of ${storageId} has no write at position ${position}`);
      writes[String(position)] = write;
    }
    return [suffix, writes];
  });
  const snapshot = {
    format: SNAPSHOT_FORMAT,
    seq: throughSeq,
    fence,
    commits: Object.fromEntries(packed)
  };
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: snapshotKey(storageId, throughSeq, fence),
        Body: encode(snapshot),
        ContentType: "application/json",
        IfNoneMatch: "*"
      })
    );
  } catch (error) {
    const status = error.$metadata?.httpStatusCode;
    if (status !== 412) throw error;
  }
  try {
    await client.send(
      new UpdateItemCommand2({
        TableName: tableName,
        Key: { pk: { S: `PI#${storageId}` }, sk: { S: "SNAPSHOT" } },
        UpdateExpression: "SET seq = :seq, fence = :fence",
        ConditionExpression: "attribute_not_exists(seq) OR seq < :seq",
        ExpressionAttributeValues: { ":seq": { N: String(throughSeq) }, ":fence": { N: String(fence) } }
      })
    );
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") {
      const newest = await readSnapshotReference(client, tableName, storageId);
      return { seq: newest?.seq ?? throughSeq, written: false, commits: 0 };
    }
    throw error;
  }
  return { seq: throughSeq, written: true, commits: packed.length };
}

// conversation/src/storage/indexed-storage.ts
var REVISION_PAGE_SIZE = 32;
var IndexedStorage = class _IndexedStorage {
  client;
  s3;
  tableName;
  bucket;
  storageId;
  pk;
  fence;
  commits;
  snapshotPolicy;
  seq = 0;
  nextId = 2;
  closed = false;
  snapshotReference;
  snapshotLoading;
  constructor(options) {
    this.client = options.client;
    this.s3 = options.s3;
    this.tableName = options.tableName;
    this.bucket = options.bucket;
    this.storageId = options.storageId;
    this.pk = `PI#${options.storageId}`;
    this.fence = options.fence;
    this.commits = options.commitCache ?? /* @__PURE__ */ new Map();
    this.snapshotPolicy = options.snapshotPolicy ?? {};
  }
  /**
   * Open (and on first use create) one storage and load its commit sequence and ID high-water mark.
   *
   * @param options Storage options.
   * @returns The open storage.
   */
  static async open(options) {
    const storage = new _IndexedStorage(options);
    await storage.load();
    return storage;
  }
  /**
   * Raise the partition's owner fence. An owner may claim its own fence again; a strictly newer fence held by
   * another owner throws `OwnershipLost`.
   *
   * @param options Client, table, partition, and the new fence.
   */
  static async claimOwnership(options) {
    try {
      await options.client.send(
        new UpdateItemCommand3({
          TableName: options.tableName,
          Key: { pk: { S: `PI#${options.storageId}` }, sk: { S: "OWNER" } },
          UpdateExpression: "SET fence = :fence",
          ConditionExpression: "attribute_not_exists(fence) OR fence <= :fence",
          ExpressionAttributeValues: { ":fence": { N: String(options.fence) } }
        })
      );
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") {
        throw new OwnershipLost("Owner fence moved: a newer owner holds this storage", { cause: error });
      }
      throw error;
    }
  }
  /**
   * Allocate the next owner fence for a partition: one `UpdateItem` on its OWNER item that adds one to the current
   * fence (starting from 0). It is called after the turn has been claimed, so a duplicate delivery cannot raise the
   * fence under a live owner, and it fences out any earlier owner.
   *
   * @param client DynamoDB client.
   * @param tableName Pi session table.
   * @param storageId Partition identity, `tenant#bot#channel`.
   * @returns The newly allocated fence.
   */
  static async allocateFence(client, tableName, storageId) {
    const result = await client.send(
      new UpdateItemCommand3({
        TableName: tableName,
        Key: { pk: { S: `PI#${storageId}` }, sk: { S: "OWNER" } },
        UpdateExpression: "SET fence = if_not_exists(fence, :zero) + :one",
        ExpressionAttributeValues: { ":zero": { N: "0" }, ":one": { N: "1" } },
        ReturnValues: "UPDATED_NEW"
      })
    );
    const allocated = result.Attributes?.fence?.N;
    if (allocated === void 0) throw new Error(`Fence allocation returned no fence for ${storageId}`);
    return Number(allocated);
  }
  /**
   * Open a storage that must already exist, without writing anything. A reader that holds no write permission uses
   * this: a session nobody has created yet is simply absent, which is not an error and must not create it.
   *
   * @param options Storage options.
   * @returns The open storage, or `undefined` when no session exists for the storage identity.
   */
  static async openExisting(options) {
    const storage = new _IndexedStorage(options);
    return await storage.loadExisting() ? storage : void 0;
  }
  async loadExisting() {
    const [meta, snapshotReference] = await Promise.all([
      this.getItem("META"),
      readSnapshotReference(this.client, this.tableName, this.storageId)
    ]);
    if (meta === void 0) return false;
    this.snapshotReference = snapshotReference;
    this.seq = number(meta, "seq");
    this.nextId = number(meta, "nextId");
    return true;
  }
  async load() {
    if (await this.loadExisting()) return;
    try {
      await this.client.send(
        new PutItemCommand3({
          TableName: this.tableName,
          Item: { pk: { S: this.pk }, sk: { S: "META" }, seq: { N: "0" }, nextId: { N: "2" } },
          ConditionExpression: "attribute_not_exists(pk)"
        })
      );
    } catch (error) {
      if (error.name !== "ConditionalCheckFailedException") throw error;
      await this.load();
    }
  }
  async commit(writes, _context) {
    this.assertOpen();
    const seq = this.seq + 1;
    const fence = this.fence ?? 0;
    let objectWritten = false;
    const key = commitKey(this.storageId, seq, fence);
    try {
      const detached = parse(encode(writes));
      const resolved = await this.resolveDocumentCopies(detached);
      this.checkBatchIds(resolved);
      const actions = this.prepareDocumentActions(resolved);
      const existingDocuments = await this.checkDocumentActions(actions);
      const token = randomUUID();
      const plan = this.planTransaction(resolved, actions, existingDocuments, seq, fence, token);
      if (plan.items.length > TRANSACTION_ITEM_LIMIT) {
        throw new StorageRejected(
          `Commit needs ${plan.items.length} transaction items; DynamoDB allows ${TRANSACTION_ITEM_LIMIT}`
        );
      }
      const object = { seq, fence, token, writes: resolved };
      const body = encode(object);
      await this.putCommitObject(key, seq, body, token);
      objectWritten = true;
      await this.transact(plan.items, token);
      this.commits.set(key, Promise.resolve(parse(body)));
      this.seq = seq;
      this.nextId = Math.max(this.nextId, plan.highestId + 1);
      await this.snapshotIfDue(false);
      return seq;
    } catch (error) {
      const outcomeUnknown = error instanceof CommitOutcomeUnknown;
      if (objectWritten && !outcomeUnknown && (error instanceof StorageRejected || error instanceof OwnershipLost)) {
        await this.deleteOrphan(key);
      }
      throw error;
    }
  }
  /**
   * Write the commit object without ever overwriting a key. A key is only ever written by this owner (its fence is
   * in the key), so an existing object is either this commit's own earlier attempt (same token: keep it) or this
   * owner's orphan from a commit whose transaction failed (replace it, but only after reading META and finding that
   * the sequence is not committed: an object at or below META.seq is committed data and is never deleted). A 409
   * ConditionalRequestConflict means a concurrent write to the same key is still in flight, which with the fence in
   * the key can only be this owner's own earlier attempt; it is transient, so it is retried with backoff and the
   * next attempt resolves to a 412 with the same token or a successful write.
   */
  async putCommitObject(key, seq, body, token) {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.s3.send(
          new PutObjectCommand2({
            Bucket: this.bucket,
            Key: key,
            Body: body,
            ContentType: "application/json",
            IfNoneMatch: "*"
          })
        );
        return;
      } catch (error) {
        const status = error.$metadata?.httpStatusCode;
        if (status === 412 && attempt < 3) {
          const existing = await this.fetchCommit(key, false);
          if (existing.token === token) return;
          const meta = await this.getItem("META");
          const committedSeq = meta === void 0 ? 0 : number(meta, "seq");
          if (committedSeq >= seq) {
            throw new OwnershipLost(`Object ${key} belongs to an already committed sequence; refusing to replace it`, {
              cause: error
            });
          }
          await this.deleteOrphan(key);
          continue;
        }
        if (status === 409 && attempt < TRANSACTION_ATTEMPTS) {
          await backoff(attempt);
          continue;
        }
        if (RETRYABLE_ERRORS.has(error.name) && attempt < TRANSACTION_ATTEMPTS) {
          await backoff(attempt);
          continue;
        }
        throw error;
      }
    }
  }
  async deleteOrphan(key) {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      process.stderr.write(`[indexed-storage] orphan ${key} left for the sweeper: ${error.message}
`);
    }
  }
  /**
   * Send the index transaction, retrying transient failures with the same `ClientRequestToken`, which is also
   * written to `META` so a lost response can be resolved by reading `META` and comparing tokens.
   */
  async transact(entries, token) {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.client.send(
          new TransactWriteItemsCommand({
            TransactItems: entries.map((entry) => entry.request),
            ClientRequestToken: token
          })
        );
        return attempt;
      } catch (error) {
        const name = error.name;
        const code = error.code;
        if (name !== "TransactionCanceledException") {
          const retryable = RETRYABLE_ERRORS.has(name) || code !== void 0 && RETRYABLE_ERRORS.has(code);
          if (retryable && attempt < TRANSACTION_ATTEMPTS) {
            await backoff(attempt);
            continue;
          }
          const state = await this.committedWithToken(token);
          if (state === "committed") return attempt;
          if (state === "unknown") {
            throw new CommitOutcomeUnknown("Commit outcome unknown: the response was lost and the check failed", {
              cause: error
            });
          }
          throw error;
        }
        const reasons = error.CancellationReasons ?? [];
        const conditionFailures = entries.filter((_, index) => reasons[index]?.Code === "ConditionalCheckFailed");
        if (conditionFailures.some((entry) => entry.role === "owner")) {
          throw new OwnershipLost("Owner fence moved: this owner is stale", { cause: error });
        }
        if (conditionFailures.some((entry) => entry.role === "meta")) {
          const state = await this.committedWithToken(token);
          if (state === "committed") return attempt;
          if (state === "unknown") {
            throw new CommitOutcomeUnknown("Commit outcome unknown: the sequence check failed and the token read failed", {
              cause: error
            });
          }
          throw new OwnershipLost("Commit sequence moved: another owner committed to this storage", {
            cause: error
          });
        }
        const recordFailure = conditionFailures.find((entry) => entry.role === "record" && entry.id !== void 0);
        if (recordFailure !== void 0) {
          const existing = await this.getItem(`R#${pad(recordFailure.id)}`);
          const table = existing === void 0 ? "another record" : text(existing, "t");
          throw new StorageRejected(`ID ${recordFailure.id} already belongs to ${table}`, { cause: error });
        }
        const transient = reasons.some((reason) => reason.Code !== void 0 && TRANSIENT_CANCELLATIONS.has(reason.Code));
        if (transient && attempt < TRANSACTION_ATTEMPTS) {
          await backoff(attempt);
          continue;
        }
        if (transient) {
          throw new OwnershipLost(`Transaction kept conflicting after ${attempt} attempts`, { cause: error });
        }
        throw new StorageRejected(`Transaction was cancelled: ${error.message}`, { cause: error });
      }
    }
  }
  async committedWithToken(token) {
    try {
      const meta = await this.getItem("META");
      return meta !== void 0 && text(meta, "token") === token ? "committed" : "not-committed";
    } catch {
      return "unknown";
    }
  }
  planTransaction(writes, actions, existingDocuments, seq, fence, token) {
    const items = [];
    let highestId = 0;
    const lastRecordWrite = /* @__PURE__ */ new Map();
    writes.forEach((write, position) => {
      if (write.type === "conversation" || write.type === "entry" || write.type === "task" || write.type === "submission") {
        lastRecordWrite.set(write.value.id, { write, position });
      }
    });
    const pointer = (position) => ({
      c: { N: String(seq) },
      f: { N: String(fence) },
      p: { N: String(position) }
    });
    for (const { write, position } of lastRecordWrite.values()) {
      highestId = Math.max(highestId, write.value.id);
      const once = write.type === "conversation" || write.type === "entry";
      items.push(
        this.planned("record", write.value.id, {
          Put: {
            TableName: this.tableName,
            Item: { ...this.recordItem(write), ...pointer(position) },
            ConditionExpression: once ? "attribute_not_exists(pk)" : "attribute_not_exists(pk) OR t = :t",
            ...once ? {} : { ExpressionAttributeValues: { ":t": { S: write.type } } }
          }
        })
      );
    }
    for (const [id, action] of actions) {
      highestId = Math.max(highestId, id);
      const existing = existingDocuments.get(id);
      const baseRecord = action.create !== void 0 ? { ...action.create, createdAt: seq } : existing.record;
      const record = action.retire ? { ...baseRecord, retiredAt: seq } : baseRecord;
      const currentOnly = isCurrentOnly(record);
      const writesRevision = action.content !== void 0 && !(action.retire && currentOnly);
      const item = {
        pk: { S: this.pk },
        sk: { S: `R#${pad(id)}` },
        t: { S: "document" },
        v: { S: encode(record) },
        l1: { S: `D#${digest(scopeKey(record.scope))}#${pad(id)}` },
        l2: { S: `DA#${digest(recordAddressKey(record))}#${pad(id)}` }
      };
      const latestVersion = writesRevision ? action.content.version : existing?.latestVersion;
      if (latestVersion !== void 0) item.ver = { N: String(latestVersion) };
      const latestSeq = writesRevision ? seq : existing?.latestSeq;
      if (latestSeq !== void 0) item.last = { N: String(latestSeq) };
      items.push(
        this.planned("record", id, {
          Put: {
            TableName: this.tableName,
            Item: item,
            ConditionExpression: action.create !== void 0 ? "attribute_not_exists(pk)" : "attribute_exists(pk) AND t = :t",
            ...action.create !== void 0 ? {} : { ExpressionAttributeValues: { ":t": { S: "document" } } }
          }
        })
      );
      if (writesRevision) {
        items.push(
          this.planned("revision", id, {
            Put: {
              TableName: this.tableName,
              Item: {
                pk: { S: this.pk },
                sk: { S: `V#${pad(id)}#${pad(seq)}` },
                b: { N: action.content.kind === "base" ? "1" : "0" },
                ...pointer(action.position)
              }
            }
          })
        );
      }
    }
    items.push(
      this.planned("meta", void 0, {
        Update: {
          TableName: this.tableName,
          Key: { pk: { S: this.pk }, sk: { S: "META" } },
          UpdateExpression: "SET seq = :seq, nextId = :nextId, #token = :token",
          ExpressionAttributeNames: { "#token": "token" },
          ConditionExpression: "seq = :expected",
          ExpressionAttributeValues: {
            ":expected": { N: String(this.seq) },
            ":seq": { N: String(seq) },
            ":nextId": { N: String(Math.max(this.nextId, highestId + 1)) },
            ":token": { S: token }
          }
        }
      })
    );
    if (this.fence !== void 0) {
      items.push(
        this.planned("owner", void 0, {
          ConditionCheck: {
            TableName: this.tableName,
            Key: { pk: { S: this.pk }, sk: { S: "OWNER" } },
            ConditionExpression: "fence = :fence",
            ExpressionAttributeValues: { ":fence": { N: String(this.fence) } }
          }
        })
      );
    }
    return { items, highestId };
  }
  planned(role, id, request) {
    return { role, id, request };
  }
  recordItem(write) {
    const id = write.value.id;
    const item = { pk: { S: this.pk }, sk: { S: `R#${pad(id)}` }, t: { S: write.type } };
    switch (write.type) {
      case "conversation": {
        item.v = { S: encode(write.value) };
        item.l1 = { S: `C#${pad(id)}` };
        const owner = write.value.owner;
        if (owner !== void 0) {
          item.l2 = { S: `CT#${pad(owner.taskId)}#${pad(id)}` };
          item.l3 = { S: `CC#${pad(owner.conversationId)}#${pad(id)}` };
        }
        break;
      }
      case "entry":
        item.cv = { N: String(write.value.conversationId) };
        item.l1 = { S: `E#${pad(write.value.conversationId)}#${pad(id)}` };
        if (write.value.head !== void 0) item.l2 = { S: `H#${pad(write.value.conversationId)}#${pad(id)}` };
        break;
      case "task":
        item.cv = { N: String(write.value.conversationId) };
        item.k = { S: encode(write.value.kind) };
        item.ab = { N: write.value.abortRequested ? "1" : "0" };
        item.bg = { N: write.value.background ? "1" : "0" };
        item.l1 = { S: `T#${pad(id)}` };
        item.l2 = { S: `TS#${write.value.state.status}#${pad(id)}` };
        break;
      case "submission":
        item.cv = { N: String(write.value.conversationId) };
        item.l1 = { S: `S#${pad(id)}` };
        item.l2 = { S: `SS#${write.value.status}#${pad(id)}` };
        if (write.value.requestId !== void 0) {
          item.l3 = {
            S: `SR#${pad(write.value.conversationId)}#${digest(encode(write.value.requestId))}#${pad(id)}`
          };
        }
        break;
    }
    return item;
  }
  async resolveDocumentCopies(writes) {
    if (!writes.some((write) => write.type === "document.copy")) return writes;
    const changed = /* @__PURE__ */ new Set();
    for (const write of writes) {
      if (write.type === "document.create" || write.type === "document.copy") changed.add(write.record.id);
      else if (write.type === "document.change" || write.type === "document.retire") changed.add(write.id);
    }
    const resolved = [];
    for (const write of writes) {
      if (write.type !== "document.copy") {
        resolved.push(write);
        continue;
      }
      try {
        if (changed.has(write.source.id)) {
          throw new Error(`Fork source document ${write.source.id} is changed in the copy batch`);
        }
        const stored = await this.materialize(write.source.id, write.source.at);
        if (stored === void 0) throw new Error(`Fork source document ${write.source.id} cannot be read`);
        if (stored.record.scope.kind !== "conversation" || write.record.scope.kind !== "conversation" || stored.record.kind !== write.record.kind || stored.record.key !== write.record.key || stored.record.history !== write.record.history || stored.record.fork !== write.record.fork) {
          throw new Error(`Fork source document ${write.source.id} does not match the copied record`);
        }
        resolved.push({
          type: "document.create",
          record: write.record,
          content: { kind: "base", version: stored.version, value: stored.value }
        });
      } catch (error) {
        if (error instanceof StorageRejected) throw error;
        throw new StorageRejected(`Document copy ${write.record.id} was rejected`, { cause: error });
      }
    }
    return resolved;
  }
  checkBatchIds(writes) {
    const claimed = /* @__PURE__ */ new Map();
    for (const write of writes) {
      if (write.type === "document.change" || write.type === "document.retire") continue;
      const document = write.type === "document.create" || write.type === "document.copy";
      const table = document ? "document" : write.type;
      const id = document ? write.record.id : write.value.id;
      const earlier = claimed.get(id);
      if (table === "conversation" || table === "entry" || table === "document") {
        if (earlier !== void 0) throw new Error(`ID ${id} is written more than once`);
      } else if (earlier !== void 0 && earlier !== table) {
        throw new Error(`ID ${id} is written as two record types`);
      }
      claimed.set(id, table);
    }
  }
  prepareDocumentActions(writes) {
    const actions = /* @__PURE__ */ new Map();
    writes.forEach((write, position) => {
      if (write.type !== "document.create" && write.type !== "document.change" && write.type !== "document.retire") {
        return;
      }
      const id = write.type === "document.create" ? write.record.id : write.id;
      let action = actions.get(id);
      if (action === void 0) {
        action = { retire: false };
        actions.set(id, action);
      }
      switch (write.type) {
        case "document.create":
          if (action.create !== void 0 || action.content !== void 0) {
            throw new Error(`Document ${id} has more than one content command`);
          }
          action.create = write.record;
          action.content = write.content;
          action.position = position;
          break;
        case "document.change":
          if (action.content !== void 0) throw new Error(`Document ${id} has more than one content command`);
          action.content = write.content;
          action.position = position;
          break;
        case "document.retire":
          if (action.retire) throw new Error(`Document ${id} is retired more than once`);
          action.retire = true;
          break;
      }
    });
    return actions;
  }
  async checkDocumentActions(actions) {
    const existingDocuments = /* @__PURE__ */ new Map();
    if (actions.size === 0) return existingDocuments;
    const items = await this.batchGet([...actions.keys()].map((id) => `R#${pad(id)}`));
    for (const [id, action] of actions) {
      const item = items.get(`R#${pad(id)}`);
      const table = item === void 0 ? void 0 : text(item, "t");
      if (action.create !== void 0 && item !== void 0) {
        if (table !== "document") throw new Error(`ID ${id} already belongs to ${table}`);
        throw new Error(`Document ${id} already exists`);
      }
      if (action.create === void 0 && (item === void 0 || table !== "document")) {
        throw new Error(`Unknown document: ${id}`);
      }
      if (item !== void 0) {
        existingDocuments.set(id, {
          record: parse(text(item, "v")),
          latestVersion: number(item, "ver"),
          latestSeq: number(item, "last")
        });
      }
    }
    const liveCounts = /* @__PURE__ */ new Map();
    for (const [id, action] of actions) {
      const existing = existingDocuments.get(id);
      if (existing?.record.retiredAt !== void 0) throw new Error(`Document ${id} is retired`);
      if (action.content?.kind === "delta") {
        if (existing?.latestVersion === void 0) throw new Error(`Document ${id} delta has no base`);
        if (existing.latestVersion !== action.content.version) {
          throw new Error(`Document ${id} version transition requires a base`);
        }
      }
      const address = action.create !== void 0 ? action.create : existing.record;
      const key = recordAddressKey(address);
      let live = liveCounts.get(key);
      const currentId = live === void 0 || action.retire ? (await this.findDocument(
        { kind: address.kind, scope: address.scope, key: address.key },
        "current",
        BACKGROUND_CONTEXT2
      ))?.id : void 0;
      if (live === void 0) live = currentId === void 0 ? 0 : 1;
      if (action.retire && currentId === id) live--;
      if (action.create !== void 0 && !action.retire) live++;
      liveCounts.set(key, live);
    }
    for (const live of liveCounts.values()) {
      if (live > 1) throw new Error("Document address already has a current incarnation");
    }
    return existingDocuments;
  }
  async mintId() {
    this.assertOpen();
    if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
    return this.nextId++;
  }
  async conversation(id, _context) {
    this.assertOpen();
    const item = await this.getItem(`R#${pad(id)}`);
    return item === void 0 || text(item, "t") !== "conversation" ? void 0 : parse(text(item, "v"));
  }
  async scanConversations(query, limit, cursor, _context) {
    this.assertOpen();
    const [index, prefix] = query.ownerTaskId !== void 0 ? ["l2", `CT#${pad(query.ownerTaskId)}#`] : query.ownerConversationId !== void 0 ? ["l3", `CC#${pad(query.ownerConversationId)}#`] : ["l1", "C#"];
    const items = await this.scanIndex(index, prefix, cursorAfter(cursor), limit, (item) => {
      const value = parse(text(item, "v"));
      return query.ownerConversationId === void 0 || value.owner?.conversationId === query.ownerConversationId;
    });
    return page(
      items.map((item) => parse(text(item, "v"))),
      limit
    );
  }
  async entry(idOrConversationId, idOrContext, context) {
    this.assertOpen();
    if (context === void 0) return this.readEntry(idOrConversationId);
    if (typeof idOrContext !== "number") throw new TypeError("Storage.entry() requires an entry ID");
    let current = await this.requireConversation(idOrConversationId);
    const item = await this.getItem(`R#${pad(idOrContext)}`);
    if (item === void 0 || text(item, "t") !== "entry") return void 0;
    const entryConversation = number(item, "cv");
    let upper = Number.POSITIVE_INFINITY;
    while (true) {
      if (entryConversation === current.id) {
        if (idOrContext > upper) return void 0;
        return { entry: await this.resolve(item), commitSeq: number(item, "c") };
      }
      if (current.parent === void 0) return void 0;
      upper = Math.min(upper, current.parent.at);
      current = await this.requireConversation(current.parent.conversationId);
    }
  }
  async findLatestHeadMarker(conversationId, atOrBeforeEntryId, _context) {
    this.assertOpen();
    let current = await this.requireConversation(conversationId);
    let upper = atOrBeforeEntryId ?? Number.POSITIVE_INFINITY;
    while (true) {
      const high = Number.isFinite(upper) ? `H#${pad(current.id)}#${pad(upper)}` : `H#${pad(current.id)}#~`;
      for await (const items of this.pages("l2", `H#${pad(current.id)}#`, high, false, 1)) {
        if (items.length === 0) continue;
        const entry = await this.resolve(items[0]);
        return { ...entry, head: entry.head };
      }
      if (current.parent === void 0) return void 0;
      upper = Math.min(upper, current.parent.at);
      current = await this.requireConversation(current.parent.conversationId);
    }
  }
  async scanEntries(query, limit, cursor, _context) {
    this.assertOpen();
    const after = cursorAfter(cursor);
    const maxEntryId = after === void 0 ? query.maxEntryId : Math.min(query.maxEntryId ?? Number.POSITIVE_INFINITY, after - 1);
    const minEntryId = query.minEntryId ?? Number.NEGATIVE_INFINITY;
    const visible = [];
    let current = await this.requireConversation(query.conversationId);
    let upper = maxEntryId ?? Number.POSITIVE_INFINITY;
    outer: while (true) {
      const prefix = `E#${pad(current.id)}#`;
      const low = Number.isFinite(minEntryId) && minEntryId > 0 ? `${prefix}${pad(minEntryId)}` : prefix;
      const high = Number.isFinite(upper) ? `${prefix}${pad(upper)}` : `${prefix}~`;
      if (!(Number.isFinite(upper) && upper < 0)) {
        for await (const items of this.pages("l1", low, high, false, Math.min(limit + 1, 100))) {
          for (const item of items) {
            visible.push(item);
            if (visible.length > limit) break outer;
          }
        }
      }
      if (current.parent === void 0) break;
      upper = Math.min(upper, current.parent.at);
      if (upper < minEntryId) break;
      current = await this.requireConversation(current.parent.conversationId);
    }
    return page(await Promise.all(visible.map((item) => this.resolve(item))), limit);
  }
  async task(id, _context) {
    this.assertOpen();
    return this.readRecord(id, "task");
  }
  async scanTasks(query, limit, cursor, _context) {
    this.assertOpen();
    const [index, prefix] = query.status === void 0 ? ["l1", "T#"] : ["l2", `TS#${query.status}#`];
    const kind = query.kind === void 0 ? void 0 : encode(query.kind);
    const items = await this.scanIndex(
      index,
      prefix,
      cursorAfter(cursor),
      limit,
      (item) => (query.conversationId === void 0 || number(item, "cv") === query.conversationId) && (kind === void 0 || text(item, "k") === kind) && (query.abortRequested === void 0 || number(item, "ab") === 1 === query.abortRequested) && (query.background === void 0 || number(item, "bg") === 1 === query.background)
    );
    return page(await Promise.all(items.map((item) => this.resolve(item))), limit);
  }
  async submission(id, _context) {
    this.assertOpen();
    return this.readRecord(id, "submission");
  }
  async scanSubmissions(query, limit, cursor, _context) {
    this.assertOpen();
    const [index, prefix] = query.status === void 0 ? ["l1", "S#"] : ["l2", `SS#${query.status}#`];
    const items = await this.scanIndex(
      index,
      prefix,
      cursorAfter(cursor),
      limit,
      (item) => query.conversationId === void 0 || number(item, "cv") === query.conversationId
    );
    return page(await Promise.all(items.map((item) => this.resolve(item))), limit);
  }
  async submissionByRequest(conversationId, requestId, _context) {
    this.assertOpen();
    const prefix = `SR#${pad(conversationId)}#${digest(encode(requestId))}#`;
    for await (const items of this.pages("l3", prefix, `${prefix}~`, false)) {
      for (const item of items) {
        const value = await this.resolve(item);
        if (value.requestId === requestId && value.conversationId === conversationId) return value;
      }
    }
    return void 0;
  }
  async findDocument(address, at, _context) {
    this.assertOpen();
    const key = addressKey(address);
    const prefix = `DA#${digest(key)}#`;
    for await (const items of this.pages("l2", prefix, `${prefix}~`, true)) {
      for (const item of items) {
        const record = parse(text(item, "v"));
        if (recordAddressKey(record) !== key) continue;
        if (isAliveAt(record, at)) return record;
      }
    }
    return void 0;
  }
  async document(id, at, _context) {
    this.assertOpen();
    return this.materialize(id, at);
  }
  async scanDocuments(query, limit, cursor, _context) {
    this.assertOpen();
    const scope = scopeKey(query.scope);
    const items = await this.scanIndex("l1", `D#${digest(scope)}#`, cursorAfter(cursor), limit, (item) => {
      const record = parse(text(item, "v"));
      return scopeKey(record.scope) === scope && (query.kind === void 0 || record.kind === query.kind) && isAliveAt(record, query.at);
    });
    return page(
      items.map((item) => parse(text(item, "v"))),
      limit
    );
  }
  async close(_context) {
    if (this.closed) return;
    await this.snapshotIfDue(true);
    this.closed = true;
  }
  /**
   * Write a snapshot object when the policy says one is due. A failed snapshot never fails the commit or the close:
   * the commit objects it would pack are still there, so the only cost is a slower cold open.
   */
  async snapshotIfDue(closing) {
    const sinceSnapshot = this.seq - (this.snapshotReference?.seq ?? 0);
    const due = sinceSnapshot > 0 && (closing && this.snapshotPolicy.atClose === true || this.snapshotPolicy.everyCommits !== void 0 && sinceSnapshot >= this.snapshotPolicy.everyCommits);
    if (!due) return;
    try {
      const result = await writeSnapshotObject(
        {
          client: this.client,
          s3: this.s3,
          tableName: this.tableName,
          bucket: this.bucket,
          fence: this.fence,
          readCommitObject: (key) => this.fetchCommit(key, true)
        },
        this.storageId
      );
      const newest = await readSnapshotReference(this.client, this.tableName, this.storageId);
      if (newest !== void 0 && newest.seq !== this.snapshotReference?.seq) {
        this.snapshotReference = newest;
        this.snapshotLoading = void 0;
      }
    } catch (error) {
      process.stderr.write(`[indexed-storage] snapshot for ${this.storageId} skipped: ${error.message}
`);
    }
  }
  /**
   * Materialize one document at a point: the revision index from the pinned seq (the record's latest revision for a
   * current read) down to the newest base, then the referenced commit objects fetched in parallel. Nothing is ever
   * deleted, so this is a consistent point-in-time read.
   */
  async materialize(id, at) {
    const item = await this.getItem(`R#${pad(id)}`);
    if (item === void 0 || text(item, "t") !== "document") return void 0;
    const record = parse(text(item, "v"));
    if (at !== "current" && isCurrentOnly(record)) {
      throw new Error(`Document ${id} does not retain historical content`);
    }
    if (!isAliveAt(record, at)) return void 0;
    const pinned = at === "current" ? number(item, "last") : at;
    const high = pinned === void 0 ? `V#${pad(id)}#~` : `V#${pad(id)}#${pad(pinned)}`;
    const newestFirst = [];
    outer: for await (const items of this.pages(void 0, `V#${pad(id)}#`, high, false, REVISION_PAGE_SIZE)) {
      for (const revision of items) {
        newestFirst.push(revision);
        if (number(revision, "b") === 1) break outer;
      }
    }
    if (newestFirst.length === 0 || number(newestFirst.at(-1), "b") !== 1) {
      throw new Error(`Document ${id} is missing a required base`);
    }
    const contents = await Promise.all(
      newestFirst.reverse().map(async (revision) => {
        const object = await this.fetchCommit(this.keyOf(revision), true);
        const write = object.writes[number(revision, "p")];
        return write.content;
      })
    );
    const base = contents[0];
    if (base.kind !== "base") throw new Error(`Document ${id} is missing a required base`);
    const deltas = contents.slice(1);
    const batches = function* () {
      for (const revision of deltas) {
        if (revision.kind !== "delta" || revision.version !== base.version) {
          throw new Error(`Document ${id} crosses a stored version boundary without a base`);
        }
        yield revision.ops;
      }
    };
    const value = applyImmutableBatches(base.value, batches());
    return { record, version: base.version, value: parse(encode(value)), deltasSinceBase: deltas.length };
  }
  keyOf(item) {
    return commitKey(this.storageId, number(item, "c"), number(item, "f"));
  }
  async resolve(item) {
    const object = await this.fetchCommit(this.keyOf(item), true);
    const write = object.writes[number(item, "p")];
    return parse(encode(write.value));
  }
  /**
   * Fetch one immutable commit object, cached for the life of this owner. Objects never change, so the cache
   * needs no invalidation.
   */
  fetchCommit(key, cache) {
    const cached = this.commits.get(key);
    if (cached !== void 0) return cached;
    const loading = (async () => {
      const packed = await this.readFromSnapshot(key);
      if (packed !== void 0) return packed;
      const response = await this.s3.send(new GetObjectCommand2({ Bucket: this.bucket, Key: key }));
      return parse(await response.Body.transformToString());
    })();
    if (cache) {
      this.commits.set(key, loading);
      loading.catch(() => this.commits.delete(key));
    }
    return loading;
  }
  /**
   * Answer a commit object read from the snapshot this storage was opened with, when the key is at or below the
   * snapshot's sequence and the snapshot carries it. The snapshot object is fetched once, on the first such read, so
   * opening a storage still costs no S3 GET. A missing or unreadable snapshot degrades to reading commit objects.
   */
  async readFromSnapshot(key) {
    const reference = this.snapshotReference;
    const parts = parseCommitKey(key);
    if (reference === void 0 || parts === void 0 || parts.seq > reference.seq) return void 0;
    this.snapshotLoading ??= readSnapshotObject(this.s3, this.bucket, this.storageId, reference).catch((error) => {
      process.stderr.write(`[indexed-storage] snapshot ${reference.seq} of ${this.storageId} unreadable: ${error.message}
`);
      return void 0;
    });
    const snapshot = await this.snapshotLoading;
    const suffix = key.slice(key.lastIndexOf("/") + 1, -".json".length);
    const packed = snapshot?.commits[suffix];
    return packed === void 0 ? void 0 : unpackCommitObject(this.storageId, suffix, packed);
  }
  async readRecord(id, table) {
    const item = await this.getItem(`R#${pad(id)}`);
    if (item === void 0 || text(item, "t") !== table) return void 0;
    return this.resolve(item);
  }
  async readEntry(id) {
    const item = await this.getItem(`R#${pad(id)}`);
    if (item === void 0 || text(item, "t") !== "entry") return void 0;
    return { entry: await this.resolve(item), commitSeq: number(item, "c") };
  }
  async requireConversation(id) {
    const item = await this.getItem(`R#${pad(id)}`);
    if (item === void 0 || text(item, "t") !== "conversation") throw new Error(`Unknown conversation: ${id}`);
    return parse(text(item, "v"));
  }
  async scanIndex(index, prefix, after, limit, accept) {
    const low = after === void 0 ? prefix : `${prefix}${pad(after + 1)}`;
    const accepted = [];
    for await (const items of this.pages(index, low, `${prefix}~`, true)) {
      for (const item of items) {
        if (!accept(item)) continue;
        accepted.push(item);
        if (accepted.length > limit) return accepted;
      }
    }
    return accepted;
  }
  async *pages(index, low, high, forward, pageSize = 100) {
    const keyName = index ?? "sk";
    let startKey;
    do {
      const response = await this.client.send(
        new QueryCommand4({
          TableName: this.tableName,
          IndexName: index === void 0 ? void 0 : `${index}-index`,
          ConsistentRead: true,
          KeyConditionExpression: "pk = :pk AND #k BETWEEN :low AND :high",
          ExpressionAttributeNames: { "#k": keyName },
          ExpressionAttributeValues: { ":pk": { S: this.pk }, ":low": { S: low }, ":high": { S: high } },
          ScanIndexForward: forward,
          Limit: pageSize,
          ExclusiveStartKey: startKey
        })
      );
      yield response.Items ?? [];
      startKey = response.LastEvaluatedKey;
    } while (startKey !== void 0);
  }
  async getItem(sk) {
    const response = await this.client.send(
      new GetItemCommand3({ TableName: this.tableName, Key: { pk: { S: this.pk }, sk: { S: sk } }, ConsistentRead: true })
    );
    return response.Item;
  }
  async batchGet(sortKeys) {
    const found = /* @__PURE__ */ new Map();
    for (let index = 0; index < sortKeys.length; index += 100) {
      let keys = sortKeys.slice(index, index + 100).map((sk) => ({ pk: { S: this.pk }, sk: { S: sk } }));
      for (let attempt = 1; keys !== void 0 && keys.length > 0; attempt++) {
        if (attempt > 1) await backoff(attempt);
        const response = await this.client.send(
          new BatchGetItemCommand({ RequestItems: { [this.tableName]: { Keys: keys, ConsistentRead: true } } })
        );
        for (const item of response.Responses?.[this.tableName] ?? []) found.set(text(item, "sk"), item);
        keys = response.UnprocessedKeys?.[this.tableName]?.Keys;
      }
    }
    return found;
  }
  assertOpen() {
    if (this.closed) throw new Error("IndexedStorage is closed");
  }
};

// conversation/src/pi/session.ts
async function openOwnerStorage(storageId, dependencies) {
  const fence = await IndexedStorage.allocateFence(dependencies.client, dependencies.tableName, storageId);
  const storage = await IndexedStorage.open({ ...dependencies, storageId, fence });
  return { storage, fence };
}
async function openOwnerSession(storageId, dependencies) {
  const { storage, fence } = await openOwnerStorage(storageId, dependencies);
  const registry = createRegistry();
  for (const extension of dependencies.extensions) registry.install(extension);
  const harness = await Harness.open(
    storage,
    { models: dependencies.models, registry, settings: dependencies.settings, env: dependencies.env },
    dependencies.context
  );
  return {
    harness,
    storage,
    fence,
    close: () => harness.close(withoutAbortSignal(dependencies.context))
  };
}

// conversation/src/turn/tool-event-fields.ts
var COMMAND_ARGUMENT_LIMIT = 1e3;
var WRITE_PREVIEW_LIMIT = 200;
var EDIT_TEXT_LIMIT = 300;
var LOCATION_ARGUMENT_LIMIT = 500;
var GENERIC_ARGUMENT_LIMIT = 300;
var GENERIC_ARGUMENT_COUNT_LIMIT = 10;
var ARGUMENT_NAME_LIMIT = 64;
var OUTPUT_LIMIT = 3e3;
var OUTPUT_KEPT_EACH_END = 1500;
var SUMMARY_QUOTE_LIMIT = 80;
var MINIMUM_SECRET_LENGTH = 8;
var NAMED_SECRET_VARIABLES = [
  "CHATTICUS_MODEL_GATEWAY_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN"
];
var SECRET_NAME_PATTERN = /KEY|TOKEN|SECRET/i;
var REDACTED = "[redacted]";
function secretValuesOf(environment) {
  const values = /* @__PURE__ */ new Set();
  for (const [name, value] of Object.entries(environment)) {
    if (value === void 0 || value.length < MINIMUM_SECRET_LENGTH) continue;
    if (NAMED_SECRET_VARIABLES.includes(name) || SECRET_NAME_PATTERN.test(name)) values.add(value);
  }
  return [...values].sort((left, right) => right.length - left.length);
}
function redactSecrets(text3, environment = process.env) {
  let result = text3;
  for (const secret of secretValuesOf(environment)) result = result.split(secret).join(REDACTED);
  return result;
}
var cut = (text3, limit) => text3.length > limit ? { text: text3.slice(0, limit), cut: true } : { text: text3, cut: false };
var oneLine = (text3) => text3.replace(/\s+/g, " ").trim();
var stringOf = (value) => typeof value === "string" ? value : value === void 0 || value === null ? "" : JSON.stringify(value);
function toolCallFields(tool, callId, rawArguments, environment = process.env) {
  const text3 = (name) => redactSecrets(stringOf(rawArguments[name]), environment);
  let truncated = false;
  const take = (value, limit) => {
    const piece = cut(value, limit);
    truncated ||= piece.cut;
    return piece.text;
  };
  const finish = (summary, toolArguments, writtenBytes = null) => ({
    tool,
    callId,
    summary,
    toolArguments,
    argumentsTruncated: truncated,
    writtenBytes
  });
  switch (tool) {
    case "run_terminal": {
      const command = take(text3("command"), COMMAND_ARGUMENT_LIMIT);
      return finish(`Running: ${oneLine(command).slice(0, SUMMARY_QUOTE_LIMIT)}`, { command });
    }
    case "read_workspace": {
      const path = take(text3("path"), LOCATION_ARGUMENT_LIMIT);
      return finish(`Reading ${path}`, { path });
    }
    case "write_workspace": {
      const path = take(text3("path"), LOCATION_ARGUMENT_LIMIT);
      const content = stringOf(rawArguments["content"]);
      const bytes = Buffer.byteLength(content);
      const preview = take(redactSecrets(content, environment), WRITE_PREVIEW_LIMIT);
      return finish(`Writing ${path} (${bytes} bytes)`, { path, bytes, preview }, bytes);
    }
    case "edit_workspace": {
      const path = take(text3("path"), LOCATION_ARGUMENT_LIMIT);
      const oldText = take(text3("old_text"), EDIT_TEXT_LIMIT);
      const newText = take(text3("new_text"), EDIT_TEXT_LIMIT);
      return finish(`Editing ${path}`, { path, old_text: oldText, new_text: newText });
    }
    case "browse": {
      const url = take(text3("url"), LOCATION_ARGUMENT_LIMIT);
      return finish(`Browsing ${url}`, { url });
    }
    default: {
      const toolArguments = {};
      let kept = 0;
      for (const [name, value] of Object.entries(rawArguments)) {
        const primitive = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
        if (!primitive || kept >= GENERIC_ARGUMENT_COUNT_LIMIT) {
          truncated = true;
          continue;
        }
        kept += 1;
        const key = take(name, ARGUMENT_NAME_LIMIT);
        toolArguments[key] = typeof value === "string" ? take(redactSecrets(value, environment), GENERIC_ARGUMENT_LIMIT) : value;
      }
      return finish(`Calling ${tool}`, toolArguments);
    }
  }
}
var EXIT_PREFIX = /^run_terminal:exit=(-?\d+)/;
var EXIT_ERROR = /Command exited with code (-?\d+)/;
var REPLACED_BLOCKS = /replaced (\d+) block/i;
function boundedEventOutput(text3) {
  if (text3.length <= OUTPUT_LIMIT) return { output: text3, truncated: false };
  const omitted = text3.length - 2 * OUTPUT_KEPT_EACH_END;
  return {
    output: `${text3.slice(0, OUTPUT_KEPT_EACH_END)}
...[${omitted} characters omitted]...
${text3.slice(text3.length - OUTPUT_KEPT_EACH_END)}`,
    truncated: true
  };
}
function toolResultFields(tool, callId, resultText, isError, writtenBytes, durationMs, environment = process.env) {
  const text3 = redactSecrets(resultText, environment);
  const bounded = boundedEventOutput(text3);
  const base = { tool, callId, output: bounded.output, outputTruncated: bounded.truncated, durationMs };
  const failure = () => ({
    ...base,
    ok: false,
    summary: `Error: ${oneLine(text3).slice(0, SUMMARY_QUOTE_LIMIT)}`
  });
  if (tool === "run_terminal") {
    const code = EXIT_PREFIX.exec(text3) ?? (isError ? EXIT_ERROR.exec(text3) : null);
    if (code !== null) return { ...base, ok: Number(code[1]) === 0, summary: `Exit ${code[1]}` };
    return isError ? failure() : { ...base, ok: true, summary: "Exit 0" };
  }
  if (isError) return failure();
  if (tool === "edit_workspace") {
    const blocks = REPLACED_BLOCKS.exec(text3)?.[1] ?? "1";
    return { ...base, ok: true, summary: `Edited ${blocks} ${blocks === "1" ? "block" : "blocks"}` };
  }
  if (tool === "write_workspace") {
    return { ...base, ok: true, summary: writtenBytes === null ? "Wrote file" : `Wrote ${writtenBytes} bytes` };
  }
  return { ...base, ok: true, summary: "Done" };
}

// conversation/src/turn/classify-errors.ts
var OUT_OF_QUOTA_REASON = "The model provider refused the request: the account is out of credits or over its quota.";
var MODEL_SPEND_CEILING_REASON = "The organization has reached its monthly model spend ceiling, so no more model calls are made until next month.";
var REJECTED_KEY_REASON = "The model provider rejected the API key.";
var ACCESS_DENIED_REASON = "The model provider denied access to the configured model.";
var INVALID_REQUEST_REASON = "The model provider rejected the request as invalid.";
var GENERIC_FAILURE_REASON = "The model provider failed to produce an answer.";
var STATUS_IN_PARENTHESES = /\((\d{3})\)/;
var STATUS_AT_START = /^(\d{3})\b/;
var ERROR_CODE = /"code"\s*:\s*"([^"]+)"/;
var ERROR_TYPE = /"type"\s*:\s*"([^"]+)"/;
var ERROR_MESSAGE = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/;
var OUT_OF_QUOTA_MARKER = /insufficient_quota|credit_balance_exhausted|no credits remaining/i;
var SECRET_TOKEN = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{8,}/g;
var PROVIDER_MESSAGE_LOG_LIMIT = 300;
function unescapeJsonString(body) {
  try {
    return JSON.parse(`"${body}"`);
  } catch {
    return body;
  }
}
function parseProviderFailure(text3) {
  const statusText = STATUS_IN_PARENTHESES.exec(text3)?.[1] ?? STATUS_AT_START.exec(text3)?.[1];
  const code = ERROR_CODE.exec(text3)?.[1] ?? ERROR_TYPE.exec(text3)?.[1] ?? null;
  return { status: statusText === void 0 ? null : Number(statusText), code };
}
function classifyModelFailure(detail) {
  const text3 = typeof detail === "string" ? detail : JSON.stringify(detail ?? "");
  const { status, code } = parseProviderFailure(text3);
  if (OUT_OF_QUOTA_MARKER.test(text3)) return OUT_OF_QUOTA_REASON;
  if (code === "model_spend_ceiling_reached") return MODEL_SPEND_CEILING_REASON;
  if (status === 401 || code === "invalid_api_key") return REJECTED_KEY_REASON;
  if (code === "model_access_denied" || status === 403 && code !== null) return ACCESS_DENIED_REASON;
  if (code === "unsupported_value" || code === "invalid_request_error" || (status === 400 || status === 404) && code !== null) {
    return INVALID_REQUEST_REASON;
  }
  return GENERIC_FAILURE_REASON;
}
function summarizeProviderFailure(detail) {
  const text3 = typeof detail === "string" ? detail : JSON.stringify(detail ?? "");
  const { status, code } = parseProviderFailure(text3);
  const body = ERROR_MESSAGE.exec(text3)?.[1];
  const readable = body === void 0 ? text3 : unescapeJsonString(body);
  const message = redactSecrets(readable).replace(SECRET_TOKEN, "[redacted]");
  return { status, code, message: message.length > PROVIDER_MESSAGE_LOG_LIMIT ? message.slice(0, PROVIDER_MESSAGE_LOG_LIMIT) : message };
}

// conversation/src/observability/log-line.ts
var BARE_VALUE = /^[A-Za-z0-9_.:/@+-]+$/;
var formatValue = (value) => {
  if (value === null) return "none";
  if (typeof value !== "string") return String(value);
  return BARE_VALUE.test(value) ? value : JSON.stringify(value);
};
function formatLogLine(event, fields = {}) {
  const parts = [event];
  for (const [key, value] of Object.entries(fields)) {
    if (value === void 0) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

// conversation/src/turn/coalescer.ts
var DEFAULT_TOKEN_FLUSH_BYTES = 200;
var DEFAULT_TOKEN_FLUSH_MILLISECONDS = 250;
var TokenCoalescer = class {
  options;
  buffer = "";
  timer = null;
  chain = Promise.resolve();
  failure = null;
  /** @param options Thresholds and the sink. */
  constructor(options) {
    this.options = options;
  }
  /** Add streamed text; never throws. */
  push(text3) {
    if (text3 === "") return;
    this.buffer += text3;
    if (Buffer.byteLength(this.buffer) >= this.options.flushBytes) {
      this.schedule();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.schedule();
      }, this.options.flushMilliseconds);
    }
  }
  /**
   * Write whatever is buffered and wait for every earlier write.
   *
   * @throws The first error the sink raised since the last flush.
   */
  async flush() {
    this.schedule();
    await this.chain;
    if (this.failure !== null) {
      const failure = this.failure;
      this.failure = null;
      throw failure;
    }
  }
  schedule() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const text3 = this.buffer;
    this.buffer = "";
    if (text3 === "") return;
    this.chain = this.chain.then(async () => {
      try {
        await this.options.write(text3);
      } catch (error) {
        this.failure ??= error;
      }
    });
  }
};

// conversation/src/turn/event-stream.ts
var THINKING_CHARACTER_LIMIT = 2e3;
var TurnEventWriter = class {
  deps;
  tenantId;
  turnId;
  attemptId;
  chain = Promise.resolve();
  firstFailure = null;
  /**
   * @param deps Store, clock and identifiers.
   * @param tenantId Organization.
   * @param turnId Turn.
   * @param attemptId The attempt whose fence every append carries.
   */
  constructor(deps, tenantId, turnId, attemptId) {
    this.deps = deps;
    this.tenantId = tenantId;
    this.turnId = turnId;
    this.attemptId = attemptId;
  }
  /** The first error an append raised, or null. */
  get failure() {
    return this.firstFailure;
  }
  /** Raise the first append failure, if any. */
  throwIfFailed() {
    if (this.firstFailure !== null) throw this.firstFailure;
  }
  /** Queue one event; resolves when it has been appended or dropped. */
  write(draft) {
    this.chain = this.chain.then(async () => {
      if (this.firstFailure !== null) return;
      try {
        await appendTurnEvent(this.deps, this.tenantId, this.turnId, this.attemptId, draft);
      } catch (error) {
        this.firstFailure = error;
      }
    });
    return this.chain;
  }
  /** Resolve when every queued event has been appended or dropped. */
  idle() {
    return this.chain;
  }
};
var textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "").join("");
};
var thinkingOf = (content) => {
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.type === "thinking" && typeof part.thinking === "string" ? part.thinking : "").join("");
};
var toolCallsOf = (content) => {
  if (!Array.isArray(content)) return [];
  const calls = [];
  for (const part of content) {
    if (part?.type !== "toolCall" || typeof part.id !== "string" || typeof part.name !== "string") continue;
    const given = part.arguments;
    calls.push({ id: part.id, name: part.name, arguments: typeof given === "object" && given !== null ? given : {} });
  }
  return calls;
};
async function writeToolCallOnce(writer, delivery, callId, toolName, rawArguments) {
  if (!delivery.claimCallJournal(callId)) return;
  const fields = toolCallFields(toolName, callId, rawArguments);
  delivery.rememberCall(callId, { toolName, writtenBytes: fields.writtenBytes });
  await writer.write({
    kind: "tool.call",
    tool: fields.tool,
    callId: fields.callId,
    summary: fields.summary,
    toolArguments: fields.toolArguments,
    argumentsTruncated: fields.argumentsTruncated
  });
}
var AgentEventDelivery = class {
  settled = /* @__PURE__ */ new Set();
  journaledCalls = /* @__PURE__ */ new Set();
  knownCalls = /* @__PURE__ */ new Map();
  thinkingCharacters = 0;
  computerStartingOutstanding = false;
  waiters = /* @__PURE__ */ new Map();
  /**
   * Claim the right to write the `tool.call` event of one Pi tool call. The listener and the executor's park path both
   * write it, and whichever claims first does, so a call is journaled once however the two interleave.
   *
   * @param callId The Pi tool call id.
   * @returns true the first time the call is claimed.
   */
  claimCallJournal(callId) {
    if (this.journaledCalls.has(callId)) return false;
    this.journaledCalls.add(callId);
    return true;
  }
  /** The call as the listener or the journal last described it, or undefined. */
  knownCall(callId) {
    return this.knownCalls.get(callId);
  }
  /** Remember what is needed from a call to describe its result. */
  rememberCall(callId, call) {
    const previous = this.knownCalls.get(callId);
    this.knownCalls.set(callId, {
      toolName: call.toolName,
      writtenBytes: call.writtenBytes ?? previous?.writtenBytes ?? null,
      startedAtMilliseconds: call.startedAtMilliseconds ?? previous?.startedAtMilliseconds ?? null
    });
  }
  /** Count reasoning summary characters already in the journal, so a resumed attempt keeps the turn's cap. */
  addThinkingCharacters(count) {
    this.thinkingCharacters += count;
  }
  /**
   * Take the part of a piece of reasoning summary that still fits in the turn's cap.
   *
   * @param text The piece the model streamed.
   * @returns The part to emit, possibly empty.
   */
  takeThinking(text3) {
    const room = Math.max(0, THINKING_CHARACTER_LIMIT - this.thinkingCharacters);
    const taken = text3.slice(0, room);
    this.thinkingCharacters += taken.length;
    return taken;
  }
  /** Record whether the journal shows a `computer.starting` that no `computer.ready` has answered. */
  setComputerStartingOutstanding(outstanding) {
    this.computerStartingOutstanding = outstanding;
  }
  /** Whether a `computer.starting` is waiting for its `computer.ready`. */
  get computerStarting() {
    return this.computerStartingOutstanding;
  }
  /** Record that a batch containing the settlement of a submission has been fully handled. */
  noteSettled(submissionId) {
    this.settled.add(submissionId);
    for (const resolve of this.waiters.get(submissionId) ?? []) resolve();
    this.waiters.delete(submissionId);
  }
  /**
   * Wait until the listener has handled the batch that settled a submission. Pi delivers batches after the commit that
   * settled the submission, so a caller about to end the turn waits here to keep every streamed token ahead of the
   * terminal event. An overflowing stream replaces batches with a snapshot and never delivers the settlement, so the
   * wait is bounded.
   *
   * @param submissionId The submission.
   * @param timeoutMilliseconds The longest to wait.
   */
  async untilSettled(submissionId, timeoutMilliseconds) {
    if (this.settled.has(submissionId)) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMilliseconds);
      const waiting = this.waiters.get(submissionId) ?? [];
      waiting.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.waiters.set(submissionId, waiting);
    });
  }
};
function createAgentEventListener(writer, coalescer, thinking, attemptId, delivery) {
  let streamedText = "";
  let streamedThinking = "";
  let thinkingUnflushed = false;
  const messageCalls = /* @__PURE__ */ new Map();
  const pushThinking = (text3) => {
    const taken = delivery.takeThinking(text3);
    if (taken === "") return;
    thinking.push(taken);
    thinkingUnflushed = true;
  };
  const flushThinking = async () => {
    if (!thinkingUnflushed) return;
    thinkingUnflushed = false;
    await thinking.flush();
  };
  const flushStreams = async () => {
    await flushThinking();
    await coalescer.flush();
  };
  return async (events) => {
    const settledInBatch = [];
    for (const event of events) {
      switch (event.type) {
        case "submission":
          if (event.record.status === "done" || event.record.status === "unanswered") settledInBatch.push(event.record.id);
          break;
        case "turn_start":
          await flushStreams();
          await writer.write({ kind: "model.request", attemptId });
          break;
        case "message_start":
          if (event.message.role === "assistant") {
            streamedThinking = thinkingOf(event.message.content);
            pushThinking(streamedThinking);
            await flushThinking();
            streamedText = textOf(event.message.content);
            coalescer.push(streamedText);
          }
          break;
        case "message_update":
          for (const change of event.changes) {
            if (change.type === "thinking_start" && change.block.type === "thinking") {
              streamedThinking += change.block.thinking;
              pushThinking(change.block.thinking);
            } else if (change.type === "thinking_delta") {
              streamedThinking += change.delta;
              pushThinking(change.delta);
            } else if (change.type === "text_delta") {
              await flushThinking();
              streamedText += change.delta;
              coalescer.push(change.delta);
            }
          }
          break;
        case "message_end": {
          const message = event.entry.model?.[0];
          if (message?.role === "assistant") {
            const fullThinking = thinkingOf(message.content);
            if (fullThinking.length > streamedThinking.length && fullThinking.startsWith(streamedThinking)) {
              pushThinking(fullThinking.slice(streamedThinking.length));
            }
            streamedThinking = "";
            await flushThinking();
            const fullText = textOf(message.content);
            if (fullText.length > streamedText.length && fullText.startsWith(streamedText)) {
              coalescer.push(fullText.slice(streamedText.length));
            }
            streamedText = "";
            for (const call of toolCallsOf(message.content)) messageCalls.set(call.id, { name: call.name, arguments: call.arguments });
          }
          break;
        }
        case "tool_execution_start":
          await flushStreams();
          delivery.rememberCall(event.toolCallId, { toolName: event.toolName, startedAtMilliseconds: Date.now() });
          await writeToolCallOnce(writer, delivery, event.toolCallId, event.toolName, event.args);
          break;
        case "tool_execution_end": {
          await flushStreams();
          await writeToolCallOnce(writer, delivery, event.toolCallId, event.toolName, messageCalls.get(event.toolCallId)?.arguments ?? {});
          const result = event.entry?.model?.[0];
          const known = delivery.knownCall(event.toolCallId);
          const started = known?.startedAtMilliseconds ?? null;
          const fields = toolResultFields(
            event.toolName,
            event.toolCallId,
            result?.role === "toolResult" ? textOf(result.content) : "",
            result?.role === "toolResult" ? result.isError === true : true,
            known?.writtenBytes ?? null,
            started === null ? null : Math.max(0, Date.now() - started)
          );
          await writer.write({
            kind: "tool.result",
            tool: fields.tool,
            callId: fields.callId,
            ok: fields.ok,
            summary: fields.summary,
            output: fields.output,
            outputTruncated: fields.outputTruncated,
            durationMs: fields.durationMs
          });
          break;
        }
        default:
          break;
      }
    }
    for (const submissionId of settledInBatch) delivery.noteSettled(submissionId);
  };
}

// conversation/src/turn/finalize.ts
import { ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID2 } from "@earendil-works/pi-durable";

// conversation/src/ledger/call-cost.ts
import {
  AssistantEntry,
  defineDocFamily,
  UsageDoc
} from "@earendil-works/pi-durable";

// conversation/src/ledger/price-book.ts
var MILLION_EXPONENT = 6;
var COST_SCALE = 8;
var PRICED_WITH_LIST = "list";
var PRICED_WITH_LONG_CONTEXT_TIER = "long_context_tier";
var PRICED_WITH_UNCACHED_FALLBACK = "uncached_fallback";
var VendorPriceBook = class {
  priceBookId;
  prices = /* @__PURE__ */ new Map();
  /** @param priceBookId Version id naming the source and date of the prices. */
  constructor(priceBookId) {
    this.priceBookId = priceBookId;
  }
  /** Register the price of one vendor model. */
  register(vendor, model, price) {
    this.prices.set(`${vendor}\0${model}`, price);
  }
  /** The price of one vendor model, or null when none is registered. */
  lookup(vendor, model) {
    return this.prices.get(`${vendor}\0${model}`) ?? null;
  }
};
var UnpricedModelError = class extends Error {
  vendor;
  model;
  priceBookId;
  constructor(vendor, model, priceBookId) {
    super(`No price is tabled for model ${vendor}/${model} in price book ${priceBookId}.`);
    this.name = "UnpricedModelError";
    this.vendor = vendor;
    this.model = model;
    this.priceBookId = priceBookId;
  }
};
var contextTokensOf = (usage) => usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
function ratesFor(price, contextTokens) {
  let chosen = null;
  for (const tier of price.tiers ?? []) {
    if (contextTokens > tier.inputTokensAbove && (chosen === null || tier.inputTokensAbove > chosen.inputTokensAbove)) chosen = tier;
  }
  return chosen === null ? { rates: price, tiered: false } : { rates: chosen, tiered: true };
}
var componentCost = (rate, tokens) => rate.multiplyByInteger(tokens).divideByPowerOfTen(MILLION_EXPONENT).quantize(COST_SCALE);
function priceCall(book, call) {
  const price = book.lookup(call.vendor, call.model);
  if (price === null) throw new UnpricedModelError(call.vendor, call.model, book.priceBookId);
  const { rates, tiered } = ratesFor(price, contextTokensOf(call));
  const labels = /* @__PURE__ */ new Set([tiered ? PRICED_WITH_LONG_CONTEXT_TIER : PRICED_WITH_LIST]);
  let cost = componentCost(rates.inputPerMillionUsd, call.inputTokens).add(componentCost(rates.outputPerMillionUsd, call.outputTokens));
  const cached = [
    [call.cacheReadTokens, rates.cacheReadPerMillionUsd],
    [call.cacheWriteTokens, rates.cacheWritePerMillionUsd]
  ];
  for (const [tokens, rate] of cached) {
    if (tokens === 0) continue;
    if (rate === void 0) labels.add(PRICED_WITH_UNCACHED_FALLBACK);
    cost = cost.add(componentCost(rate ?? rates.inputPerMillionUsd, tokens));
  }
  return { costUsd: cost, pricedWith: [...labels].sort(), appliedRates: rates };
}

// conversation/src/ledger/call-cost.ts
var ENTRY_PAGE_SIZE = 100;
var DOCUMENT_PAGE_SIZE = 100;
var CALL_COST_DOCUMENT_KIND = "chatticus.cost";
var CALL_COST_RECORD_VERSION = 1;
var emptyCallCost = (seed) => ({
  version: CALL_COST_RECORD_VERSION,
  filled: false,
  conversationId: seed.conversationId,
  entryId: 0,
  kind: "turn_round",
  turnId: "",
  round: 0,
  provider: "",
  model: "",
  responseId: null,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  contextTokens: 0,
  priceBookId: "",
  tier: null,
  pricedWith: [],
  inputRatePerMillionUsd: null,
  outputRatePerMillionUsd: null,
  costUsd: null,
  unpriced: false,
  providerCostEstimateUsd: 0,
  recordedAt: ""
});
var CallCostDoc = defineDocFamily({
  kind: CALL_COST_DOCUMENT_KIND,
  version: CALL_COST_RECORD_VERSION,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (seed) => emptyCallCost(seed)
});
var callCostKeyOf = (entryId) => `entry-${entryId}`;
async function assistantCallsOf(storage, conversationId, fromEntryId, context) {
  const calls = [];
  let cursor;
  do {
    const page2 = await storage.scanEntries({ conversationId, minEntryId: fromEntryId }, ENTRY_PAGE_SIZE, cursor, context);
    for (const entry of page2.items) {
      if (entry.kind !== AssistantEntry.kind || entry.conversationId !== conversationId) continue;
      const message = entry.model?.[0];
      if (message?.role !== "assistant") continue;
      calls.push({
        entryId: Number(entry.id),
        subject: {
          vendor: message.provider,
          model: message.model,
          inputTokens: message.usage.input,
          cacheReadTokens: message.usage.cacheRead,
          cacheWriteTokens: message.usage.cacheWrite,
          outputTokens: message.usage.output
        },
        reasoningTokens: message.usage.reasoning ?? 0,
        responseId: message.responseId ?? null,
        providerCostEstimateUsd: message.usage.cost.total
      });
    }
    cursor = page2.next;
  } while (cursor !== void 0);
  return calls.sort((left, right) => left.entryId - right.entryId);
}
function priceInto(draft, subject, prices) {
  draft.priceBookId = prices.priceBookId;
  try {
    const priced = priceCall(prices, subject);
    draft.costUsd = priced.costUsd.toString();
    draft.pricedWith = [...priced.pricedWith];
    draft.tier = priced.pricedWith.includes(PRICED_WITH_LONG_CONTEXT_TIER) ? "long_context" : "standard";
    draft.inputRatePerMillionUsd = priced.appliedRates.inputPerMillionUsd.toString();
    draft.outputRatePerMillionUsd = priced.appliedRates.outputPerMillionUsd.toString();
    draft.unpriced = false;
  } catch (error) {
    if (!(error instanceof UnpricedModelError)) throw error;
    draft.unpriced = true;
  }
}
function fillFacts(draft, facts, prices) {
  draft.filled = true;
  draft.kind = facts.kind;
  draft.entryId = facts.entryId;
  draft.turnId = facts.turnId;
  draft.round = facts.round;
  draft.provider = facts.usage.vendor;
  draft.model = facts.usage.model;
  draft.responseId = facts.responseId;
  draft.inputTokens = facts.usage.inputTokens;
  draft.cacheReadTokens = facts.usage.cacheReadTokens;
  draft.cacheWriteTokens = facts.usage.cacheWriteTokens;
  draft.outputTokens = facts.usage.outputTokens;
  draft.reasoningTokens = facts.usage.reasoningTokens;
  draft.contextTokens = contextTokensOf(facts.usage);
  draft.providerCostEstimateUsd = facts.providerCostEstimateUsd;
  draft.recordedAt = facts.recordedAt;
  priceInto(draft, facts.usage, prices);
}
function fillRecord(draft, call, round, turnId, prices, recordedAt) {
  fillFacts(
    draft,
    {
      kind: "turn_round",
      conversationId: draft.conversationId,
      entryId: call.entryId,
      turnId,
      round,
      usage: { ...call.subject, reasoningTokens: call.reasoningTokens },
      responseId: call.responseId,
      providerCostEstimateUsd: call.providerCostEstimateUsd,
      recordedAt
    },
    prices
  );
}
async function deriveCostRecordsFromEntries(session, storage, request, context) {
  const calls = await assistantCallsOf(storage, request.conversationId, request.promptEntryId, context);
  if (calls.length === 0) return 0;
  const recordedAt = request.now().toISOString();
  return session.commit(async (tx) => {
    let written = 0;
    for (const [index, call] of calls.entries()) {
      const draft = await tx.doc(CallCostDoc, request.conversationId, callCostKeyOf(call.entryId), {
        conversationId: String(request.conversationId)
      });
      if (draft.filled) continue;
      fillRecord(draft, call, index + 1, request.turnId, request.prices, recordedAt);
      written += 1;
    }
    return written;
  }, context);
}
var zeroCounters = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, estimateUsd: 0 });
var hasTokens = (counters) => counters.input + counters.cacheRead + counters.cacheWrite + counters.output > 0;
var positiveDifference = (left, right) => ({
  input: Math.max(0, left.input - right.input),
  cacheRead: Math.max(0, left.cacheRead - right.cacheRead),
  cacheWrite: Math.max(0, left.cacheWrite - right.cacheWrite),
  output: Math.max(0, left.output - right.output),
  reasoning: Math.max(0, left.reasoning - right.reasoning),
  estimateUsd: Math.max(0, left.estimateUsd - right.estimateUsd)
});
function addCounters(total, part) {
  total.input += part.input;
  total.cacheRead += part.cacheRead;
  total.cacheWrite += part.cacheWrite;
  total.output += part.output;
  total.reasoning += part.reasoning;
  total.estimateUsd += part.estimateUsd;
}
var modelKeyOf = (provider, model) => `${provider}/${model}`;
async function usageLedgerOfConversation(session, conversationId, context) {
  const state = await session.snapshot(UsageDoc, conversationId, context);
  const byModel = /* @__PURE__ */ new Map();
  for (const [key, usage] of Object.entries(state?.models ?? {})) {
    byModel.set(key, {
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      output: usage.output,
      reasoning: usage.reasoning ?? 0,
      estimateUsd: usage.cost.total
    });
  }
  return byModel;
}
async function entryUsageOfConversation(storage, conversationId, context) {
  const byModel = /* @__PURE__ */ new Map();
  let newestEntryId = 0;
  let cursor;
  do {
    const page2 = await storage.scanEntries({ conversationId }, ENTRY_PAGE_SIZE, cursor, context);
    for (const entry of page2.items) {
      if (entry.conversationId !== conversationId) continue;
      newestEntryId = Math.max(newestEntryId, Number(entry.id));
      if (entry.kind !== AssistantEntry.kind) continue;
      const message = entry.model?.[0];
      if (message?.role !== "assistant") continue;
      const key = modelKeyOf(message.provider, message.model);
      const total = byModel.get(key) ?? zeroCounters();
      addCounters(total, {
        input: message.usage.input,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        output: message.usage.output,
        reasoning: message.usage.reasoning ?? 0,
        estimateUsd: message.usage.cost.total
      });
      byModel.set(key, total);
    }
    cursor = page2.next;
  } while (cursor !== void 0);
  return { byModel, newestEntryId };
}
var compactionCostKeyOf = (provider, model, cumulative) => `compaction-${provider}-${model}-${cumulative.input}-${cumulative.cacheRead}-${cumulative.cacheWrite}-${cumulative.output}`;
async function deriveCompactionCostRecords(session, storage, request, context) {
  const ledger = await usageLedgerOfConversation(session, request.conversationId, context);
  if (ledger.size === 0) return 0;
  const entries = await entryUsageOfConversation(storage, request.conversationId, context);
  const remainders = /* @__PURE__ */ new Map();
  for (const [key, counters] of ledger) {
    const remainder = positiveDifference(counters, entries.byModel.get(key) ?? zeroCounters());
    if (hasTokens(remainder)) remainders.set(key, remainder);
  }
  if (remainders.size === 0) return 0;
  const recorded = /* @__PURE__ */ new Map();
  for (const record of await readCallCostRecords(session, storage, request.conversationId, context)) {
    if (record.kind !== "compaction") continue;
    const key = modelKeyOf(record.provider, record.model);
    const total = recorded.get(key) ?? zeroCounters();
    addCounters(total, {
      input: record.inputTokens,
      cacheRead: record.cacheReadTokens,
      cacheWrite: record.cacheWriteTokens,
      output: record.outputTokens,
      reasoning: record.reasoningTokens,
      estimateUsd: record.providerCostEstimateUsd
    });
    recorded.set(key, total);
  }
  const recordedAt = request.now().toISOString();
  return session.commit(async (tx) => {
    let written = 0;
    for (const [key, cumulative] of remainders) {
      const fresh = positiveDifference(cumulative, recorded.get(key) ?? zeroCounters());
      if (!hasTokens(fresh)) continue;
      const separator = key.indexOf("/");
      const provider = key.slice(0, separator);
      const model = key.slice(separator + 1);
      const draft = await tx.doc(CallCostDoc, request.conversationId, compactionCostKeyOf(provider, model, cumulative), {
        conversationId: String(request.conversationId)
      });
      if (draft.filled) continue;
      fillFacts(
        draft,
        {
          kind: "compaction",
          conversationId: String(request.conversationId),
          entryId: entries.newestEntryId,
          turnId: request.turnId,
          round: 0,
          usage: {
            vendor: provider,
            model,
            inputTokens: fresh.input,
            cacheReadTokens: fresh.cacheRead,
            cacheWriteTokens: fresh.cacheWrite,
            outputTokens: fresh.output,
            reasoningTokens: fresh.reasoning
          },
          responseId: null,
          providerCostEstimateUsd: fresh.estimateUsd,
          recordedAt
        },
        request.prices
      );
      written += 1;
    }
    return written;
  }, context);
}
async function deriveCostRecords(session, storage, request, context) {
  const fromEntries = await deriveCostRecordsFromEntries(session, storage, request, context);
  return fromEntries + await deriveCompactionCostRecords(session, storage, request, context);
}
async function readCallCostRecords(session, storage, conversationId, context) {
  const keys = [];
  let cursor;
  do {
    const page2 = await storage.scanDocuments(
      { scope: { kind: "conversation", conversationId }, at: "current", kind: CALL_COST_DOCUMENT_KIND },
      DOCUMENT_PAGE_SIZE,
      cursor,
      context
    );
    for (const record of page2.items) if (record.key !== void 0) keys.push(record.key);
    cursor = page2.next;
  } while (cursor !== void 0);
  const records = [];
  for (const key of keys) {
    const value = await session.snapshot(CallCostDoc, conversationId, key, context);
    if (value !== void 0 && value.filled) records.push({ ...value, pricedWith: [...value.pricedWith] });
  }
  return records.sort((left, right) => left.entryId - right.entryId);
}

// conversation/src/ledger/turn-cost.ts
import {
  TransactionCanceledException as TransactionCanceledException2,
  TransactWriteItemsCommand as TransactWriteItemsCommand2
} from "@aws-sdk/client-dynamodb";

// conversation/src/budget/budget-store.ts
import {
  GetItemCommand as GetItemCommand4,
  PutItemCommand as PutItemCommand4,
  QueryCommand as QueryCommand5,
  ScanCommand
} from "@aws-sdk/client-dynamodb";
function vendorLedgerKey(tenantId, turnId) {
  return { pk: `${tenantId}#vendor_ledger`, sk: `turn#${turnId}` };
}

// conversation/src/store/transient-retry.ts
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
var TRANSIENT_RETRY_MAX_ATTEMPTS = 5;
var TRANSIENT_RETRY_BASE_DELAY_MILLISECONDS = 25;
var TRANSIENT_RETRY_FACTOR = 2;
var TRANSIENT_RETRY_BUDGET_MILLISECONDS = 2e3;
var TRANSIENT_ERROR_NAMES = /* @__PURE__ */ new Set([
  "TransactionConflictException",
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "InternalServerError",
  "ServiceUnavailable"
]);
var TRANSACTION_CONFLICT_REASON = "TransactionConflict";
var CONDITION_FAILED_REASON = "ConditionalCheckFailed";
function isTransientDynamoError(error) {
  const name = error?.name;
  if (error instanceof TransactionCanceledException || name === "TransactionCanceledException") {
    const reasons = error.CancellationReasons ?? [];
    return reasons.some((reason) => reason.Code === TRANSACTION_CONFLICT_REASON) && !reasons.some((reason) => reason.Code === CONDITION_FAILED_REASON);
  }
  return typeof name === "string" && TRANSIENT_ERROR_NAMES.has(name);
}
var defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function retryTransient(operation, options = {}) {
  const maxAttempts = options.maxAttempts ?? TRANSIENT_RETRY_MAX_ATTEMPTS;
  const base = options.baseDelayMilliseconds ?? TRANSIENT_RETRY_BASE_DELAY_MILLISECONDS;
  const factor = options.factor ?? TRANSIENT_RETRY_FACTOR;
  const budget = options.budgetMilliseconds ?? TRANSIENT_RETRY_BUDGET_MILLISECONDS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  let slept = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientDynamoError(error) || attempt >= maxAttempts) {
        throw error;
      }
      const delay2 = random() * base * factor ** (attempt - 1);
      if (slept + delay2 > budget) {
        throw error;
      }
      slept += delay2;
      await sleep(delay2);
    }
  }
}

// conversation/src/ledger/turn-cost.ts
var costIndexPartitionOf = (tenantId, month) => `${tenantId}#cost#${month}`;
var VOICE_COST_ROW_PREFIX = "voice:";
var isVoiceCostRowId = (rowId) => rowId.startsWith(VOICE_COST_ROW_PREFIX);
var costTurnIndexKey = (tenantId, month, rowId) => ({
  pk: costIndexPartitionOf(tenantId, month),
  sk: isVoiceCostRowId(rowId) ? `voice#${rowId.slice(VOICE_COST_ROW_PREFIX.length)}` : `turn#${rowId}`
});
function summarizeTurnCost(records) {
  const ordered = [...records].sort((left, right) => left.entryId - right.entryId);
  const first = ordered[0];
  if (first === void 0) return null;
  let total = Decimal.zero();
  let unpricedCalls = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  const labels = /* @__PURE__ */ new Set();
  const models = /* @__PURE__ */ new Set();
  const responseIds = /* @__PURE__ */ new Set();
  let compactionContextTokens = 0;
  let compactionOutputTokens = 0;
  const subtotals = /* @__PURE__ */ new Map();
  for (const record of ordered) {
    inputTokens += record.inputTokens;
    cacheReadTokens += record.cacheReadTokens;
    cacheWriteTokens += record.cacheWriteTokens;
    outputTokens += record.outputTokens;
    models.add(record.model);
    const recordTokens = record.contextTokens + record.outputTokens;
    if (record.responseId !== null && recordTokens > 0) responseIds.add(record.responseId);
    if (record.kind === "compaction") {
      compactionContextTokens += record.contextTokens;
      compactionOutputTokens += record.outputTokens;
    }
    for (const label of record.pricedWith) labels.add(label);
    const subtotal = subtotals.get(record.model) ?? {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      costUsd: Decimal.zero(),
      unpricedCalls: 0,
      calls: 0
    };
    subtotal.inputTokens += record.inputTokens;
    subtotal.cacheReadTokens += record.cacheReadTokens;
    subtotal.cacheWriteTokens += record.cacheWriteTokens;
    subtotal.outputTokens += record.outputTokens;
    subtotal.calls += 1;
    if (record.costUsd === null) {
      unpricedCalls += 1;
      subtotal.unpricedCalls += 1;
      subtotal.costUsd = null;
    } else {
      const cost = Decimal.parse(record.costUsd);
      total = total.add(cost);
      if (subtotal.costUsd !== null) subtotal.costUsd = subtotal.costUsd.add(cost);
    }
    subtotals.set(record.model, subtotal);
  }
  const hasTokens2 = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens > 0;
  return {
    recordCount: ordered.length,
    vendor: first.provider,
    model: first.model,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    contextInputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd: unpricedCalls > 0 || !hasTokens2 ? null : total,
    unpricedCalls,
    models: [...models].sort(),
    pricedWith: [...labels].sort(),
    priceBookId: first.priceBookId,
    inputRatePerMillionUsd: first.inputRatePerMillionUsd === null ? null : Decimal.parse(first.inputRatePerMillionUsd),
    outputRatePerMillionUsd: first.outputRatePerMillionUsd === null ? null : Decimal.parse(first.outputRatePerMillionUsd),
    firstRecordedAt: ordered.map((record) => record.recordedAt).sort()[0],
    byModel: subtotals,
    responseIds: [...responseIds].sort(),
    compactionContextTokens,
    compactionOutputTokens
  };
}
var COST_SOURCE_SESSION = "session";
var text2 = (value) => ({ S: value });
var number2 = (value) => ({ N: String(value) });
function subtotalAttribute(subtotal) {
  const fields = {
    input_tokens: number2(subtotal.inputTokens),
    cache_read_tokens: number2(subtotal.cacheReadTokens),
    cache_write_tokens: number2(subtotal.cacheWriteTokens),
    output_tokens: number2(subtotal.outputTokens),
    unpriced_calls: number2(subtotal.unpricedCalls),
    calls: number2(subtotal.calls)
  };
  if (subtotal.costUsd !== null) fields.cost_usd = { N: subtotal.costUsd.toString() };
  return { M: fields };
}
function assignment() {
  const values = {};
  const set = [];
  const remove2 = [];
  return {
    values,
    set,
    remove: remove2,
    put(name, value) {
      if (value === null) {
        remove2.push(`#${name}`);
        return;
      }
      values[`:${name}`] = value;
      set.push(`#${name} = :${name}`);
    }
  };
}
var updateOf = (assignments) => {
  const names = {};
  for (const reference of [...assignments.set.map((clause) => clause.split(" ")[0]), ...assignments.remove]) {
    names[reference] = reference.slice(1);
  }
  return {
    UpdateExpression: `SET ${assignments.set.join(", ")}${assignments.remove.length === 0 ? "" : ` REMOVE ${assignments.remove.join(", ")}`}`,
    ExpressionAttributeValues: assignments.values,
    ExpressionAttributeNames: { ...names, "#record_count": "record_count" }
  };
};
function ledgerRowAssignments(dimensions, summary, now) {
  const row = assignment();
  row.put("tenant_id", text2(dimensions.tenantId));
  row.put("turn_id", text2(dimensions.turnId));
  row.put("vendor", text2(summary.vendor));
  row.put("model", text2(summary.model));
  row.put("input_tokens", number2(summary.contextInputTokens));
  row.put("output_tokens", number2(summary.outputTokens));
  row.put("billed_via", text2(BILLED_VIA_VENDOR));
  row.put("recorded_at", text2(summary.firstRecordedAt || now));
  row.put("price_book_id", text2(summary.priceBookId));
  row.put("models", { SS: [...summary.models] });
  row.put("unpriced_calls", number2(summary.unpricedCalls));
  row.put("priced_with", summary.pricedWith.length === 0 ? null : { SS: [...summary.pricedWith] });
  row.put("cost_usd", summary.costUsd === null ? null : { N: summary.costUsd.toString() });
  row.put("input_price_per_million_usd", summary.inputRatePerMillionUsd === null ? null : { N: summary.inputRatePerMillionUsd.toString() });
  row.put("output_price_per_million_usd", summary.outputRatePerMillionUsd === null ? null : { N: summary.outputRatePerMillionUsd.toString() });
  row.put("record_count", number2(summary.recordCount));
  row.put("source", text2(COST_SOURCE_SESSION));
  row.put("response_ids", summary.responseIds.length === 0 ? null : { SS: [...summary.responseIds] });
  row.put("compaction_context_tokens", number2(summary.compactionContextTokens));
  row.put("compaction_output_tokens", number2(summary.compactionOutputTokens));
  return row;
}
function turnIndexAssignments(dimensions, summary, now) {
  const row = assignment();
  row.put("tenant_id", text2(dimensions.tenantId));
  row.put("turn_id", text2(dimensions.turnId));
  row.put("kind", text2(dimensions.kind));
  row.put("bot_id", dimensions.botId === null ? null : text2(dimensions.botId));
  row.put("channel_id", text2(dimensions.channelId));
  row.put("prompt_author_id", dimensions.promptAuthorId === null ? null : text2(dimensions.promptAuthorId));
  row.put("prompt_message_seq", dimensions.promptMessageSeq === null ? null : number2(dimensions.promptMessageSeq));
  row.put("message_seq", dimensions.messageSeq === null ? null : number2(dimensions.messageSeq));
  row.put("owner_kind", text2(dimensions.ownerKind));
  row.put("status", text2(dimensions.status));
  row.put("input_tokens", number2(summary.inputTokens));
  row.put("cache_read_tokens", number2(summary.cacheReadTokens));
  row.put("cache_write_tokens", number2(summary.cacheWriteTokens));
  row.put("output_tokens", number2(summary.outputTokens));
  row.put("by_model", {
    M: Object.fromEntries([...summary.byModel].map(([model, subtotal]) => [model, subtotalAttribute(subtotal)]))
  });
  row.put("price_book_id", text2(summary.priceBookId));
  row.put("cost_usd", summary.costUsd === null ? null : { N: summary.costUsd.toString() });
  row.put("unpriced_calls", number2(summary.unpricedCalls));
  row.put("record_count", number2(summary.recordCount));
  row.put("source", text2(COST_SOURCE_SESSION));
  row.put("response_ids", summary.responseIds.length === 0 ? null : { SS: [...summary.responseIds] });
  row.put("recorded_at", text2(summary.firstRecordedAt || now));
  row.put("updated_at", text2(now));
  return row;
}
var GUARD = "attribute_not_exists(#record_count) OR #record_count <= :recordCount";
async function projectTurnCost(deps, dimensions, summary) {
  const now = deps.now().toISOString();
  const ledgerKey = vendorLedgerKey(dimensions.tenantId, dimensions.turnId);
  const indexKey = costTurnIndexKey(dimensions.tenantId, (summary.firstRecordedAt || now).slice(0, 7), dimensions.turnId);
  const ledger = ledgerRowAssignments(dimensions, summary, now);
  const index = turnIndexAssignments(dimensions, summary, now);
  const guard = { ":recordCount": number2(summary.recordCount) };
  const items = [
    {
      Update: {
        TableName: deps.tableName,
        Key: { pk: text2(ledgerKey.pk), sk: text2(ledgerKey.sk) },
        ConditionExpression: GUARD,
        ...updateOf({ ...ledger, values: { ...ledger.values, ...guard } })
      }
    },
    {
      Update: {
        TableName: deps.tableName,
        Key: { pk: text2(indexKey.pk), sk: text2(indexKey.sk) },
        ConditionExpression: GUARD,
        ...updateOf({ ...index, values: { ...index.values, ...guard } })
      }
    }
  ];
  try {
    await retryTransient(() => deps.client.send(new TransactWriteItemsCommand2({ TransactItems: items })));
    return true;
  } catch (error) {
    if (error instanceof TransactionCanceledException2 && error.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed")) {
      return false;
    }
    throw error;
  }
}

// conversation/src/turn/finalize.ts
var replyMessageIdFor = (turnId) => `reply-${turnId}`;
var statusOfPoint = (point) => point === "resumed" ? "running" : point;
var promptRequestIdFor = (turnId) => `turn:${turnId}`;
async function recordTurnCost(inputs, point, messageSeq = null) {
  const { deps, turn, session, root, context } = inputs;
  const prompt = await session.harness.commit((tx) => tx.submissionByRequest(root.id, promptRequestIdFor(turn.turnId)), context);
  const promptEntryId = prompt?.entry;
  if (promptEntryId === void 0) return;
  await deriveCostRecords(
    session.harness,
    session.storage,
    { conversationId: root.id, turnId: turn.turnId, promptEntryId: Number(promptEntryId), prices: deps.ledger.prices, now: deps.ledger.now },
    context
  );
  const records = (await readCallCostRecords(session.harness, session.storage, root.id, context)).filter(
    (record) => record.turnId === turn.turnId
  );
  const summary = summarizeTurnCost(records);
  if (summary === null) return;
  await projectTurnCost(
    deps.ledger,
    {
      tenantId: turn.tenantId,
      turnId: turn.turnId,
      kind: "turn",
      botId: turn.botId,
      channelId: turn.channelId,
      promptAuthorId: turn.promptAuthorId,
      promptMessageSeq: turn.promptMessageSeq,
      messageSeq: messageSeq ?? turn.messageSeq,
      ownerKind: deps.ownerKind,
      status: statusOfPoint(point)
    },
    summary
  );
}
async function commitFinalAnswer(inputs, answerEntryId) {
  const { deps, turn, session, context } = inputs;
  const body = await readEntryBody(session.storage, answerEntryId, context) ?? "";
  const messageId = replyMessageIdFor(turn.turnId);
  const log = await session.harness.snapshot(ChannelLogDoc, ROOT_CONVERSATION_ID2, context);
  const existing = log?.lines.find((line) => line.messageId === messageId);
  const mailbox = { client: deps.client, tableName: deps.messagingTableName };
  const createdAt = existing?.createdAt ?? deps.turns.clock.now().toISOString();
  const messageSeq = existing?.seq ?? await allocateSeq(mailbox, turn.tenantId, turn.channelId);
  await appendLine(
    session.harness,
    {
      seq: messageSeq,
      messageId,
      authorKind: "bot",
      authorId: turn.botId,
      addressedToBotId: null,
      createdAt,
      entryId: answerEntryId
    },
    context
  );
  for (const participant of inputs.channel.participants) {
    if (participant.kind !== "bot" || participant.actorId === turn.botId) continue;
    await put(mailbox, {
      tenantId: turn.tenantId,
      botId: participant.actorId,
      channelId: turn.channelId,
      seq: messageSeq,
      messageId,
      authorKind: "bot",
      authorId: turn.botId,
      addressedToBotId: null,
      body,
      createdAt
    });
  }
  return { messageSeq, body };
}

// conversation/src/domain/actions.ts
var WORKSPACE_GATE = "workspace";
var BROWSER_GATE = "browser";
function gateForComputerTool(toolName) {
  return BROWSER_ACTION_KINDS.has(toolName) ? BROWSER_GATE : WORKSPACE_GATE;
}
function envelopeForCall(toolName, arguments_) {
  const idempotent = toolName === "read_workspace" || BROWSER_ACTION_KINDS.has(toolName);
  return {
    tool: toolName,
    idempotent,
    ...arguments_["path"] === void 0 ? {} : { path: arguments_["path"] },
    ...toolName === "run_terminal" ? { cwd: (arguments_["cwd"] ?? "/workspace").trim() || "/workspace" } : {},
    ...arguments_["url"] === void 0 ? {} : { origin: arguments_["url"] }
  };
}
async function requestComputerAction(deps, request) {
  const proposed = {
    actionId: deps.ids.next(),
    tenantId: request.tenantId,
    computerId: request.computerId,
    turnId: request.turnId,
    channelId: request.channelId,
    botId: request.botId,
    userId: request.userId,
    callId: request.callId,
    toolName: request.toolName,
    arguments: { ...request.arguments },
    gate: gateForComputerTool(request.toolName),
    envelope: envelopeForCall(request.toolName, request.arguments),
    status: "requested",
    claimedBy: null,
    leaseExpiresAt: null,
    result: null,
    resultIsError: false,
    createdAt: deps.clock.now(),
    completedAt: null
  };
  return (await deps.actions.createIfAbsent(proposed)).action;
}

// conversation/src/domain/workers.ts
var COST_CLASS_RANK = { local: 0, ec2: 1, fargate: 2 };
var AWS_COST_CLASSES = /* @__PURE__ */ new Set(["ec2", "fargate"]);
async function healthyWorkers(tenantId, deps) {
  const now = deps.clock.now().getTime();
  const healthy = [];
  for (const record of await deps.store.listWorkers(tenantId)) {
    if (now - record.lastHeartbeatAt.getTime() > deps.heartbeatTimeoutSeconds * 1e3) {
      continue;
    }
    healthy.push(record);
  }
  return healthy;
}
async function createTurnJob(request, deps) {
  let tenantId = request.tenantId;
  const botId = request.botId ?? null;
  if (botId !== null) {
    const bot = await deps.store.getBot(tenantId, botId);
    if (bot === null) {
      throw new Error(`Bot ${JSON.stringify(botId)} is not registered.`);
    }
    tenantId = bot.tenantId;
  }
  let computerId = request.computerId ?? null;
  let computerPolicy = request.computerPolicy ?? null;
  if (request.requiredCapabilities.has("computer")) {
    const computer = await ensureComputer(tenantId, deps);
    computerId ??= computer.computerId;
    computerPolicy ??= computer.policy;
  }
  return {
    jobId: deps.ids.next(),
    tenantId,
    requiredCapabilities: request.requiredCapabilities,
    computerPolicy: computerPolicy ?? "prefer_local",
    computerId,
    userId: request.userId ?? null,
    botId
  };
}
function workerSnapshotIsStale(record, computer) {
  if (record.costClass !== "local") {
    return false;
  }
  if (record.computerId !== computer.computerId) {
    return false;
  }
  if (computer.snapshotGeneration === 0) {
    return false;
  }
  return record.hydratedSnapshotGeneration === void 0 || record.hydratedSnapshotGeneration < computer.snapshotGeneration;
}
async function assignTurn(job, deps) {
  let candidates = (await healthyWorkers(job.tenantId, deps)).filter(
    (record) => [...job.requiredCapabilities].every((capability) => record.capabilities.includes(capability))
  );
  if (job.computerId !== null) {
    candidates = candidates.filter((record) => record.computerId === job.computerId);
    const organizationComputer = await deps.store.getComputer(job.tenantId);
    const computer = organizationComputer?.computerId === job.computerId ? organizationComputer : null;
    if (computer !== null) {
      if (computer.stopped) {
        return null;
      }
      candidates = candidates.filter((record) => !workerSnapshotIsStale(record, computer));
      if (computer.hydrateRequired) {
        if (computer.intendedHostWorkerId === void 0) {
          return null;
        }
        candidates = candidates.filter((record) => record.workerId === computer.intendedHostWorkerId);
      }
    }
  }
  if (job.computerPolicy === "local_only") {
    candidates = candidates.filter((record) => record.costClass === "local");
  } else if (job.computerPolicy === "aws_only") {
    candidates = candidates.filter((record) => AWS_COST_CLASSES.has(record.costClass));
  }
  candidates.sort(
    (left, right) => COST_CLASS_RANK[left.costClass] - COST_CLASS_RANK[right.costClass] || right.lastHeartbeatAt.getTime() - left.lastHeartbeatAt.getTime()
  );
  return candidates[0] ?? null;
}

// conversation/src/turn/park.ts
var resumeEnqueueId = (turnId, actionId) => `${turnId}#resume-${actionId}`;
var actionDependenciesOf = (deps) => ({
  actions: deps.computer.actions,
  clock: deps.turns.clock,
  ids: deps.turns.ids
});
async function computerWorkRefusal(deps, tenantId) {
  return computerWorkPauseReason(tenantId, {
    store: deps.messaging,
    rollups: deps.computer.rollups,
    environment: deps.computer.environment,
    clock: deps.turns.clock
  });
}
async function computerToolUnavailableText(deps, tenantId, call) {
  if (!BROWSER_ACTION_KINDS.has(call.toolName)) return null;
  return (await deps.messaging.getComputer(tenantId))?.browserUnavailable === true ? BROWSER_UNAVAILABLE_TEXT : null;
}
async function ensureHostForParkedTurn(deps, turn) {
  if (turn.promptAuthorId === null) {
    throw new Error(`Turn ${JSON.stringify(turn.turnId)} has no prompt author to start a computer for.`);
  }
  const liveOwner = await liveOwnerOfOrganization(turn.tenantId, {
    store: deps.messaging,
    clock: deps.turns.clock,
    heartbeatTimeoutSeconds: deps.computer.heartbeatTimeoutSeconds
  });
  if (liveOwner !== null) return false;
  const job = await createTurnJob(
    { tenantId: turn.tenantId, requiredCapabilities: /* @__PURE__ */ new Set(["computer"]), botId: turn.botId, userId: turn.promptAuthorId },
    { store: deps.messaging, ids: deps.turns.ids }
  );
  const host = await assignTurn(job, {
    store: deps.messaging,
    clock: deps.turns.clock,
    heartbeatTimeoutSeconds: deps.computer.heartbeatTimeoutSeconds
  });
  if (host !== null) return false;
  deps.faults?.maybeCrash("computer_start", "before");
  await deps.computer.computerStarts.enqueue({
    jobId: job.jobId,
    tenantId: job.tenantId,
    turnId: turn.turnId,
    botId: turn.botId,
    userId: turn.promptAuthorId,
    computerId: job.computerId ?? (await ensureComputer(turn.tenantId, { store: deps.messaging, ids: deps.turns.ids })).computerId,
    computerPolicy: job.computerPolicy,
    requiredCapabilities: [...job.requiredCapabilities]
  });
  deps.faults?.maybeCrash("computer_start", "after");
  return true;
}
async function resumeTurnForAction(deps, tenantId, turnId, actionId) {
  const cleared = await clearWaiting(deps.turns, tenantId, turnId);
  if (cleared === null) return false;
  await requestLogicalEnqueue(
    { recorder: deps.turns.store, turnRuns: deps.turnRuns, faults: deps.faults },
    runJobFor(cleared),
    resumeEnqueueId(turnId, actionId)
  );
  await armProbe(deps.turnProbes, cleared, TURN_DEADLINE_SECONDS);
  return true;
}
async function parkOnComputerAction(deps, turn, attemptId, call) {
  const computer = await ensureComputer(turn.tenantId, { store: deps.messaging, ids: deps.turns.ids });
  deps.faults?.maybeCrash("computer_action", "before");
  const action = await requestComputerAction(actionDependenciesOf(deps), {
    tenantId: turn.tenantId,
    computerId: computer.computerId,
    turnId: turn.turnId,
    channelId: turn.channelId,
    botId: turn.botId,
    userId: turn.promptAuthorId,
    callId: call.callId,
    toolName: call.toolName,
    arguments: call.arguments
  });
  deps.faults?.maybeCrash("computer_action", "after");
  deps.faults?.maybeCrash("computer_park", "before");
  await releaseForWaiting(deps.turns, turn.tenantId, turn.turnId, attemptId, action.gate, {
    actionId: action.actionId,
    toolName: action.toolName,
    arguments: { ...action.arguments }
  });
  deps.faults?.maybeCrash("computer_park", "after");
  await ensureHostForParkedTurn(deps, turn);
  const current = await deps.computer.actions.get(turn.tenantId, action.actionId);
  if (current?.status === "done") {
    await resumeTurnForAction(deps, turn.tenantId, turn.turnId, action.actionId);
  }
  return current ?? action;
}

// conversation/src/turn/probes.ts
var MAXIMUM_PROBE_DELAY_SECONDS = 900;
var WAITING_LIMIT_SECONDS = 15 * 60;
var yieldEnqueueId = (turnId, attempt) => `${turnId}#yield-${attempt}`;
async function requestLogicalEnqueue(deps, job, enqueueId, fence) {
  deps.faults?.maybeCrash("logical_enqueue", "before");
  if (!await deps.recorder.recordLogicalEnqueue(job.tenantId, job.turnId, enqueueId, fence)) return false;
  deps.faults?.maybeCrash("logical_enqueue", "after");
  await deps.turnRuns.enqueue(job);
  return true;
}
var clampDelay = (seconds) => Math.min(MAXIMUM_PROBE_DELAY_SECONDS, Math.max(1, Math.ceil(seconds)));
async function armProbe(probes, turn, delaySeconds) {
  await probes.send(
    { tenantId: turn.tenantId, turnId: turn.turnId, kind: "deadline", expectAttempt: turn.attempt },
    clampDelay(delaySeconds)
  );
}
var runJobFor = (turn) => ({
  tenantId: turn.tenantId,
  channelId: turn.channelId,
  botId: turn.botId,
  turnId: turn.turnId,
  requiredCapabilities: ["cpu"]
});

// conversation/src/turn/prompt.ts
var COMPUTER_GUIDANCE_LINES = [
  "The organization has a computer. Its /workspace folder is a persistent workspace that all teammates share. Files there stay between turns.",
  "Git and a C toolchain (gcc, g++, make) are installed. Use run_terminal to run shell commands in /workspace.",
  "To change an existing file, use edit_workspace. To create a new file, use write_workspace.",
  "To run code, write it to /workspace, then compile and run it with run_terminal.",
  "Before you say that something cannot run on the computer, try it with run_terminal and tell the user what happened. Do not rely on what you said earlier."
];
function buildSystemPrompt(subject) {
  const memoryLines = Object.keys(subject.memory).sort().map((key) => `memory ${key}: ${subject.memory[key]}`);
  return [`You are ${subject.botName}, a teammate in a Chatticus conversation. Answer briefly.`, ...COMPUTER_GUIDANCE_LINES, ...memoryLines].join("\n");
}

// conversation/src/turn/yield.ts
var DEFAULT_YIELD_BELOW_MILLISECONDS = 3e4;
async function yieldAttempt(deps, tenantId, turnId, attemptId) {
  const turn = await getTurn(deps.turns, tenantId, turnId);
  await relinquishTurn(deps.turns, tenantId, turnId, attemptId);
  await requestLogicalEnqueue(
    { recorder: deps.turns.store, turnRuns: deps.turnRuns, faults: deps.faults },
    runJobFor(turn),
    yieldEnqueueId(turnId, turn.attempt)
  );
  await armProbe(deps.turnProbes, turn, TURN_DEADLINE_SECONDS);
}

// conversation/src/turn/executor.ts
var DEFAULT_EXECUTOR_TUNING = {
  renewIntervalMilliseconds: 2e4,
  mailboxPollMilliseconds: 500,
  yieldBelowMilliseconds: DEFAULT_YIELD_BELOW_MILLISECONDS,
  tokenFlushBytes: DEFAULT_TOKEN_FLUSH_BYTES,
  tokenFlushMilliseconds: DEFAULT_TOKEN_FLUSH_MILLISECONDS,
  retry: { maxRetries: 2, baseDelayMilliseconds: 1e3 },
  compaction: { keepRecentTokens: 2e4 }
};
var EVENT_DELIVERY_WAIT_MILLISECONDS = 2e3;
var MISSING_PROMPT_REASON = "The message this turn was meant to answer is missing.";
var MISSING_SUBJECT_REASON = "The bot or the channel of this turn no longer exists.";
var UNCERTAIN_COMMIT_REASON = "The conversation could not confirm its last write; the turn is being reconciled.";
var OWNER_CLOSED_FOR_HANDOFF = "The owner closed to hand the turn to the computer.";
var AttemptLost = class extends Error {
  constructor() {
    super("Another attempt now owns this turn.");
    this.name = "AttemptLost";
  }
};
var draftOf = (item) => ({
  seq: item.seq,
  messageId: item.messageId,
  authorKind: item.authorKind,
  authorId: item.authorId,
  addressedToBotId: item.addressedToBotId,
  createdAt: item.createdAt
});
var delay = (milliseconds) => {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  return { promise, cancel: () => clearTimeout(timer) };
};
var TurnAttempt = class {
  job;
  deps;
  tuning;
  attemptId;
  turn;
  context;
  mailbox;
  writer;
  coalescer;
  thinkingCoalescer;
  delivery = new AgentEventDelivery();
  inputs = [];
  lost;
  signalLost = () => void 0;
  renewTimer = null;
  renewing = false;
  fatal = null;
  parkCall = null;
  parkRequested;
  signalPark = () => void 0;
  session = null;
  root = null;
  stream = null;
  bot = null;
  channel = null;
  constructor(job, deps, tuning, attemptId, turn) {
    this.job = job;
    this.deps = deps;
    this.tuning = tuning;
    this.attemptId = attemptId;
    this.turn = turn;
    this.context = deps.context ?? BACKGROUND_CONTEXT3;
    this.mailbox = { client: deps.client, tableName: deps.messagingTableName };
    this.writer = new TurnEventWriter(deps.turns, job.tenantId, job.turnId, attemptId);
    this.coalescer = new TokenCoalescer({
      flushBytes: tuning.tokenFlushBytes,
      flushMilliseconds: tuning.tokenFlushMilliseconds,
      write: async (text3) => {
        deps.faults?.maybeCrash("progress_append", "before");
        await this.writer.write({ kind: "turn.token", token: text3 });
        deps.faults?.maybeCrash("progress_append", "after");
      }
    });
    this.thinkingCoalescer = new TokenCoalescer({
      flushBytes: tuning.tokenFlushBytes,
      flushMilliseconds: tuning.tokenFlushMilliseconds,
      write: async (text3) => {
        await this.writer.write({ kind: "turn.thinking", text: redactSecrets(text3) });
      }
    });
    this.lost = new Promise((_resolve, reject) => {
      this.signalLost = () => reject(new AttemptLost());
    });
    this.lost.catch(() => void 0);
    this.parkRequested = new Promise((resolve) => {
      this.signalPark = resolve;
    });
  }
  async run() {
    try {
      return await this.execute();
    } catch (error) {
      return await this.settleError(error);
    } finally {
      await this.cleanup();
    }
  }
  async execute() {
    const { messaging } = this.deps;
    const bot = await messaging.getBot(this.job.tenantId, this.job.botId);
    const channel = await messaging.getChannel(this.job.tenantId, this.turn.channelId);
    if (bot === null || channel === null) return this.fail(MISSING_SUBJECT_REASON);
    const { prices } = this.deps.ledger;
    if (prices.lookup(this.deps.model.provider, this.deps.model.modelId) === null) {
      return this.fail(
        `No price is tabled for model ${this.deps.model.provider}/${this.deps.model.modelId} in price book ${prices.priceBookId}, so the turn was not run.`
      );
    }
    this.bot = bot;
    this.channel = channel;
    const sessionDependencies = {
      client: this.deps.client,
      s3: this.deps.s3,
      tableName: this.deps.conversationsTableName,
      bucket: this.deps.piSessionsBucket,
      models: this.deps.models,
      extensions: this.deps.executionProfile === "computerless" ? chatticusExtensions({ systemPrompt: () => buildSystemPrompt({ botName: bot.name, memory: bot.memory }) }) : [
        ...chatticusExtensions({
          systemPrompt: () => buildSystemPrompt({ botName: bot.name, memory: bot.memory })
        }),
        ...taskToolExtensions(
          { tenantId: this.job.tenantId, userId: primaryHumanParticipant(channel), botId: this.job.botId },
          { store: messaging, ids: this.deps.turns.ids }
        ),
        ...this.deps.boards === void 0 ? [] : botBoardToolExtensions(
          { organizationId: this.job.tenantId, botId: this.job.botId, turnId: this.job.turnId },
          this.deps.boards
        ),
        (this.deps.computerTools ?? computerToolsExtension)(this.computerHandoff()),
        toolGateExtension(this.toolGateDependencies())
      ],
      context: this.context,
      env: this.deps.env,
      settings: {
        retry: { maxRetries: this.tuning.retry.maxRetries, baseDelayMs: this.tuning.retry.baseDelayMilliseconds },
        compaction: { keepRecentTokens: this.tuning.compaction.keepRecentTokens }
      }
    };
    const session = await (this.deps.sessionFactory ?? openOwnerSession)(
      storageIdFor(this.job.tenantId, this.job.botId, this.turn.channelId),
      sessionDependencies
    );
    this.session = session;
    await recordStorageFence(this.deps.turns, this.job.tenantId, this.job.turnId, this.attemptId, session.fence);
    await this.readJournal();
    await this.writer.write({ kind: "attempt.claimed", attemptId: this.attemptId });
    if (this.delivery.computerStarting) {
      this.delivery.setComputerStartingOutstanding(false);
      await this.writer.write({ kind: "computer.ready", detail: "Computer ready" });
    }
    this.writer.throwIfFailed();
    const agent = {
      model: { provider: this.deps.model.provider, modelId: this.deps.model.modelId },
      thinkingLevel: this.deps.model.thinkingLevel
    };
    const root = await session.harness.root(this.context, { agent });
    this.root = root;
    await root.configure(agent, this.context);
    this.stream = await watchEvents(session.harness, root.id, this.context);
    this.stream.start(createAgentEventListener(this.writer, this.coalescer, this.thinkingCoalescer, this.attemptId, this.delivery));
    this.renewTimer = setInterval(() => void this.renew(), this.tuning.renewIntervalMilliseconds);
    return this.drive(session, root);
  }
  async drive(session, root) {
    if (this.turn.attempt > 1) await recordTurnCost(this.finalizeInputs(session, root), "resumed");
    this.deps.faults?.maybeCrash("model_acceptance", "before");
    await this.pumpMailbox(session, root);
    if (!this.inputs.some((input) => input.isPrompt)) {
      await this.adoptSubmittedPrompt(root);
    }
    if (!this.inputs.some((input) => input.isPrompt)) return this.fail(MISSING_PROMPT_REASON);
    let closing = false;
    for (; ; ) {
      await this.waitForProgress();
      await this.guard(session);
      if (this.parkCall !== null) return this.parkOnComputer(this.parkCall);
      if (this.mustYield()) return this.yieldTurn();
      await this.pumpMailbox(session, root);
      if (this.inputs.some((input) => input.settled === null)) continue;
      if (!closing) {
        await beginClosing(this.deps.turns, this.job.tenantId, this.job.turnId, this.attemptId);
        closing = true;
        await this.pumpMailbox(session, root);
        if (this.inputs.some((input) => input.settled === null)) continue;
      }
      break;
    }
    return this.conclude(session, root);
  }
  async conclude(session, root) {
    await this.delivery.untilSettled(this.inputs[this.inputs.length - 1].submission.id, EVENT_DELIVERY_WAIT_MILLISECONDS);
    this.deps.faults?.maybeCrash("model_acceptance", "after");
    await this.flushStreams();
    await this.guard(session);
    if (!await renewAttempt(this.deps, this.job.tenantId, this.job.turnId, this.attemptId)) {
      throw new AttemptLost();
    }
    const last = this.inputs[this.inputs.length - 1].settled;
    if (last.type !== "input" || last.status !== "done") {
      if (last.status === "unanswered" && last.reason === "model_error") {
        const { status, code, message } = summarizeProviderFailure(last.detail);
        console.info(formatLogLine("provider_failed", { turn_id: this.job.turnId, status, code, message }));
        return this.fail(classifyModelFailure(last.detail));
      }
      return this.fail(`The turn was not answered (${last.status === "unanswered" ? last.reason : last.status}).`);
    }
    const inputs = this.finalizeInputs(session, root);
    this.deps.faults?.maybeCrash("completion_append", "before");
    const reply = await commitFinalAnswer(inputs, last.answer);
    await recordTurnCost(inputs, "completed", reply.messageSeq);
    this.deps.faults?.maybeCrash("completion_append", "after");
    await completeTurn(this.deps.turns, this.job.tenantId, this.job.turnId, this.attemptId, reply.messageSeq, reply.body);
    return "done";
  }
  toolGateDependencies() {
    const policy = new PolicyControl({
      policyStore: new DynamoPolicyStore(this.deps.client, this.deps.messagingTableName),
      store: this.deps.messaging,
      clock: this.deps.turns.clock,
      ids: this.deps.turns.ids
    });
    const { tenantId, turnId } = this.job;
    const promptAuthorId = this.turn.promptAuthorId;
    return {
      now: () => this.deps.turns.clock.now(),
      readGrant: () => turnCapabilityGrant(this.deps, tenantId, turnId),
      resolveStanding: (actionType) => {
        if (promptAuthorId === null) {
          throw new MemberStandingRequiredError(`Turn '${turnId}' has no prompt message.`);
        }
        return policy.memberStandingForUser(tenantId, promptAuthorId, actionType);
      }
    };
  }
  parkDependencies() {
    const computer = this.deps.computer;
    if (computer === void 0) throw new Error("Computer handoff is unavailable for this execution profile.");
    return {
      turns: this.deps.turns,
      messaging: this.deps.messaging,
      turnRuns: this.deps.turnRuns,
      turnProbes: this.deps.turnProbes,
      computer,
      faults: this.deps.faults
    };
  }
  computerHandoff() {
    if (this.deps.computer === void 0) throw new Error("Computer handoff is unavailable for this execution profile.");
    const { tenantId, turnId } = this.job;
    return {
      lookup: (call) => this.deps.computer.actions.getByCall(tenantId, turnId, call.callId),
      refusal: () => computerWorkRefusal(this.parkDependencies(), tenantId),
      unavailable: (call) => computerToolUnavailableText(this.parkDependencies(), tenantId, call),
      park: (call, abortSignal) => {
        this.parkCall ??= call;
        this.signalPark();
        return new Promise((_resolve, reject) => {
          if (abortSignal?.aborted) reject(new Error(OWNER_CLOSED_FOR_HANDOFF));
          abortSignal?.addEventListener("abort", () => reject(new Error(OWNER_CLOSED_FOR_HANDOFF)));
        });
      }
    };
  }
  /**
   * A resumed owner rereads the journal so the tool calls its predecessor already wrote are not written again when Pi
   * reports them once more, the reasoning summary already written counts against the turn's cap, and a
   * `computer.starting` that no `computer.ready` has answered is answered by this owner's claim.
   */
  async readJournal() {
    if (this.turn.attempt <= 1) return;
    let starting = false;
    for (const event of await this.deps.turns.store.listEvents(this.job.tenantId, this.job.turnId, 0)) {
      if (event.kind === "tool.call" && event.callId !== void 0) {
        this.delivery.claimCallJournal(event.callId);
        const bytes = event.toolArguments?.["bytes"];
        this.delivery.rememberCall(event.callId, { toolName: event.tool ?? "", writtenBytes: typeof bytes === "number" ? bytes : null });
      } else if (event.kind === "turn.thinking") {
        this.delivery.addThinkingCharacters((event.text ?? "").length);
      } else if (event.kind === "computer.starting") {
        starting = true;
      } else if (event.kind === "computer.ready") {
        starting = false;
      }
    }
    this.delivery.setComputerStartingOutstanding(starting);
  }
  /**
   * The turn called a computer tool that has no answer yet: record the action, park the turn and end this owner. The
   * harness is closed without aborting (the session's close), so the tool call stays pending for the next owner.
   */
  async parkOnComputer(call) {
    await this.flushStreams();
    await writeToolCallOnce(this.writer, this.delivery, call.callId, call.toolName, call.arguments);
    if (!this.delivery.computerStarting) {
      this.delivery.setComputerStartingOutstanding(true);
      await this.writer.write({ kind: "computer.starting", detail: "Starting your computer" });
    }
    await this.writer.idle();
    this.writer.throwIfFailed();
    await recordTurnCost(this.finalizeInputs(this.session, this.root), "parked");
    await parkOnComputerAction(this.parkDependencies(), this.turn, this.attemptId, call);
    return "parked";
  }
  async flushStreams() {
    await this.thinkingCoalescer.flush();
    await this.coalescer.flush();
  }
  mustYield() {
    const remaining = this.deps.remainingMilliseconds;
    if (remaining === void 0 || remaining() >= this.tuning.yieldBelowMilliseconds) return false;
    return this.inputs.some((input) => input.settled === null);
  }
  async yieldTurn() {
    await this.flushStreams();
    this.writer.throwIfFailed();
    await recordTurnCost(this.finalizeInputs(this.session, this.root), "yielded");
    await yieldAttempt(this.deps, this.job.tenantId, this.job.turnId, this.attemptId);
    return "yielded";
  }
  async fail(reason) {
    await this.flushStreams();
    this.writer.throwIfFailed();
    if (this.session !== null && this.root !== null) {
      await recordTurnCost(this.finalizeInputs(this.session, this.root), "failed");
    }
    await failTurn(this.deps.turns, this.job.tenantId, this.job.turnId, this.attemptId, reason);
    return "failed";
  }
  finalizeInputs(session, root) {
    return {
      deps: this.deps,
      turn: this.turn,
      attemptId: this.attemptId,
      bot: this.bot,
      channel: this.channel,
      session,
      root,
      context: this.context
    };
  }
  async settleError(thrown) {
    const error = findStorageFailure(thrown) ?? thrown;
    if (error instanceof CommitOutcomeUnknown) {
      try {
        await reconcileTurn(this.deps.turns, this.job.tenantId, this.job.turnId, this.attemptId, UNCERTAIN_COMMIT_REASON);
      } catch (inner) {
        if (inner instanceof StaleAttemptError || inner instanceof TurnTerminalError) {
          this.deps.observer?.lost?.("running");
          return "lost";
        }
        throw inner;
      }
      return "reconciling";
    }
    if (error instanceof AttemptLost || error instanceof OwnershipLost || error instanceof StaleAttemptError || error instanceof TurnTerminalError) {
      this.deps.observer?.lost?.("running");
      return "lost";
    }
    throw error;
  }
  async cleanup() {
    if (this.renewTimer !== null) clearInterval(this.renewTimer);
    await this.stream?.stop().catch(() => void 0);
    await this.session?.close().catch(() => void 0);
  }
  async guard(session) {
    if (this.fatal !== null) throw this.fatal;
    this.writer.throwIfFailed();
    await session.harness.commit(() => void 0, this.context);
  }
  async waitForProgress() {
    const pause = delay(this.tuning.mailboxPollMilliseconds);
    const waits = this.inputs.filter((input) => input.settled === null).map((input) => input.watching);
    try {
      await Promise.race([this.lost, this.parkRequested, pause.promise, ...waits]);
    } finally {
      pause.cancel();
    }
  }
  async renew() {
    if (this.renewing) return;
    this.renewing = true;
    try {
      if (!await renewAttempt(this.deps, this.job.tenantId, this.job.turnId, this.attemptId)) {
        this.signalLost();
      }
    } catch {
      return;
    } finally {
      this.renewing = false;
    }
  }
  track(requestId, isPrompt, item, submission) {
    const input = {
      requestId,
      isPrompt,
      item,
      submission,
      recorded: item === null,
      settled: null,
      watching: Promise.resolve()
    };
    input.watching = submission.wait(this.context).then(
      (record) => {
        input.settled = record;
      },
      (error) => {
        this.fatal ??= error;
      }
    );
    this.inputs.push(input);
  }
  async adoptSubmittedPrompt(root) {
    const requestId = `turn:${this.job.turnId}`;
    const existing = await root.commit((tx) => tx.submissionByRequest(root.id, requestId), this.context);
    if (existing === void 0) return;
    const submission = await root.submit({ type: "input", content: "", requestId }, this.context);
    this.track(requestId, true, null, submission);
  }
  async recordPending(session) {
    for (const input of this.inputs) {
      if (input.recorded || input.item === null) continue;
      const state = await recordInputLine(session.harness, draftOf(input.item), input.requestId, this.context);
      if (state === "pending") continue;
      await remove(this.mailbox, input.item);
      input.recorded = true;
    }
  }
  async pumpMailbox(session, root) {
    await this.recordPending(session);
    const tracked = new Set(this.inputs.map((input) => input.item?.messageId));
    const items = await list(this.mailbox, this.job.tenantId, this.job.botId, this.turn.channelId);
    for (const item of items) {
      if (tracked.has(item.messageId)) continue;
      const isPrompt = item.seq === this.turn.promptMessageSeq;
      if (isPrompt || item.addressedToBotId === this.job.botId) {
        const requestId = isPrompt ? `turn:${this.job.turnId}` : `msg:${item.messageId}`;
        const submission = await root.submit(
          isPrompt ? { type: "input", content: item.body, requestId } : { type: "input", content: item.body, requestId, whenBusy: "steer" },
          this.context
        );
        this.track(requestId, isPrompt, item, submission);
        tracked.add(item.messageId);
      } else if (this.inputs.every((input) => input.settled !== null)) {
        await writeAttributedMessage(session.harness, { ...draftOf(item), body: item.body }, this.context);
        await remove(this.mailbox, item);
      }
    }
    await this.recordPending(session);
  }
};
async function renewAttempt(deps, tenantId, turnId, attemptId) {
  if (await renewTurn(deps.turns, tenantId, turnId, attemptId) === null) return false;
  await deps.runVisibility.extend(tenantId, turnId);
  return true;
}
async function claimTurnAttempt(deps, job) {
  deps.faults?.maybeCrash("worker_claim", "before");
  const attemptId = deps.turns.ids.next();
  const claim = await claimTurn(deps.turns, job.tenantId, job.turnId, attemptId, deps.workerLabel ?? null);
  if (claim === null) return null;
  await armProbe(deps.turnProbes, claim.turn, ATTEMPT_LEASE_SECONDS);
  deps.faults?.maybeCrash("worker_claim", "after");
  return claim;
}
async function executeTurn(job, deps) {
  const tuning = { ...DEFAULT_EXECUTOR_TUNING, ...deps.tuning };
  const claim = await claimTurnAttempt(deps, job);
  if (claim === null) {
    deps.observer?.lost?.("claim");
    return "lost";
  }
  deps.observer?.claimed?.(claim.attemptId, claim.turn.attempt);
  return new TurnAttempt(job, deps, tuning, claim.attemptId, claim.turn).run();
}
async function consumeRunJob(job, deps, acknowledge) {
  const outcome = await executeTurn(job, deps);
  deps.faults?.maybeCrash("acknowledgement", "before");
  await acknowledge();
  deps.faults?.maybeCrash("acknowledgement", "after");
  return outcome;
}
export {
  Decimal,
  VendorPriceBook,
  consumeRunJob
};
