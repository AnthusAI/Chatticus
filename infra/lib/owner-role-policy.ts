import * as fs from "fs";
import * as path from "path";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * The tag keys the credential broker sets on every AssumeRole of the per-turn owner role, and the only keys that role's
 * trust policy accepts. Mirrors OWNER_SESSION_TAG_KEYS in conversation/src/gateway/session-tags.ts.
 */
export const OWNER_SESSION_TAG_KEYS = ["tenant", "bot", "channel", "computer", "turn"] as const;

/**
 * The tag keys the credential broker sets on every AssumeRole of the supervisor role, and the only keys that role's trust
 * policy accepts. Mirrors SUPERVISOR_SESSION_TAG_KEYS in conversation/src/gateway/session-tags.ts.
 */
export const SUPERVISOR_SESSION_TAG_KEYS = ["tenant", "computer"] as const;

/**
 * The file of the owner role's permission statements. The conversation scenarios evaluate this same file, so what they
 * prove is what is deployed. It lives under conversation/ because the key families it names are defined there, and it is
 * read as data because infra and conversation are separate TypeScript projects.
 */
export const OWNER_ROLE_POLICY_FILE = path.join(
  __dirname,
  "../../conversation/src/gateway/owner-role-policy.json",
);

/** The file of the supervisor role's permission statements, read as data for the same reason as the owner role's. */
export const SUPERVISOR_ROLE_POLICY_FILE = path.join(
  __dirname,
  "../../conversation/src/gateway/supervisor-role-policy.json",
);

/** The ARNs of the stores the statements refer to. */
export interface OwnerRolePolicyResources {
  readonly piSessionsBucketArn: string;
  readonly conversationsTableArn: string;
  readonly messagingTableArn: string;
}

/** The ARN the supervisor role's statements refer to. */
export interface SupervisorRolePolicyResources {
  readonly snapshotBucketArn: string;
}

function statementsFromFile(file: string, replacements: Record<string, string>): iam.PolicyStatement[] {
  let text = fs.readFileSync(file, "utf8");
  for (const [placeholder, value] of Object.entries(replacements)) {
    text = text.split(`{{${placeholder}}}`).join(value);
  }
  const document = JSON.parse(text) as { statements: Array<Record<string, unknown>> };
  return document.statements.map((statement) => iam.PolicyStatement.fromJson(statement));
}

/**
 * The statements of the owner role's permission policy, with the store ARNs filled in. The `${aws:PrincipalTag/...}`
 * policy variables stay literal text in the statements: IAM substitutes them from the session tags when it evaluates a
 * request, and CloudFormation passes the document through untouched.
 */
export function ownerRolePolicyStatements(
  resources: OwnerRolePolicyResources,
): iam.PolicyStatement[] {
  return statementsFromFile(OWNER_ROLE_POLICY_FILE, {
    piSessionsBucketArn: resources.piSessionsBucketArn,
    conversationsTableArn: resources.conversationsTableArn,
    messagingTableArn: resources.messagingTableArn,
  });
}

/**
 * The statements of the supervisor role's permission policy: the snapshot objects of one computer and nothing else, and
 * an explicit Deny on the overlay prefix of that computer for every write. Each statement's `Effect` is passed through
 * unchanged. The policy variables stay literal text, as for {@link ownerRolePolicyStatements}.
 */
export function supervisorRolePolicyStatements(
  resources: SupervisorRolePolicyResources,
): iam.PolicyStatement[] {
  return statementsFromFile(SUPERVISOR_ROLE_POLICY_FILE, {
    snapshotBucketArn: resources.snapshotBucketArn,
  });
}

/**
 * The trust conditions that make a session without every required tag, or with any other tag, impossible: every
 * `aws:RequestTag/<key>` must exist, and the request may carry no tag key outside the list. The `Null` half is what stops
 * a session with no tags at all.
 *
 * @param tagKeys The exact tag keys of the role; defaults to the five of the per-turn owner role.
 */
export function ownerSessionTagConditions(
  tagKeys: readonly string[] = OWNER_SESSION_TAG_KEYS,
): Record<string, Record<string, unknown>> {
  const requiredTags: Record<string, string> = {};
  for (const key of tagKeys) {
    requiredTags[`aws:RequestTag/${key}`] = "false";
  }
  return {
    Null: requiredTags,
    "ForAllValues:StringEquals": { "aws:TagKeys": [...tagKeys] },
  };
}
