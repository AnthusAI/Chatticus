import * as fs from "fs";
import * as path from "path";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * The tag keys the starter sets on every AssumeRole of the owner role, and the only keys the role's trust policy accepts.
 * Mirrors OWNER_SESSION_TAG_KEYS in conversation/src/gateway/session-tags.ts.
 */
export const OWNER_SESSION_TAG_KEYS = ["tenant", "bot", "channel", "computer", "turn"] as const;

/**
 * The file of the owner role's permission statements. The conversation scenarios evaluate this same file, so what they
 * prove is what is deployed. It lives under conversation/ because the key families it names are defined there, and it is
 * read as data because infra and conversation are separate TypeScript projects.
 */
export const OWNER_ROLE_POLICY_FILE = path.join(
  __dirname,
  "../../conversation/src/gateway/owner-role-policy.json",
);

/** The ARNs of the stores the statements refer to. */
export interface OwnerRolePolicyResources {
  readonly piSessionsBucketArn: string;
  readonly snapshotBucketArn: string;
  readonly conversationsTableArn: string;
  readonly messagingTableArn: string;
}

/**
 * The statements of the owner role's permission policy, with the store ARNs filled in. The `${aws:PrincipalTag/...}`
 * policy variables stay literal text in the statements: IAM substitutes them from the session tags when it evaluates a
 * request, and CloudFormation passes the document through untouched.
 */
export function ownerRolePolicyStatements(
  resources: OwnerRolePolicyResources,
): iam.PolicyStatement[] {
  const text = fs
    .readFileSync(OWNER_ROLE_POLICY_FILE, "utf8")
    .split("{{piSessionsBucketArn}}")
    .join(resources.piSessionsBucketArn)
    .split("{{snapshotBucketArn}}")
    .join(resources.snapshotBucketArn)
    .split("{{conversationsTableArn}}")
    .join(resources.conversationsTableArn)
    .split("{{messagingTableArn}}")
    .join(resources.messagingTableArn);
  const document = JSON.parse(text) as { statements: Array<Record<string, unknown>> };
  return document.statements.map((statement) => iam.PolicyStatement.fromJson(statement));
}

/**
 * The trust conditions that make a session without all five tags, or with any other tag, impossible: every
 * `aws:RequestTag/<key>` must exist, and the request may carry no tag key outside the five.
 */
export function ownerSessionTagConditions(): Record<string, Record<string, unknown>> {
  const requiredTags: Record<string, string> = {};
  for (const key of OWNER_SESSION_TAG_KEYS) {
    requiredTags[`aws:RequestTag/${key}`] = "false";
  }
  return {
    Null: requiredTags,
    "ForAllValues:StringEquals": { "aws:TagKeys": [...OWNER_SESSION_TAG_KEYS] },
  };
}
