// conversation/src/runtime/site-hosted-chat.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { DynamoDBClient as DynamoDBClient3 } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient as SSMClient2 } from "@aws-sdk/client-ssm";

// conversation/src/store/dynamo-messaging-store.ts
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand as GetItemCommand2,
  PutItemCommand as PutItemCommand2,
  QueryCommand as QueryCommand2,
  ScanCommand as ScanCommand2,
  TransactionCanceledException as TransactionCanceledException2,
  TransactWriteItemsCommand,
  UpdateItemCommand
} from "@aws-sdk/client-dynamodb";

// conversation/src/budget/budget-store.ts
import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand
} from "@aws-sdk/client-dynamodb";

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

// conversation/src/budget/models.ts
var BILLED_VIA_VENDOR = "vendor";
var CE_STATUS_OK = "ok";
function organizationRunsInItsOwnAwsAccount(organization) {
  return organization.awsCrossAccountRole !== null && organization.awsCrossAccountRole !== "";
}

// conversation/src/budget/budget-store.ts
function vendorLedgerKey(tenantId, turnId) {
  return { pk: `${tenantId}#vendor_ledger`, sk: `turn#${turnId}` };
}
function computerRuntimeKey(tenantId, ownerGeneration) {
  return { pk: `${tenantId}#computer_runtime`, sk: `generation#${String(ownerGeneration).padStart(10, "0")}` };
}
function computerRuntimeSegmentItem(segment, ownerId) {
  return {
    ...keyOf(computerRuntimeKey(segment.tenantId, segment.ownerGeneration)),
    tenant_id: { S: segment.tenantId },
    owner_generation: { N: String(segment.ownerGeneration) },
    owner_id: { S: ownerId },
    started_at: { S: segment.startedAt.toISOString() },
    last_seen_at: { S: segment.lastSeenAt.toISOString() }
  };
}
function requireInstant(item, name) {
  const moment = new Date(requireString(item, name));
  if (Number.isNaN(moment.getTime())) {
    throw new Error(`Item attribute ${name} is not a date-time.`);
  }
  return moment;
}
function computerRuntimeSegmentFromItem(item) {
  return {
    tenantId: requireString(item, "tenant_id"),
    ownerGeneration: Number(requireNumber(item, "owner_generation")),
    startedAt: requireInstant(item, "started_at"),
    lastSeenAt: requireInstant(item, "last_seen_at")
  };
}
async function queryComputerRuntimeSegments(client, tableName, tenantId) {
  const segments = [];
  let startKey;
  do {
    const response = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: `${tenantId}#computer_runtime` } },
        ConsistentRead: true,
        ExclusiveStartKey: startKey
      })
    );
    for (const item of response.Items ?? []) {
      segments.push(computerRuntimeSegmentFromItem(item));
    }
    startKey = response.LastEvaluatedKey;
  } while (startKey !== void 0);
  return segments;
}
function keyOf(key) {
  return { pk: { S: key.pk }, sk: { S: key.sk } };
}
function requireString(item, name) {
  const value = item[name]?.S;
  if (value === void 0) {
    throw new Error(`Item is missing string attribute ${name}.`);
  }
  return value;
}
function requireNumber(item, name) {
  const value = item[name]?.N;
  if (value === void 0) {
    throw new Error(`Item is missing number attribute ${name}.`);
  }
  return value;
}

// conversation/src/http/errors.ts
var DomainError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = this.constructor.name;
  }
};
var WorkerRegistrationRefusedError = class extends DomainError {
  constructor(message) {
    super("worker_registration_refused", message);
  }
};
var WorkerNotRegisteredError = class extends DomainError {
  constructor(message) {
    super("worker_not_registered", message);
  }
};
var DuplicateBotNameError = class extends DomainError {
  constructor(message) {
    super("duplicate_bot_name", message);
  }
};
var ChannelNotFoundError = class extends DomainError {
  constructor(message) {
    super("channel_not_found", message);
  }
};
var ChannelTenantMismatchError = class extends DomainError {
  constructor(message) {
    super("channel_tenant_mismatch", message);
  }
};
var InvalidChannelIdentityError = class extends DomainError {
  constructor(message) {
    super("invalid_channel_identity", message);
  }
};
var ActorNotInChannelError = class extends DomainError {
  constructor(message) {
    super("actor_not_in_channel", message);
  }
};
var IdempotencyKeyReuseError = class extends DomainError {
  constructor(message) {
    super("idempotency_key_reused", message);
  }
};
var IdempotencyReservationBusyError = class extends DomainError {
  constructor(message) {
    super("idempotency_reservation_busy", message);
  }
};
var TurnNotFoundError = class extends DomainError {
  constructor(message) {
    super("turn_not_found", message);
  }
};
var TurnAccessDeniedError = class extends DomainError {
  constructor(message) {
    super("turn_access_denied", message);
  }
};
var StaleAttemptError = class extends DomainError {
  constructor(message) {
    super("stale_attempt", message);
  }
};
var TurnClaimDeniedError = class extends DomainError {
  constructor(message) {
    super("turn_claim_denied", message);
  }
};
var TurnReconcilingError = class extends DomainError {
  constructor(message) {
    super("turn_reconciling", message);
  }
};
var TurnTerminalError = class extends DomainError {
  constructor(message) {
    super("turn_terminal", message);
  }
};
var TurnNotWaitingError = class extends DomainError {
  constructor(message) {
    super("turn_not_waiting", message);
  }
};
var ComputerNotReadyError = class extends DomainError {
  constructor(message) {
    super("computer_not_ready", message);
  }
};
var TaskNotFoundError = class extends DomainError {
  constructor(message) {
    super("task_not_found", message);
  }
};
var TaskAccessDeniedError = class extends DomainError {
  constructor(message) {
    super("task_access_denied", message);
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
var GrantExceedsMemberStandingError = class extends DomainError {
  constructor(message) {
    super("grant_exceeds_member_standing", message);
  }
};
var OrganizationNotFoundError = class extends DomainError {
  constructor(message) {
    super("organization_not_found", message);
  }
};
var OrganizationStatusTransitionError = class extends DomainError {
  constructor(message) {
    super("organization_status_transition", message);
  }
};
var NotOrganizationOwnerError = class extends DomainError {
  constructor(message) {
    super("not_organization_owner", message);
  }
};
var OrganizationOwnerCapError = class extends DomainError {
  constructor(message) {
    super("organization_owner_cap", message);
  }
};
var OrganizationCreationRateLimitedError = class extends DomainError {
  constructor(message) {
    super("organization_creation_rate_limited", message);
  }
};
var OrganizationNameTooLongError = class extends DomainError {
  constructor(message) {
    super("organization_name_too_long", message);
  }
};
var WaitlistRateLimitedError = class extends DomainError {
  constructor(message) {
    super("waitlist_rate_limited", message);
  }
};
var ComputerActionNotFoundError = class extends DomainError {
  constructor(message) {
    super("computer_action_not_found", message);
  }
};
var ComputerActionNotClaimedError = class extends DomainError {
  constructor(message) {
    super("computer_action_not_claimed", message);
  }
};
var ComputerNotFoundError = class extends DomainError {
  constructor(message) {
    super("computer_not_found", message);
  }
};
var CapabilitySinkDenied = class extends DomainError {
  constructor(message) {
    super("capability_sink_denied", message);
  }
};
function statusFor(error) {
  if (error instanceof CapabilitySinkDenied) {
    return 403;
  }
  if (error instanceof ChannelTenantMismatchError || error instanceof TurnAccessDeniedError || error instanceof ActorNotInChannelError) {
    return 403;
  }
  if (error instanceof TaskAccessDeniedError) {
    return 403;
  }
  if (error instanceof WorkerRegistrationRefusedError) {
    return 403;
  }
  if (error instanceof MemberStandingRequiredError || error instanceof GrantExceedsMemberStandingError) {
    return 403;
  }
  if (error instanceof TaskNotFoundError || error instanceof WorkerNotRegisteredError || error instanceof ComputerActionNotFoundError || error instanceof ComputerNotFoundError) {
    return 404;
  }
  if (error instanceof ComputerActionNotClaimedError) {
    return 409;
  }
  if (error instanceof IdempotencyKeyReuseError) {
    return 409;
  }
  if (error instanceof IdempotencyReservationBusyError) {
    return 409;
  }
  if (error instanceof StaleAttemptError || error instanceof TurnClaimDeniedError) {
    return 409;
  }
  if (error instanceof TurnReconcilingError || error instanceof TurnTerminalError || error instanceof TurnNotWaitingError || error instanceof ComputerNotReadyError) {
    return 409;
  }
  if (error instanceof ChannelNotFoundError || error instanceof TurnNotFoundError) {
    return 404;
  }
  if (error instanceof OrganizationNotFoundError) {
    return 404;
  }
  if (error instanceof OrganizationOwnerCapError) {
    return 409;
  }
  if (error instanceof OrganizationStatusTransitionError) {
    return 409;
  }
  if (error instanceof OrganizationCreationRateLimitedError) {
    return 429;
  }
  if (error instanceof WaitlistRateLimitedError) {
    return 429;
  }
  if (error instanceof OrganizationNameTooLongError) {
    return 400;
  }
  if (error instanceof NotOrganizationOwnerError) {
    return 403;
  }
  return 400;
}

// conversation/src/store/codecs/util.ts
function formatIsoDateTime(date) {
  const iso = date.toISOString();
  const withoutZ = iso.slice(0, -1);
  const noMillis = withoutZ.replace(/\.\d{3}$/, "");
  return noMillis + "+00:00";
}
function stringifyPythonStyle(value) {
  const json = JSON.stringify(value);
  return json.replace(/,(?=\S)/g, ", ").replace(/:(?=\S)/g, ": ");
}

// conversation/src/store/codecs/bot.ts
function encode(value) {
  return {
    pk: { S: `${value.tenantId}#roster` },
    sk: { S: `bot#${value.botId}` },
    tenant_id: { S: value.tenantId },
    bot_id: { S: value.botId },
    name: { S: value.name },
    memory: { S: stringifyPythonStyle(value.memory) },
    ...value.boardArchivedAt === void 0 ? {} : { board_archived_at: { S: value.boardArchivedAt.toISOString() } }
  };
}
function decode(item) {
  const botId = item.bot_id?.S;
  if (!botId) {
    throw new Error("malformed bot item: bot_id");
  }
  const tenantId = item.tenant_id?.S;
  if (!tenantId) {
    throw new Error("malformed bot item: tenant_id");
  }
  const name = item.name?.S;
  if (!name) {
    throw new Error("malformed bot item: name");
  }
  const memoryRaw = item.memory?.S ?? "{}";
  let memory = {};
  try {
    const parsed = JSON.parse(memoryRaw);
    if (typeof parsed === "object" && parsed !== null) {
      memory = Object.fromEntries(
        Object.entries(parsed).map(([key, val]) => [String(key), String(val)])
      );
    }
  } catch {
    memory = {};
  }
  return {
    botId,
    tenantId,
    name,
    memory,
    ...item.board_archived_at?.S === void 0 ? {} : { boardArchivedAt: new Date(item.board_archived_at.S) }
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
function requireString2(item, attribute, kind) {
  const value = item[attribute]?.S;
  if (value === void 0 || value === "") {
    throw new Error(`malformed ${kind} item: ${attribute}`);
  }
  return value;
}

// conversation/src/store/codecs/channel.ts
function messageSortKey(seq) {
  return `msg#${String(seq).padStart(10, "0")}`;
}
function encodeChannel(channel) {
  const item = {
    pk: { S: `${channel.tenantId}#channel#${channel.channelId}` },
    sk: { S: "meta" },
    tenant_id: { S: channel.tenantId },
    channel_id: { S: channel.channelId },
    kind: { S: channel.kind },
    next_seq: { N: String(channel.nextSeq) },
    participants: {
      S: stringifyPythonStyle(
        channel.participants.map((participant) => ({ kind: participant.kind, actor_id: participant.actorId }))
      )
    }
  };
  if (channel.name !== null) {
    item.name = { S: channel.name };
  }
  return item;
}
function decodeChannel(item) {
  const participants = JSON.parse(requireString2(item, "participants", "channel"));
  const nextSeq = item.next_seq?.N;
  if (nextSeq === void 0) {
    throw new Error("malformed channel item: next_seq");
  }
  return {
    channelId: requireString2(item, "channel_id", "channel"),
    tenantId: requireString2(item, "tenant_id", "channel"),
    kind: requireString2(item, "kind", "channel"),
    name: item.name?.S ?? null,
    participants: participants.map((row) => ({ kind: row.kind, actorId: row.actor_id })),
    nextSeq: Number(nextSeq)
  };
}
function encodeMessage(message) {
  return {
    pk: { S: `${message.tenantId}#channel#${message.channelId}` },
    sk: { S: messageSortKey(message.seq) },
    tenant_id: { S: message.tenantId },
    channel_id: { S: message.channelId },
    message_id: { S: message.messageId },
    seq: { N: String(message.seq) },
    author_kind: { S: message.authorKind },
    author_id: { S: message.authorId },
    body: { S: message.body },
    addressed_to_bot_id: { S: message.addressedToBotId ?? "" },
    created_at: { S: formatIsoDateTime(message.createdAt) }
  };
}
function decodeMessage(item) {
  return {
    messageId: requireString2(item, "message_id", "message"),
    channelId: requireString2(item, "channel_id", "message"),
    tenantId: requireString2(item, "tenant_id", "message"),
    seq: Number(item.seq?.N),
    authorKind: requireString2(item, "author_kind", "message"),
    authorId: requireString2(item, "author_id", "message"),
    body: item.body?.S ?? "",
    addressedToBotId: item.addressed_to_bot_id?.S || null,
    createdAt: new Date(requireString2(item, "created_at", "message"))
  };
}

// conversation/src/store/codecs/computer.ts
var OWNER_ATTRIBUTE_NAMES = [
  "owner_id",
  "owner_protocol_version",
  "owner_started_at",
  "owner_credentials_expire_at",
  "owner_credentials_renewed_at",
  "dispatch_credentials_renewed_at",
  "idle_since_at",
  "owner_stop_approved_at",
  "dispatch_id",
  "dispatch_turn_id",
  "dispatch_action_id",
  "dispatch_attempt",
  "dispatch_lease_expires_at",
  "interactive_until_at",
  "file_operation_id"
];
var epochSeconds = (moment) => ({ N: String(Math.floor(moment.getTime() / 1e3)) });
var dateFromSeconds = (attribute) => attribute?.N === void 0 ? void 0 : new Date(Number(attribute.N) * 1e3);
var optionalDate = (key, value) => value === void 0 ? {} : { [key]: value };
function encode2(value) {
  const item = {
    pk: { S: `${value.tenantId}#computer#${value.computerId}` },
    sk: { S: "meta" },
    tenant_id: { S: value.tenantId },
    computer_id: { S: value.computerId },
    stopped: { BOOL: value.stopped },
    policy: { S: value.policy },
    model_ready: { BOOL: value.modelReady },
    workspace_ready: { BOOL: value.workspaceReady },
    browser_ready: { BOOL: value.browserReady },
    host_start_generation: { N: String(value.hostStartGeneration) },
    host_start_dispatched_generation: { N: String(value.hostStartDispatchedGeneration) },
    host_start_lease_expires_at: { N: String(
      value.hostStartLeaseExpiresAt ? Math.floor(value.hostStartLeaseExpiresAt.getTime() / 1e3) : 0
    ) },
    snapshot_generation: { N: String(value.snapshotGeneration) },
    disk_dirty: { BOOL: value.diskDirty },
    hydrate_required: { BOOL: value.hydrateRequired }
  };
  if (value.browserUnavailable === true) {
    item.browser_unavailable = { BOOL: true };
  }
  if (value.snapshotUri !== void 0) {
    item.snapshot_uri = { S: value.snapshotUri };
  }
  if (value.snapshotChecksum !== void 0) {
    item.snapshot_checksum = { S: value.snapshotChecksum };
  }
  if (value.intendedHostWorkerId !== void 0) {
    item.intended_host_worker_id = { S: value.intendedHostWorkerId };
  }
  if (value.liveWriterHostId !== void 0) {
    item.live_writer_host_id = { S: value.liveWriterHostId };
  }
  if (value.hostLostAt !== void 0) {
    item.host_lost_at = { N: String(Math.floor(value.hostLostAt.getTime() / 1e3)) };
  }
  if (value.hostLostGeneration !== void 0) {
    item.host_lost_generation = { N: String(value.hostLostGeneration) };
  }
  if (value.ownerId !== void 0) item.owner_id = { S: value.ownerId };
  if (value.ownerGeneration !== void 0) item.owner_generation = { N: String(value.ownerGeneration) };
  if (value.ownerProtocolVersion !== void 0) item.owner_protocol_version = { N: String(value.ownerProtocolVersion) };
  if (value.ownerStartedAt !== void 0) item.owner_started_at = epochSeconds(value.ownerStartedAt);
  if (value.ownerCredentialsExpireAt !== void 0) item.owner_credentials_expire_at = epochSeconds(value.ownerCredentialsExpireAt);
  if (value.ownerCredentialsRenewedAt !== void 0) item.owner_credentials_renewed_at = epochSeconds(value.ownerCredentialsRenewedAt);
  if (value.dispatchCredentialsRenewedAt !== void 0) item.dispatch_credentials_renewed_at = epochSeconds(value.dispatchCredentialsRenewedAt);
  if (value.idleSinceAt !== void 0) item.idle_since_at = epochSeconds(value.idleSinceAt);
  if (value.ownerStopApprovedAt !== void 0) item.owner_stop_approved_at = epochSeconds(value.ownerStopApprovedAt);
  if (value.dispatchId !== void 0) item.dispatch_id = { S: value.dispatchId };
  if (value.dispatchTurnId !== void 0) item.dispatch_turn_id = { S: value.dispatchTurnId };
  if (value.dispatchActionId !== void 0) item.dispatch_action_id = { S: value.dispatchActionId };
  if (value.dispatchAttempt !== void 0) item.dispatch_attempt = { N: String(value.dispatchAttempt) };
  if (value.dispatchLeaseExpiresAt !== void 0) item.dispatch_lease_expires_at = epochSeconds(value.dispatchLeaseExpiresAt);
  if (value.interactiveUntilAt !== void 0) item.interactive_until_at = epochSeconds(value.interactiveUntilAt);
  if (value.fileOperationId !== void 0) item.file_operation_id = { S: value.fileOperationId };
  return item;
}
function decode2(item) {
  const computerId = item.computer_id?.S;
  if (!computerId) {
    throw new Error("malformed computer item: computer_id");
  }
  const tenantId = item.tenant_id?.S;
  if (!tenantId) {
    throw new Error("malformed computer item: tenant_id");
  }
  const policy = item.policy?.S;
  if (!policy) {
    throw new Error("malformed computer item: policy");
  }
  const stopped = item.stopped?.BOOL ?? false;
  const modelReady = item.model_ready?.BOOL ?? true;
  const workspaceReady = item.workspace_ready?.BOOL ?? false;
  const browserReady = item.browser_ready?.BOOL ?? false;
  const hostStartGeneration = item.host_start_generation?.N ? Number(item.host_start_generation.N) : 0;
  const hostStartDispatchedGeneration = item.host_start_dispatched_generation?.N ? Number(item.host_start_dispatched_generation.N) : 0;
  const leaseEpoch = item.host_start_lease_expires_at?.N ? Number(item.host_start_lease_expires_at.N) : 0;
  const snapshotGeneration = item.snapshot_generation?.N ? Number(item.snapshot_generation.N) : 0;
  const diskDirty = item.disk_dirty?.BOOL ?? false;
  const hydrateRequired = item.hydrate_required?.BOOL ?? false;
  return {
    computerId,
    tenantId,
    policy,
    stopped,
    modelReady,
    workspaceReady,
    browserReady,
    ...item.browser_unavailable?.BOOL === true ? { browserUnavailable: true } : {},
    hostStartGeneration,
    hostStartDispatchedGeneration,
    snapshotGeneration,
    diskDirty,
    hydrateRequired,
    hostStartLeaseExpiresAt: leaseEpoch ? new Date(leaseEpoch * 1e3) : void 0,
    snapshotUri: item.snapshot_uri?.S,
    snapshotChecksum: item.snapshot_checksum?.S,
    intendedHostWorkerId: item.intended_host_worker_id?.S,
    liveWriterHostId: item.live_writer_host_id?.S,
    hostLostAt: item.host_lost_at?.N ? new Date(Number(item.host_lost_at.N) * 1e3) : void 0,
    hostLostGeneration: item.host_lost_generation?.N ? Number(item.host_lost_generation.N) : void 0,
    ...item.owner_id?.S === void 0 ? {} : { ownerId: item.owner_id.S },
    ...item.owner_generation?.N === void 0 ? {} : { ownerGeneration: Number(item.owner_generation.N) },
    ...item.owner_protocol_version?.N === void 0 ? {} : { ownerProtocolVersion: Number(item.owner_protocol_version.N) },
    ...optionalDate("ownerStartedAt", dateFromSeconds(item.owner_started_at)),
    ...optionalDate("ownerCredentialsExpireAt", dateFromSeconds(item.owner_credentials_expire_at)),
    ...optionalDate("ownerCredentialsRenewedAt", dateFromSeconds(item.owner_credentials_renewed_at)),
    ...optionalDate("dispatchCredentialsRenewedAt", dateFromSeconds(item.dispatch_credentials_renewed_at)),
    ...optionalDate("idleSinceAt", dateFromSeconds(item.idle_since_at)),
    ...optionalDate("ownerStopApprovedAt", dateFromSeconds(item.owner_stop_approved_at)),
    ...item.dispatch_id?.S === void 0 ? {} : { dispatchId: item.dispatch_id.S },
    ...item.dispatch_turn_id?.S === void 0 ? {} : { dispatchTurnId: item.dispatch_turn_id.S },
    ...item.dispatch_action_id?.S === void 0 ? {} : { dispatchActionId: item.dispatch_action_id.S },
    ...item.dispatch_attempt?.N === void 0 ? {} : { dispatchAttempt: Number(item.dispatch_attempt.N) },
    ...optionalDate("dispatchLeaseExpiresAt", dateFromSeconds(item.dispatch_lease_expires_at)),
    ...optionalDate("interactiveUntilAt", dateFromSeconds(item.interactive_until_at)),
    ...item.file_operation_id?.S === void 0 ? {} : { fileOperationId: item.file_operation_id.S }
  };
}

// conversation/src/store/keys.ts
function computerRecordKey(tenantId) {
  return {
    pk: `${tenantId}#computer#record`,
    sk: "meta"
  };
}
function postIdempotencyKey(tenantId, idempotencyKey) {
  return {
    pk: `${tenantId}#roster`,
    sk: `idem#${idempotencyKey}`
  };
}
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
function liveFileOperationPartition(tenantId) {
  return `${tenantId}#computer#fileops`;
}
function liveFileOperationKey(tenantId, operationId) {
  return { pk: liveFileOperationPartition(tenantId), sk: `op#${operationId}` };
}
function fileAuditPartition(tenantId) {
  return `${tenantId}#computer#audit`;
}
function fileAuditKey(tenantId, atMilliseconds, operationId) {
  return { pk: fileAuditPartition(tenantId), sk: `at#${String(atMilliseconds).padStart(13, "0")}#${operationId}` };
}

// conversation/src/store/codecs/file-audit.ts
var epochSeconds2 = (moment) => ({ N: String(Math.floor(moment.getTime() / 1e3)) });
function encode3(value) {
  const key = fileAuditKey(value.tenantId, value.at.getTime(), value.operationId);
  const item = {
    pk: { S: key.pk },
    sk: { S: key.sk },
    tenant_id: { S: value.tenantId },
    computer_id: { S: value.computerId },
    user_id: { S: value.userId },
    operation_id: { S: value.operationId },
    operation: { S: value.operation },
    path: { S: value.path },
    source: { S: value.source },
    outcome: { S: value.outcome },
    at: { S: value.at.toISOString() },
    expires_at: epochSeconds2(value.expiresAt)
  };
  const strings = [
    ["to_path", value.toPath],
    ["tree_sha256_before", value.treeSha256Before],
    ["resolved_path", value.resolvedPath],
    ["owner_id", value.ownerId],
    ["error_code", value.errorCode],
    ["sha256_before", value.sha256Before],
    ["sha256_before_reported", value.sha256BeforeReported],
    ["sha256_after", value.sha256After],
    ["sha256_after_reported", value.sha256AfterReported],
    ["kept_as", value.keptAs]
  ];
  for (const [name, text3] of strings) if (text3 !== void 0) item[name] = { S: text3 };
  if (value.recursive !== void 0) item.recursive = { BOOL: value.recursive };
  if (value.removed !== void 0) item.removed = { N: String(value.removed) };
  if (value.bytes !== void 0) item.bytes = { N: String(value.bytes) };
  if (value.secretName !== void 0) item.secret_name = { BOOL: value.secretName };
  if (value.revealed !== void 0) item.revealed = { BOOL: value.revealed };
  if (value.flags !== void 0 && value.flags.length > 0) item.flags = { SS: [...value.flags] };
  if (value.finishedAt !== void 0) item.finished_at = { S: value.finishedAt.toISOString() };
  return item;
}
function required(item, name) {
  const value = item[name]?.S;
  if (value === void 0 || value === "") throw new Error(`malformed file audit item: ${name}`);
  return value;
}
function decode3(item) {
  const expiresAt = item.expires_at?.N;
  if (expiresAt === void 0) throw new Error("malformed file audit item: expires_at");
  return {
    tenantId: required(item, "tenant_id"),
    computerId: required(item, "computer_id"),
    userId: required(item, "user_id"),
    operationId: required(item, "operation_id"),
    operation: required(item, "operation"),
    path: required(item, "path"),
    source: required(item, "source"),
    outcome: required(item, "outcome"),
    at: new Date(required(item, "at")),
    expiresAt: new Date(Number(expiresAt) * 1e3),
    ...item.to_path?.S === void 0 ? {} : { toPath: item.to_path.S },
    ...item.recursive?.BOOL === void 0 ? {} : { recursive: item.recursive.BOOL },
    ...item.removed?.N === void 0 ? {} : { removed: Number(item.removed.N) },
    ...item.tree_sha256_before?.S === void 0 ? {} : { treeSha256Before: item.tree_sha256_before.S },
    ...item.resolved_path?.S === void 0 ? {} : { resolvedPath: item.resolved_path.S },
    ...item.owner_id?.S === void 0 ? {} : { ownerId: item.owner_id.S },
    ...item.error_code?.S === void 0 ? {} : { errorCode: item.error_code.S },
    ...item.sha256_before?.S === void 0 ? {} : { sha256Before: item.sha256_before.S },
    ...item.sha256_before_reported?.S === void 0 ? {} : { sha256BeforeReported: item.sha256_before_reported.S },
    ...item.sha256_after?.S === void 0 ? {} : { sha256After: item.sha256_after.S },
    ...item.sha256_after_reported?.S === void 0 ? {} : { sha256AfterReported: item.sha256_after_reported.S },
    ...item.bytes?.N === void 0 ? {} : { bytes: Number(item.bytes.N) },
    ...item.secret_name?.BOOL === void 0 ? {} : { secretName: item.secret_name.BOOL },
    ...item.revealed?.BOOL === void 0 ? {} : { revealed: item.revealed.BOOL },
    ...item.kept_as?.S === void 0 ? {} : { keptAs: item.kept_as.S },
    ...item.flags?.SS === void 0 ? {} : { flags: [...item.flags.SS].sort() },
    ...item.finished_at?.S === void 0 ? {} : { finishedAt: new Date(item.finished_at.S) }
  };
}

// conversation/src/store/codecs/idempotency.ts
function encode4(value) {
  const item = {
    pk: { S: value.pk },
    sk: { S: value.sk },
    tenant_id: { S: value.tenantId },
    channel_id: { S: value.channelId },
    message_id: { S: value.messageId },
    seq: { N: String(value.seq) },
    author_kind: { S: value.authorKind },
    author_id: { S: value.authorId },
    body: { S: value.body },
    addressed_to_bot_id: { S: value.addressedToBotId ?? "" },
    created_at: { S: value.createdAt }
  };
  if (value.turnId !== void 0) {
    item.turn_id = { S: value.turnId };
  }
  return item;
}
function decode4(item) {
  const pk = item.pk?.S;
  if (!pk) {
    throw new Error("malformed idempotency item: pk");
  }
  const sk = item.sk?.S;
  if (!sk) {
    throw new Error("malformed idempotency item: sk");
  }
  const tenantId = item.tenant_id?.S;
  if (!tenantId) {
    throw new Error("malformed idempotency item: tenant_id");
  }
  const channelId = item.channel_id?.S;
  if (!channelId) {
    throw new Error("malformed idempotency item: channel_id");
  }
  const messageId = item.message_id?.S;
  if (!messageId) {
    throw new Error("malformed idempotency item: message_id");
  }
  const seqStr = item.seq?.N;
  if (!seqStr) {
    throw new Error("malformed idempotency item: seq");
  }
  const authorKind = item.author_kind?.S;
  if (!authorKind) {
    throw new Error("malformed idempotency item: author_kind");
  }
  const authorId = item.author_id?.S;
  if (!authorId) {
    throw new Error("malformed idempotency item: author_id");
  }
  const body = item.body?.S;
  if (!body) {
    throw new Error("malformed idempotency item: body");
  }
  const createdAt = item.created_at?.S;
  if (!createdAt) {
    throw new Error("malformed idempotency item: created_at");
  }
  const addressedToBotId = item.addressed_to_bot_id?.S || void 0;
  return {
    pk,
    sk,
    tenantId,
    channelId,
    messageId,
    seq: Number(seqStr),
    authorKind,
    authorId,
    body,
    addressedToBotId,
    createdAt,
    turnId: item.turn_id?.S
  };
}

// conversation/src/store/codecs/identity.ts
function encode5(value) {
  return {
    pk: { S: `user#${value.userId}` },
    sk: { S: "identity" },
    user_id: { S: value.userId },
    email: { S: value.email },
    created_at: { S: formatIsoDateTime(value.createdAt) }
  };
}
function decode5(item) {
  const userId = item.user_id?.S;
  if (!userId) {
    throw new Error("malformed identity item: user_id");
  }
  const email = item.email?.S;
  if (!email) {
    throw new Error("malformed identity item: email");
  }
  const createdAtStr = item.created_at?.S;
  if (!createdAtStr) {
    throw new Error("malformed identity item: created_at");
  }
  return {
    userId,
    email,
    createdAt: new Date(createdAtStr)
  };
}

// conversation/src/store/codecs/invitation.ts
function encode6(value) {
  return {
    pk: { S: `${value.tenantId}#org` },
    sk: { S: `invite#${value.invitationId}` },
    invitation_id: { S: value.invitationId },
    tenant_id: { S: value.tenantId },
    email: { S: value.email },
    invited_by_user_id: { S: value.invitedByUserId },
    role: { S: value.role },
    status: { S: value.status },
    expires_at: { N: String(Math.floor(value.expiresAt.getTime() / 1e3)) },
    created_at: { S: formatIsoDateTime(value.createdAt) }
  };
}
function decode6(item) {
  const invitationId = item.invitation_id?.S;
  if (!invitationId) {
    throw new Error("malformed invitation item: invitation_id");
  }
  const tenantId = item.tenant_id?.S;
  if (!tenantId) {
    throw new Error("malformed invitation item: tenant_id");
  }
  const email = item.email?.S;
  if (!email) {
    throw new Error("malformed invitation item: email");
  }
  const invitedByUserId = item.invited_by_user_id?.S;
  if (!invitedByUserId) {
    throw new Error("malformed invitation item: invited_by_user_id");
  }
  const role = item.role?.S;
  if (!role) {
    throw new Error("malformed invitation item: role");
  }
  const status = item.status?.S;
  if (!status) {
    throw new Error("malformed invitation item: status");
  }
  const expiresEpoch = item.expires_at?.N;
  if (!expiresEpoch) {
    throw new Error("malformed invitation item: expires_at");
  }
  const createdAtStr = item.created_at?.S;
  if (!createdAtStr) {
    throw new Error("malformed invitation item: created_at");
  }
  return {
    invitationId,
    tenantId,
    email,
    invitedByUserId,
    role,
    status,
    expiresAt: new Date(Number(expiresEpoch) * 1e3),
    createdAt: new Date(createdAtStr)
  };
}

// conversation/src/store/codecs/live-file-operation.ts
import { gunzipSync, gzipSync } from "node:zlib";
function encodeOutcome(outcome) {
  return { B: gzipSync(Buffer.from(outcome, "utf8")) };
}
var epochSeconds3 = (moment) => ({ N: String(Math.floor(moment.getTime() / 1e3)) });
function encode7(value) {
  const key = liveFileOperationKey(value.tenantId, value.operationId);
  const item = {
    pk: { S: key.pk },
    sk: { S: key.sk },
    operation_id: { S: value.operationId },
    tenant_id: { S: value.tenantId },
    computer_id: { S: value.computerId },
    user_id: { S: value.userId },
    owner_id: { S: value.ownerId },
    generation: { N: String(value.generation) },
    kind: { S: value.kind },
    status: { S: value.status },
    queued_at: { S: value.queuedAt.toISOString() },
    expires_at: epochSeconds3(value.expiresAt)
  };
  if (value.request !== void 0) item.request = { S: value.request };
  if (value.deliveredAt !== void 0) item.delivered_at = { S: value.deliveredAt.toISOString() };
  if (value.deliveredSequence !== void 0) item.delivered_sequence = { N: String(value.deliveredSequence) };
  if (value.outcome !== void 0) item.outcome = encodeOutcome(value.outcome);
  if (value.waiterGone === true) item.waiter_gone = { BOOL: true };
  if (value.auditAtMilliseconds !== void 0) item.audit_at_ms = { N: String(value.auditAtMilliseconds) };
  return item;
}
function required2(item, name) {
  const value = item[name]?.S;
  if (value === void 0 || value === "") throw new Error(`malformed file request item: ${name}`);
  return value;
}
function decode7(item) {
  const generation = item.generation?.N;
  const expiresAt = item.expires_at?.N;
  if (generation === void 0) throw new Error("malformed file request item: generation");
  if (expiresAt === void 0) throw new Error("malformed file request item: expires_at");
  return {
    operationId: required2(item, "operation_id"),
    tenantId: required2(item, "tenant_id"),
    computerId: required2(item, "computer_id"),
    userId: required2(item, "user_id"),
    ownerId: required2(item, "owner_id"),
    generation: Number(generation),
    kind: required2(item, "kind"),
    status: required2(item, "status"),
    ...item.request?.S === void 0 ? {} : { request: item.request.S },
    queuedAt: new Date(required2(item, "queued_at")),
    ...item.delivered_at?.S === void 0 ? {} : { deliveredAt: new Date(item.delivered_at.S) },
    ...item.delivered_sequence?.N === void 0 ? {} : { deliveredSequence: Number(item.delivered_sequence.N) },
    ...item.outcome?.B === void 0 ? {} : { outcome: gunzipSync(item.outcome.B).toString("utf8") },
    ...item.waiter_gone?.BOOL === true ? { waiterGone: true } : {},
    ...item.audit_at_ms?.N === void 0 ? {} : { auditAtMilliseconds: Number(item.audit_at_ms.N) },
    expiresAt: new Date(Number(expiresAt) * 1e3)
  };
}
function isExpired(operation, now2) {
  return operation.expiresAt.getTime() <= now2.getTime();
}

// conversation/src/store/codecs/membership.ts
function encode8(value) {
  return {
    pk: { S: `${value.tenantId}#org` },
    sk: { S: `member#${value.userId}` },
    tenant_id: { S: value.tenantId },
    user_id: { S: value.userId },
    role: { S: value.role },
    joined_at: { S: formatIsoDateTime(value.joinedAt) }
  };
}
function decode8(item) {
  const tenantId = item.tenant_id?.S;
  if (!tenantId) {
    throw new Error("malformed membership item: tenant_id");
  }
  const userId = item.user_id?.S;
  if (!userId) {
    throw new Error("malformed membership item: user_id");
  }
  const role = item.role?.S;
  if (!role) {
    throw new Error("malformed membership item: role");
  }
  const joinedAtStr = item.joined_at?.S;
  if (!joinedAtStr) {
    throw new Error("malformed membership item: joined_at");
  }
  return {
    tenantId,
    userId,
    role,
    joinedAt: new Date(joinedAtStr)
  };
}

// conversation/src/store/codecs/organization.ts
function encode9(value) {
  const item = {
    pk: { S: `${value.tenantId}#org` },
    sk: { S: "meta" },
    tenant_id: { S: value.tenantId },
    name: { S: value.name },
    status: { S: value.status },
    owner_user_id: { S: value.ownerUserId },
    created_at: { S: formatIsoDateTime(value.createdAt) }
  };
  if (value.awsAccountId !== void 0) {
    item.aws_account_id = { S: value.awsAccountId };
  }
  if (value.awsCrossAccountRole !== void 0) {
    item.aws_cross_account_role = { S: value.awsCrossAccountRole };
  }
  if (value.awsExternalId !== void 0) {
    item.aws_external_id = { S: value.awsExternalId };
  }
  if (value.awsSetupPath !== void 0) {
    item.aws_setup_path = { S: value.awsSetupPath };
  }
  if (value.setupFeeCents !== void 0) {
    item.setup_fee_cents = { N: String(value.setupFeeCents) };
  }
  if (value.assistedSetupSession) {
    item.assisted_setup_session = { BOOL: true };
  }
  if (value.monthlyAwsSpendCeilingUsd !== void 0) {
    item.monthly_aws_spend_ceiling_usd = { N: value.monthlyAwsSpendCeilingUsd };
  }
  return item;
}
function decode9(item) {
  const tenantId = item.tenant_id?.S;
  if (!tenantId) {
    throw new Error("malformed organization item: tenant_id");
  }
  const name = item.name?.S;
  if (!name) {
    throw new Error("malformed organization item: name");
  }
  const status = item.status?.S;
  if (!status) {
    throw new Error("malformed organization item: status");
  }
  const ownerUserId = item.owner_user_id?.S;
  if (!ownerUserId) {
    throw new Error("malformed organization item: owner_user_id");
  }
  const createdAtStr = item.created_at?.S;
  if (!createdAtStr) {
    throw new Error("malformed organization item: created_at");
  }
  const setupFeeCents = item.setup_fee_cents?.N;
  const monthlyAwsSpendCeilingUsd = item.monthly_aws_spend_ceiling_usd?.N;
  return {
    tenantId,
    name,
    status,
    ownerUserId,
    createdAt: new Date(createdAtStr),
    awsAccountId: item.aws_account_id?.S,
    awsCrossAccountRole: item.aws_cross_account_role?.S,
    awsExternalId: item.aws_external_id?.S,
    awsSetupPath: item.aws_setup_path?.S,
    setupFeeCents: setupFeeCents ? Number(setupFeeCents) : void 0,
    assistedSetupSession: item.assisted_setup_session?.BOOL ?? false,
    monthlyAwsSpendCeilingUsd
  };
}

// conversation/src/store/codecs/task.ts
function encode10(value) {
  const item = {
    pk: { S: `${value.tenantId}#task#${value.taskId}` },
    sk: { S: "meta" },
    tenant_id: { S: value.tenantId },
    user_id: { S: value.userId },
    task_id: { S: value.taskId },
    title: { S: value.title },
    status: { S: value.status }
  };
  if (value.evidence !== void 0) {
    item.evidence = { S: value.evidence };
  }
  if (value.closeReason !== void 0) {
    item.close_reason = { S: value.closeReason };
  }
  if (value.createdByBotId !== void 0) {
    item.created_by_bot_id = { S: value.createdByBotId };
  }
  if (value.updatedByBotId !== void 0) {
    item.updated_by_bot_id = { S: value.updatedByBotId };
  }
  return item;
}
function decode10(item) {
  const taskId = item.task_id?.S;
  if (!taskId) {
    throw new Error("malformed task item: task_id");
  }
  const tenantId = item.tenant_id?.S;
  if (!tenantId) {
    throw new Error("malformed task item: tenant_id");
  }
  const userId = item.user_id?.S;
  if (!userId) {
    throw new Error("malformed task item: user_id");
  }
  const title = item.title?.S;
  if (!title) {
    throw new Error("malformed task item: title");
  }
  const status = item.status?.S;
  if (!status) {
    throw new Error("malformed task item: status");
  }
  return {
    taskId,
    tenantId,
    userId,
    title,
    status,
    evidence: item.evidence?.S,
    closeReason: item.close_reason?.S,
    createdByBotId: item.created_by_bot_id?.S,
    updatedByBotId: item.updated_by_bot_id?.S
  };
}

// conversation/src/store/codecs/worker.ts
function encode11(value) {
  const item = {
    pk: { S: `${value.tenantId}#roster` },
    sk: { S: `worker#${value.workerId}` },
    worker_id: { S: value.workerId },
    tenant_id: { S: value.tenantId },
    cost_class: { S: value.costClass },
    capabilities: { S: stringifyPythonStyle(value.capabilities.sort()) },
    token_hash: { S: value.tokenHash },
    last_heartbeat_at: { S: formatIsoDateTime(value.lastHeartbeatAt) }
  };
  if (value.computerId !== void 0) {
    item.computer_id = { S: value.computerId };
  }
  if (value.pollSequence !== void 0) {
    item.poll_sequence = { N: String(value.pollSequence) };
  }
  if (value.pollState !== void 0) {
    item.poll_state = { S: value.pollState };
  }
  if (value.pollPaceMilliseconds !== void 0) {
    item.poll_pace_ms = { N: String(value.pollPaceMilliseconds) };
  }
  if (value.hydratedSnapshotGeneration !== void 0) {
    item.hydrated_snapshot_generation = { N: String(value.hydratedSnapshotGeneration) };
  }
  return item;
}
function decode11(item) {
  const workerId = item.worker_id?.S;
  if (!workerId) {
    throw new Error("malformed worker item: worker_id");
  }
  const tenantId = item.tenant_id?.S;
  if (!tenantId) {
    throw new Error("malformed worker item: tenant_id");
  }
  const costClass = item.cost_class?.S;
  if (!costClass) {
    throw new Error("malformed worker item: cost_class");
  }
  const capabilitiesStr = item.capabilities?.S ?? "[]";
  let capabilities = [];
  try {
    const parsed = JSON.parse(capabilitiesStr);
    if (Array.isArray(parsed)) {
      capabilities = parsed.map(String);
    }
  } catch {
    capabilities = [];
  }
  const tokenHash = item.token_hash?.S;
  if (!tokenHash) {
    throw new Error("malformed worker item: token_hash");
  }
  const lastHeartbeatAtStr = item.last_heartbeat_at?.S;
  if (!lastHeartbeatAtStr) {
    throw new Error("malformed worker item: last_heartbeat_at");
  }
  const hydratedStr = item.hydrated_snapshot_generation?.N;
  return {
    workerId,
    tenantId,
    costClass,
    capabilities,
    tokenHash,
    lastHeartbeatAt: new Date(lastHeartbeatAtStr),
    computerId: item.computer_id?.S,
    hydratedSnapshotGeneration: hydratedStr ? Number(hydratedStr) : void 0,
    ...item.poll_sequence?.N === void 0 ? {} : { pollSequence: Number(item.poll_sequence.N) },
    ...item.poll_state?.S === void 0 ? {} : { pollState: item.poll_state.S },
    ...item.poll_pace_ms?.N === void 0 ? {} : { pollPaceMilliseconds: Number(item.poll_pace_ms.N) }
  };
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
  const sleep2 = options.sleep ?? defaultSleep;
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
      await sleep2(delay2);
    }
  }
}

// conversation/src/store/dynamo-messaging-store.ts
var ONE_HOUR_SECONDS = 3600;
function rosterPartition(tenantId) {
  return `${tenantId}#roster`;
}
function computerRecordItemKey(tenantId) {
  const key = computerRecordKey(tenantId);
  return { pk: { S: key.pk }, sk: { S: key.sk } };
}
function organizationPartition(tenantId) {
  return `${tenantId}#org`;
}
function userPartition(userId) {
  return `user#${userId}`;
}
function channelPartition(tenantId, channelId) {
  return `${tenantId}#channel#${channelId}`;
}
var DynamoMessagingStore = class {
  client;
  tableName;
  queryPageLimit;
  /**
   * @param client DynamoDB client.
   * @param tableName Messaging table name.
   * @param queryPageLimit Optional cap on items evaluated per Query or Scan page, so tests can exercise pagination.
   */
  constructor(client, tableName, queryPageLimit) {
    this.client = client;
    this.tableName = tableName;
    this.queryPageLimit = queryPageLimit;
  }
  async getIdentityByEmail(email) {
    const lookup = await this.get(`identity_lookup#${email}`, "meta");
    if (lookup === null) {
      return null;
    }
    const item = await this.get(userPartition(lookup.user_id?.S ?? ""), "identity");
    return item === null ? null : decode5(item);
  }
  async putIdentity(identity) {
    await this.put(encode5(identity));
    await this.put({
      pk: { S: `identity_lookup#${identity.email}` },
      sk: { S: "meta" },
      user_id: { S: identity.userId },
      email: { S: identity.email },
      created_at: { S: formatIsoDateTime(identity.createdAt) }
    });
  }
  async getOrganization(tenantId) {
    const item = await this.get(organizationPartition(tenantId), "meta");
    return item === null ? null : this.organizationFromItem(item);
  }
  async putOrganization(organization) {
    await this.put(
      encode9({
        tenantId: organization.tenantId,
        name: organization.name,
        status: organization.status,
        ownerUserId: organization.ownerUserId,
        createdAt: organization.createdAt,
        awsAccountId: organization.awsAccountId ?? void 0,
        awsCrossAccountRole: organization.awsCrossAccountRole ?? void 0,
        awsExternalId: organization.awsExternalId ?? void 0,
        awsSetupPath: organization.awsSetupPath ?? void 0,
        setupFeeCents: organization.setupFeeCents ?? void 0,
        assistedSetupSession: organization.assistedSetupSession,
        monthlyAwsSpendCeilingUsd: organization.monthlyAwsSpendCeilingUsd === null ? void 0 : organization.monthlyAwsSpendCeilingUsd.toString()
      })
    );
  }
  async setMonthlyAwsSpendCeilingWhenUnset(tenantId, monthlyAwsSpendCeilingUsd) {
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: { pk: { S: organizationPartition(tenantId) }, sk: { S: "meta" } },
          UpdateExpression: "SET monthly_aws_spend_ceiling_usd = :ceiling",
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(monthly_aws_spend_ceiling_usd)",
          ExpressionAttributeValues: { ":ceiling": { N: monthlyAwsSpendCeilingUsd.toString() } }
        })
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
  }
  async getMembership(tenantId, userId) {
    const item = await this.get(organizationPartition(tenantId), `member#${userId}`);
    return item === null ? null : this.membershipFromItem(item);
  }
  async putMembership(membership) {
    await this.put(encode8(membership));
    await this.put({
      pk: { S: userPartition(membership.userId) },
      sk: { S: `org#${membership.tenantId}` },
      tenant_id: { S: membership.tenantId },
      user_id: { S: membership.userId },
      role: { S: membership.role }
    });
  }
  async listMemberships(tenantId) {
    const items = await this.queryPrefix(organizationPartition(tenantId), "member#");
    return items.map((item) => this.membershipFromItem(item)).sort((left, right) => compareStrings(left.userId, right.userId));
  }
  async getInvitation(invitationId) {
    const lookup = await this.get(`invitation_lookup#${invitationId}`, "meta");
    if (lookup === null) {
      return null;
    }
    const canonical = await this.get(organizationPartition(lookup.tenant_id?.S ?? ""), `invite#${invitationId}`);
    return canonical === null ? null : this.invitationFromItem(canonical);
  }
  async putInvitation(invitation) {
    await this.put(encode6(invitation));
    await this.put({
      pk: { S: `invitation_lookup#${invitation.invitationId}` },
      sk: { S: "meta" },
      tenant_id: { S: invitation.tenantId },
      invitation_id: { S: invitation.invitationId }
    });
    await this.put({
      pk: { S: `invitation_email#${invitation.email}` },
      sk: { S: `pending#${invitation.invitationId}` },
      invitation_id: { S: invitation.invitationId },
      tenant_id: { S: invitation.tenantId },
      expires_at: { N: String(Math.floor(invitation.expiresAt.getTime() / 1e3)) }
    });
  }
  async listOrganizationsForUser(userId) {
    const rows = await this.queryPrefix(userPartition(userId), "org#");
    const organizations = [];
    for (const row of rows) {
      const organization = await this.getOrganization(row.tenant_id?.S ?? "");
      if (organization !== null) {
        organizations.push(organization);
      }
    }
    return organizations.sort((left, right) => compareStrings(left.tenantId, right.tenantId));
  }
  async listOrganizationsByStatus(status) {
    const organizations = [];
    let exclusiveStartKey;
    do {
      const response = await this.client.send(
        new ScanCommand2({
          TableName: this.tableName,
          FilterExpression: "sk = :meta AND attribute_exists(owner_user_id) AND #status = :status",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":meta": { S: "meta" }, ":status": { S: status } },
          ConsistentRead: true,
          Limit: this.queryPageLimit,
          ExclusiveStartKey: exclusiveStartKey
        })
      );
      for (const item of response.Items ?? []) {
        organizations.push(this.organizationFromItem(item));
      }
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey !== void 0);
    return organizations.sort((left, right) => compareStrings(left.tenantId, right.tenantId));
  }
  async incrementOrganizationCreationAttempts(userId, now2, windowMilliseconds) {
    return this.incrementRateCounter(userId, "org_create_rate", now2, Math.max(Math.floor(windowMilliseconds / 1e3), 1));
  }
  async incrementRateCounter(userId, name, now2, windowSeconds) {
    const bucket = Math.floor(Math.floor(now2.getTime() / 1e3) / windowSeconds);
    const expiresAt = Math.floor(now2.getTime() / 1e3) + windowSeconds + ONE_HOUR_SECONDS;
    const response = await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: userPartition(userId) }, sk: { S: `${name}#${bucket}` } },
        UpdateExpression: "SET attempt_count = if_not_exists(attempt_count, :zero) + :one, expires_at = :expires",
        ExpressionAttributeValues: {
          ":zero": { N: "0" },
          ":one": { N: "1" },
          ":expires": { N: String(expiresAt) }
        },
        ReturnValues: "ALL_NEW"
      })
    );
    return Number(response.Attributes?.attempt_count?.N);
  }
  async listPendingInvitationsForEmail(email) {
    const rows = await this.queryPrefix(`invitation_email#${email}`, "pending#");
    const invitations = [];
    for (const row of rows) {
      const invitation = await this.getInvitation(row.invitation_id?.S ?? "");
      if (invitation !== null && invitation.status === "pending") {
        invitations.push(invitation);
      }
    }
    return invitations.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }
  async putBot(bot, reserveName) {
    const botItem = encode(bot);
    if (!reserveName) {
      await this.put(botItem);
      return;
    }
    const nameItem = {
      pk: { S: rosterPartition(bot.tenantId) },
      sk: { S: `bot_name#${bot.name}` },
      tenant_id: { S: bot.tenantId },
      bot_id: { S: bot.botId },
      name: { S: bot.name }
    };
    try {
      await retryTransient(() => this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            { Put: { TableName: this.tableName, Item: botItem } },
            {
              Put: {
                TableName: this.tableName,
                Item: nameItem,
                ConditionExpression: "attribute_not_exists(pk)"
              }
            }
          ]
        })
      ));
    } catch (error) {
      if (error instanceof TransactionCanceledException2 && (error.CancellationReasons ?? []).some((reason) => reason.Code === "ConditionalCheckFailed")) {
        throw new DuplicateBotNameError(`Bot named '${bot.name}' already exists for tenant '${bot.tenantId}'.`);
      }
      throw error;
    }
  }
  async getBot(tenantId, botId) {
    const item = await this.get(rosterPartition(tenantId), `bot#${botId}`);
    return item === null ? null : decode(item);
  }
  async getBotByName(tenantId, name) {
    const reservation = await this.get(rosterPartition(tenantId), `bot_name#${name}`);
    if (reservation !== null) {
      return this.getBot(tenantId, reservation.bot_id?.S ?? "");
    }
    for (const item of await this.queryPrefix(rosterPartition(tenantId), "bot#")) {
      if (item.name?.S === name) {
        return decode(item);
      }
    }
    return null;
  }
  async listBots(tenantId) {
    const items = await this.queryPrefix(rosterPartition(tenantId), "bot#");
    return items.map(decode).sort((left, right) => compareStrings(left.name, right.name));
  }
  async getBotIdempotency(tenantId, idempotencyKey) {
    const item = await this.get(rosterPartition(tenantId), `botidem#${idempotencyKey}`);
    const botId = item?.bot_id?.S;
    return botId === void 0 || botId === "" ? null : this.getBot(tenantId, botId);
  }
  async putBotIdempotency(tenantId, idempotencyKey, bot) {
    await this.put({
      pk: { S: rosterPartition(tenantId) },
      sk: { S: `botidem#${idempotencyKey}` },
      tenant_id: { S: tenantId },
      bot_id: { S: bot.botId }
    });
  }
  async putChannel(channel) {
    await this.put(encodeChannel(channel));
    await this.putChannelIndexes(channel);
  }
  async putChannelIfAbsent(channel) {
    try {
      await this.client.send(
        new PutItemCommand2({
          TableName: this.tableName,
          Item: encodeChannel(channel),
          ConditionExpression: "attribute_not_exists(pk)"
        })
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
      const existing = await this.getChannel(channel.tenantId, channel.channelId);
      if (existing === null) {
        throw error;
      }
      await this.putChannelIndexes(existing);
      return existing;
    }
    await this.putChannelIndexes(channel);
    return channel;
  }
  async getChannel(tenantId, channelId) {
    const item = await this.get(channelPartition(tenantId, channelId), "meta");
    return item === null ? null : decodeChannel(item);
  }
  async listChannels(tenantId, userId) {
    const rows = await this.queryPrefix(rosterPartition(tenantId), `channel#${userId}#`);
    const channels = [];
    for (const row of rows) {
      const channel = await this.getChannel(tenantId, row.channel_id?.S ?? "");
      if (channel !== null) {
        channels.push(channel);
      }
    }
    return channels.sort((left, right) => compareStrings(left.channelId, right.channelId));
  }
  async resolveChannelTenant(channelId) {
    const item = await this.get(`channel_lookup#${channelId}`, "meta");
    return item?.tenant_id?.S ?? null;
  }
  async getChannelIdempotency(tenantId, idempotencyKey) {
    const item = await this.get(rosterPartition(tenantId), `chidem#${idempotencyKey}`);
    const channelId = item?.channel_id?.S;
    return channelId === void 0 || channelId === "" ? null : this.getChannel(tenantId, channelId);
  }
  async putChannelIdempotency(tenantId, idempotencyKey, channel) {
    await this.put({
      pk: { S: rosterPartition(tenantId) },
      sk: { S: `chidem#${idempotencyKey}` },
      tenant_id: { S: tenantId },
      channel_id: { S: channel.channelId }
    });
  }
  async getPostIdempotency(tenantId, idempotencyKey) {
    const key = postIdempotencyKey(tenantId, idempotencyKey);
    const item = await this.get(key.pk, key.sk);
    if (item === null) {
      return null;
    }
    const decoded = decode4(item);
    return {
      message: {
        messageId: decoded.messageId,
        channelId: decoded.channelId,
        tenantId: decoded.tenantId,
        seq: decoded.seq,
        authorKind: decoded.authorKind,
        authorId: decoded.authorId,
        body: decoded.body,
        addressedToBotId: decoded.addressedToBotId ?? null,
        createdAt: new Date(decoded.createdAt)
      },
      turnId: decoded.turnId ?? null
    };
  }
  async putPostIdempotency(tenantId, idempotencyKey, message, turnId) {
    const key = postIdempotencyKey(tenantId, idempotencyKey);
    await this.put(
      encode4({
        pk: key.pk,
        sk: key.sk,
        tenantId,
        channelId: message.channelId,
        messageId: message.messageId,
        seq: message.seq,
        authorKind: message.authorKind,
        authorId: message.authorId,
        body: message.body,
        addressedToBotId: message.addressedToBotId ?? void 0,
        createdAt: message.createdAt.toISOString(),
        turnId: turnId ?? void 0
      })
    );
  }
  async reservePostIdempotency(tenantId, idempotencyKey, fingerprint, candidate, now2) {
    const key = postIdempotencyKey(tenantId, idempotencyKey);
    const pendingItem = {
      pk: { S: key.pk },
      sk: { S: key.sk },
      tenant_id: { S: tenantId },
      reservation_state: { S: "pending" },
      request_fingerprint: { S: fingerprint },
      reservation_owner: { S: candidate.ownerId },
      lease_expires_at: { N: String(candidate.leaseExpiresAt.getTime()) },
      message_id: { S: candidate.messageId },
      created_at: { S: candidate.createdAt.toISOString() },
      ...candidate.reservedTurnId === null ? {} : { reserved_turn_id: { S: candidate.reservedTurnId } },
      ...candidate.startedEventId === null ? {} : { started_event_id: { S: candidate.startedEventId } }
    };
    try {
      await this.client.send(new PutItemCommand2({
        TableName: this.tableName,
        Item: pendingItem,
        ConditionExpression: "attribute_not_exists(pk)"
      }));
      return { state: "owner", reservation: { ...candidate, seq: null, admission: null } };
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
    let existing = await this.get(key.pk, key.sk);
    if (existing === null) return { state: "busy" };
    if (existing.request_fingerprint?.S !== fingerprint) return { state: "conflict" };
    if (existing.reservation_state?.S !== "pending") {
      if (existing.reservation_state?.S === "complete") {
        const result = await this.getPostIdempotency(tenantId, idempotencyKey);
        return result === null ? { state: "busy" } : { state: "completed", result };
      }
      return { state: "conflict" };
    }
    const leaseExpiresAt = Number(existing.lease_expires_at?.N ?? "0");
    if (leaseExpiresAt <= now2.getTime()) {
      try {
        const updated = await this.client.send(new UpdateItemCommand({
          TableName: this.tableName,
          Key: { pk: { S: key.pk }, sk: { S: key.sk } },
          UpdateExpression: "SET reservation_owner = :owner, lease_expires_at = :lease",
          ConditionExpression: "reservation_state = :pending AND request_fingerprint = :fingerprint AND lease_expires_at <= :now",
          ExpressionAttributeValues: {
            ":owner": { S: candidate.ownerId },
            ":lease": { N: String(candidate.leaseExpiresAt.getTime()) },
            ":pending": { S: "pending" },
            ":fingerprint": { S: fingerprint },
            ":now": { N: String(now2.getTime()) }
          },
          ReturnValues: "ALL_NEW"
        }));
        existing = updated.Attributes ?? existing;
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
        return { state: "busy" };
      }
      return { state: "owner", reservation: this.decodePostReservation(existing) };
    }
    return { state: "busy" };
  }
  async setPostIdempotencySequence(tenantId, idempotencyKey, ownerId, seq, now2) {
    const key = postIdempotencyKey(tenantId, idempotencyKey);
    try {
      const result = await this.client.send(new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: key.pk }, sk: { S: key.sk } },
        UpdateExpression: "SET #seq = if_not_exists(#seq, :seq)",
        ConditionExpression: "reservation_state = :pending AND reservation_owner = :owner AND lease_expires_at > :now",
        ExpressionAttributeNames: { "#seq": "seq" },
        ExpressionAttributeValues: { ":seq": { N: String(seq) }, ":pending": { S: "pending" }, ":owner": { S: ownerId }, ":now": { N: String(now2.getTime()) } },
        ReturnValues: "ALL_NEW"
      }));
      const stored = result.Attributes?.seq?.N;
      return stored === void 0 ? null : Number(stored);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return null;
      throw error;
    }
  }
  async completePostIdempotency(tenantId, idempotencyKey, ownerId, message, turnId, now2) {
    const key = postIdempotencyKey(tenantId, idempotencyKey);
    try {
      await this.client.send(new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: key.pk }, sk: { S: key.sk } },
        UpdateExpression: "SET reservation_state = :complete, channel_id = :channel, message_id = :message, seq = :seq, author_kind = :author_kind, author_id = :author_id, body = :body, addressed_to_bot_id = :addressed, created_at = :created" + (turnId === null ? " REMOVE turn_id" : ", turn_id = :turn"),
        ConditionExpression: "reservation_state = :pending AND reservation_owner = :owner AND lease_expires_at > :now",
        ExpressionAttributeValues: {
          ":complete": { S: "complete" },
          ":pending": { S: "pending" },
          ":owner": { S: ownerId },
          ":now": { N: String(now2.getTime()) },
          ":channel": { S: message.channelId },
          ":message": { S: message.messageId },
          ":seq": { N: String(message.seq) },
          ":author_kind": { S: message.authorKind },
          ":author_id": { S: message.authorId },
          ":body": { S: message.body },
          ":addressed": { S: message.addressedToBotId ?? "" },
          ":created": { S: message.createdAt.toISOString() },
          ...turnId === null ? {} : { ":turn": { S: turnId } }
        }
      }));
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }
  decodePostReservation(item) {
    const ownerId = item.reservation_owner?.S;
    const messageId = item.message_id?.S;
    const createdAt = item.created_at?.S;
    const lease = item.lease_expires_at?.N;
    if (ownerId === void 0 || messageId === void 0 || createdAt === void 0 || lease === void 0) {
      throw new Error("malformed post idempotency reservation");
    }
    return {
      ownerId,
      messageId,
      createdAt: new Date(createdAt),
      leaseExpiresAt: new Date(Number(lease)),
      seq: item.seq?.N === void 0 ? null : Number(item.seq.N),
      reservedTurnId: item.reserved_turn_id?.S ?? null,
      startedEventId: item.started_event_id?.S ?? null,
      admission: item.admitted_turn_id?.S === void 0 ? null : {
        turnId: item.admitted_turn_id.S,
        kind: item.admission_kind?.S === "steered" ? "steered" : "started"
      }
    };
  }
  async putMessage(message) {
    await this.put(encodeMessage(message));
  }
  async listMessages(tenantId, channelId, afterSeq) {
    const messages = [];
    let exclusiveStartKey;
    do {
      const response = await this.client.send(
        new QueryCommand2({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND sk > :sk",
          ExpressionAttributeValues: {
            ":pk": { S: channelPartition(tenantId, channelId) },
            ":sk": { S: messageSortKey(afterSeq) }
          },
          ConsistentRead: true,
          Limit: this.queryPageLimit,
          ExclusiveStartKey: exclusiveStartKey
        })
      );
      for (const item of response.Items ?? []) {
        if (item.sk?.S?.startsWith("msg#")) {
          messages.push(decodeMessage(item));
        }
      }
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey !== void 0);
    return messages.sort((left, right) => left.seq - right.seq);
  }
  async putWorker(worker) {
    await this.put(encode11({ ...worker, capabilities: [...worker.capabilities] }));
  }
  async getWorker(tenantId, workerId) {
    const item = await this.get(rosterPartition(tenantId), `worker#${workerId}`);
    return item === null ? null : decode11(item);
  }
  async listWorkers(tenantId) {
    const items = await this.queryPrefix(rosterPartition(tenantId), "worker#");
    return items.map(decode11).sort((left, right) => compareStrings(left.workerId, right.workerId));
  }
  async putTask(task) {
    await this.put(encode10(task));
    await this.put({
      pk: { S: rosterPartition(task.tenantId) },
      sk: { S: `task#${task.userId}#${task.taskId}` },
      tenant_id: { S: task.tenantId },
      user_id: { S: task.userId },
      task_id: { S: task.taskId }
    });
  }
  async getTask(tenantId, taskId) {
    const item = await this.get(`${tenantId}#task#${taskId}`, "meta");
    return item === null ? null : decode10(item);
  }
  async listTasks(tenantId, userId) {
    const rows = await this.queryPrefix(rosterPartition(tenantId), `task#${userId}#`);
    const tasks = [];
    for (const row of rows) {
      const task = await this.getTask(tenantId, row.task_id?.S ?? "");
      if (task !== null) {
        tasks.push(task);
      }
    }
    return tasks.sort((left, right) => compareStrings(left.taskId, right.taskId));
  }
  async getComputer(tenantId) {
    const key = computerRecordKey(tenantId);
    const item = await this.get(key.pk, key.sk);
    return item === null ? null : decode2(item);
  }
  async putComputer(computer) {
    const key = computerRecordItemKey(computer.tenantId);
    await this.put({ ...encode2(computer), pk: key.pk, sk: key.sk });
  }
  async createComputerIfAbsent(computer) {
    const key = computerRecordItemKey(computer.tenantId);
    try {
      await this.client.send(
        new PutItemCommand2({
          TableName: this.tableName,
          Item: { ...encode2(computer), pk: key.pk, sk: key.sk },
          ConditionExpression: "attribute_not_exists(pk)"
        })
      );
      return computer;
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      return await this.getComputer(computer.tenantId);
    }
  }
  async markComputerStopped(tenantId, change) {
    const values = { ":off": { BOOL: false }, ":on": { BOOL: true } };
    let condition = "attribute_exists(pk)";
    if (change.expectedHostStartGeneration !== void 0) {
      condition += " AND host_start_generation = :generation";
      values[":generation"] = { N: String(change.expectedHostStartGeneration) };
    }
    const diskDirtyAssignment = change.diskMatchesPublished ? ", disk_dirty = :off" : "";
    return this.updateComputerWhere(tenantId, {
      update: `SET stopped = :on, model_ready = :off, workspace_ready = :off, browser_ready = :off${diskDirtyAssignment} REMOVE ${OWNER_ATTRIBUTE_NAMES.join(", ")}`,
      condition,
      values
    });
  }
  async markComputerRunning(tenantId) {
    return this.updateComputerWhere(tenantId, {
      update: "SET stopped = :off REMOVE browser_unavailable",
      condition: "attribute_exists(pk)",
      values: { ":off": { BOOL: false } }
    });
  }
  async recordComputerCapabilityReady(tenantId, capability) {
    const attribute = { model: "model_ready", workspace: "workspace_ready", browser: "browser_ready" }[capability];
    return this.updateComputerWhere(tenantId, {
      update: `SET ${attribute} = :on${capability === "browser" ? " REMOVE browser_unavailable" : ""}`,
      condition: "attribute_exists(pk)",
      values: { ":on": { BOOL: true } }
    });
  }
  async recordComputerBrowserUnavailable(tenantId) {
    return this.updateComputerWhere(tenantId, {
      update: "SET browser_ready = :off, browser_unavailable = :on",
      condition: "attribute_exists(pk)",
      values: { ":off": { BOOL: false }, ":on": { BOOL: true } }
    });
  }
  async claimHostStartGeneration(tenantId, expectedGeneration, leaseExpiresAt) {
    try {
      const response = await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: computerRecordItemKey(tenantId),
          UpdateExpression: "SET host_start_generation = :next, host_start_lease_expires_at = :lease REMOVE live_writer_host_id, " + OWNER_ATTRIBUTE_NAMES.join(", "),
          ConditionExpression: "attribute_exists(pk) AND host_start_generation = :expected",
          ExpressionAttributeValues: {
            ":expected": { N: String(expectedGeneration) },
            ":next": { N: String(expectedGeneration + 1) },
            ":lease": { N: String(Math.floor(leaseExpiresAt.getTime() / 1e3)) }
          },
          ReturnValues: "ALL_NEW"
        })
      );
      return decode2(response.Attributes);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return null;
      }
      throw error;
    }
  }
  async settleLostComputerHost(tenantId, expectedGeneration, lostAt, hydrateRequired) {
    try {
      const response = await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: computerRecordItemKey(tenantId),
          UpdateExpression: "SET stopped = :stopped, model_ready = :off, workspace_ready = :off, browser_ready = :off, disk_dirty = :off, hydrate_required = :hydrate, host_lost_at = :lostAt, host_lost_generation = :generation REMOVE live_writer_host_id, " + OWNER_ATTRIBUTE_NAMES.join(", "),
          ConditionExpression: "attribute_exists(pk) AND host_start_generation = :generation AND (disk_dirty = :on OR attribute_exists(live_writer_host_id))",
          ExpressionAttributeValues: {
            ":stopped": { BOOL: true },
            ":off": { BOOL: false },
            ":on": { BOOL: true },
            ":hydrate": { BOOL: hydrateRequired },
            ":lostAt": { N: String(Math.floor(lostAt.getTime() / 1e3)) },
            ":generation": { N: String(expectedGeneration) }
          },
          ReturnValues: "ALL_NEW"
        })
      );
      return decode2(response.Attributes);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return null;
      }
      throw error;
    }
  }
  async recordComputerSnapshotPublished(tenantId, published) {
    return this.updateComputerWhere(tenantId, {
      update: "SET snapshot_uri = :uri, snapshot_checksum = :checksum, snapshot_generation = snapshot_generation + :one, disk_dirty = :clean",
      condition: "attribute_exists(pk) AND hydrate_required = :no",
      values: {
        ":uri": { S: published.snapshotUri },
        ":checksum": { S: published.snapshotChecksum },
        ":one": { N: "1" },
        ":clean": { BOOL: false },
        ":no": { BOOL: false }
      }
    });
  }
  async recordComputerHydrated(tenantId) {
    return this.updateComputerWhere(tenantId, {
      update: "SET hydrate_required = :no, disk_dirty = :no REMOVE intended_host_worker_id",
      condition: "attribute_exists(pk)",
      values: { ":no": { BOOL: false } }
    });
  }
  async markComputerDiskDirty(tenantId) {
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: computerRecordItemKey(tenantId),
          UpdateExpression: "SET disk_dirty = :dirty",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":dirty": { BOOL: true } }
        })
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
  }
  async claimComputerDiskWriter(tenantId, hostId) {
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: computerRecordItemKey(tenantId),
          UpdateExpression: "SET live_writer_host_id = :host",
          ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(live_writer_host_id) OR live_writer_host_id = :host)",
          ExpressionAttributeValues: { ":host": { S: hostId } }
        })
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
  }
  async releaseHostStartLease(tenantId, generation) {
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: computerRecordItemKey(tenantId),
          UpdateExpression: "REMOVE host_start_lease_expires_at",
          ConditionExpression: "attribute_exists(pk) AND host_start_generation = :generation",
          ExpressionAttributeValues: { ":generation": { N: String(generation) } }
        })
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
  }
  async markHostStartDispatched(tenantId, generation) {
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: computerRecordItemKey(tenantId),
          UpdateExpression: "SET host_start_dispatched_generation = :generation",
          ConditionExpression: "attribute_exists(pk) AND host_start_generation = :generation AND host_start_dispatched_generation < :generation",
          ExpressionAttributeValues: { ":generation": { N: String(generation) } }
        })
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
  }
  async releaseHostStartDispatch(tenantId, generation) {
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: computerRecordItemKey(tenantId),
          UpdateExpression: "SET host_start_dispatched_generation = :previous",
          ConditionExpression: "attribute_exists(pk) AND host_start_dispatched_generation = :generation",
          ExpressionAttributeValues: { ":generation": { N: String(generation) }, ":previous": { N: String(generation - 1) } }
        })
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
    }
  }
  async consumeOwnerBootstrap(tenantId, bootstrap) {
    const removed = OWNER_ATTRIBUTE_NAMES.filter((name) => !["owner_id", "owner_protocol_version", "owner_started_at", "owner_credentials_expire_at"].includes(name));
    return this.updateComputerWhere(tenantId, {
      update: `SET owner_id = :owner, owner_generation = :generation, owner_protocol_version = :version, owner_started_at = :startedAt, owner_credentials_expire_at = :credentialsExpireAt REMOVE ${removed.join(", ")}`,
      condition: "attribute_exists(pk) AND host_start_generation = :generation AND (attribute_not_exists(owner_generation) OR owner_generation < :generation)",
      values: {
        ":owner": { S: bootstrap.ownerId },
        ":generation": { N: String(bootstrap.generation) },
        ":version": { N: String(bootstrap.protocolVersion) },
        ":startedAt": { N: String(Math.floor(bootstrap.startedAt.getTime() / 1e3)) },
        ":credentialsExpireAt": { N: String(Math.floor(bootstrap.credentialsExpireAt.getTime() / 1e3)) }
      }
    });
  }
  async openComputerRuntimeSegment(tenantId, run) {
    await this.client.send(
      new PutItemCommand2({
        TableName: this.tableName,
        Item: computerRuntimeSegmentItem(
          { tenantId, ownerGeneration: run.ownerGeneration, startedAt: run.startedAt, lastSeenAt: run.startedAt },
          run.ownerId
        )
      })
    );
  }
  async extendComputerRuntimeSegment(tenantId, ownerGeneration, seenAt) {
    const key = computerRuntimeKey(tenantId, ownerGeneration);
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: { pk: { S: key.pk }, sk: { S: key.sk } },
          UpdateExpression: "SET last_seen_at = :seen",
          ConditionExpression: "attribute_exists(pk) AND last_seen_at < :seen",
          ExpressionAttributeValues: { ":seen": { S: seenAt.toISOString() } }
        })
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
  }
  listComputerRuntimeSegments(tenantId) {
    return queryComputerRuntimeSegments(this.client, this.tableName, tenantId);
  }
  async recordOwnerPoll(tenantId, workerId, poll) {
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: { pk: { S: rosterPartition(tenantId) }, sk: { S: `worker#${workerId}` } },
          UpdateExpression: "SET last_heartbeat_at = :at, poll_sequence = :sequence, poll_state = :state, poll_pace_ms = :pace",
          ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(poll_sequence) OR poll_sequence <= :sequence)",
          ExpressionAttributeValues: {
            ":at": { S: formatIsoDateTime(poll.at) },
            ":sequence": { N: String(poll.sequence) },
            ":state": { S: poll.state },
            ":pace": { N: String(poll.paceMilliseconds) }
          }
        })
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }
  async updateOwnerPresence(tenantId, ownerId, change) {
    const sets = [];
    const removes = [];
    const values = { ":owner": { S: ownerId } };
    if (change.protocolVersion !== void 0) {
      sets.push("owner_protocol_version = :version");
      values[":version"] = { N: String(change.protocolVersion) };
    }
    if (change.idleSinceAt instanceof Date) {
      sets.push("idle_since_at = :idleSince");
      values[":idleSince"] = { N: String(Math.floor(change.idleSinceAt.getTime() / 1e3)) };
    } else if (change.idleSinceAt === null) {
      removes.push("idle_since_at");
    }
    if (sets.length === 0 && removes.length === 0) return true;
    const update = [sets.length === 0 ? "" : `SET ${sets.join(", ")}`, removes.length === 0 ? "" : `REMOVE ${removes.join(", ")}`].filter((part) => part !== "").join(" ");
    return await this.updateComputerWhere(tenantId, { update, condition: "attribute_exists(pk) AND owner_id = :owner", values }) !== null;
  }
  async offerOwnerDispatch(tenantId, ownerId, expectedDispatchId, dispatch) {
    const dispatchCondition = expectedDispatchId === null ? "attribute_not_exists(dispatch_id)" : "dispatch_id = :expectedDispatch";
    const values = {
      ":owner": { S: ownerId },
      ":dispatchId": { S: dispatch.dispatchId },
      ":turnId": { S: dispatch.turnId },
      ":actionId": { S: dispatch.actionId },
      ":attempt": { N: String(dispatch.attempt) },
      ":lease": { N: String(Math.floor(dispatch.leaseExpiresAt.getTime() / 1e3)) }
    };
    if (expectedDispatchId !== null) values[":expectedDispatch"] = { S: expectedDispatchId };
    return await this.updateComputerWhere(tenantId, {
      update: "SET dispatch_id = :dispatchId, dispatch_turn_id = :turnId, dispatch_action_id = :actionId, dispatch_attempt = :attempt, dispatch_lease_expires_at = :lease REMOVE dispatch_credentials_renewed_at",
      condition: `attribute_exists(pk) AND owner_id = :owner AND attribute_not_exists(owner_stop_approved_at) AND ${dispatchCondition}`,
      values
    }) !== null;
  }
  async approveOwnerStop(tenantId, ownerId, expectedDispatchId, expectedFileOperationId, approvedAt) {
    const dispatchCondition = expectedDispatchId === null ? "attribute_not_exists(dispatch_id)" : "dispatch_id = :expectedDispatch";
    const fileCondition = expectedFileOperationId === null ? "attribute_not_exists(file_operation_id)" : "file_operation_id = :expectedFileOperation";
    const values = { ":owner": { S: ownerId }, ":approvedAt": { N: String(Math.floor(approvedAt.getTime() / 1e3)) } };
    if (expectedDispatchId !== null) values[":expectedDispatch"] = { S: expectedDispatchId };
    if (expectedFileOperationId !== null) values[":expectedFileOperation"] = { S: expectedFileOperationId };
    return await this.updateComputerWhere(tenantId, {
      update: "SET owner_stop_approved_at = :approvedAt",
      condition: `attribute_exists(pk) AND owner_id = :owner AND ${dispatchCondition} AND ${fileCondition}`,
      values
    }) !== null;
  }
  async renewOwnerCredentials(tenantId, ownerId, generation, change) {
    const renewedAttribute = change.kind === "supervisor" ? "owner_credentials_renewed_at" : "dispatch_credentials_renewed_at";
    const seenCondition = change.seenRenewedAt === null ? `attribute_not_exists(${renewedAttribute})` : `${renewedAttribute} = :seen`;
    const values = {
      ":owner": { S: ownerId },
      ":generation": { N: String(generation) },
      ":renewedAt": { N: String(Math.floor(change.renewedAt.getTime() / 1e3)) }
    };
    if (change.seenRenewedAt !== null) values[":seen"] = { N: String(Math.floor(change.seenRenewedAt.getTime() / 1e3)) };
    let update = `SET ${renewedAttribute} = :renewedAt`;
    let condition = `attribute_exists(pk) AND owner_id = :owner AND owner_generation = :generation AND attribute_not_exists(owner_stop_approved_at) AND ${seenCondition}`;
    if (change.kind === "supervisor") {
      update += ", owner_credentials_expire_at = :credentialsExpireAt";
      values[":credentialsExpireAt"] = { N: String(Math.floor(change.credentialsExpireAt.getTime() / 1e3)) };
    } else {
      condition += " AND dispatch_id = :dispatchId";
      values[":dispatchId"] = { S: change.dispatchId };
    }
    return await this.updateComputerWhere(tenantId, { update, condition, values }) !== null;
  }
  async touchInteractiveWindow(tenantId, ownerId, generation, until) {
    return await this.updateComputerWhere(tenantId, {
      update: "SET interactive_until_at = :until",
      condition: "attribute_exists(pk) AND owner_id = :owner AND owner_generation = :generation AND attribute_not_exists(owner_stop_approved_at)",
      values: { ":until": { N: String(Math.floor(until.getTime() / 1e3)) }, ":owner": { S: ownerId }, ":generation": { N: String(generation) } }
    }) !== null;
  }
  async queueLiveFileOperation(operation, interactiveUntilAt) {
    const computerKey = computerRecordItemKey(operation.tenantId);
    try {
      await retryTransient(
        () => this.client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Update: {
                  TableName: this.tableName,
                  Key: computerKey,
                  UpdateExpression: "SET interactive_until_at = :until, file_operation_id = :operation",
                  ConditionExpression: "attribute_exists(pk) AND owner_id = :owner AND owner_generation = :generation AND attribute_not_exists(owner_stop_approved_at)",
                  ExpressionAttributeValues: {
                    ":until": { N: String(Math.floor(interactiveUntilAt.getTime() / 1e3)) },
                    ":operation": { S: operation.operationId },
                    ":owner": { S: operation.ownerId },
                    ":generation": { N: String(operation.generation) }
                  }
                }
              },
              {
                Put: {
                  TableName: this.tableName,
                  Item: encode7(operation),
                  ConditionExpression: "attribute_not_exists(pk)"
                }
              }
            ]
          })
        )
      );
      return true;
    } catch (error) {
      if (error instanceof TransactionCanceledException2 && (error.CancellationReasons ?? []).some((reason) => reason.Code === "ConditionalCheckFailed")) {
        return false;
      }
      throw error;
    }
  }
  async getLiveFileOperation(tenantId, operationId, now2) {
    const key = liveFileOperationKey(tenantId, operationId);
    const item = await this.get(key.pk, key.sk);
    if (item === null) return null;
    const operation = decode7(item);
    return isExpired(operation, now2) ? null : operation;
  }
  async listLiveFileOperations(tenantId, now2) {
    const rows = await this.queryPrefix(liveFileOperationPartition(tenantId), "op#");
    return rows.map((row) => decode7(row)).filter((operation) => !isExpired(operation, now2)).sort((left, right) => left.queuedAt.getTime() - right.queuedAt.getTime() || compareStrings(left.operationId, right.operationId));
  }
  async countOpenLiveFileOperations(tenantId, now2) {
    let count = 0;
    let exclusiveStartKey;
    do {
      const response = await this.client.send(
        new QueryCommand2({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          FilterExpression: "#status IN (:pending, :delivered) AND expires_at > :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":pk": { S: liveFileOperationPartition(tenantId) },
            ":prefix": { S: "op#" },
            ":pending": { S: "pending" },
            ":delivered": { S: "delivered" },
            ":now": { N: String(Math.floor(now2.getTime() / 1e3)) }
          },
          Select: "COUNT",
          ConsistentRead: true,
          Limit: this.queryPageLimit,
          ExclusiveStartKey: exclusiveStartKey
        })
      );
      count += response.Count ?? 0;
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey !== void 0);
    return count;
  }
  async deliverLiveFileOperation(tenantId, operationId, delivery) {
    const key = liveFileOperationKey(tenantId, operationId);
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: { pk: { S: key.pk }, sk: { S: key.sk } },
          UpdateExpression: "SET #status = :delivered, delivered_at = :at, delivered_sequence = :sequence",
          ConditionExpression: "attribute_exists(pk) AND #status = :pending AND owner_id = :owner AND generation = :generation AND expires_at > :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":delivered": { S: "delivered" },
            ":pending": { S: "pending" },
            ":at": { S: delivery.at.toISOString() },
            ":sequence": { N: String(delivery.sequence) },
            ":owner": { S: delivery.ownerId },
            ":generation": { N: String(delivery.generation) },
            ":now": { N: String(Math.floor(delivery.at.getTime() / 1e3)) }
          }
        })
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }
  async abandonLiveFileOperation(tenantId, operationId, now2) {
    const key = liveFileOperationKey(tenantId, operationId);
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: { pk: { S: key.pk }, sk: { S: key.sk } },
          UpdateExpression: "SET #status = :abandoned REMOVE #request, outcome",
          ConditionExpression: "attribute_exists(pk) AND #status = :pending",
          ExpressionAttributeNames: { "#status": "status", "#request": "request" },
          ExpressionAttributeValues: { ":abandoned": { S: "abandoned" }, ":pending": { S: "pending" } }
        })
      );
      return "abandoned";
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      return (await this.getLiveFileOperation(tenantId, operationId, now2))?.status ?? "absent";
    }
  }
  async completeLiveFileOperation(tenantId, operationId, outcome, now2) {
    const key = liveFileOperationKey(tenantId, operationId);
    try {
      const response = await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: { pk: { S: key.pk }, sk: { S: key.sk } },
          UpdateExpression: "SET #status = :done, outcome = :outcome",
          ConditionExpression: "attribute_exists(pk) AND #status = :delivered AND expires_at > :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":done": { S: "done" },
            ":delivered": { S: "delivered" },
            ":outcome": encodeOutcome(outcome),
            ":now": { N: String(Math.floor(now2.getTime() / 1e3)) }
          },
          ReturnValues: "ALL_NEW"
        })
      );
      return decode7(response.Attributes);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return null;
      throw error;
    }
  }
  async markLiveFileOperationWaiterGone(tenantId, operationId) {
    const key = liveFileOperationKey(tenantId, operationId);
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: { pk: { S: key.pk }, sk: { S: key.sk } },
          UpdateExpression: "SET waiter_gone = :gone",
          ConditionExpression: "attribute_exists(pk) AND #status = :delivered",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":gone": { BOOL: true }, ":delivered": { S: "delivered" } }
        })
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }
  async deleteLiveFileOperation(tenantId, operationId) {
    const key = liveFileOperationKey(tenantId, operationId);
    await this.client.send(new DeleteItemCommand({ TableName: this.tableName, Key: { pk: { S: key.pk }, sk: { S: key.sk } } }));
  }
  async putFileAudit(record) {
    await this.client.send(
      new PutItemCommand2({ TableName: this.tableName, Item: encode3(record), ConditionExpression: "attribute_not_exists(pk)" })
    );
  }
  async getFileAudit(tenantId, atMilliseconds, operationId, now2) {
    const key = fileAuditKey(tenantId, atMilliseconds, operationId);
    const item = await this.get(key.pk, key.sk);
    if (item === null) return null;
    const record = decode3(item);
    return record.expiresAt.getTime() <= now2.getTime() ? null : record;
  }
  async finalizeFileAudit(tenantId, atMilliseconds, operationId, finish) {
    const key = fileAuditKey(tenantId, atMilliseconds, operationId);
    const sets = ["outcome = :outcome", "finished_at = :finishedAt"];
    const values = { ":outcome": { S: finish.outcome }, ":finishedAt": { S: finish.finishedAt.toISOString() } };
    const texts = [
      ["error_code", ":errorCode", finish.errorCode],
      ["resolved_path", ":resolvedPath", finish.resolvedPath],
      ["kept_as", ":keptAs", finish.keptAs],
      ["sha256_before_reported", ":beforeReported", finish.sha256BeforeReported],
      ["sha256_after_reported", ":afterReported", finish.sha256AfterReported]
    ];
    for (const [attribute, placeholder, value] of texts) {
      if (value === void 0) continue;
      sets.push(`${attribute} = ${placeholder}`);
      values[placeholder] = { S: value };
    }
    if (finish.removed !== void 0) {
      sets.push("removed = :removed");
      values[":removed"] = { N: String(finish.removed) };
    }
    if (finish.flags !== void 0 && finish.flags.length > 0) {
      sets.push("flags = :flags");
      values[":flags"] = { SS: [...finish.flags] };
    }
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: { pk: { S: key.pk }, sk: { S: key.sk } },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: values
        })
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }
  async listFileAuditRecords(tenantId, now2) {
    const rows = await this.queryPrefix(fileAuditPartition(tenantId), "at#");
    return rows.map((row) => decode3(row)).filter((record) => record.expiresAt.getTime() > now2.getTime()).sort((left, right) => left.at.getTime() - right.at.getTime() || compareStrings(left.operationId, right.operationId));
  }
  async updateComputerWhere(tenantId, change) {
    try {
      const response = await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: computerRecordItemKey(tenantId),
          UpdateExpression: change.update,
          ConditionExpression: change.condition,
          ExpressionAttributeValues: change.values,
          ReturnValues: "ALL_NEW"
        })
      );
      return decode2(response.Attributes);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return null;
      throw error;
    }
  }
  async putChannelIndexes(channel) {
    await this.put({
      pk: { S: `channel_lookup#${channel.channelId}` },
      sk: { S: "meta" },
      tenant_id: { S: channel.tenantId },
      channel_id: { S: channel.channelId }
    });
    for (const participant of channel.participants) {
      if (participant.kind !== "human") {
        continue;
      }
      await this.put({
        pk: { S: rosterPartition(channel.tenantId) },
        sk: { S: `channel#${participant.actorId}#${channel.channelId}` },
        tenant_id: { S: channel.tenantId },
        user_id: { S: participant.actorId },
        channel_id: { S: channel.channelId }
      });
    }
  }
  organizationFromItem(item) {
    const decoded = decode9(item);
    return {
      tenantId: decoded.tenantId,
      name: decoded.name,
      status: decoded.status,
      ownerUserId: decoded.ownerUserId,
      createdAt: decoded.createdAt,
      awsAccountId: decoded.awsAccountId ?? null,
      awsCrossAccountRole: decoded.awsCrossAccountRole ?? null,
      awsExternalId: decoded.awsExternalId ?? null,
      awsSetupPath: decoded.awsSetupPath ?? null,
      setupFeeCents: decoded.setupFeeCents ?? null,
      assistedSetupSession: decoded.assistedSetupSession ?? false,
      monthlyAwsSpendCeilingUsd: decoded.monthlyAwsSpendCeilingUsd === void 0 ? null : Decimal.parse(decoded.monthlyAwsSpendCeilingUsd)
    };
  }
  membershipFromItem(item) {
    const decoded = decode8(item);
    return { ...decoded, role: decoded.role };
  }
  invitationFromItem(item) {
    const decoded = decode6(item);
    return {
      ...decoded,
      role: decoded.role,
      status: decoded.status
    };
  }
  async put(item) {
    await this.client.send(new PutItemCommand2({ TableName: this.tableName, Item: item }));
  }
  async get(partitionKey, sortKey) {
    const response = await this.client.send(
      new GetItemCommand2({
        TableName: this.tableName,
        Key: { pk: { S: partitionKey }, sk: { S: sortKey } },
        ConsistentRead: true
      })
    );
    return response.Item ?? null;
  }
  async queryPrefix(partitionKey, sortKeyPrefix) {
    const items = [];
    let exclusiveStartKey;
    do {
      const response = await this.client.send(
        new QueryCommand2({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": { S: partitionKey }, ":prefix": { S: sortKeyPrefix } },
          ConsistentRead: true,
          Limit: this.queryPageLimit,
          ExclusiveStartKey: exclusiveStartKey
        })
      );
      items.push(...response.Items ?? []);
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey !== void 0);
    return items;
  }
};
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// conversation/src/store/turn-admission-store.ts
import {
  GetItemCommand as GetItemCommand4,
  TransactionCanceledException as TransactionCanceledException4,
  TransactWriteItemsCommand as TransactWriteItemsCommand3
} from "@aws-sdk/client-dynamodb";

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
function householdConversationGrant() {
  return new TaskCapabilityGrant(
    /* @__PURE__ */ new Set(["read_workspace", "write_workspace", "edit_workspace", "run_terminal"]),
    /* @__PURE__ */ new Set(),
    /* @__PURE__ */ new Set(),
    /* @__PURE__ */ new Set(["/workspace"]),
    /* @__PURE__ */ new Set([EgressClass.ApprovedOriginFetch]),
    /* @__PURE__ */ new Set()
  );
}
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
function grantToPayload(grant) {
  return {
    tools: [...grant.tools].sort(),
    origins: [...grant.origins].sort(),
    recipients: [...grant.recipients].sort(),
    file_scopes: [...grant.fileScopes].sort(),
    egress_classes: [...grant.egressClasses].sort(),
    ingest_classes: [...grant.ingestClasses].sort()
  };
}
function grantFromPayload(payload) {
  const frozenset = (fieldName) => {
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
    frozenset("ingest_classes")
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
  constructor(now2 = null) {
    this.now = now2 ?? (() => /* @__PURE__ */ new Date());
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

// conversation/src/store/turn-events.ts
import { QueryCommand as QueryCommand3 } from "@aws-sdk/client-dynamodb";
var turnItemPartitionKey = (tenantId, turnId) => `${tenantId}#turn#${turnId}`;
var turnEventSortKey = (seq) => `evt#${String(seq).padStart(10, "0")}`;
var EVENT_SORT_KEY_PREFIX = "evt#";
function turnEventItem(event, expiresAt) {
  const item = {
    pk: { S: turnItemPartitionKey(event.tenantId, event.turnId) },
    sk: { S: turnEventSortKey(event.seq) },
    tenant_id: { S: event.tenantId },
    turn_id: { S: event.turnId },
    channel_id: { S: event.channelId },
    event_id: { S: event.eventId },
    seq: { N: String(event.seq) },
    kind: { S: event.kind },
    expires_at: { N: String(Math.floor(expiresAt.getTime() / 1e3)) }
  };
  if (event.token !== void 0) {
    item.token = { S: event.token };
  }
  if (event.messageSeq !== void 0) {
    item.message_seq = { N: String(event.messageSeq) };
  }
  if (event.body !== void 0) {
    item.body = { S: event.body };
  }
  if (event.attemptId !== void 0) {
    item.attempt_id = { S: event.attemptId };
  }
  if (event.tool !== void 0) item.tool = { S: event.tool };
  if (event.callId !== void 0) item.call_id = { S: event.callId };
  if (event.summary !== void 0) item.summary = { S: event.summary };
  if (event.toolArguments !== void 0) item.tool_arguments = { S: JSON.stringify(event.toolArguments) };
  if (event.argumentsTruncated !== void 0) item.arguments_truncated = { BOOL: event.argumentsTruncated };
  if (event.ok !== void 0) item.ok = { BOOL: event.ok };
  if (event.output !== void 0) item.output = { S: event.output };
  if (event.outputTruncated !== void 0) item.output_truncated = { BOOL: event.outputTruncated };
  if (event.durationMs !== void 0 && event.durationMs !== null) item.duration_ms = { N: String(event.durationMs) };
  if (event.text !== void 0) item.text = { S: event.text };
  if (event.detail !== void 0) item.detail = { S: event.detail };
  if (event.pendingComputerTool !== void 0) {
    item.pending_computer_tool = { S: encodePendingComputerTool(event.pendingComputerTool) };
  }
  return item;
}
function encodePendingComputerTool(tool) {
  return JSON.stringify({
    action_id: tool.actionId,
    arguments: Object.fromEntries(Object.entries(tool.arguments).sort(([left], [right]) => left.localeCompare(right))),
    tool_name: tool.toolName
  });
}
function decodePendingComputerTool(text3) {
  const parsed = JSON.parse(text3);
  return { actionId: parsed.action_id, toolName: parsed.tool_name, arguments: parsed.arguments };
}
function turnEventFromItem(item) {
  const event = {
    eventId: item.event_id.S,
    tenantId: item.tenant_id.S,
    turnId: item.turn_id.S,
    channelId: item.channel_id.S,
    seq: Number(item.seq.N),
    kind: item.kind.S
  };
  if (item.token?.S !== void 0) {
    event.token = item.token.S;
  }
  if (item.message_seq?.N !== void 0) {
    event.messageSeq = Number(item.message_seq.N);
  }
  if (item.body?.S !== void 0) {
    event.body = item.body.S;
  }
  if (item.attempt_id?.S !== void 0) {
    event.attemptId = item.attempt_id.S;
  }
  if (item.tool?.S !== void 0) event.tool = item.tool.S;
  if (item.call_id?.S !== void 0) event.callId = item.call_id.S;
  if (item.summary?.S !== void 0) event.summary = item.summary.S;
  if (item.tool_arguments?.S !== void 0) event.toolArguments = JSON.parse(item.tool_arguments.S);
  if (item.arguments_truncated?.BOOL !== void 0) event.argumentsTruncated = item.arguments_truncated.BOOL;
  if (item.ok?.BOOL !== void 0) event.ok = item.ok.BOOL;
  if (item.output?.S !== void 0) event.output = item.output.S;
  if (item.output_truncated?.BOOL !== void 0) event.outputTruncated = item.output_truncated.BOOL;
  if (item.duration_ms?.N !== void 0) event.durationMs = Number(item.duration_ms.N);
  if (item.text?.S !== void 0) event.text = item.text.S;
  if (item.detail?.S !== void 0) event.detail = item.detail.S;
  if (item.pending_computer_tool?.S !== void 0) {
    event.pendingComputerTool = decodePendingComputerTool(item.pending_computer_tool.S);
  }
  return event;
}
async function listTurnEventItems(client, tableName, tenantId, turnId, afterSeq) {
  const events = [];
  let exclusiveStartKey;
  do {
    const page2 = await client.send(
      new QueryCommand3({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :after AND :end",
        ExpressionAttributeValues: {
          ":pk": { S: turnItemPartitionKey(tenantId, turnId) },
          ":after": { S: turnEventSortKey(afterSeq + 1) },
          ":end": { S: `${EVENT_SORT_KEY_PREFIX}~` }
        },
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    for (const item of page2.Items ?? []) {
      events.push(turnEventFromItem(item));
    }
    exclusiveStartKey = page2.LastEvaluatedKey;
  } while (exclusiveStartKey !== void 0);
  return events;
}

// conversation/src/store/codecs/grant.ts
var TURN_GRANT_SORT_KEY = "grant";
function encodeGrantText(grant) {
  const payload = grantToPayload(grant);
  const sorted = Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left < right ? -1 : 1));
  return JSON.stringify(sorted);
}
function encodeGrant(tenantId, turnId, grant) {
  return {
    pk: { S: turnItemPartitionKey(tenantId, turnId) },
    sk: { S: TURN_GRANT_SORT_KEY },
    tenant_id: { S: tenantId },
    turn_id: { S: turnId },
    grant: { S: encodeGrantText(grant) }
  };
}
function decodeGrant(item) {
  const text3 = item.grant?.S;
  if (text3 === void 0) {
    throw new Error("malformed turn grant item: grant");
  }
  return grantFromPayload(JSON.parse(text3));
}

// conversation/src/pi/mailbox.ts
import {
  ConditionalCheckFailedException as ConditionalCheckFailedException2,
  DeleteItemCommand as DeleteItemCommand2,
  PutItemCommand as PutItemCommand3,
  QueryCommand as QueryCommand4,
  UpdateItemCommand as UpdateItemCommand2
} from "@aws-sdk/client-dynamodb";
var mailboxPartitionKey = (tenantId, botId, channelId) => `MB#${tenantId}#${botId}#${channelId}`;
var mailboxSortKey = (seq) => String(seq).padStart(10, "0");
async function allocateSeq(store, tenantId, channelId) {
  const result = await store.client.send(
    new UpdateItemCommand2({
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
      new PutItemCommand3({
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
      new QueryCommand4({
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
    new DeleteItemCommand2({
      TableName: store.tableName,
      Key: { pk: { S: mailboxPartitionKey(item.tenantId, item.botId, item.channelId) }, sk: { S: mailboxSortKey(item.seq) } }
    })
  );
}

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

// conversation/src/budget/computer-runtime.ts
var COMPUTER_TASK_USD_PER_HOUR = Decimal.parse("0.009875");
var MOST_A_HOSTED_COMPUTER_COSTS_IN_ONE_DAY_USD = COMPUTER_TASK_USD_PER_HOUR.multiplyByInteger(24);

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
function liveOwnerOf(computer, worker, now2, timeoutSeconds) {
  return computer.ownerId !== void 0 && computer.ownerGeneration === computer.hostStartGeneration && worker !== null && worker.workerId === computer.ownerId && worker.computerId === computer.computerId && now2.getTime() - worker.lastHeartbeatAt.getTime() <= timeoutSeconds * 1e3;
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
  const now2 = deps.clock.now();
  const leaseExpiresAt = addSeconds(now2, ATTEMPT_LEASE_SECONDS);
  const deadlineAt = addSeconds(now2, TURN_DEADLINE_SECONDS);
  const turn = await deps.store.claimTurn({ tenantId, turnId, attemptId, claimedBy, now: now2, leaseExpiresAt, deadlineAt });
  if (turn === null || turn.attemptId === null) {
    return null;
  }
  return { turn, attemptId: turn.attemptId, attempt: turn.attempt, leaseExpiresAt, deadlineAt };
}
async function renewTurn(deps, tenantId, turnId, attemptId) {
  const now2 = deps.clock.now();
  const leaseExpiresAt = addSeconds(now2, ATTEMPT_LEASE_SECONDS);
  const deadlineAt = addSeconds(now2, TURN_DEADLINE_SECONDS);
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
var observationOf = (turn) => ({
  attemptId: turn.attemptId,
  recoveryAttempts: turn.recoveryAttempts
});
async function recoverExpiredTurn(deps, observed) {
  const now2 = deps.clock.now();
  return deps.store.recoverExpiredTurn({
    tenantId: observed.tenantId,
    turnId: observed.turnId,
    observed: observationOf(observed),
    now: now2,
    deadlineAt: addSeconds(now2, TURN_DEADLINE_SECONDS)
  });
}
async function failStaleTurn(deps, observed, condition, reason) {
  const now2 = deps.clock.now();
  return deps.store.failStaleTurn({
    tenantId: observed.tenantId,
    turnId: observed.turnId,
    observed: observationOf(observed),
    condition,
    now: now2,
    reason,
    eventId: deps.ids.next(),
    expiresAt: addSeconds(now2, TURN_EVENT_TTL_SECONDS)
  });
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
async function listTurnEvents(deps, tenantId, turnId, afterSeq) {
  await getTurn(deps, tenantId, turnId);
  return deps.store.listEvents(tenantId, turnId, afterSeq);
}

// conversation/src/store/turn-store.ts
import {
  ConditionalCheckFailedException as ConditionalCheckFailedException3,
  DeleteItemCommand as DeleteItemCommand3,
  GetItemCommand as GetItemCommand3,
  TransactionCanceledException as TransactionCanceledException3,
  TransactWriteItemsCommand as TransactWriteItemsCommand2,
  UpdateItemCommand as UpdateItemCommand3
} from "@aws-sdk/client-dynamodb";
var ACTIVE_STATUS = "active";
var TRANSITION_ATTEMPTS = 8;
function turnPointerKey(tenantId, channelId, pointer, botId) {
  return {
    pk: `${tenantId}#channel#${channelId}`,
    sk: botId === null ? `${pointer}_turn_primary` : `${pointer}_turn#${botId}`
  };
}
var epochSeconds4 = (moment) => String(Math.floor(moment.getTime() / 1e3));
var optionalString = (item, name) => {
  const value = item[name]?.S;
  return value !== void 0 && value !== "" ? value : null;
};
var optionalNumber = (item, name) => {
  const value = item[name]?.N;
  return value !== void 0 ? Number(value) : null;
};
var optionalDate2 = (item, name) => {
  const seconds = optionalNumber(item, name);
  return seconds === null ? null : new Date(seconds * 1e3);
};
function turnFromItem(item) {
  const pending = optionalString(item, "pending_computer_tool");
  return {
    turnId: item.turn_id.S,
    tenantId: item.tenant_id.S,
    channelId: item.channel_id.S,
    botId: item.bot_id.S,
    status: item.status.S,
    promptMessageSeq: optionalNumber(item, "prompt_message_seq"),
    promptAuthorId: optionalString(item, "prompt_author_id"),
    attemptId: optionalString(item, "attempt_id"),
    attempt: optionalNumber(item, "attempt") ?? 0,
    claimedBy: optionalString(item, "claimed_by"),
    leaseExpiresAt: optionalDate2(item, "lease_expires_at"),
    deadlineAt: optionalDate2(item, "deadline_at"),
    recoveryAttempts: optionalNumber(item, "recovery_attempts") ?? 0,
    waitingFor: optionalString(item, "waiting_for"),
    waitingSince: optionalDate2(item, "waiting_since"),
    logicalEnqueueIds: [...item.logical_enqueue_ids?.SS ?? []],
    pendingComputerTool: pending === null ? null : decodePendingComputerTool(pending),
    storageFence: optionalNumber(item, "storage_fence"),
    nextEventSeq: optionalNumber(item, "next_event_seq") ?? 1,
    terminalReason: optionalString(item, "terminal_reason"),
    messageSeq: optionalNumber(item, "message_seq")
  };
}
async function recordLogicalEnqueueOnTurn(client, tableName, tenantId, turnId, enqueueId, fence) {
  const key = { pk: { S: turnItemPartitionKey(tenantId, turnId) }, sk: { S: "meta" } };
  if (fence !== void 0) {
    const reservationKey = postIdempotencyKey(fence.tenantId, fence.idempotencyKey);
    try {
      await retryTransient(() => client.send(new TransactWriteItemsCommand2({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { pk: { S: reservationKey.pk }, sk: { S: reservationKey.sk } },
              ConditionExpression: "reservation_state = :pending AND reservation_owner = :owner AND lease_expires_at > :now",
              ExpressionAttributeValues: { ":pending": { S: "pending" }, ":owner": { S: fence.ownerId }, ":now": { N: String(fence.now.getTime()) } }
            }
          },
          {
            Update: {
              TableName: tableName,
              Key: key,
              UpdateExpression: "ADD logical_enqueue_ids :ids",
              ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(logical_enqueue_ids) OR NOT contains(logical_enqueue_ids, :id))",
              ExpressionAttributeValues: { ":ids": { SS: [enqueueId] }, ":id": { S: enqueueId } }
            }
          }
        ]
      })));
      return true;
    } catch (error) {
      if (!(error instanceof TransactionCanceledException3)) throw error;
      const [turn, reservation] = await Promise.all([
        client.send(new GetItemCommand3({ TableName: tableName, Key: key, ConsistentRead: true })),
        client.send(new GetItemCommand3({ TableName: tableName, Key: { pk: { S: reservationKey.pk }, sk: { S: reservationKey.sk } }, ConsistentRead: true }))
      ]);
      if (turn.Item === void 0) throw new TurnNotFoundError(`Turn ${pythonRepr(turnId)} does not exist.`);
      const ids = turn.Item.logical_enqueue_ids?.SS ?? [];
      if (ids.includes(enqueueId)) return false;
      if (reservation.Item?.reservation_state?.S !== "pending" || reservation.Item.reservation_owner?.S !== fence.ownerId || Number(reservation.Item.lease_expires_at?.N ?? "0") <= fence.now.getTime()) {
        throw new IdempotencyReservationBusyError("The message reservation is no longer owned by this enqueue attempt.");
      }
      throw error;
    }
  }
  try {
    await retryTransient(() => client.send(
      new UpdateItemCommand3({
        TableName: tableName,
        Key: key,
        UpdateExpression: "ADD logical_enqueue_ids :ids",
        ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(logical_enqueue_ids) OR NOT contains(logical_enqueue_ids, :id))",
        ExpressionAttributeValues: { ":ids": { SS: [enqueueId] }, ":id": { S: enqueueId } }
      })
    ));
    return true;
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException3)) {
      throw error;
    }
  }
  const existing = await client.send(new GetItemCommand3({ TableName: tableName, Key: key, ConsistentRead: true }));
  if (existing.Item === void 0) {
    throw new TurnNotFoundError(`Turn ${pythonRepr(turnId)} does not exist.`);
  }
  return false;
}
var DynamoTurnControlStore = class {
  client;
  tableName;
  /**
   * @param client DynamoDB client.
   * @param tableName The Messaging table.
   */
  constructor(client, tableName) {
    this.client = client;
    this.tableName = tableName;
  }
  metaKey(tenantId, turnId) {
    return { pk: { S: turnItemPartitionKey(tenantId, turnId) }, sk: { S: "meta" } };
  }
  async getTurn(tenantId, turnId) {
    const result = await this.client.send(
      new GetItemCommand3({ TableName: this.tableName, Key: this.metaKey(tenantId, turnId), ConsistentRead: true })
    );
    return result.Item === void 0 ? null : turnFromItem(result.Item);
  }
  async claimTurn(request) {
    const claimedByClause = request.claimedBy === null ? "" : ", claimed_by = :claimedBy";
    const removeClaimedBy = request.claimedBy === null ? " REMOVE claimed_by" : "";
    const values = {
      ":attemptId": { S: request.attemptId },
      ":lease": { N: epochSeconds4(request.leaseExpiresAt) },
      ":deadline": { N: epochSeconds4(request.deadlineAt) },
      ":now": { N: epochSeconds4(request.now) },
      ":active": { S: ACTIVE_STATUS },
      ":one": { N: "1" }
    };
    if (request.claimedBy !== null) {
      values[":claimedBy"] = { S: request.claimedBy };
    }
    try {
      const result = await retryTransient(() => this.client.send(
        new UpdateItemCommand3({
          TableName: this.tableName,
          Key: this.metaKey(request.tenantId, request.turnId),
          UpdateExpression: `SET attempt_id = :attemptId, lease_expires_at = :lease, deadline_at = :deadline${claimedByClause} ADD attempt :one${removeClaimedBy}`,
          ConditionExpression: "attribute_exists(pk) AND #status = :active AND attribute_not_exists(waiting_for) AND (attribute_not_exists(lease_expires_at) OR lease_expires_at <= :now)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW"
        })
      ));
      return turnFromItem(result.Attributes);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException3) {
        return null;
      }
      throw error;
    }
  }
  async renewTurn(request) {
    try {
      const result = await retryTransient(() => this.client.send(
        new UpdateItemCommand3({
          TableName: this.tableName,
          Key: this.metaKey(request.tenantId, request.turnId),
          UpdateExpression: "SET lease_expires_at = :lease, deadline_at = :deadline",
          ConditionExpression: "attempt_id = :attemptId AND #status = :active",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":lease": { N: epochSeconds4(request.leaseExpiresAt) },
            ":deadline": { N: epochSeconds4(request.deadlineAt) },
            ":attemptId": { S: request.attemptId },
            ":active": { S: ACTIVE_STATUS }
          },
          ReturnValues: "ALL_NEW"
        })
      ));
      return turnFromItem(result.Attributes);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException3) {
        return null;
      }
      throw error;
    }
  }
  async recordStorageFence(tenantId, turnId, attemptId, storageFence) {
    try {
      await retryTransient(() => this.client.send(
        new UpdateItemCommand3({
          TableName: this.tableName,
          Key: this.metaKey(tenantId, turnId),
          UpdateExpression: "SET storage_fence = :fence",
          ConditionExpression: "attempt_id = :attemptId AND #status = :active",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":fence": { N: String(storageFence) },
            ":attemptId": { S: attemptId },
            ":active": { S: ACTIVE_STATUS }
          }
        })
      ));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException3) {
        throw await this.rejection(tenantId, turnId, attemptId);
      }
      throw error;
    }
  }
  async appendEvent(request) {
    return this.transition({ ...request, set: {}, remove: [], terminal: false });
  }
  async completeTurn(request) {
    return this.transition({
      tenantId: request.tenantId,
      turnId: request.turnId,
      attemptId: request.attemptId,
      draft: { kind: "turn.completed", messageSeq: request.messageSeq, body: request.body },
      eventId: request.eventId,
      expiresAt: request.expiresAt,
      set: { status: { S: "completed" }, message_seq: { N: String(request.messageSeq) } },
      remove: ["waiting_for", "pending_computer_tool"],
      terminal: true
    });
  }
  async failTurn(request) {
    return this.transition({
      tenantId: request.tenantId,
      turnId: request.turnId,
      attemptId: request.attemptId,
      draft: { kind: "turn.failed", body: request.reason },
      eventId: request.eventId,
      expiresAt: request.expiresAt,
      set: { status: { S: "failed" }, terminal_reason: { S: request.reason } },
      remove: ["claimed_by", "lease_expires_at"],
      terminal: true
    });
  }
  async parkTurn(request) {
    return this.transition({
      tenantId: request.tenantId,
      turnId: request.turnId,
      attemptId: request.attemptId,
      draft: { kind: "turn.waiting", body: request.gate, pendingComputerTool: request.pendingComputerTool },
      eventId: request.eventId,
      expiresAt: request.expiresAt,
      set: {
        waiting_for: { S: request.gate },
        waiting_since: { N: epochSeconds4(request.now) },
        pending_computer_tool: { S: encodePendingComputerTool(request.pendingComputerTool) }
      },
      remove: ["attempt_id", "claimed_by", "lease_expires_at"],
      terminal: false
    });
  }
  async resumeTurn(tenantId, turnId) {
    try {
      const result = await retryTransient(() => this.client.send(
        new UpdateItemCommand3({
          TableName: this.tableName,
          Key: this.metaKey(tenantId, turnId),
          UpdateExpression: "REMOVE waiting_for, waiting_since, pending_computer_tool",
          ConditionExpression: "attribute_exists(pk) AND #status = :active AND attribute_exists(waiting_for)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":active": { S: ACTIVE_STATUS } },
          ReturnValues: "ALL_NEW"
        })
      ));
      return turnFromItem(result.Attributes);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException3) {
        return null;
      }
      throw error;
    }
  }
  async beginClosing(tenantId, turnId, attemptId) {
    try {
      await retryTransient(() => this.client.send(
        new UpdateItemCommand3({
          TableName: this.tableName,
          Key: this.metaKey(tenantId, turnId),
          UpdateExpression: "SET closing = :closing",
          ConditionExpression: "attempt_id = :attemptId AND #status = :active",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":closing": { BOOL: true },
            ":attemptId": { S: attemptId },
            ":active": { S: ACTIVE_STATUS }
          }
        })
      ));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException3) {
        throw await this.rejection(tenantId, turnId, attemptId);
      }
      throw error;
    }
  }
  async reconcileTurn(request) {
    return this.transition({
      tenantId: request.tenantId,
      turnId: request.turnId,
      attemptId: request.attemptId,
      draft: { kind: "turn.reconciling", body: request.reason },
      eventId: request.eventId,
      expiresAt: request.expiresAt,
      set: { status: { S: "reconciling" }, terminal_reason: { S: request.reason } },
      remove: ["claimed_by", "lease_expires_at"],
      terminal: false
    });
  }
  async recoverExpiredTurn(request) {
    const values = {
      ":active": { S: ACTIVE_STATUS },
      ":now": { N: epochSeconds4(request.now) },
      ":deadline": { N: epochSeconds4(request.deadlineAt) },
      ":observedRecovery": { N: String(request.observed.recoveryAttempts) },
      ":nextRecovery": { N: String(request.observed.recoveryAttempts + 1) }
    };
    let attemptCondition = "attribute_not_exists(attempt_id)";
    if (request.observed.attemptId !== null) {
      attemptCondition = "attempt_id = :observedAttempt";
      values[":observedAttempt"] = { S: request.observed.attemptId };
    }
    try {
      const result = await retryTransient(() => this.client.send(
        new UpdateItemCommand3({
          TableName: this.tableName,
          Key: this.metaKey(request.tenantId, request.turnId),
          UpdateExpression: "SET recovery_attempts = :nextRecovery, deadline_at = :deadline REMOVE attempt_id, claimed_by, lease_expires_at",
          ConditionExpression: `attribute_exists(pk) AND #status = :active AND attribute_not_exists(waiting_for) AND (attribute_not_exists(lease_expires_at) OR lease_expires_at <= :now) AND ${attemptCondition} AND recovery_attempts = :observedRecovery`,
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW"
        })
      ));
      return turnFromItem(result.Attributes);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException3) {
        return null;
      }
      throw error;
    }
  }
  async failStaleTurn(request) {
    const nowSeconds = Math.floor(request.now.getTime() / 1e3);
    const leaseExpired = (turn) => turn.waitingFor === null && (turn.leaseExpiresAt === null || Math.floor(turn.leaseExpiresAt.getTime() / 1e3) <= nowSeconds);
    const holds = (turn) => turn.recoveryAttempts === request.observed.recoveryAttempts && (request.condition === "waiting" ? turn.waitingFor !== null : leaseExpired(turn));
    const guardValues = {};
    let guardExpression = "attribute_exists(waiting_for)";
    if (request.condition === "lease_expired") {
      guardExpression = "attribute_not_exists(waiting_for) AND (attribute_not_exists(lease_expires_at) OR lease_expires_at <= :guardNow)";
      guardValues[":guardNow"] = { N: String(nowSeconds) };
    }
    const guard = { expression: guardExpression, names: {}, values: guardValues };
    try {
      return await this.transition({
        tenantId: request.tenantId,
        turnId: request.turnId,
        attemptId: request.observed.attemptId,
        guard,
        holds,
        draft: { kind: "turn.failed", body: request.reason },
        eventId: request.eventId,
        expiresAt: request.expiresAt,
        set: { status: { S: "failed" }, terminal_reason: { S: request.reason } },
        remove: ["claimed_by", "lease_expires_at"],
        terminal: true
      });
    } catch (error) {
      if (error instanceof StaleAttemptError || error instanceof TurnTerminalError || error instanceof TurnNotFoundError) {
        return null;
      }
      throw error;
    }
  }
  async relinquishTurn(request) {
    return this.transition({
      tenantId: request.tenantId,
      turnId: request.turnId,
      attemptId: request.attemptId,
      draft: { kind: "attempt.relinquished", attemptId: request.attemptId },
      eventId: request.eventId,
      expiresAt: request.expiresAt,
      set: {},
      remove: ["attempt_id", "claimed_by", "lease_expires_at"],
      terminal: false
    });
  }
  async recordLogicalEnqueue(tenantId, turnId, enqueueId) {
    return recordLogicalEnqueueOnTurn(this.client, this.tableName, tenantId, turnId, enqueueId);
  }
  async listEvents(tenantId, turnId, afterSeq) {
    return listTurnEventItems(this.client, this.tableName, tenantId, turnId, afterSeq);
  }
  async getGrant(tenantId, turnId) {
    const result = await this.client.send(
      new GetItemCommand3({
        TableName: this.tableName,
        Key: { pk: { S: turnItemPartitionKey(tenantId, turnId) }, sk: { S: TURN_GRANT_SORT_KEY } },
        ConsistentRead: true
      })
    );
    return result.Item === void 0 ? null : decodeGrant(result.Item);
  }
  async replaceGrant(request) {
    for (let attempt = 0; attempt < TRANSITION_ATTEMPTS; attempt += 1) {
      const current = await this.getTurn(request.tenantId, request.turnId);
      if (current === null) {
        throw new TurnNotFoundError(`Turn ${pythonRepr(request.turnId)} does not exist.`);
      }
      if (current.status !== ACTIVE_STATUS) {
        throw new TurnTerminalError(`Turn ${pythonRepr(request.turnId)} is not active.`);
      }
      const event = {
        eventId: request.eventId,
        tenantId: current.tenantId,
        turnId: current.turnId,
        channelId: current.channelId,
        seq: current.nextEventSeq,
        kind: "turn.grant.replaced",
        body: request.body
      };
      try {
        await retryTransient(() => this.client.send(
          new TransactWriteItemsCommand2({
            TransactItems: [
              {
                Update: {
                  TableName: this.tableName,
                  Key: this.metaKey(request.tenantId, request.turnId),
                  UpdateExpression: "SET next_event_seq = :nextSeq",
                  ConditionExpression: "#status = :active AND next_event_seq = :seq",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":nextSeq": { N: String(current.nextEventSeq + 1) },
                    ":seq": { N: String(current.nextEventSeq) },
                    ":active": { S: ACTIVE_STATUS }
                  }
                }
              },
              { Put: { TableName: this.tableName, Item: encodeGrant(request.tenantId, request.turnId, request.grant) } },
              {
                Put: {
                  TableName: this.tableName,
                  Item: turnEventItem(event, request.expiresAt),
                  ConditionExpression: "attribute_not_exists(pk)"
                }
              }
            ]
          })
        ));
      } catch (error) {
        if (error instanceof TransactionCanceledException3) {
          continue;
        }
        throw error;
      }
      return event;
    }
    throw new Error(`Turn ${pythonRepr(request.turnId)} could not replace its grant after ${TRANSITION_ATTEMPTS} attempts.`);
  }
  async pointedTurn(tenantId, channelId, pointer, botId) {
    const key = turnPointerKey(tenantId, channelId, pointer, botId);
    const pointed = await this.client.send(
      new GetItemCommand3({
        TableName: this.tableName,
        Key: { pk: { S: key.pk }, sk: { S: key.sk } },
        ConsistentRead: true
      })
    );
    const turnId = pointed.Item?.turn_id?.S;
    return turnId === void 0 ? null : this.getTurn(tenantId, turnId);
  }
  async rejection(tenantId, turnId, attemptId) {
    const current = await this.getTurn(tenantId, turnId);
    if (current === null) {
      return new TurnNotFoundError(`Turn ${pythonRepr(turnId)} does not exist.`);
    }
    if (current.attemptId !== attemptId) {
      return new StaleAttemptError(
        `Turn ${pythonRepr(turnId)} rejected attempt ${pythonRepr(attemptId ?? "")} (current ${pythonRepr(current.attemptId ?? "")}).`
      );
    }
    return new TurnTerminalError(`Turn ${pythonRepr(turnId)} is not active.`);
  }
  async transition(request) {
    for (let attempt = 0; attempt < TRANSITION_ATTEMPTS; attempt += 1) {
      const current = await this.getTurn(request.tenantId, request.turnId);
      if (current === null || current.attemptId !== request.attemptId || current.status !== ACTIVE_STATUS) {
        throw await this.rejection(request.tenantId, request.turnId, request.attemptId);
      }
      if (request.holds !== void 0 && !request.holds(current)) {
        throw new StaleAttemptError(`Turn ${pythonRepr(request.turnId)} is no longer as the probe observed it.`);
      }
      const event = {
        eventId: request.eventId,
        tenantId: current.tenantId,
        turnId: current.turnId,
        channelId: current.channelId,
        seq: current.nextEventSeq,
        ...request.draft
      };
      const names = { "#status": "status" };
      const values = {
        ":nextSeq": { N: String(current.nextEventSeq + 1) },
        ":seq": { N: String(current.nextEventSeq) },
        ":active": { S: ACTIVE_STATUS },
        ...request.guard?.values ?? {}
      };
      Object.assign(names, request.guard?.names ?? {});
      let ownerCondition = "attribute_not_exists(attempt_id)";
      if (request.attemptId !== null) {
        ownerCondition = "attempt_id = :attemptId";
        values[":attemptId"] = { S: request.attemptId };
      }
      const guardCondition = request.guard === void 0 ? "" : ` AND ${request.guard.expression}`;
      const assignments = ["next_event_seq = :nextSeq"];
      for (const [name, value] of Object.entries(request.set)) {
        names[`#set_${name}`] = name;
        values[`:set_${name}`] = value;
        assignments.push(`#set_${name} = :set_${name}`);
      }
      const removals = request.remove.map((name) => {
        names[`#remove_${name}`] = name;
        return `#remove_${name}`;
      });
      const removeClause = removals.length === 0 ? "" : ` REMOVE ${removals.join(", ")}`;
      try {
        await retryTransient(() => this.client.send(
          new TransactWriteItemsCommand2({
            TransactItems: [
              {
                Update: {
                  TableName: this.tableName,
                  Key: this.metaKey(request.tenantId, request.turnId),
                  UpdateExpression: `SET ${assignments.join(", ")}${removeClause}`,
                  ConditionExpression: `${ownerCondition} AND #status = :active AND next_event_seq = :seq${guardCondition}`,
                  ExpressionAttributeNames: names,
                  ExpressionAttributeValues: values
                }
              },
              {
                Put: {
                  TableName: this.tableName,
                  Item: turnEventItem(event, request.expiresAt),
                  ConditionExpression: "attribute_not_exists(pk)"
                }
              }
            ]
          })
        ));
      } catch (error) {
        if (error instanceof TransactionCanceledException3) {
          continue;
        }
        throw error;
      }
      if (request.terminal) {
        await this.clearActivePointers(current);
      }
      return event;
    }
    throw new Error(`Turn ${pythonRepr(request.turnId)} could not append an event after ${TRANSITION_ATTEMPTS} attempts.`);
  }
  async clearActivePointers(turn) {
    for (const botId of [turn.botId, null]) {
      const key = turnPointerKey(turn.tenantId, turn.channelId, "active", botId);
      try {
        await retryTransient(() => this.client.send(
          new DeleteItemCommand3({
            TableName: this.tableName,
            Key: { pk: { S: key.pk }, sk: { S: key.sk } },
            ConditionExpression: "turn_id = :turnId",
            ExpressionAttributeValues: { ":turnId": { S: turn.turnId } }
          })
        ));
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException3)) {
          throw error;
        }
      }
    }
  }
};

// conversation/src/store/turn-admission-store.ts
var turnPartitionKey = turnItemPartitionKey;
var activeTurnPointerKey = (tenantId, channelId, botId) => turnPointerKey(tenantId, channelId, "active", botId);
var ACTIVE_STATUS2 = "active";
var pointerItem = (key, request) => ({
  pk: { S: key.pk },
  sk: { S: key.sk },
  tenant_id: { S: request.tenantId },
  channel_id: { S: request.channelId },
  bot_id: { S: request.botId },
  turn_id: { S: request.turnId }
});
var DynamoTurnAdmission = class {
  client;
  tableName;
  /**
   * @param client DynamoDB client.
   * @param tableName The Messaging table.
   */
  constructor(client, tableName) {
    this.client = client;
    this.tableName = tableName;
  }
  reservationAdmissionUpdate(fence, turnId, kind) {
    const key = postIdempotencyKey(fence.tenantId, fence.idempotencyKey);
    return { Update: {
      TableName: this.tableName,
      Key: { pk: { S: key.pk }, sk: { S: key.sk } },
      UpdateExpression: "SET admitted_turn_id = :turn, admission_kind = :kind",
      ConditionExpression: "reservation_state = :pending AND reservation_owner = :owner AND lease_expires_at > :now",
      ExpressionAttributeValues: {
        ":turn": { S: turnId },
        ":kind": { S: kind },
        ":pending": { S: "pending" },
        ":owner": { S: fence.ownerId },
        ":now": { N: String(fence.now.getTime()) }
      }
    } };
  }
  async reservationFenceIsCurrent(fence) {
    const key = postIdempotencyKey(fence.tenantId, fence.idempotencyKey);
    const result = await this.client.send(new GetItemCommand4({
      TableName: this.tableName,
      Key: { pk: { S: key.pk }, sk: { S: key.sk } },
      ConsistentRead: true
    }));
    return result.Item?.reservation_state?.S === "pending" && result.Item.reservation_owner?.S === fence.ownerId && Number(result.Item.lease_expires_at?.N ?? "0") > fence.now.getTime();
  }
  async reservationAdmissionMatches(fence, turnId, kind) {
    const key = postIdempotencyKey(fence.tenantId, fence.idempotencyKey);
    const result = await this.client.send(new GetItemCommand4({
      TableName: this.tableName,
      Key: { pk: { S: key.pk }, sk: { S: key.sk } },
      ConsistentRead: true
    }));
    return result.Item?.admitted_turn_id?.S === turnId && result.Item?.admission_kind?.S === kind;
  }
  async openTurn(tenantId, channelId, botId) {
    const pointerKey = activeTurnPointerKey(tenantId, channelId, botId);
    const pointer = await this.client.send(
      new GetItemCommand4({
        TableName: this.tableName,
        Key: { pk: { S: pointerKey.pk }, sk: { S: pointerKey.sk } },
        ConsistentRead: true
      })
    );
    const pointerTurnId = pointer.Item?.turn_id?.S;
    if (pointerTurnId === void 0) {
      return null;
    }
    const turn = await this.client.send(
      new GetItemCommand4({
        TableName: this.tableName,
        Key: { pk: { S: turnPartitionKey(tenantId, pointerTurnId) }, sk: { S: "meta" } },
        ConsistentRead: true
      })
    );
    return {
      pointerTurnId,
      active: turn.Item?.status?.S === ACTIVE_STATUS2,
      closing: turn.Item?.closing?.BOOL === true
    };
  }
  async startTurn(request) {
    const pointerKey = activeTurnPointerKey(request.tenantId, request.channelId, request.botId);
    const pointerCondition = request.expectedPointerTurnId === null ? { ConditionExpression: "attribute_not_exists(pk)" } : {
      ConditionExpression: "turn_id = :expected",
      ExpressionAttributeValues: { ":expected": { S: request.expectedPointerTurnId } }
    };
    const grantPuts = request.grant === null ? [] : [{ Put: { TableName: this.tableName, Item: encodeGrant(request.tenantId, request.turnId, request.grant) } }];
    try {
      await retryTransient(() => this.client.send(
        new TransactWriteItemsCommand3({
          TransactItems: [
            ...grantPuts,
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: { S: turnPartitionKey(request.tenantId, request.turnId) },
                  sk: { S: "meta" },
                  tenant_id: { S: request.tenantId },
                  turn_id: { S: request.turnId },
                  channel_id: { S: request.channelId },
                  bot_id: { S: request.botId },
                  status: { S: ACTIVE_STATUS2 },
                  prompt_message_seq: { N: String(request.promptMessageSeq) },
                  prompt_author_id: { S: request.promptAuthorId },
                  attempt: { N: "0" },
                  next_event_seq: { N: "2" },
                  recovery_attempts: { N: "0" },
                  created_at: { S: formatIsoDateTime(request.createdAt) }
                },
                ConditionExpression: "attribute_not_exists(pk)"
              }
            },
            ...request.initialItem === void 0 ? [] : [{
              Put: {
                TableName: this.tableName,
                Item: mailboxItemAttributes(request.initialItem),
                ConditionExpression: MAILBOX_PUT_CONDITION,
                ExpressionAttributeValues: { ":messageId": { S: request.initialItem.messageId } }
              }
            }],
            {
              Put: {
                TableName: this.tableName,
                Item: pointerItem(pointerKey, request),
                ...pointerCondition
              }
            },
            {
              Put: {
                TableName: this.tableName,
                Item: pointerItem(turnPointerKey(request.tenantId, request.channelId, "latest", request.botId), request)
              }
            },
            {
              Put: {
                TableName: this.tableName,
                Item: pointerItem(turnPointerKey(request.tenantId, request.channelId, "active", null), request)
              }
            },
            {
              Put: {
                TableName: this.tableName,
                Item: pointerItem(turnPointerKey(request.tenantId, request.channelId, "latest", null), request)
              }
            },
            {
              Put: {
                TableName: this.tableName,
                Item: turnEventItem(
                  {
                    eventId: request.startedEventId,
                    tenantId: request.tenantId,
                    turnId: request.turnId,
                    channelId: request.channelId,
                    seq: 1,
                    kind: "turn.started"
                  },
                  new Date(request.createdAt.getTime() + TURN_EVENT_TTL_SECONDS * 1e3)
                ),
                ConditionExpression: "attribute_not_exists(pk)"
              }
            },
            ...request.reservationFence === void 0 ? [] : [this.reservationAdmissionUpdate(request.reservationFence, request.turnId, "started")]
          ]
        })
      ));
      return true;
    } catch (error) {
      if (request.reservationFence !== void 0 && await this.reservationAdmissionMatches(request.reservationFence, request.turnId, "started")) {
        return true;
      }
      if (error instanceof TransactionCanceledException4) {
        if (request.reservationFence !== void 0 && !await this.reservationFenceIsCurrent(request.reservationFence)) {
          throw new IdempotencyReservationBusyError("The message reservation is no longer owned by this admission attempt.");
        }
        return false;
      }
      throw error;
    }
  }
  async recordLogicalEnqueue(tenantId, turnId, enqueueId, fence) {
    if (fence === void 0) return recordLogicalEnqueueOnTurn(this.client, this.tableName, tenantId, turnId, enqueueId);
    return recordLogicalEnqueueOnTurn(this.client, this.tableName, tenantId, turnId, enqueueId, fence);
  }
  async steerTurn(turnId, item, fence) {
    try {
      await retryTransient(() => this.client.send(
        new TransactWriteItemsCommand3({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: { S: turnPartitionKey(item.tenantId, turnId) }, sk: { S: "meta" } },
                ConditionExpression: "#status = :active AND attribute_not_exists(closing)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":active": { S: ACTIVE_STATUS2 } }
              }
            },
            {
              Put: {
                TableName: this.tableName,
                Item: mailboxItemAttributes(item),
                ConditionExpression: MAILBOX_PUT_CONDITION,
                ExpressionAttributeValues: { ":messageId": { S: item.messageId } }
              }
            },
            ...fence === void 0 ? [] : [this.reservationAdmissionUpdate(fence, turnId, "steered")]
          ]
        })
      ));
      return true;
    } catch (error) {
      if (fence !== void 0 && await this.reservationAdmissionMatches(fence, turnId, "steered")) {
        return true;
      }
      if (error instanceof TransactionCanceledException4) {
        if (fence !== void 0 && !await this.reservationFenceIsCurrent(fence)) {
          throw new IdempotencyReservationBusyError("The message reservation is no longer owned by this admission attempt.");
        }
        const reasons = error.CancellationReasons ?? [];
        if (reasons[0]?.Code !== "ConditionalCheckFailed" && reasons[1]?.Code === "ConditionalCheckFailed") {
          throw new Error(`mailbox seq ${item.seq} already holds a different message`, { cause: error });
        }
        return false;
      }
      throw error;
    }
  }
};

// conversation/src/pi/message-cache.ts
var MESSAGE_CACHE_CAPACITY = 500;
var MessageBodyCache = class {
  entries = /* @__PURE__ */ new Map();
  capacity;
  /**
   * @param capacity The most entries kept; the least recently used entry beyond it is dropped.
   */
  constructor(capacity = MESSAGE_CACHE_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`message cache capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
  }
  /** The number of entries held. */
  get size() {
    return this.entries.size;
  }
  /**
   * Look up an entry and mark it most recently used.
   *
   * @param objectKey The S3 object key.
   * @returns The cached value, or undefined.
   */
  get(objectKey) {
    const value = this.entries.get(objectKey);
    if (value === void 0) return void 0;
    this.entries.delete(objectKey);
    this.entries.set(objectKey, value);
    return value;
  }
  /**
   * Store an entry as most recently used, evicting the least recently used one when over capacity.
   *
   * @param objectKey The S3 object key.
   * @param value The value to keep.
   * @returns This cache.
   */
  set(objectKey, value) {
    this.entries.delete(objectKey);
    this.entries.set(objectKey, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== void 0) this.entries.delete(oldest);
    }
    return this;
  }
  /**
   * Drop an entry.
   *
   * @param objectKey The S3 object key.
   * @returns Whether an entry was dropped.
   */
  delete(objectKey) {
    return this.entries.delete(objectKey);
  }
};

// conversation/src/pi/submission-inspector.ts
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT2 } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";

// conversation/src/storage/indexed-storage.ts
import { randomUUID } from "node:crypto";
import {
  BatchGetItemCommand,
  GetItemCommand as GetItemCommand6,
  PutItemCommand as PutItemCommand4,
  QueryCommand as QueryCommand6,
  TransactWriteItemsCommand as TransactWriteItemsCommand4,
  UpdateItemCommand as UpdateItemCommand6
} from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, GetObjectCommand as GetObjectCommand2, PutObjectCommand as PutObjectCommand2 } from "@aws-sdk/client-s3";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutableBatches } from "@earendil-works/chord/delta";
import {
  StorageRejected
} from "@earendil-works/pi-durable";

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
var encode12 = (value) => JSON.stringify(value);
var scopeKey = (scope) => {
  switch (scope.kind) {
    case "session":
      return encode12(["session"]);
    case "conversation":
      return encode12(["conversation", scope.conversationId]);
    case "task":
      return encode12(["task", scope.taskId]);
  }
};
var addressKey = (address) => encode12([address.kind, scopeKey(address.scope), address.key === void 0 ? ["singleton"] : ["family", address.key]]);
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

// conversation/src/storage/snapshot-object.ts
import {
  GetItemCommand as GetItemCommand5,
  QueryCommand as QueryCommand5,
  UpdateItemCommand as UpdateItemCommand5
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
var SNAPSHOT_FORMAT = 1;
var SNAPSHOT_FETCH_CONCURRENCY = 16;
var commitSuffix = (seq, fence) => `${String(seq).padStart(12, "0")}-${String(fence).padStart(8, "0")}`;
async function readSnapshotReference(client, tableName, storageId) {
  const response = await client.send(
    new GetItemCommand5({
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
      new QueryCommand5({
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
    new GetItemCommand5({
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
        Body: encode12(snapshot),
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
      new UpdateItemCommand5({
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
        new UpdateItemCommand6({
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
      new UpdateItemCommand6({
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
        new PutItemCommand4({
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
      const detached = parse(encode12(writes));
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
      const body = encode12(object);
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
          new TransactWriteItemsCommand4({
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
        v: { S: encode12(record) },
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
        item.v = { S: encode12(write.value) };
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
        item.k = { S: encode12(write.value.kind) };
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
            S: `SR#${pad(write.value.conversationId)}#${digest(encode12(write.value.requestId))}#${pad(id)}`
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
        BACKGROUND_CONTEXT
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
    const kind = query.kind === void 0 ? void 0 : encode12(query.kind);
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
    const prefix = `SR#${pad(conversationId)}#${digest(encode12(requestId))}#`;
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
    return { record, version: base.version, value: parse(encode12(value)), deltasSinceBase: deltas.length };
  }
  keyOf(item) {
    return commitKey(this.storageId, number(item, "c"), number(item, "f"));
  }
  async resolve(item) {
    const object = await this.fetchCommit(this.keyOf(item), true);
    const write = object.writes[number(item, "p")];
    return parse(encode12(write.value));
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
        new QueryCommand6({
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
      new GetItemCommand6({ TableName: this.tableName, Key: { pk: { S: this.pk }, sk: { S: sk } }, ConsistentRead: true })
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

// conversation/src/pi/submission-inspector.ts
var turnRequestId = (turnId) => `turn:${turnId}`;
async function readTurnSubmission(storage, turnId, context = BACKGROUND_CONTEXT2) {
  return storage.submissionByRequest(ROOT_CONVERSATION_ID, turnRequestId(turnId), context);
}
var PiSubmissionInspector = class {
  options;
  constructor(options) {
    this.options = options;
  }
  async turnAnswered(turn) {
    const storage = await IndexedStorage.openExisting({
      ...this.options,
      storageId: storageIdFor(turn.tenantId, turn.botId, turn.channelId)
    });
    if (storage === void 0) return false;
    const record = await readTurnSubmission(storage, turn.turnId);
    return record?.type === "input" && record.status === "done";
  }
};

// conversation/src/turn/executor.ts
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT4 } from "@earendil-works/chord/context";
import {
  watchEvents
} from "@earendil-works/pi-durable";

// conversation/src/pi/channel-log.ts
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT3 } from "@earendil-works/chord/context";
import {
  createSession,
  defineDoc,
  ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID2,
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
async function appendLine(session, line, context = BACKGROUND_CONTEXT3) {
  return session.commit(async (tx) => {
    const log = await tx.doc(ChannelLogDoc, ROOT_CONVERSATION_ID2);
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
async function writeAttributedMessage(session, draft, context = BACKGROUND_CONTEXT3) {
  return session.commit(async (tx) => {
    const log = await tx.doc(ChannelLogDoc, ROOT_CONVERSATION_ID2);
    const existing = log.lines.find((line) => line.messageId === draft.messageId);
    if (existing) return existing.entryId;
    const entry = await tx.appendEntry(ROOT_CONVERSATION_ID2, attributedWriteEntryDraft(draft));
    log.lines.push(draftLine(draft, entry.id));
    return entry.id;
  }, context);
}
async function recordInputLine(session, draft, requestId, context = BACKGROUND_CONTEXT3) {
  return session.commit(async (tx) => {
    const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID2, requestId);
    if (submission?.entry === void 0) return "pending";
    const log = await tx.doc(ChannelLogDoc, ROOT_CONVERSATION_ID2);
    if (log.lines.some((existing) => existing.messageId === draft.messageId)) return "present";
    log.lines.push(draftLine({ ...draft, body: "" }, submission.entry));
    return "added";
  }, context);
}
async function readLog(storage, context = BACKGROUND_CONTEXT3) {
  const session = createSession(storage);
  const value = await session.snapshot(ChannelLogDoc, ROOT_CONVERSATION_ID2, context);
  return value === void 0 ? [] : value.lines.map((line) => ({ ...line }));
}
async function readEntryBody(storage, entryId, context = BACKGROUND_CONTEXT3) {
  const found = await storage.entry(entryId, context);
  if (found === void 0) return void 0;
  const data = found.entry.data;
  if (typeof data === "object" && data !== null && !Array.isArray(data) && typeof data.body === "string") return data.body;
  const message = found.entry.model?.[0];
  if (message === void 0) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.type === "text" ? part.text : "").join("");
}

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
var CapabilitySinkDenied2 = class extends Error {
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
    throw new CapabilitySinkDenied2(MEMBER_STANDING_DENIAL);
  }
}
function requireAllow(policy, request, memberStanding, { structuredArguments } = {}) {
  denyIfExceedsMemberStanding(policy, request, memberStanding, { structuredArguments });
  const decision = policy.evaluate(request);
  if (decision === "DENY") {
    const reason = policy.denials.length > 0 ? policy.denials[policy.denials.length - 1].reason : "denied";
    throw new CapabilitySinkDenied2(reason);
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
    throw new CapabilitySinkDenied2(reason);
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
    if (error instanceof CapabilitySinkDenied2) {
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
    if (error instanceof CapabilitySinkDenied2) {
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
    if (error instanceof CapabilitySinkDenied2 || error instanceof MemberStandingRequiredError) {
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
import { createHash as createHash2 } from "node:crypto";
var NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
function uuid5(namespace, name) {
  const hash = createHash2("sha1").update(Buffer.from(namespace.replace(/-/g, ""), "hex")).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = bytes[6] & 15 | 80;
  bytes[8] = bytes[8] & 63 | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function pythonJsonString(value) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}
function directChannelId(tenantId, userId, botId) {
  const identity = `[${[tenantId, userId, botId].map(pythonJsonString).join(", ")}]`;
  return uuid5(NAMESPACE_URL, `chatticus:direct:${identity}`);
}
async function createChannel(tenantId, userId, botIds, options, deps) {
  const kind = options.kind ?? "direct";
  const uniqueBotIds = [...new Set(botIds)];
  const normalizedName = options.name === void 0 || options.name === null ? null : options.name.trim();
  if (kind === "direct") {
    if (uniqueBotIds.length !== 1 || normalizedName !== null) {
      throw new InvalidChannelIdentityError("A direct channel requires exactly one bot and no name.");
    }
  } else if (kind === "named") {
    if (uniqueBotIds.length < 2 || !normalizedName) {
      throw new InvalidChannelIdentityError("A named channel requires a name and at least two bots.");
    }
  } else {
    throw new InvalidChannelIdentityError(`Unknown channel kind ${pythonRepr(String(kind))}.`);
  }
  const idempotencyKey = options.idempotencyKey ?? null;
  if (idempotencyKey !== null) {
    const cached = await deps.store.getChannelIdempotency(tenantId, idempotencyKey);
    if (cached !== null) {
      return cached;
    }
  }
  const participants = [{ kind: "human", actorId: userId }];
  for (const botId of uniqueBotIds) {
    const bot = await botById(tenantId, botId, deps);
    if (bot.tenantId !== tenantId) {
      throw new ActorNotInChannelError(
        `Bot ${pythonRepr(botId)} does not belong to tenant ${pythonRepr(tenantId)}.`
      );
    }
    participants.push({ kind: "bot", actorId: botId });
  }
  if (kind === "direct") {
    for (const existing of await deps.store.listChannels(tenantId, userId)) {
      const existingBotIds = existing.participants.filter((participant) => participant.kind === "bot").map((participant) => participant.actorId);
      if (existing.kind === "direct" && existingBotIds.length === uniqueBotIds.length && existingBotIds.every((botId, index) => botId === uniqueBotIds[index])) {
        return existing;
      }
    }
  }
  const channelId = kind === "direct" ? directChannelId(tenantId, userId, uniqueBotIds[0]) : deps.ids.next();
  let channel = {
    channelId,
    tenantId,
    kind,
    name: normalizedName,
    participants,
    nextSeq: 1
  };
  if (kind === "direct") {
    channel = await deps.store.putChannelIfAbsent(channel);
  } else {
    await deps.store.putChannel(channel);
  }
  if (idempotencyKey !== null) {
    await deps.store.putChannelIdempotency(tenantId, idempotencyKey, channel);
  }
  return channel;
}
async function getChannel(tenantId, channelId, deps) {
  const record = await deps.store.getChannel(tenantId, channelId);
  if (record === null) {
    throw new ChannelNotFoundError(`Channel ${pythonRepr(channelId)} does not exist.`);
  }
  return record;
}
function primaryHumanParticipant(channel) {
  for (const participant of channel.participants) {
    if (participant.kind === "human") {
      return participant.actorId;
    }
  }
  throw new ActorNotInChannelError(`Channel ${pythonRepr(channel.channelId)} has no human participants.`);
}
async function requireChannelTenant(channelId, tenantId, deps) {
  const channel = await deps.store.getChannel(tenantId, channelId);
  if (channel !== null) {
    return channel;
  }
  const owningTenant = await deps.store.resolveChannelTenant(channelId);
  if (owningTenant !== null && owningTenant !== tenantId) {
    throw new ChannelTenantMismatchError(
      `Tenant ${pythonRepr(tenantId)} does not own channel ${pythonRepr(channelId)}.`
    );
  }
  throw new ChannelNotFoundError(`Channel ${pythonRepr(channelId)} does not exist.`);
}

// conversation/src/store/policy-store.ts
import {
  ConditionalCheckFailedException as ConditionalCheckFailedException4,
  GetItemCommand as GetItemCommand7,
  PutItemCommand as PutItemCommand5,
  QueryCommand as QueryCommand7
} from "@aws-sdk/client-dynamodb";

// conversation/src/store/codecs/approval.ts
function encode13(value) {
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
function decode12(item) {
  const kind = requireString2(item, "kind", "approval");
  if (kind !== "proposal" && kind !== "approval") {
    throw new Error("malformed approval item: kind");
  }
  return {
    approvalId: requireString2(item, "approval_id", "approval"),
    tenantId: requireString2(item, "tenant_id", "approval"),
    kind,
    actionType: requireString2(item, "action_type", "approval"),
    destination: item.destination?.S ?? "",
    payload: item.payload?.S ?? "",
    approverKind: item.approver_kind?.S ?? null,
    approverId: item.approver_id?.S ?? null
  };
}

// conversation/src/store/codecs/connection.ts
function encode14(value) {
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
function decode13(item) {
  const proposal = {
    proposalId: requireString2(item, "proposal_id", "connection"),
    grantingTenantId: requireString2(item, "granting_tenant_id", "connection"),
    receivingTenantId: requireString2(item, "receiving_tenant_id", "connection"),
    channelId: requireString2(item, "channel_id", "connection"),
    channelName: requireString2(item, "channel_name", "connection"),
    permission: requireString2(item, "permission", "connection"),
    proposerUserId: requireString2(item, "proposer_user_id", "connection")
  };
  const connectionId = item.connection_id?.S;
  const authorized = connectionId === void 0 ? null : {
    connectionId,
    grantingTenantId: proposal.grantingTenantId,
    receivingTenantId: proposal.receivingTenantId,
    channelId: proposal.channelId,
    channelName: proposal.channelName,
    permission: proposal.permission,
    clippedByUserId: requireString2(item, "clipped_by_user_id", "connection"),
    createdAt: new Date(requireString2(item, "created_at", "connection"))
  };
  return {
    proposal,
    status: item.status?.S ?? null,
    escalationTargetUserId: item.escalation_target_user_id?.S ?? null,
    authorized
  };
}

// conversation/src/store/codecs/rule.ts
function encode15(value) {
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
function decode14(item) {
  return {
    ruleId: requireString2(item, "rule_id", "rule"),
    tenantId: requireString2(item, "tenant_id", "rule"),
    kind: requireString2(item, "kind", "rule"),
    actionType: requireString2(item, "action_type", "rule"),
    userId: item.user_id?.S ?? null,
    argumentBindings: decodePairs(item.argument_bindings),
    creator: {
      kind: requireString2(item, "creator_kind", "rule"),
      actorId: requireString2(item, "creator_id", "rule")
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
    refusalId: requireString2(item, "refusal_id", "refusal"),
    tenantId: requireString2(item, "tenant_id", "refusal"),
    kind: requireString2(item, "kind", "refusal"),
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
    await this.create(encode13(approval), `approval ${JSON.stringify(approval.approvalId)}`);
  }
  async getApproval(tenantId, approvalId) {
    const item = await this.get(approvalKey(tenantId, approvalId));
    return item === null ? null : decode12(item);
  }
  async createRule(rule) {
    await this.create(encode15(rule), `rule ${JSON.stringify(rule.ruleId)}`);
  }
  async listRules(tenantId) {
    const items = await this.list(`${tenantId}#rules`, "RULE#");
    return items.map(decode14);
  }
  async createConnectionRecord(record) {
    await this.create(encode14(record), `connection ${JSON.stringify(record.proposal.proposalId)}`);
  }
  async replaceConnectionRecord(record) {
    await this.replace(encode14(record), `connection ${JSON.stringify(record.proposal.proposalId)}`);
  }
  async getConnectionRecord(grantingTenantId, proposalId) {
    const item = await this.get(connectionKey(grantingTenantId, proposalId));
    return item === null ? null : decode13(item);
  }
  async listConnectionRecords(grantingTenantId) {
    const items = await this.list(`${grantingTenantId}#connections`, "CONN#");
    return items.map(decode13);
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
        new PutItemCommand5({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)"
        })
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException4) {
        throw new PolicyItemAlreadyExistsError(`The ${description} already exists.`);
      }
      throw error;
    }
  }
  async replace(item, description) {
    try {
      await this.client.send(
        new PutItemCommand5({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_exists(pk)"
        })
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException4) {
        throw new PolicyItemNotFoundError(`The ${description} does not exist.`);
      }
      throw error;
    }
  }
  async put(item) {
    await this.client.send(new PutItemCommand5({ TableName: this.tableName, Item: item }));
  }
  async get(key) {
    const response = await this.client.send(
      new GetItemCommand7({
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
        new QueryCommand7({
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
  const others = covering.filter((userId) => userId !== proposal.proposerUserId).sort(compareStrings2);
  if (others.length > 0) {
    return others[0];
  }
  return [...covering].sort(compareStrings2)[0];
}
function compareStrings2(left, right) {
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

// conversation/src/pi/session.ts
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
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
import { ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID3 } from "@earendil-works/pi-durable";

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
  TransactionCanceledException as TransactionCanceledException5,
  TransactWriteItemsCommand as TransactWriteItemsCommand5
} from "@aws-sdk/client-dynamodb";
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
function ledgerRowAssignments(dimensions, summary, now2) {
  const row = assignment();
  row.put("tenant_id", text2(dimensions.tenantId));
  row.put("turn_id", text2(dimensions.turnId));
  row.put("vendor", text2(summary.vendor));
  row.put("model", text2(summary.model));
  row.put("input_tokens", number2(summary.contextInputTokens));
  row.put("output_tokens", number2(summary.outputTokens));
  row.put("billed_via", text2(BILLED_VIA_VENDOR));
  row.put("recorded_at", text2(summary.firstRecordedAt || now2));
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
function turnIndexAssignments(dimensions, summary, now2) {
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
  row.put("recorded_at", text2(summary.firstRecordedAt || now2));
  row.put("updated_at", text2(now2));
  return row;
}
var GUARD = "attribute_not_exists(#record_count) OR #record_count <= :recordCount";
async function projectTurnCost(deps, dimensions, summary) {
  const now2 = deps.now().toISOString();
  const ledgerKey = vendorLedgerKey(dimensions.tenantId, dimensions.turnId);
  const indexKey = costTurnIndexKey(dimensions.tenantId, (summary.firstRecordedAt || now2).slice(0, 7), dimensions.turnId);
  const ledger = ledgerRowAssignments(dimensions, summary, now2);
  const index = turnIndexAssignments(dimensions, summary, now2);
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
    await retryTransient(() => deps.client.send(new TransactWriteItemsCommand5({ TransactItems: items })));
    return true;
  } catch (error) {
    if (error instanceof TransactionCanceledException5 && error.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed")) {
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
  const log = await session.harness.snapshot(ChannelLogDoc, ROOT_CONVERSATION_ID3, context);
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
var INTERRUPTED_ACTION_RESULT = "The computer was lost while this tool ran, and it may have partially run.";
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
async function expireLostComputerActions(deps, tenantId) {
  const now2 = deps.clock.now();
  const changed = [];
  for (const action of await deps.actions.listOpen(tenantId)) {
    if (action.status !== "claimed" || action.leaseExpiresAt === null || action.leaseExpiresAt.getTime() > now2.getTime()) continue;
    const settled = action.envelope.idempotent ? await deps.actions.release(tenantId, action.actionId) : await deps.actions.complete({
      tenantId,
      actionId: action.actionId,
      workerId: null,
      result: INTERRUPTED_ACTION_RESULT,
      resultIsError: true,
      now: now2
    });
    if (settled !== null) changed.push(settled);
  }
  return changed;
}

// conversation/src/auth/worker-credentials.ts
import { createHash as createHash3, randomBytes, timingSafeEqual } from "node:crypto";
var TOKEN_SEPARATOR = ".";
function workerIdOfToken(token) {
  const index = token.lastIndexOf(TOKEN_SEPARATOR);
  return index <= 0 ? null : token.slice(0, index);
}
function hashWorkerToken(token) {
  return createHash3("sha256").update(token).digest("hex");
}
function verifyWorkerTokenHash(token, tokenHash) {
  const expected = Buffer.from(hashWorkerToken(token));
  const actual = Buffer.from(tokenHash);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// conversation/src/domain/workers.ts
var COST_CLASS_RANK = { local: 0, ec2: 1, fargate: 2 };
var AWS_COST_CLASSES = /* @__PURE__ */ new Set(["ec2", "fargate"]);
var MAX_CLAIMED_WORKER_ID_LENGTH = 200;
async function verifyWorkerToken(tenantId, token, deps) {
  const claimedWorkerId = workerIdOfToken(token);
  if (claimedWorkerId === null || claimedWorkerId.length > MAX_CLAIMED_WORKER_ID_LENGTH) {
    return null;
  }
  const worker = await deps.store.getWorker(tenantId, claimedWorkerId);
  return worker !== null && verifyWorkerTokenHash(token, worker.tokenHash) ? worker.workerId : null;
}
async function healthyWorkers(tenantId, deps) {
  const now2 = deps.clock.now().getTime();
  const healthy = [];
  for (const record of await deps.store.listWorkers(tenantId)) {
    if (now2 - record.lastHeartbeatAt.getTime() > deps.heartbeatTimeoutSeconds * 1e3) {
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
async function settleParkedTurn(deps, turn) {
  const pending = turn.pendingComputerTool;
  if (pending === null) return false;
  let resumed = false;
  for (const changed of await expireLostComputerActions(actionDependenciesOf(deps), turn.tenantId)) {
    if (changed.status === "done" && await resumeTurnForAction(deps, changed.tenantId, changed.turnId, changed.actionId)) {
      resumed = resumed || changed.turnId === turn.turnId;
    }
  }
  if (resumed) return true;
  const action = await deps.computer.actions.get(turn.tenantId, pending.actionId);
  if (action?.status === "done") {
    return resumeTurnForAction(deps, turn.tenantId, turn.turnId, action.actionId);
  }
  if (action?.status === "requested") {
    await ensureHostForParkedTurn(deps, turn);
  }
  return false;
}

// conversation/src/turn/probes.ts
var MAXIMUM_PROBE_DELAY_SECONDS = 900;
var WAITING_LIMIT_SECONDS = 15 * 60;
var DEFAULT_MAXIMUM_RECOVERY_ATTEMPTS = 1;
var RECOVERY_EXHAUSTED_REASON = "recovery attempts exhausted";
var COMPUTER_UNAVAILABLE_REASON = "computer unavailable";
function logicalEnqueueId(turnId, recoveryAttempt) {
  if (recoveryAttempt === void 0) return `${turnId}#initial`;
  return `${turnId}#recovery-${recoveryAttempt}`;
}
var finalizeEnqueueId = (turnId) => `${turnId}#finalize`;
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
var secondsBetween = (later, earlier) => (later.getTime() - earlier.getTime()) / 1e3;
async function resumeRecovery(deps, turn) {
  await requestLogicalEnqueue(
    { recorder: deps.turns.store, turnRuns: deps.turnRuns, faults: deps.faults },
    runJobFor(turn),
    logicalEnqueueId(turn.turnId, turn.recoveryAttempts)
  );
  await armProbe(deps.turnProbes, turn, TURN_DEADLINE_SECONDS);
}
async function handleUnownedTurn(deps, turn) {
  if (turn.recoveryAttempts < (deps.maximumRecoveryAttempts ?? DEFAULT_MAXIMUM_RECOVERY_ATTEMPTS)) {
    deps.faults?.maybeCrash("deadline_recovery", "before");
    const recovered = await recoverExpiredTurn(deps.turns, turn);
    if (recovered === null) return;
    deps.faults?.maybeCrash("deadline_recovery", "after");
    await resumeRecovery(deps, recovered);
    return;
  }
  if (await deps.submissions.turnAnswered(turn)) {
    const requested = await requestLogicalEnqueue(
      { recorder: deps.turns.store, turnRuns: deps.turnRuns, faults: deps.faults },
      runJobFor(turn),
      finalizeEnqueueId(turn.turnId)
    );
    if (requested) {
      await armProbe(deps.turnProbes, turn, TURN_DEADLINE_SECONDS);
      return;
    }
  }
  await failStaleTurn(deps.turns, turn, "lease_expired", RECOVERY_EXHAUSTED_REASON);
}
async function handleProbe(deps, message) {
  const turn = await deps.turns.store.getTurn(message.tenantId, message.turnId);
  if (turn === null || turn.status !== "active") return;
  const superseded = turn.attempt > message.expectAttempt;
  const now2 = deps.turns.clock.now();
  if (turn.waitingFor !== null) {
    if (superseded) return;
    if (deps.computer === void 0) {
      await failStaleTurn(deps.turns, turn, "waiting", "computer capability is unavailable for this conversation");
      return;
    }
    if (await settleParkedTurn({ ...deps, computer: deps.computer }, turn)) return;
    const since = turn.waitingSince ?? turn.deadlineAt ?? now2;
    const remaining = WAITING_LIMIT_SECONDS - secondsBetween(now2, since);
    if (remaining <= 0) {
      await failStaleTurn(deps.turns, turn, "waiting", COMPUTER_UNAVAILABLE_REASON);
      return;
    }
    await armProbe(deps.turnProbes, turn, Math.min(remaining, ATTEMPT_LEASE_SECONDS));
    return;
  }
  const recoveryId = logicalEnqueueId(turn.turnId, turn.recoveryAttempts);
  if (turn.attemptId === null && turn.recoveryAttempts > 0 && !turn.logicalEnqueueIds.includes(recoveryId)) {
    await resumeRecovery(deps, turn);
    return;
  }
  const ownedUntil = turn.leaseExpiresAt ?? turn.deadlineAt;
  if (ownedUntil !== null && ownedUntil.getTime() > now2.getTime()) {
    if (superseded) return;
    await armProbe(deps.turnProbes, turn, secondsBetween(ownedUntil, now2));
    return;
  }
  await handleUnownedTurn(deps, turn);
}

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
    this.context = deps.context ?? BACKGROUND_CONTEXT4;
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

// conversation/src/turn/openai-models.ts
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
var DEFAULT_TURN_MODEL = { provider: "openai", modelId: "gpt-6-luna", thinkingLevel: "low" };
function createOpenAiModels() {
  const models = createModels();
  models.setProvider(openaiProvider());
  return models;
}

// conversation/src/turn/sqs-queues.ts
import { ChangeMessageVisibilityCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
var RUN_VISIBILITY_SECONDS = 1800;
var SqsTurnRunQueue = class {
  client;
  queueUrl;
  constructor(client, queueUrl) {
    this.client = client;
    this.queueUrl = queueUrl;
  }
  async enqueue(job) {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(job) }));
  }
};
var SqsTurnProbeQueue = class {
  client;
  queueUrl;
  constructor(client, queueUrl) {
    this.client = client;
    this.queueUrl = queueUrl;
  }
  async send(message, delaySeconds) {
    await this.client.send(
      new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(message), DelaySeconds: delaySeconds })
    );
  }
};
var SqsRunVisibility = class {
  client;
  queueUrl;
  receiptHandle;
  constructor(client, queueUrl, receiptHandle) {
    this.client = client;
    this.queueUrl = queueUrl;
    this.receiptHandle = receiptHandle;
  }
  async extend() {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: this.receiptHandle,
        VisibilityTimeout: RUN_VISIBILITY_SECONDS
      })
    );
  }
};

// conversation/src/ledger/vendor-prices.ts
var OPENAI_VENDOR = "openai";
var OPENAI_PRICE_BOOK_ID = "openai@2026-10-13+pi-ai-1.0.2";
var OPENAI_MODEL_PRICES = {
  "gpt-6-luna": {
    input: "0.10",
    output: "0.50",
    cacheRead: "0.01",
    cacheWrite: "0.125",
    tiers: [{ inputTokensAbove: 272e3, input: "0.2", output: "0.75", cacheRead: "0.02", cacheWrite: "0.25" }]
  },
  "gpt-5-nano": { input: "0.05", output: "0.40", cacheRead: "0.005", cacheWrite: "0" },
  "gpt-5-mini": { input: "0.25", output: "2.00", cacheRead: "0.025", cacheWrite: "0" }
};
var cacheRatesOf = (entry) => ({
  ...entry.cacheRead === void 0 ? {} : { cacheReadPerMillionUsd: Decimal.parse(entry.cacheRead) },
  ...entry.cacheWrite === void 0 ? {} : { cacheWritePerMillionUsd: Decimal.parse(entry.cacheWrite) }
});
var tierOf = (entry) => ({
  inputTokensAbove: entry.inputTokensAbove,
  inputPerMillionUsd: Decimal.parse(entry.input),
  outputPerMillionUsd: Decimal.parse(entry.output),
  ...cacheRatesOf(entry)
});
function openAiModelPrice(modelId) {
  const entry = OPENAI_MODEL_PRICES[modelId];
  if (entry === void 0) throw new Error(`No OpenAI price is tabled for model ${modelId}.`);
  return {
    inputPerMillionUsd: Decimal.parse(entry.input),
    outputPerMillionUsd: Decimal.parse(entry.output),
    ...cacheRatesOf(entry),
    ...entry.tiers === void 0 ? {} : { tiers: entry.tiers.map(tierOf) }
  };
}
function defaultVendorPriceBook() {
  const book = new VendorPriceBook(OPENAI_PRICE_BOOK_ID);
  for (const modelId of Object.keys(OPENAI_MODEL_PRICES)) book.register(OPENAI_VENDOR, modelId, openAiModelPrice(modelId));
  return book;
}

// conversation/src/lambdas/openai-key.ts
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
async function resolveOpenAiApiKey(environment = process.env, reader = new SSMClient({})) {
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

// conversation/src/http/embedded-chat-app.ts
import { Hono } from "hono";

// conversation/src/auth/cognito.ts
import { CognitoJwtVerifier } from "aws-jwt-verify";
var CognitoTokenError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "CognitoTokenError";
  }
};

// conversation/src/auth/principal.ts
var IdentityNotFoundError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "IdentityNotFoundError";
  }
};
var MembershipNotFoundError = class extends Error {
  userId;
  constructor(message, userId = null) {
    super(message);
    this.name = "MembershipNotFoundError";
    this.userId = userId;
  }
};
var OrgAccessDeniedError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "OrgAccessDeniedError";
  }
};
var NotAMemberError = class extends OrgAccessDeniedError {
  userId;
  constructor(message, userId) {
    super(message);
    this.name = "NotAMemberError";
    this.userId = userId;
  }
};
var PrincipalAudienceDeniedError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PrincipalAudienceDeniedError";
  }
};
var PrincipalHttpError = class extends Error {
  status;
  detail;
  /** The user id of a signed-in caller who is not a member of the organization in the path; null for every other refusal. */
  nonMemberUserId;
  constructor(status, detail, nonMemberUserId = null) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.nonMemberUserId = nonMemberUserId;
    this.name = "PrincipalHttpError";
  }
};
var orgPathPattern = /^\/orgs\/([^/]+)(?:\/|$)/;
function parseBearerToken(authorization) {
  if (authorization === null) {
    return null;
  }
  const separatorIndex = authorization.indexOf(" ");
  const scheme = separatorIndex === -1 ? authorization : authorization.slice(0, separatorIndex);
  if (scheme.toLowerCase() !== "bearer") {
    return null;
  }
  const token = separatorIndex === -1 ? "" : authorization.slice(separatorIndex + 1).trim();
  return token === "" ? null : token;
}
function orgTenantIdFromPath(path) {
  const match = orgPathPattern.exec(path);
  return match === null ? null : match[1] ?? null;
}
async function resolveUserPrincipalFromToken(dependencies, tenantId, token) {
  const claims = await dependencies.verifier.verifyIdToken(token);
  const identity = await dependencies.directory.getIdentityByEmail(claims.email);
  if (identity === null) {
    throw new IdentityNotFoundError(`No identity is registered for email '${claims.email}'.`);
  }
  let cached = dependencies.membershipCache.get(tenantId, identity.userId);
  if (cached === void 0) {
    const membership = await dependencies.directory.getMembership(tenantId, identity.userId);
    if (membership === null) {
      throw new MembershipNotFoundError(
        `User '${identity.userId}' is not a member of organization '${tenantId}'.`,
        identity.userId
      );
    }
    const organizationStatus = await dependencies.directory.getOrganizationStatus(tenantId);
    cached = { membership, organizationStatus, role: membership.role };
    dependencies.membershipCache.set(tenantId, identity.userId, cached);
  }
  return {
    kind: "user",
    tenantId,
    userId: identity.userId,
    workerId: null,
    organizationStatus: cached.organizationStatus,
    role: cached.role
  };
}
async function verifyOrgAccess(principal, pathTenantId, dependencies) {
  if (principal.kind === "worker") {
    if (principal.tenantId !== pathTenantId) {
      throw new OrgAccessDeniedError(
        `Worker '${principal.workerId}' is not registered for organization '${pathTenantId}'.`
      );
    }
    return;
  }
  if (principal.userId === null) {
    throw new OrgAccessDeniedError("User principal is missing user_id.");
  }
  const membership = await dependencies.directory.getMembership(pathTenantId, principal.userId);
  if (membership === null) {
    throw new NotAMemberError(
      `User '${principal.userId}' is not a member of organization '${pathTenantId}'.`,
      principal.userId
    );
  }
  const status = await dependencies.directory.getOrganizationStatus(pathTenantId);
  if (dependencies.requireEnabledMember && status !== "enabled") {
    throw new OrgAccessDeniedError(
      `Organization '${pathTenantId}' has status '${status}'; enabled membership is required.`
    );
  }
}
function forbidden(detail) {
  return new PrincipalHttpError(403, detail);
}
async function resolvePrincipal(request, dependencies) {
  const tenantId = orgTenantIdFromPath(new URL(request.url).pathname);
  if (tenantId === null) {
    throw forbidden("user credential required");
  }
  const token = parseBearerToken(request.headers.get("Authorization"));
  if (token === null) {
    throw forbidden("user credential required");
  }
  if (await dependencies.directory.verifyWorkerToken(tenantId, token) !== null) {
    throw forbidden("worker credential not accepted on this route");
  }
  let principal = null;
  if (dependencies.integrationTestAuthenticator !== void 0) {
    principal = await dependencies.integrationTestAuthenticator(tenantId, token);
  }
  try {
    if (principal === null) {
      principal = await resolveUserPrincipalFromToken(dependencies, tenantId, token);
    }
    await verifyOrgAccess(principal, tenantId, dependencies);
  } catch (error) {
    if (error instanceof CognitoTokenError || error instanceof IdentityNotFoundError || error instanceof MembershipNotFoundError || error instanceof OrgAccessDeniedError || error instanceof PrincipalAudienceDeniedError) {
      if (error instanceof NotAMemberError || error instanceof MembershipNotFoundError) {
        throw new PrincipalHttpError(403, error.message, error.userId);
      }
      throw forbidden(error.message);
    }
    throw error;
  }
  return principal;
}

// conversation/src/http/acting-user.ts
function assertActingUserId(principal, actingUserId) {
  if (principal.userId === null || actingUserId !== principal.userId) {
    throw new PrincipalHttpError(403, "the acting user must be the signed-in user");
  }
}
function assertHumanParticipantOfChannel(principal, channel) {
  const takesPart = channel.participants.some(
    (participant) => participant.kind === "human" && participant.actorId === principal.userId
  );
  if (!takesPart) {
    throw new PrincipalHttpError(403, "the signed-in user is not a participant of this channel");
  }
}
async function assertCallerParticipatesInChannel(principal, tenantId, channelId, deps) {
  const channel = await deps.store.getChannel(tenantId, channelId);
  if (channel === null) {
    return;
  }
  assertHumanParticipantOfChannel(principal, channel);
}

// conversation/src/auth/integration-test.ts
import { createHmac, timingSafeEqual as timingSafeEqual2 } from "node:crypto";

// conversation/src/domain/organizations.ts
var DEFAULT_MONTHLY_AWS_SPEND_CEILING_USD = Decimal.parse("50.00");

// conversation/src/acceptance/sigv4.ts
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";

// conversation/src/auth/integration-test.ts
function currentTime(config) {
  return config.now === null ? /* @__PURE__ */ new Date() : config.now();
}
function parseIntegrationTestToken(token) {
  const separatorIndex = token.lastIndexOf(".");
  if (separatorIndex === -1) {
    return null;
  }
  return [token.slice(0, separatorIndex), token.slice(separatorIndex + 1)];
}
function verifyIntegrationTestToken(token, config) {
  const parsed = parseIntegrationTestToken(token);
  if (parsed === null) {
    return null;
  }
  const [payloadSegment, signature] = parsed;
  const expected = Buffer.from(createHmac("sha256", config.hmacSecret).update(payloadSegment).digest("hex"));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual2(expected, actual)) {
    return null;
  }
  let payload;
  try {
    const decoded = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      return null;
    }
    payload = decoded;
  } catch {
    return null;
  }
  if (payload["kind"] !== "integration_test") {
    return null;
  }
  if (payload["tenant_id"] !== config.tenantId) {
    return null;
  }
  if (payload["user_id"] !== config.userId) {
    return null;
  }
  const expiresAt = payload["exp"];
  if (typeof expiresAt !== "number" || !Number.isInteger(expiresAt)) {
    return null;
  }
  if (expiresAt <= Math.floor(currentTime(config).getTime() / 1e3)) {
    return null;
  }
  return payload;
}
async function resolveIntegrationTestPrincipal(directory, tenantId, token, config) {
  if (verifyIntegrationTestToken(token, config) === null) {
    throw new PrincipalHttpError(403, "invalid integration test credential");
  }
  if (tenantId !== config.tenantId) {
    throw new PrincipalHttpError(403, "integration test credential tenant mismatch");
  }
  const membership = await directory.getMembership(tenantId, config.userId);
  if (membership === null) {
    throw new PrincipalHttpError(
      403,
      `User '${config.userId}' is not a member of organization '${tenantId}'.`
    );
  }
  return {
    kind: "integration",
    tenantId,
    userId: config.userId,
    workerId: null,
    organizationStatus: await directory.getOrganizationStatus(tenantId),
    role: membership.role
  };
}
function integrationTestAuthenticator(directory, config) {
  return async (tenantId, token) => {
    if (verifyIntegrationTestToken(token, config) === null) {
      return null;
    }
    return resolveIntegrationTestPrincipal(directory, tenantId, token, config);
  };
}

// conversation/src/auth/membership-cache.ts
var MembershipCache = class _MembershipCache {
  static maximumEntries = 1e3;
  static timeToLiveMilliseconds = 3e4;
  entries = /* @__PURE__ */ new Map();
  clock;
  constructor(clock) {
    this.clock = clock;
  }
  get(tenantId, userId) {
    const key = `${tenantId}:${userId}`;
    const entry = this.entries.get(key);
    if (entry === void 0) {
      return void 0;
    }
    if (this.clock.nowMilliseconds() >= entry.expiresAt) {
      this.entries.delete(key);
      return void 0;
    }
    return entry.value;
  }
  set(tenantId, userId, value) {
    const key = `${tenantId}:${userId}`;
    this.entries.delete(key);
    if (this.entries.size >= _MembershipCache.maximumEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== void 0) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, {
      value,
      expiresAt: this.clock.nowMilliseconds() + _MembershipCache.timeToLiveMilliseconds
    });
  }
  clear() {
    this.entries.clear();
  }
  get size() {
    return this.entries.size;
  }
};

// conversation/src/auth/store-principal-directory.ts
var StorePrincipalDirectory = class {
  store;
  constructor(store) {
    this.store = store;
  }
  async getIdentityByEmail(email) {
    const identity = await this.store.getIdentityByEmail(email);
    if (identity === null) {
      return null;
    }
    return { userId: identity.userId };
  }
  async getMembership(tenantId, userId) {
    return this.store.getMembership(tenantId, userId);
  }
  async getOrganizationStatus(tenantId) {
    const organization = await this.store.getOrganization(tenantId);
    if (organization === null) {
      throw new OrganizationNotFoundError(`Organization ${JSON.stringify(tenantId)} is unknown.`);
    }
    return organization.status;
  }
  async verifyWorkerToken(tenantId, token) {
    return verifyWorkerToken(tenantId, token, { store: this.store });
  }
};

// conversation/src/http/user-principal.ts
function createUserMembershipCache(clock) {
  return new MembershipCache({ nowMilliseconds: () => clock.now().getTime() });
}
async function resolveUserPrincipal(c, deps, options = { requireEnabledMember: true }) {
  if (deps.resolveHostPrincipal !== void 0) {
    const principal = await deps.resolveHostPrincipal(c.req.raw);
    if (principal === null) return c.json({ detail: "host identity is not authorized" }, 401);
    if (principal.kind !== "user" || principal.userId === null || !principal.userId.trim() || !principal.tenantId.trim() || principal.organizationStatus !== "enabled") {
      return c.json({ detail: "host identity is not authorized" }, 403);
    }
    if (options.requireEnabledMember && principal.role !== "owner" && principal.role !== "member") {
      return c.json({ detail: "host identity is not authorized" }, 403);
    }
    return principal;
  }
  if (deps.verifier === null) {
    return c.json({ detail: "Cognito verifier is not configured." }, 503);
  }
  const directory = new StorePrincipalDirectory(deps.store);
  return resolvePrincipal(c.req.raw, {
    verifier: deps.verifier,
    directory,
    membershipCache: deps.membershipCache,
    requireEnabledMember: options.requireEnabledMember,
    ...deps.integrationTest === null ? {} : { integrationTestAuthenticator: integrationTestAuthenticator(directory, deps.integrationTest) }
  });
}
function isRefusal(result) {
  return result instanceof Response;
}
function pathParameter(c, name) {
  const value = c.req.param(name);
  if (value === void 0) {
    throw new Error(`Route is missing path parameter ${name}.`);
  }
  return value;
}

// conversation/src/http/routes/channels.ts
function channelPayload(channel) {
  return {
    channel_id: channel.channelId,
    tenant_id: channel.tenantId,
    user_id: primaryHumanParticipant(channel),
    kind: channel.kind,
    name: channel.name,
    participants: channel.participants.map((participant) => ({
      kind: participant.kind,
      actor_id: participant.actorId
    }))
  };
}

// conversation/src/domain/messages.ts
import { createHash as createHash4, randomUUID as randomUUID2 } from "node:crypto";

// conversation/src/pi/message-activity.ts
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT5 } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID4 } from "@earendil-works/pi-durable";
var ACTIVITY_ITEM_LIMIT = 50;
var ACTIVITY_RESPONSE_CHARACTER_BUDGET = 3e6;
var ENTRY_PAGE_SIZE2 = 200;
var countingItem = (omitted) => ({
  call_id: "more",
  tool: "more",
  summary: `${omitted} more tool calls`,
  arguments: {},
  arguments_truncated: false,
  ok: null,
  result_summary: null,
  output: null,
  output_truncated: false,
  duration_ms: null
});
function capActivity(items, totalCalls = items.length) {
  if (totalCalls <= ACTIVITY_ITEM_LIMIT) return [...items];
  const kept = ACTIVITY_ITEM_LIMIT - 1;
  return [...items.slice(0, kept), countingItem(totalCalls - kept)];
}
function fitActivityBudget(activities, budget = ACTIVITY_RESPONSE_CHARACTER_BUDGET) {
  const fitted = activities.map(() => void 0);
  let remaining = budget;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity === void 0) continue;
    const size = JSON.stringify(activity).length;
    if (size > remaining) continue;
    remaining -= size;
    fitted[index] = activity;
  }
  return fitted;
}
async function readTurnActivity(storage, afterEntryId, answerEntryId, context = BACKGROUND_CONTEXT5) {
  const newestFirst = [];
  let cursor;
  do {
    const page2 = await storage.scanEntries(
      { conversationId: ROOT_CONVERSATION_ID4, minEntryId: afterEntryId + 1, maxEntryId: answerEntryId },
      ENTRY_PAGE_SIZE2,
      cursor,
      context
    );
    newestFirst.push(...page2.items);
    cursor = page2.next;
  } while (cursor !== void 0);
  const calls = /* @__PURE__ */ new Map();
  let totalCalls = 0;
  for (const entry of newestFirst.reverse()) {
    const message = entry.model?.[0];
    if (message?.role === "assistant") {
      for (const call of toolCallsOf(message.content)) {
        totalCalls += 1;
        if (calls.size >= ACTIVITY_ITEM_LIMIT) continue;
        const fields = toolCallFields(call.name, call.id, call.arguments);
        calls.set(call.id, {
          id: call.id,
          writtenBytes: fields.writtenBytes,
          item: {
            call_id: fields.callId,
            tool: fields.tool,
            summary: fields.summary,
            arguments: fields.toolArguments,
            arguments_truncated: fields.argumentsTruncated,
            ok: null,
            result_summary: null,
            output: null,
            output_truncated: false,
            duration_ms: null
          }
        });
      }
    } else if (message?.role === "toolResult") {
      const recorded = calls.get(message.toolCallId);
      if (recorded === void 0) continue;
      const fields = toolResultFields(
        recorded.item.tool,
        recorded.id,
        textOf(message.content),
        message.isError === true,
        recorded.writtenBytes,
        null
      );
      recorded.item.ok = fields.ok;
      recorded.item.result_summary = fields.summary;
      recorded.item.output = fields.output;
      recorded.item.output_truncated = fields.outputTruncated;
    }
  }
  return capActivity([...calls.values()].map((call) => call.item), totalCalls);
}

// conversation/src/pi/channel-listing.ts
var authoritative = (candidate, current) => candidate.line.authorKind === "bot" && candidate.line.authorId === candidate.botId && current.line.authorId !== current.botId;
async function listChannelMessages(dependencies, tenantId, channelId, botIds, afterSeq = 0) {
  const mailboxStore = { client: dependencies.client, tableName: dependencies.messagingTableName };
  const bySeq = /* @__PURE__ */ new Map();
  for (const botId of botIds) {
    const storageId = storageIdFor(tenantId, botId, channelId);
    const storage = dependencies.openExistingStorage === void 0 ? await IndexedStorage.openExisting({
      client: dependencies.client,
      s3: dependencies.s3,
      tableName: dependencies.conversationsTableName,
      bucket: dependencies.bucket,
      storageId,
      commitCache: dependencies.commitCache
    }) : await dependencies.openExistingStorage(storageId);
    const allLines = storage === void 0 ? [] : await readLog(storage);
    const session = storage === void 0 ? void 0 : { storage, lines: allLines };
    const logged = storage === void 0 ? [] : allLines.filter((line) => line.seq > afterSeq).map((line) => ({ line, body: () => readEntryBody(storage, line.entryId) }));
    for (const { line, body } of logged) {
      const current = bySeq.get(line.seq);
      if (current?.line !== void 0 && !authoritative({ line, botId }, { line: current.line, botId: current.botId })) continue;
      bySeq.set(line.seq, {
        line,
        botId,
        session,
        listed: {
          message_id: line.messageId,
          channel_id: channelId,
          tenant_id: tenantId,
          seq: line.seq,
          author_kind: line.authorKind,
          author_id: line.authorId,
          addressed_to_bot_id: line.addressedToBotId,
          created_at: line.createdAt
        },
        body: body().then((text3) => text3 ?? "")
      });
    }
    for (const item of await list(mailboxStore, tenantId, botId, channelId, afterSeq)) {
      if (bySeq.has(item.seq)) continue;
      bySeq.set(item.seq, {
        botId,
        listed: {
          message_id: item.messageId,
          channel_id: channelId,
          tenant_id: tenantId,
          seq: item.seq,
          author_kind: item.authorKind,
          author_id: item.authorId,
          addressed_to_bot_id: item.addressedToBotId,
          created_at: item.createdAt
        },
        body: Promise.resolve(item.body)
      });
    }
  }
  const ordered = [...bySeq.values()].sort((left, right) => left.listed.seq - right.listed.seq);
  const activities = fitActivityBudget(await Promise.all(ordered.map((entry) => activityOf(entry))));
  return Promise.all(
    ordered.map(async (entry, index) => {
      const activity = activities[index];
      return { ...entry.listed, body: await entry.body, ...activity === void 0 ? {} : { activity } };
    })
  );
}
var activityOf = async (entry) => {
  const { line, session } = entry;
  if (line === void 0 || session === void 0) return void 0;
  if (line.authorKind !== "bot" || line.authorId !== entry.botId) return void 0;
  const previousAnswer = session.lines.filter((candidate) => candidate.authorKind === "bot" && candidate.authorId === entry.botId && candidate.entryId < line.entryId).reduce((newest, candidate) => Math.max(newest, candidate.entryId), 0);
  const activity = await readTurnActivity(session.storage, previousAnswer, line.entryId);
  return activity.length === 0 ? void 0 : activity;
};

// conversation/src/domain/messages.ts
function scopedPostIdempotencyKey(request) {
  if (request.idempotencyKey === null) return null;
  return createHash4("sha256").update(JSON.stringify([request.tenantId, request.channelId, request.authorKind, request.authorId, request.idempotencyKey])).digest("hex");
}
function postRequestFingerprint(request) {
  return createHash4("sha256").update(JSON.stringify([
    request.tenantId,
    request.channelId,
    request.authorKind,
    request.authorId,
    request.body,
    request.addressedToBotId,
    request.enqueueTurn !== false
  ])).digest("hex");
}
var CLOSING_POLL_ATTEMPTS = 100;
var DEFAULT_CLOSING_POLL_MILLISECONDS = 50;
function requireParticipant(channel, kind, actorId) {
  for (const participant of channel.participants) {
    if (participant.kind === kind && participant.actorId === actorId) {
      return;
    }
  }
  throw new ActorNotInChannelError(
    `${kind} ${pythonRepr(actorId)} is not a participant of channel ${pythonRepr(channel.channelId)}.`
  );
}
var sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function admitAddressedMessage(deps, channel, message, botId, addressedItem, options) {
  const pollMilliseconds = deps.closingPollMilliseconds ?? DEFAULT_CLOSING_POLL_MILLISECONDS;
  for (let attempt = 0; attempt < CLOSING_POLL_ATTEMPTS; attempt += 1) {
    const open = await deps.turns.openTurn(channel.tenantId, channel.channelId, botId);
    if (open !== null && open.active && !open.closing) {
      if (await deps.turns.steerTurn(open.pointerTurnId, addressedItem, options.fence)) {
        return { turnId: open.pointerTurnId, started: false, kind: "steered" };
      }
      continue;
    }
    if (open !== null && open.active && open.closing) {
      await sleep(pollMilliseconds);
      continue;
    }
    const turnId = options.reservedTurnId ?? deps.ids.next();
    await deps.turnProbes.send(
      { tenantId: channel.tenantId, turnId, kind: "deadline", expectAttempt: 0 },
      TURN_DEADLINE_SECONDS
    );
    const started = await deps.turns.startTurn({
      tenantId: channel.tenantId,
      channelId: channel.channelId,
      botId,
      turnId,
      promptMessageSeq: message.seq,
      promptAuthorId: message.authorId,
      grant: message.authorKind === "human" ? householdConversationGrant() : null,
      createdAt: message.createdAt,
      startedEventId: options.startedEventId ?? deps.ids.next(),
      expectedPointerTurnId: open === null ? null : open.pointerTurnId,
      initialItem: addressedItem,
      ...options.fence === void 0 ? {} : { reservationFence: { ...options.fence, now: deps.clock.now() } }
    });
    if (started) {
      deps.faults?.maybeCrash("message_commit", "after");
      return { turnId, started: true, kind: "started" };
    }
  }
  throw new Error(
    `Bot ${pythonRepr(botId)} on channel ${pythonRepr(channel.channelId)} did not accept a new turn; its previous turn is still closing.`
  );
}
async function postMessage(deps, request) {
  const idempotencyKey = scopedPostIdempotencyKey(request);
  const channel = await requireChannelTenant(request.channelId, request.tenantId, deps);
  requireParticipant(channel, request.authorKind, request.authorId);
  if (request.addressedToBotId !== null) {
    requireParticipant(channel, "bot", request.addressedToBotId);
  }
  deps.faults?.maybeCrash("message_commit", "before");
  let reservation = null;
  if (idempotencyKey !== null) {
    const candidate = {
      ownerId: randomUUID2(),
      messageId: deps.ids.next(),
      createdAt: deps.clock.now(),
      leaseExpiresAt: new Date(deps.clock.now().getTime() + 3e4),
      reservedTurnId: request.addressedToBotId === null ? null : deps.ids.next(),
      startedEventId: request.addressedToBotId === null ? null : deps.ids.next()
    };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await deps.store.reservePostIdempotency(
        request.tenantId,
        idempotencyKey,
        postRequestFingerprint(request),
        candidate,
        deps.clock.now()
      );
      if (result.state === "conflict") {
        throw new IdempotencyKeyReuseError("The idempotency key was already used with a different message payload.");
      }
      if (result.state === "completed") return result.result;
      if (result.state === "owner") {
        reservation = result.reservation;
        break;
      }
      await sleep(10);
    }
    if (reservation === null) {
      throw new IdempotencyReservationBusyError("The message request is already being processed; retry with the same key.");
    }
  }
  const allocatedSeq = reservation?.seq ?? await allocateSeq(deps.mailbox, channel.tenantId, channel.channelId);
  let seq = allocatedSeq;
  if (reservation !== null) {
    const savedSeq = await deps.store.setPostIdempotencySequence(
      request.tenantId,
      idempotencyKey,
      reservation.ownerId,
      allocatedSeq,
      deps.clock.now()
    );
    if (savedSeq === null) {
      throw new IdempotencyReservationBusyError("The message reservation was reclaimed before its sequence was saved.");
    }
    seq = savedSeq;
  }
  const message = {
    messageId: reservation?.messageId ?? deps.ids.next(),
    channelId: channel.channelId,
    tenantId: channel.tenantId,
    seq,
    authorKind: request.authorKind,
    authorId: request.authorId,
    body: request.body,
    addressedToBotId: request.addressedToBotId,
    createdAt: reservation?.createdAt ?? deps.clock.now()
  };
  const itemFor = (botId) => ({
    tenantId: channel.tenantId,
    botId,
    channelId: channel.channelId,
    seq,
    messageId: message.messageId,
    authorKind: message.authorKind,
    authorId: message.authorId,
    addressedToBotId: message.addressedToBotId,
    body: message.body,
    createdAt: message.createdAt.toISOString()
  });
  const participatingBotIds = channel.participants.filter((participant) => participant.kind === "bot").map((participant) => participant.actorId);
  for (const botId of participatingBotIds) {
    if (botId !== request.addressedToBotId) {
      await put(deps.mailbox, itemFor(botId));
    }
  }
  let turnId = null;
  if (request.addressedToBotId !== null) {
    let admission = reservation?.admission === null || reservation?.admission === void 0 ? null : { ...reservation.admission, started: reservation.admission.kind === "started" };
    if (admission === null) {
      admission = await admitAddressedMessage(
        deps,
        channel,
        message,
        request.addressedToBotId,
        itemFor(request.addressedToBotId),
        {
          reservedTurnId: reservation?.reservedTurnId,
          startedEventId: reservation?.startedEventId,
          ...reservation === null || idempotencyKey === null ? {} : {
            fence: { tenantId: request.tenantId, idempotencyKey, ownerId: reservation.ownerId, now: deps.clock.now() }
          }
        }
      );
    }
    turnId = admission.turnId;
    if (reservation?.admission?.kind === "started") {
      await deps.turnProbes.send(
        { tenantId: channel.tenantId, turnId: admission.turnId, kind: "deadline", expectAttempt: 0 },
        TURN_DEADLINE_SECONDS
      );
    }
    if (admission.kind === "started" && request.enqueueTurn !== false) {
      const fence = reservation === null || idempotencyKey === null ? void 0 : {
        tenantId: request.tenantId,
        idempotencyKey,
        ownerId: reservation.ownerId,
        now: deps.clock.now()
      };
      await requestLogicalEnqueue(
        { recorder: deps.turns, turnRuns: deps.turnRuns, faults: deps.faults },
        {
          tenantId: channel.tenantId,
          channelId: channel.channelId,
          botId: request.addressedToBotId,
          turnId: admission.turnId,
          requiredCapabilities: ["cpu"]
        },
        logicalEnqueueId(admission.turnId),
        fence
      );
    }
  }
  if (idempotencyKey !== null) {
    const completed = await deps.store.completePostIdempotency(
      request.tenantId,
      idempotencyKey,
      reservation.ownerId,
      message,
      turnId,
      deps.clock.now()
    );
    if (!completed) throw new IdempotencyReservationBusyError("The message reservation expired before completion; retry with the same key.");
  }
  return { message, turnId };
}
async function listMessages(deps, request) {
  const channel = await requireChannelTenant(request.channelId, request.tenantId, deps);
  const botIds = channel.participants.filter((participant) => participant.kind === "bot").map((participant) => participant.actorId);
  const listed = await listChannelMessages(
    deps.listing,
    channel.tenantId,
    channel.channelId,
    botIds,
    request.afterSeq ?? 0
  );
  return listed.map((entry) => ({
    messageId: entry.message_id,
    channelId: entry.channel_id,
    tenantId: entry.tenant_id,
    seq: entry.seq,
    authorKind: entry.author_kind,
    authorId: entry.author_id,
    body: entry.body,
    addressedToBotId: entry.addressed_to_bot_id,
    createdAt: new Date(entry.created_at),
    ...entry.activity === void 0 ? {} : { activity: entry.activity }
  }));
}

// conversation/src/http/routes/messages.ts
function tenantIdForRequest(c, principal, deps) {
  const tenantId = deps.tenantIdForPrincipal?.(principal) ?? pathParameter(c, "tenant_id");
  if (!tenantId.trim()) throw new Error("The host principal did not provide a tenant scope.");
  return tenantId;
}
function messagePayload(message) {
  return {
    message_id: message.messageId,
    channel_id: message.channelId,
    tenant_id: message.tenantId,
    seq: message.seq,
    author_kind: message.authorKind,
    author_id: message.authorId,
    body: message.body,
    addressed_to_bot_id: message.addressedToBotId,
    created_at: message.createdAt.toISOString(),
    ...message.activity === void 0 ? {} : { activity: message.activity }
  };
}
function parsePostMessageBody(raw) {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const body = raw;
  if (body.author_kind !== "human" && body.author_kind !== "bot") {
    return null;
  }
  if (typeof body.author_id !== "string" || typeof body.body !== "string") {
    return null;
  }
  const addressed = body.addressed_to_bot_id ?? null;
  if (addressed !== null && typeof addressed !== "string") {
    return null;
  }
  const enqueueTurn = body.enqueue_turn ?? true;
  if (typeof enqueueTurn !== "boolean") {
    return null;
  }
  return {
    authorKind: body.author_kind,
    authorId: body.author_id,
    body: body.body,
    addressedToBotId: addressed,
    enqueueTurn
  };
}
async function postChannelMessageHandler(c, deps) {
  const principal = await resolveUserPrincipal(c, deps);
  if (isRefusal(principal)) {
    return principal;
  }
  const body = parsePostMessageBody(await c.req.json().catch(() => null));
  if (body === null) {
    return c.json({ detail: "author_kind, author_id and body are required" }, 422);
  }
  if (body.authorKind !== "human") {
    return c.json({ detail: "bots post through the executor, not the user message route" }, 403);
  }
  assertActingUserId(principal, body.authorId);
  const result = await postMessage(deps.messages, {
    tenantId: tenantIdForRequest(c, principal, deps),
    channelId: pathParameter(c, "channel_id"),
    authorKind: body.authorKind,
    authorId: body.authorId,
    body: body.body,
    addressedToBotId: body.addressedToBotId,
    idempotencyKey: (c.req.header("Idempotency-Key") ?? "").trim() || null,
    enqueueTurn: body.enqueueTurn
  });
  return c.json({ message: messagePayload(result.message), turn_id: result.turnId }, 200);
}
async function listChannelMessagesHandler(c, deps) {
  const principal = await resolveUserPrincipal(c, deps);
  if (isRefusal(principal)) {
    return principal;
  }
  const tenantId = tenantIdForRequest(c, principal, deps);
  await assertCallerParticipatesInChannel(principal, tenantId, pathParameter(c, "channel_id"), deps.messages);
  const after = Number(c.req.query("after") ?? "0");
  if (!Number.isInteger(after) || after < 0) {
    return c.json({ detail: "after must be a non-negative integer" }, 422);
  }
  const messages = await listMessages(deps.messages, {
    tenantId,
    channelId: pathParameter(c, "channel_id"),
    afterSeq: after
  });
  return c.json({ messages: messages.map(messagePayload) }, 200);
}

// conversation/src/http/routes/turns.ts
function turnEventPayload(event) {
  const payload = {
    kind: event.kind,
    seq: event.seq,
    event_id: event.eventId,
    turn_id: event.turnId,
    channel_id: event.channelId
  };
  if (event.token !== void 0) {
    payload.token = event.token;
  }
  if (event.messageSeq !== void 0) {
    payload.message_seq = event.messageSeq;
  }
  if (event.body !== void 0) {
    payload.body = event.body;
  }
  if (event.pendingComputerTool !== void 0) {
    payload.pending_computer_tool = {
      action_id: event.pendingComputerTool.actionId,
      tool_name: event.pendingComputerTool.toolName,
      arguments: { ...event.pendingComputerTool.arguments }
    };
  }
  if (event.attemptId !== void 0) {
    payload.attempt_id = event.attemptId;
  }
  if (event.tool !== void 0) payload.tool = event.tool;
  if (event.callId !== void 0) payload.call_id = event.callId;
  if (event.summary !== void 0) payload.summary = event.summary;
  if (event.toolArguments !== void 0) payload.arguments = { ...event.toolArguments };
  if (event.argumentsTruncated !== void 0) payload.arguments_truncated = event.argumentsTruncated;
  if (event.ok !== void 0) payload.ok = event.ok;
  if (event.output !== void 0) payload.output = event.output;
  if (event.outputTruncated !== void 0) payload.output_truncated = event.outputTruncated;
  if (event.kind === "tool.result") payload.duration_ms = event.durationMs ?? null;
  if (event.text !== void 0) payload.text = event.text;
  if (event.detail !== void 0) payload.detail = event.detail;
  return payload;
}
async function readableTurn(c, deps) {
  const principal = await resolveUserPrincipal(c, deps);
  if (isRefusal(principal)) {
    return principal;
  }
  const tenantId = deps.tenantIdForPrincipal?.(principal) ?? pathParameter(c, "tenant_id");
  if (!tenantId.trim()) throw new Error("The host principal did not provide a tenant scope.");
  const turnId = pathParameter(c, "turn_id");
  try {
    const turn = await getTurn(deps.turns, tenantId, turnId);
    const channel = await getChannel(tenantId, turn.channelId, deps);
    assertHumanParticipantOfChannel(principal, channel);
    return turn;
  } catch (error) {
    if (error instanceof TurnNotFoundError) {
      throw new TurnAccessDeniedError(`Tenant ${pythonRepr(tenantId)} cannot read turn ${pythonRepr(turnId)}.`);
    }
    throw error;
  }
}
async function listTurnEventsHandler(c, deps) {
  const turn = await readableTurn(c, deps);
  if (turn instanceof Response) {
    return turn;
  }
  const after = Number(c.req.query("after") ?? "0");
  if (!Number.isInteger(after) || after < 0) {
    return c.json({ detail: "after must be a non-negative integer" }, 422);
  }
  const events = await listTurnEvents(deps.turns, turn.tenantId, turn.turnId, after);
  return c.json({ events: events.map(turnEventPayload) }, 200);
}

// conversation/src/http/routes/turn-stream.ts
import { streamSSE } from "hono/streaming";

// conversation/src/http/stream.ts
var DEFAULT_STREAM_TIMING = {
  minimumPollMilliseconds: 50,
  maximumPollMilliseconds: 1e3,
  heartbeatMilliseconds: 15e3,
  idleTimeoutMilliseconds: 6e5,
  maximumLifetimeMilliseconds: 84e4,
  writeStallMilliseconds: 1e4
};
var HEARTBEAT_FRAME = ": heartbeat\n\n";
var wallStreamClock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) => new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  })
};
var InvalidLastEventIdError = class extends Error {
};
function cursorFromLastEventId(headerValue) {
  if (headerValue === void 0) {
    return 0;
  }
  const stripped = headerValue.trim();
  if (stripped === "") {
    return 0;
  }
  if (!/^[0-9]+$/.test(stripped)) {
    throw new InvalidLastEventIdError(`Last-Event-ID '${headerValue}' is not a sequence.`);
  }
  return Number.parseInt(stripped, 10);
}
function formatEventFrame(kind, seq, payload) {
  return `event: ${kind}
id: ${seq}
data: ${JSON.stringify(payload)}

`;
}
async function writeFrameUnlessStalled(stream, frame, stallMilliseconds, clock) {
  const stallGuard = new AbortController();
  const stalled = clock.sleep(stallMilliseconds, stallGuard.signal, "write-stall").then(() => !stallGuard.signal.aborted);
  const written = stream.write(frame).then(() => false);
  const didStall = await Promise.race([written, stalled]);
  stallGuard.abort();
  return !didStall;
}

// conversation/src/http/routes/turn-stream.ts
var OpenStreamCounter = class {
  openCount = 0;
  /** The number of streams currently open. */
  get open() {
    return this.openCount;
  }
  /** Record one stream opening. */
  opened() {
    this.openCount += 1;
  }
  /** Record one stream ending. */
  closed() {
    this.openCount -= 1;
  }
};
var TERMINAL_KINDS = /* @__PURE__ */ new Set(["turn.completed", "turn.failed", "turn.reconciling"]);
var TERMINAL_KIND_OF_STATUS = {
  completed: "turn.completed",
  failed: "turn.failed",
  reconciling: "turn.reconciling"
};
var IDLE_RECONCILING_BODY = "Stream idle; reconcile from committed state.";
function formatTurnEventFrame(event) {
  return formatEventFrame(event.kind, event.seq, turnEventPayload(event));
}
function terminalEventFromTurn(turn, cursor, eventId) {
  const kind = TERMINAL_KIND_OF_STATUS[turn.status];
  if (kind === void 0) {
    throw new Error(`Turn ${turn.turnId} is ${turn.status}, which is not terminal.`);
  }
  const event = {
    eventId,
    tenantId: turn.tenantId,
    turnId: turn.turnId,
    channelId: turn.channelId,
    seq: Math.max(cursor, turn.nextEventSeq - 1),
    kind
  };
  if (kind === "turn.completed" && turn.messageSeq !== null) {
    event.messageSeq = turn.messageSeq;
  }
  if (kind !== "turn.completed" && turn.terminalReason !== null) {
    event.body = turn.terminalReason;
  }
  return event;
}
async function streamTurnHandler(c, deps) {
  const turn = await readableTurn(c, deps);
  if (turn instanceof Response) return turn;
  let cursor;
  try {
    cursor = cursorFromLastEventId(c.req.header("Last-Event-ID"));
  } catch (error) {
    if (error instanceof InvalidLastEventIdError) return c.json({ detail: error.message }, 400);
    throw error;
  }
  const timing = deps.streamTiming;
  const clock = deps.streamClock;
  const turnWasTerminalOnOpen = TERMINAL_KIND_OF_STATUS[turn.status] !== void 0;
  return streamSSE(c, async (stream) => {
    deps.openStreams.opened();
    const stopped = new AbortController();
    stream.onAbort(() => stopped.abort());
    const writeFrame = async (frame) => {
      const written = await writeFrameUnlessStalled(stream, frame, timing.writeStallMilliseconds, clock);
      if (!written) stopped.abort();
      return written;
    };
    try {
      const openedAt = clock.now();
      let lastEventAt = openedAt;
      let nextHeartbeatAt = openedAt + timing.heartbeatMilliseconds;
      let pollMilliseconds = timing.minimumPollMilliseconds;
      while (!stopped.signal.aborted) {
        const now2 = clock.now();
        if (now2 - openedAt >= timing.maximumLifetimeMilliseconds) return;
        if (now2 - lastEventAt >= timing.idleTimeoutMilliseconds) {
          const current = await getTurn(deps.turns, turn.tenantId, turn.turnId);
          if (current.waitingFor !== null) {
            lastEventAt = now2;
          } else {
            const reconciling = {
              eventId: deps.turns.ids.next(),
              tenantId: turn.tenantId,
              turnId: turn.turnId,
              channelId: turn.channelId,
              seq: cursor,
              kind: "turn.reconciling",
              body: IDLE_RECONCILING_BODY
            };
            await writeFrame(formatTurnEventFrame(reconciling));
            return;
          }
        }
        if (now2 >= nextHeartbeatAt) {
          if (!await writeFrame(HEARTBEAT_FRAME)) return;
          nextHeartbeatAt = now2 + timing.heartbeatMilliseconds;
        }
        const events = await listTurnEvents(deps.turns, turn.tenantId, turn.turnId, cursor);
        if (events.length === 0) {
          if (turnWasTerminalOnOpen) {
            const finished = await getTurn(deps.turns, turn.tenantId, turn.turnId);
            await writeFrame(formatTurnEventFrame(terminalEventFromTurn(finished, cursor, deps.turns.ids.next())));
            return;
          }
          await clock.sleep(pollMilliseconds, stopped.signal, "poll");
          pollMilliseconds = Math.min(pollMilliseconds * 2, timing.maximumPollMilliseconds);
          continue;
        }
        pollMilliseconds = timing.minimumPollMilliseconds;
        lastEventAt = clock.now();
        for (const event of events) {
          if (!await writeFrame(formatTurnEventFrame(event))) return;
          cursor = event.seq;
          if (TERMINAL_KINDS.has(event.kind)) return;
        }
      }
    } finally {
      deps.openStreams.closed();
    }
  });
}

// conversation/src/http/embedded-chat-app.ts
function createEmbeddedChatApp(deps) {
  const app = new Hono();
  const principalDependencies = {
    store: deps.messages.store,
    verifier: null,
    membershipCache: createUserMembershipCache(deps.clock),
    integrationTest: null,
    resolveHostPrincipal: deps.resolvePrincipal
  };
  const messageRoutes = {
    ...principalDependencies,
    messages: deps.messages,
    tenantIdForPrincipal: (principal) => principal.tenantId
  };
  const turnRoutes = {
    ...principalDependencies,
    turns: deps.turns,
    tenantIdForPrincipal: (principal) => principal.tenantId
  };
  app.onError((error, context) => {
    if (error instanceof DomainError) return context.json({ detail: error.message }, statusFor(error));
    if (error instanceof PrincipalHttpError) return context.json({ detail: error.detail }, error.status);
    throw error;
  });
  app.post("/channels/:channel_id/messages", (context) => postChannelMessageHandler(context, messageRoutes));
  app.post("/private-channel", async (context) => {
    if (deps.privateConversation === void 0) return context.json({ detail: "private conversation is unavailable" }, 503);
    const principal = await deps.resolvePrincipal(context.req.raw);
    if (principal === null) return context.json({ detail: "authentication required" }, 401);
    if (principal.kind !== "user" || principal.userId === null || !principal.userId.trim() || !principal.tenantId.trim()) {
      return context.json({ detail: "a verified user principal is required" }, 403);
    }
    await deps.privateConversation.ensureAssistant?.(principal.tenantId);
    const channel = await createChannel(
      principal.tenantId,
      principal.userId,
      [deps.privateConversation.assistantBotId],
      { kind: "direct" },
      { store: deps.messages.store, ids: deps.messages.ids }
    );
    return context.json(channelPayload(channel), 200);
  });
  app.get("/channels/:channel_id/messages", (context) => listChannelMessagesHandler(context, messageRoutes));
  app.get("/turns/:turn_id/events", (context) => listTurnEventsHandler(context, turnRoutes));
  app.get("/turns/:turn_id/stream", (context) => streamTurnHandler(context, {
    ...turnRoutes,
    streamTiming: deps.streamTiming ?? DEFAULT_STREAM_TIMING,
    streamClock: deps.streamClock ?? wallStreamClock,
    openStreams: deps.openStreams ?? new OpenStreamCounter()
  }));
  return app;
}

// conversation/src/runtime/site-hosted-chat.ts
var RESOURCE_ENVIRONMENT_KEYS = {
  messagingTableName: "PAPYRUS_CHAT_MESSAGING_TABLE",
  conversationsTableName: "PAPYRUS_CHAT_CONVERSATIONS_TABLE",
  sessionBucket: "PAPYRUS_CHAT_SESSION_BUCKET",
  turnRunsQueueUrl: "PAPYRUS_CHAT_TURN_RUNS_QUEUE_URL",
  turnProbesQueueUrl: "PAPYRUS_CHAT_TURN_PROBES_QUEUE_URL",
  assistantBotId: "PAPYRUS_CHAT_PRIVATE_BOT_ID",
  assistantBotName: "PAPYRUS_CHAT_PRIVATE_BOT_NAME",
  openAiApiKeyParameter: "OPENAI_API_KEY_PARAMETER"
};
function unavailableCapability() {
  throw new Error("Computer capability is unavailable in the site-hosted computerless runtime.");
}
var unavailableStore = new Proxy({}, { get: unavailableCapability });
var computerlessHandoff = {
  actions: unavailableStore,
  computerStarts: unavailableStore,
  rollups: unavailableStore,
  environment: "site-hosted-computerless",
  heartbeatTimeoutSeconds: 60
};
function required3(environment, key) {
  const value = environment[key]?.trim();
  if (value === void 0 || value === "") throw new Error(`The environment variable ${key} is required.`);
  return value;
}
function siteHostedChatResourcesFromEnvironment(environment) {
  return {
    messagingTableName: required3(environment, RESOURCE_ENVIRONMENT_KEYS.messagingTableName),
    conversationsTableName: required3(environment, RESOURCE_ENVIRONMENT_KEYS.conversationsTableName),
    sessionBucket: required3(environment, RESOURCE_ENVIRONMENT_KEYS.sessionBucket),
    turnRunsQueueUrl: required3(environment, RESOURCE_ENVIRONMENT_KEYS.turnRunsQueueUrl),
    turnProbesQueueUrl: required3(environment, RESOURCE_ENVIRONMENT_KEYS.turnProbesQueueUrl),
    assistantBotId: required3(environment, RESOURCE_ENVIRONMENT_KEYS.assistantBotId),
    assistantBotName: required3(environment, RESOURCE_ENVIRONMENT_KEYS.assistantBotName),
    ...environment[RESOURCE_ENVIRONMENT_KEYS.openAiApiKeyParameter] ? { openAiApiKeyParameter: environment[RESOURCE_ENVIRONMENT_KEYS.openAiApiKeyParameter] } : {}
  };
}
function siteHostedChatClients() {
  return {
    dynamo: new DynamoDBClient3({}),
    s3: new S3Client({}),
    sqs: new SQSClient({}),
    parameters: new SSMClient2({})
  };
}
function now() {
  return /* @__PURE__ */ new Date();
}
function createSiteHostedChatDependencies(resources, clients, clock = { now }) {
  const messaging = new DynamoMessagingStore(clients.dynamo, resources.messagingTableName);
  const runQueue = new SqsTurnRunQueue(clients.sqs, resources.turnRunsQueueUrl);
  const probeQueue = new SqsTurnProbeQueue(clients.sqs, resources.turnProbesQueueUrl);
  return {
    clock,
    messages: {
      store: messaging,
      ids: { next: () => randomUUID3() },
      clock,
      mailbox: { client: clients.dynamo, tableName: resources.messagingTableName },
      turns: new DynamoTurnAdmission(clients.dynamo, resources.messagingTableName),
      turnRuns: runQueue,
      turnProbes: probeQueue,
      listing: {
        client: clients.dynamo,
        s3: clients.s3,
        messagingTableName: resources.messagingTableName,
        conversationsTableName: resources.conversationsTableName,
        bucket: resources.sessionBucket,
        commitCache: new MessageBodyCache()
      }
    },
    turns: {
      store: new DynamoTurnControlStore(clients.dynamo, resources.messagingTableName),
      clock,
      ids: { next: () => randomUUID3() }
    },
    resolvePrincipal: async () => null,
    privateConversation: {
      assistantBotId: resources.assistantBotId,
      ensureAssistant: async (tenantId) => {
        if (await messaging.getBot(tenantId, resources.assistantBotId)) return;
        const namedBot = await messaging.getBotByName(tenantId, resources.assistantBotName);
        if (namedBot && namedBot.botId !== resources.assistantBotId) {
          throw new Error("The configured private assistant name belongs to a different bot.");
        }
        try {
          await messaging.putBot({ botId: resources.assistantBotId, tenantId, name: resources.assistantBotName, memory: {} }, true);
        } catch (error) {
          if (!await messaging.getBot(tenantId, resources.assistantBotId)) throw error;
        }
      }
    }
  };
}
function jobFrom(record) {
  const job = JSON.parse(record.body);
  const { tenantId, turnId, botId } = job;
  if (typeof tenantId !== "string" || typeof turnId !== "string" || typeof botId !== "string") {
    throw new Error("A TurnRuns message must name tenantId, turnId and botId.");
  }
  return { tenantId, turnId, botId };
}
function probeFrom(record) {
  const message = JSON.parse(record.body);
  const { tenantId, turnId, kind, expectAttempt } = message;
  if (typeof tenantId !== "string" || typeof turnId !== "string" || kind !== "deadline" || typeof expectAttempt !== "number") {
    throw new Error("A TurnProbes message must name tenantId, turnId, kind deadline and expectAttempt.");
  }
  return { tenantId, turnId, kind, expectAttempt };
}
function createSiteHostedRunHandler(environment, clients = siteHostedChatClients()) {
  const resources = siteHostedChatResourcesFromEnvironment(environment);
  let dependencies;
  const getDependencies = async () => {
    if (dependencies) return dependencies;
    if (environment.OPENAI_API_KEY === void 0 || environment.OPENAI_API_KEY === "") {
      if (resources.openAiApiKeyParameter) environment.OPENAI_API_KEY_PARAMETER = resources.openAiApiKeyParameter;
      await resolveOpenAiApiKey(environment, clients.parameters);
    }
    if (!environment.OPENAI_API_KEY) throw new Error("An OpenAI API key is required by the hosted chat worker.");
    const messaging = new DynamoMessagingStore(clients.dynamo, resources.messagingTableName);
    dependencies = {
      turns: {
        store: new DynamoTurnControlStore(clients.dynamo, resources.messagingTableName),
        clock: { now },
        ids: { next: () => randomUUID3() }
      },
      messaging,
      client: clients.dynamo,
      s3: clients.s3,
      messagingTableName: resources.messagingTableName,
      conversationsTableName: resources.conversationsTableName,
      piSessionsBucket: resources.sessionBucket,
      models: createOpenAiModels(),
      model: DEFAULT_TURN_MODEL,
      ledger: { client: clients.dynamo, tableName: resources.messagingTableName, prices: defaultVendorPriceBook(), now },
      ownerKind: "lambda",
      workerLabel: "papyrus-private-chat-run-worker",
      turnRuns: new SqsTurnRunQueue(clients.sqs, resources.turnRunsQueueUrl),
      turnProbes: new SqsTurnProbeQueue(clients.sqs, resources.turnProbesQueueUrl),
      computer: computerlessHandoff,
      executionProfile: "computerless"
    };
    return dependencies;
  };
  return async (event, context) => {
    for (const record of event.Records) {
      const shared = await getDependencies();
      await consumeRunJob(
        jobFrom(record),
        {
          ...shared,
          runVisibility: new SqsRunVisibility(clients.sqs, resources.turnRunsQueueUrl, record.receiptHandle),
          remainingMilliseconds: () => context.getRemainingTimeInMillis()
        },
        async () => void 0
      );
    }
  };
}
function createSiteHostedProbeHandler(environment, clients = siteHostedChatClients()) {
  const resources = siteHostedChatResourcesFromEnvironment(environment);
  const turns = {
    store: new DynamoTurnControlStore(clients.dynamo, resources.messagingTableName),
    clock: { now },
    ids: { next: () => randomUUID3() }
  };
  const dependencies = {
    turns,
    turnRuns: new SqsTurnRunQueue(clients.sqs, resources.turnRunsQueueUrl),
    turnProbes: new SqsTurnProbeQueue(clients.sqs, resources.turnProbesQueueUrl),
    messaging: new DynamoMessagingStore(clients.dynamo, resources.messagingTableName),
    submissions: new PiSubmissionInspector({
      client: clients.dynamo,
      s3: clients.s3,
      tableName: resources.conversationsTableName,
      bucket: resources.sessionBucket
    })
  };
  return async (event) => {
    for (const record of event.Records) await handleProbe(dependencies, probeFrom(record));
  };
}
function createSiteHostedChatApp(environment, resolvePrincipal2, clients = siteHostedChatClients()) {
  const dependencies = createSiteHostedChatDependencies(siteHostedChatResourcesFromEnvironment(environment), clients);
  return createEmbeddedChatApp({ ...dependencies, resolvePrincipal: resolvePrincipal2 });
}
export {
  createSiteHostedChatApp,
  createSiteHostedChatDependencies,
  createSiteHostedProbeHandler,
  createSiteHostedRunHandler,
  siteHostedChatClients,
  siteHostedChatResourcesFromEnvironment
};
