import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { computerRepositoryNamePrefix } from "./computer-stack";
import {
  MAIL_INGRESS_STACK_ID,
  mailEnabled,
  stackIdsOfEnvironment,
  type ChatticusCloudEnvironment,
} from "./environments";
import { TAG_ENVIRONMENT } from "./tagging";

export const CDK_BOOTSTRAP_QUALIFIER = cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER;

/**
 * The bootstrap roles a deploy workflow may assume. The CloudFormation
 * execution role is deliberately absent: only CloudFormation itself, through
 * the bootstrap deploy role, passes it.
 */
export const CDK_BOOTSTRAP_ASSUMABLE_ROLE_KINDS = [
  "deploy-role",
  "file-publishing-role",
  "image-publishing-role",
  "lookup-role",
] as const;

export const COMPUTER_IMAGE_PUSH_ACTIONS = [
  "ecr:BatchCheckLayerAvailability",
  "ecr:BatchGetImage",
  "ecr:CompleteLayerUpload",
  "ecr:DescribeImages",
  "ecr:DescribeRepositories",
  "ecr:GetDownloadUrlForLayer",
  "ecr:InitiateLayerUpload",
  "ecr:PutImage",
  "ecr:UploadLayerPart",
] as const;

export const CLOUDFORMATION_READ_ACTIONS = [
  "cloudformation:DescribeStackEvents",
  "cloudformation:DescribeStackResources",
  "cloudformation:DescribeStacks",
  "cloudformation:GetTemplate",
  "cloudformation:ListStackResources",
] as const;

export const CDK_TOOLKIT_STACK_NAME = "CDKToolkit";

/**
 * The permissions of a GitHub OIDC deploy role for one environment, replacing
 * AdministratorAccess. Stack changes are made by the CDK bootstrap roles, so the
 * role mainly assumes them; what it calls directly is limited to what the
 * deploy, build, promote and verify workflows and the scripts they run call:
 * reading stack status and outputs, the environment's own SSM parameters, the
 * invoke key secret's version ids, and pushing the computer image to the
 * environment's own repository.
 *
 * Known boundary: the bootstrap CloudFormation execution role is itself
 * AdministratorAccess and the bootstrap roles are shared by all three
 * environments in the account. Because every deploy role can assume the bootstrap
 * deploy role, the explicit peer-environment denies added in
 * account-github-deploy-stack.ts bound only what the OIDC role does directly;
 * they do not stop a deploy driven through bootstrap from touching another
 * environment. A separate bootstrap qualifier per environment is the real fix
 * and is a follow-up.
 */
export function deployRoleStatements(
  stack: cdk.Stack,
  environment: ChatticusCloudEnvironment,
): iam.PolicyStatement[] {
  const bootstrapRoleArns = CDK_BOOTSTRAP_ASSUMABLE_ROLE_KINDS.map((kind) =>
    stack.formatArn({
      service: "iam",
      region: "",
      resource: "role",
      resourceName: `cdk-${CDK_BOOTSTRAP_QUALIFIER}-${kind}-${stack.account}-${stack.region}`,
    }),
  );
  const sharedMailStackIds = mailEnabled(environment) ? [MAIL_INGRESS_STACK_ID] : [];
  const readableStackArns = [...stackIdsOfEnvironment(environment), ...sharedMailStackIds, CDK_TOOLKIT_STACK_NAME].map((stackId) =>
    stack.formatArn({ service: "cloudformation", resource: "stack", resourceName: `${stackId}/*` }),
  );
  const environmentParameterArn = stack.formatArn({
    service: "ssm",
    resource: "parameter",
    resourceName: `chatticus/${environment}/*`,
  });
  const bootstrapVersionParameterArn = stack.formatArn({
    service: "ssm",
    resource: "parameter",
    resourceName: `cdk-bootstrap/${CDK_BOOTSTRAP_QUALIFIER}/version`,
  });

  return [
    new iam.PolicyStatement({
      sid: "AssumeCdkBootstrapRoles",
      actions: ["sts:AssumeRole", "sts:TagSession"],
      resources: bootstrapRoleArns,
    }),
    new iam.PolicyStatement({
      sid: "ReadEnvironmentStacks",
      actions: [...CLOUDFORMATION_READ_ACTIONS],
      resources: readableStackArns,
    }),
    new iam.PolicyStatement({
      sid: "ReadEnvironmentParameters",
      actions: ["ssm:GetParameter"],
      resources: [environmentParameterArn, bootstrapVersionParameterArn],
    }),
    new iam.PolicyStatement({
      sid: "ReadInvokeKeySecretVersions",
      actions: ["secretsmanager:ListSecretVersionIds"],
      resources: [
        stack.formatArn({
          service: "secretsmanager",
          resource: "secret",
          resourceName: "*",
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
      conditions: { StringEquals: { [`aws:ResourceTag/${TAG_ENVIRONMENT}`]: environment } },
    }),
    new iam.PolicyStatement({
      sid: "EcrLoginToken",
      actions: ["ecr:GetAuthorizationToken"],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "ComputerImagePush",
      actions: [...COMPUTER_IMAGE_PUSH_ACTIONS],
      resources: [
        stack.formatArn({
          service: "ecr",
          resource: "repository",
          resourceName: `${computerRepositoryNamePrefix(environment)}*`,
        }),
      ],
    }),
    new iam.PolicyStatement({
      sid: "DenyIdentityAndAccountAdministration",
      effect: iam.Effect.DENY,
      actions: [
        "iam:CreateUser",
        "iam:*AccessKey",
        "iam:CreateLoginProfile",
        "iam:UpdateLoginProfile",
        "organizations:*",
        "account:*",
      ],
      resources: ["*"],
    }),
  ];
}
