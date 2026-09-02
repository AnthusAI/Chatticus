import {
  ChatticusCloudEnvironment,
  WEB_SITE_DOMAINS,
  signupModeForEnvironment,
  webParameterPrefix,
} from "./environments";

/** Docker image for web bundling when local tryBundle is unavailable. Includes Node + AWS CLI. */
export const WEB_BUNDLE_DOCKER_IMAGE =
  "public.ecr.aws/sam/build-nodejs22.x";

/** Fetch public Cognito SSM parameters at bundle time (not CloudFormation tokens). */
export function webBuildEnvExports(environmentName: ChatticusCloudEnvironment): string {
  const webPrefix = webParameterPrefix(environmentName);
  const siteDomain = WEB_SITE_DOMAINS[environmentName];
  return [
    `export NEXT_PUBLIC_COGNITO_USER_POOL_ID="$(aws ssm get-parameter --name '${webPrefix}/cognito-user-pool-id' --query 'Parameter.Value' --output text)"`,
    `export NEXT_PUBLIC_COGNITO_CLIENT_ID="$(aws ssm get-parameter --name '${webPrefix}/cognito-app-client-id' --query 'Parameter.Value' --output text)"`,
    `export NEXT_PUBLIC_COGNITO_AUTH_DOMAIN="$(aws ssm get-parameter --name '${webPrefix}/cognito-auth-domain' --query 'Parameter.Value' --output text)"`,
    `[ -n "$NEXT_PUBLIC_COGNITO_USER_POOL_ID" ]`,
    `[ -n "$NEXT_PUBLIC_COGNITO_CLIENT_ID" ]`,
    `[ -n "$NEXT_PUBLIC_COGNITO_AUTH_DOMAIN" ]`,
    `export NEXT_PUBLIC_COGNITO_REDIRECT_URI='https://${siteDomain}/auth/callback'`,
    `export NEXT_PUBLIC_CHATTICUS_SIGNUP_MODE='${signupModeForEnvironment(environmentName)}'`,
    `export CHATTICUS_ENV='${environmentName}'`,
  ].join(" && ");
}

export function webDockerBundleCommand(
  environmentName: ChatticusCloudEnvironment,
): string {
  return [
    "cd /asset-input",
    webBuildEnvExports(environmentName),
    "npm ci",
    "npm run build",
    "cp -r out/. /asset-output/",
  ].join(" && ");
}

export function webLocalBundleCommand(
  environmentName: ChatticusCloudEnvironment,
): string {
  return [webBuildEnvExports(environmentName), "npm ci", "npm run build"].join(
    " && ",
  );
}

/** Shell guard: only attempt local bundling when AWS CLI is on PATH. */
export const WEB_LOCAL_BUNDLE_AWS_CLI_CHECK = "command -v aws >/dev/null";
