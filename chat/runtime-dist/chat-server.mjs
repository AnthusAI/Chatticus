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

// conversation/src/domain/channels.ts
import { createHash } from "node:crypto";

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
  static parse(text2) {
    const match = DECIMAL_PATTERN.exec(text2.trim());
    if (match === null) {
      throw new Error(`Not a decimal number: ${JSON.stringify(text2)}`);
    }
    const [, sign, whole = "", fraction = "", exponentText] = match;
    const digits = `${whole}${fraction}`;
    if (digits.length === 0) {
      throw new Error(`Not a decimal number: ${JSON.stringify(text2)}`);
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

// conversation/src/domain/channels.ts
var NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
function uuid5(namespace, name) {
  const hash = createHash("sha1").update(Buffer.from(namespace.replace(/-/g, ""), "hex")).update(Buffer.from(name, "utf8")).digest();
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
import { createHmac, timingSafeEqual } from "node:crypto";

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
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
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

// conversation/src/auth/worker-credentials.ts
import { createHash as createHash2, randomBytes, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
var TOKEN_SEPARATOR = ".";
function workerIdOfToken(token) {
  const index = token.lastIndexOf(TOKEN_SEPARATOR);
  return index <= 0 ? null : token.slice(0, index);
}
function hashWorkerToken(token) {
  return createHash2("sha256").update(token).digest("hex");
}
function verifyWorkerTokenHash(token, tokenHash) {
  const expected = Buffer.from(hashWorkerToken(token));
  const actual = Buffer.from(tokenHash);
  return expected.length === actual.length && timingSafeEqual2(expected, actual);
}

// conversation/src/domain/workers.ts
var MAX_CLAIMED_WORKER_ID_LENGTH = 200;
async function verifyWorkerToken(tenantId, token, deps) {
  const claimedWorkerId = workerIdOfToken(token);
  if (claimedWorkerId === null || claimedWorkerId.length > MAX_CLAIMED_WORKER_ID_LENGTH) {
    return null;
  }
  const worker = await deps.store.getWorker(tenantId, claimedWorkerId);
  return worker !== null && verifyWorkerTokenHash(token, worker.tokenHash) ? worker.workerId : null;
}

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

// conversation/src/storage/indexed-storage.ts
import { randomUUID } from "node:crypto";
import {
  BatchGetItemCommand,
  GetItemCommand as GetItemCommand2,
  PutItemCommand,
  QueryCommand as QueryCommand2,
  TransactWriteItemsCommand,
  UpdateItemCommand as UpdateItemCommand2
} from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, GetObjectCommand as GetObjectCommand2, PutObjectCommand as PutObjectCommand2 } from "@aws-sdk/client-s3";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutableBatches } from "@earendil-works/chord/delta";
import {
  StorageRejected
} from "@earendil-works/pi-durable";

// conversation/src/storage/storage-support.ts
import { createHash as createHash3 } from "node:crypto";
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
var digest = (value) => createHash3("sha256").update(value).digest("base64url");
var parse = (text2) => JSON.parse(text2);
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

// conversation/src/storage/snapshot-object.ts
import {
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
var SNAPSHOT_FORMAT = 1;
var SNAPSHOT_FETCH_CONCURRENCY = 16;
var commitSuffix = (seq, fence) => `${String(seq).padStart(12, "0")}-${String(fence).padStart(8, "0")}`;
async function readSnapshotReference(client, tableName, storageId) {
  const response = await client.send(
    new GetItemCommand({
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
      new QueryCommand({
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
    new GetItemCommand({
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
      new UpdateItemCommand({
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
        new UpdateItemCommand2({
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
      new UpdateItemCommand2({
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
        new PutItemCommand({
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
        new QueryCommand2({
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
      new GetItemCommand2({ TableName: this.tableName, Key: { pk: { S: this.pk }, sk: { S: sk } }, ConsistentRead: true })
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

// conversation/src/pi/channel-log.ts
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT2 } from "@earendil-works/chord/context";
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
async function readLog(storage, context = BACKGROUND_CONTEXT2) {
  const session = createSession(storage);
  const value = await session.snapshot(ChannelLogDoc, ROOT_CONVERSATION_ID, context);
  return value === void 0 ? [] : value.lines.map((line) => ({ ...line }));
}
async function readEntryBody(storage, entryId, context = BACKGROUND_CONTEXT2) {
  const found = await storage.entry(entryId, context);
  if (found === void 0) return void 0;
  const data = found.entry.data;
  if (typeof data === "object" && data !== null && !Array.isArray(data) && typeof data.body === "string") return data.body;
  const message = found.entry.model?.[0];
  if (message === void 0) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.type === "text" ? part.text : "").join("");
}

// conversation/src/pi/mailbox.ts
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  PutItemCommand as PutItemCommand2,
  QueryCommand as QueryCommand3,
  UpdateItemCommand as UpdateItemCommand3
} from "@aws-sdk/client-dynamodb";
var mailboxPartitionKey = (tenantId, botId, channelId) => `MB#${tenantId}#${botId}#${channelId}`;
var mailboxSortKey = (seq) => String(seq).padStart(10, "0");
async function allocateSeq(store, tenantId, channelId) {
  const result = await store.client.send(
    new UpdateItemCommand3({
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
  ...item.origin === void 0 ? {} : { origin: { S: JSON.stringify(item.origin) } },
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
    if (error instanceof ConditionalCheckFailedException) {
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
      new QueryCommand3({
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
        createdAt: raw.created_at?.S ?? "",
        ...raw.origin?.S === void 0 ? {} : { origin: JSON.parse(raw.origin.S) }
      });
    }
    startKey = page2.LastEvaluatedKey;
  } while (startKey !== void 0);
  return items;
}

// conversation/src/pi/message-activity.ts
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT3 } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID2 } from "@earendil-works/pi-durable";

// conversation/src/domain/turns.ts
var TURN_DEADLINE_SECONDS = 120;
var TURN_EVENT_TTL_SECONDS = 24 * 60 * 60;
async function getTurn(deps, tenantId, turnId) {
  const turn = await deps.store.getTurn(tenantId, turnId);
  if (turn === null) {
    throw new TurnNotFoundError(`Turn ${pythonRepr(turnId)} does not exist.`);
  }
  return turn;
}
async function listTurnEvents(deps, tenantId, turnId, afterSeq) {
  await getTurn(deps, tenantId, turnId);
  return deps.store.listEvents(tenantId, turnId, afterSeq);
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
function redactSecrets(text2, environment = process.env) {
  let result = text2;
  for (const secret of secretValuesOf(environment)) result = result.split(secret).join(REDACTED);
  return result;
}
var cut = (text2, limit) => text2.length > limit ? { text: text2.slice(0, limit), cut: true } : { text: text2, cut: false };
var oneLine = (text2) => text2.replace(/\s+/g, " ").trim();
var stringOf = (value) => typeof value === "string" ? value : value === void 0 || value === null ? "" : JSON.stringify(value);
function toolCallFields(tool, callId, rawArguments, environment = process.env) {
  const text2 = (name) => redactSecrets(stringOf(rawArguments[name]), environment);
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
      const command = take(text2("command"), COMMAND_ARGUMENT_LIMIT);
      return finish(`Running: ${oneLine(command).slice(0, SUMMARY_QUOTE_LIMIT)}`, { command });
    }
    case "read_workspace": {
      const path = take(text2("path"), LOCATION_ARGUMENT_LIMIT);
      return finish(`Reading ${path}`, { path });
    }
    case "write_workspace": {
      const path = take(text2("path"), LOCATION_ARGUMENT_LIMIT);
      const content = stringOf(rawArguments["content"]);
      const bytes = Buffer.byteLength(content);
      const preview = take(redactSecrets(content, environment), WRITE_PREVIEW_LIMIT);
      return finish(`Writing ${path} (${bytes} bytes)`, { path, bytes, preview }, bytes);
    }
    case "edit_workspace": {
      const path = take(text2("path"), LOCATION_ARGUMENT_LIMIT);
      const oldText = take(text2("old_text"), EDIT_TEXT_LIMIT);
      const newText = take(text2("new_text"), EDIT_TEXT_LIMIT);
      return finish(`Editing ${path}`, { path, old_text: oldText, new_text: newText });
    }
    case "browse": {
      const url = take(text2("url"), LOCATION_ARGUMENT_LIMIT);
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
function boundedEventOutput(text2) {
  if (text2.length <= OUTPUT_LIMIT) return { output: text2, truncated: false };
  const omitted = text2.length - 2 * OUTPUT_KEPT_EACH_END;
  return {
    output: `${text2.slice(0, OUTPUT_KEPT_EACH_END)}
...[${omitted} characters omitted]...
${text2.slice(text2.length - OUTPUT_KEPT_EACH_END)}`,
    truncated: true
  };
}
function toolResultFields(tool, callId, resultText, isError, writtenBytes, durationMs, environment = process.env) {
  const text2 = redactSecrets(resultText, environment);
  const bounded = boundedEventOutput(text2);
  const base = { tool, callId, output: bounded.output, outputTruncated: bounded.truncated, durationMs };
  const failure = () => ({
    ...base,
    ok: false,
    summary: `Error: ${oneLine(text2).slice(0, SUMMARY_QUOTE_LIMIT)}`
  });
  if (tool === "run_terminal") {
    const code = EXIT_PREFIX.exec(text2) ?? (isError ? EXIT_ERROR.exec(text2) : null);
    if (code !== null) return { ...base, ok: Number(code[1]) === 0, summary: `Exit ${code[1]}` };
    return isError ? failure() : { ...base, ok: true, summary: "Exit 0" };
  }
  if (isError) return failure();
  if (tool === "edit_workspace") {
    const blocks = REPLACED_BLOCKS.exec(text2)?.[1] ?? "1";
    return { ...base, ok: true, summary: `Edited ${blocks} ${blocks === "1" ? "block" : "blocks"}` };
  }
  if (tool === "write_workspace") {
    return { ...base, ok: true, summary: writtenBytes === null ? "Wrote file" : `Wrote ${writtenBytes} bytes` };
  }
  return { ...base, ok: true, summary: "Done" };
}

// conversation/src/turn/event-stream.ts
var textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "").join("");
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

// conversation/src/pi/message-activity.ts
var ACTIVITY_ITEM_LIMIT = 50;
var ACTIVITY_RESPONSE_CHARACTER_BUDGET = 3e6;
var ENTRY_PAGE_SIZE = 200;
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
async function readTurnActivity(storage, afterEntryId, answerEntryId, context = BACKGROUND_CONTEXT3) {
  const newestFirst = [];
  let cursor;
  do {
    const page2 = await storage.scanEntries(
      { conversationId: ROOT_CONVERSATION_ID2, minEntryId: afterEntryId + 1, maxEntryId: answerEntryId },
      ENTRY_PAGE_SIZE,
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
          created_at: line.createdAt,
          ...line.origin === void 0 ? {} : { origin: line.origin }
        },
        body: body().then((text2) => text2 ?? "")
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
          created_at: item.createdAt,
          ...item.origin === void 0 ? {} : { origin: item.origin }
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

// conversation/src/policy/capability-policy.ts
var EgressClass = {
  None: "none",
  ApprovedOriginFetch: "approved_origin_fetch",
  StructuredSend: "structured_send",
  FileTransfer: "file_transfer"
};
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

// host-protocol/src/schemas.ts
import { z } from "zod";
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

// conversation/src/turn/probes.ts
var WAITING_LIMIT_SECONDS = 15 * 60;
function logicalEnqueueId(turnId, recoveryAttempt) {
  if (recoveryAttempt === void 0) return `${turnId}#initial`;
  return `${turnId}#recovery-${recoveryAttempt}`;
}
async function requestLogicalEnqueue(deps, job, enqueueId, fence) {
  deps.faults?.maybeCrash("logical_enqueue", "before");
  if (!await deps.recorder.recordLogicalEnqueue(job.tenantId, job.turnId, enqueueId, fence)) return false;
  deps.faults?.maybeCrash("logical_enqueue", "after");
  await deps.turnRuns.enqueue(job);
  return true;
}

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
    createdAt: reservation?.createdAt ?? deps.clock.now(),
    ...request.origin === void 0 ? {} : { origin: request.origin }
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
    createdAt: message.createdAt.toISOString(),
    ...message.origin === void 0 ? {} : { origin: message.origin }
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
    ...entry.origin === void 0 ? {} : { origin: entry.origin },
    ...entry.activity === void 0 ? {} : { activity: entry.activity }
  }));
}

// conversation/src/http/routes/messages.ts
function tenantIdForRequest(c, principal, deps) {
  const tenantId = deps.tenantIdForPrincipal?.(principal) ?? pathParameter(c, "tenant_id");
  if (!tenantId.trim()) throw new Error("The host principal did not provide a tenant scope.");
  return tenantId;
}
function originPayload(origin) {
  return {
    binding_id: origin.bindingId,
    provider: origin.provider,
    external_message_id: origin.externalMessageId,
    conversation_key: origin.conversationKey,
    sender_external_id: origin.senderExternalId,
    assertion: origin.assertion
  };
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
    ...message.origin === void 0 ? {} : { origin: originPayload(message.origin) },
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
        const now = clock.now();
        if (now - openedAt >= timing.maximumLifetimeMilliseconds) return;
        if (now - lastEventAt >= timing.idleTimeoutMilliseconds) {
          const current = await getTurn(deps.turns, turn.tenantId, turn.turnId);
          if (current.waitingFor !== null) {
            lastEventAt = now;
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
        if (now >= nextHeartbeatAt) {
          if (!await writeFrame(HEARTBEAT_FRAME)) return;
          nextHeartbeatAt = now + timing.heartbeatMilliseconds;
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
export {
  createEmbeddedChatApp
};
