import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHATTICUS_AWS_REGION,
  WEB_BUNDLE_DOCKER_IMAGE,
  WEB_LOCAL_BUNDLE_AWS_CLI_CHECK,
  webBuildEnvExports,
  webDockerBundleCommand,
  webDockerBundlingEnvironment,
  webLocalBundleCommand,
} from "../lib/web-build-env";

describe("webBuildEnvExports", () => {
  it("fails closed when SSM values are missing", () => {
    const script = webBuildEnvExports("development");
    assert.match(script, /cognito-user-pool-id/);
    assert.match(script, /cognito-app-client-id/);
    assert.match(script, /cognito-auth-domain/);
    assert.match(script, /\[ -n "\$NEXT_PUBLIC_COGNITO_USER_POOL_ID" \]/);
    assert.match(script, /NEXT_PUBLIC_COGNITO_REDIRECT_URI='https:\/\/dev\.chattic\.us\/auth\/callback'/);
  });

  it("sets AWS region for SSM lookups inside docker bundling", () => {
    const script = webBuildEnvExports("production");
    assert.match(script, /export AWS_DEFAULT_REGION='us-east-1'/);
    assert.equal(
      (script.match(/--region 'us-east-1'/g) ?? []).length,
      3,
      "each SSM lookup must pass --region explicitly",
    );
    assert.equal(CHATTICUS_AWS_REGION, "us-east-1");
  });
});

describe("web bundle commands", () => {
  it("uses preinstalled aws cli in the docker image without apt-get", () => {
    const command = webDockerBundleCommand("development");
    assert.doesNotMatch(command, /apt-get/);
    assert.match(command, /aws ssm get-parameter/);
    assert.match(command, /export AWS_DEFAULT_REGION='us-east-1'/);
    assert.equal((command.match(/--region 'us-east-1'/g) ?? []).length, 3);
    assert.match(command, /npm run build --workspace=web/);
    assert.match(command, /cp -r web\/out\/\. \/asset-output\//);
    assert.match(WEB_BUNDLE_DOCKER_IMAGE, /sam\/build-nodejs/);
  });

  it("uses aws cli during local tryBundle when available", () => {
    const command = webLocalBundleCommand("staging");
    assert.match(command, /\/chatticus\/staging\/web\/cognito-user-pool-id/);
    assert.match(command, /export AWS_DEFAULT_REGION='us-east-1'/);
    assert.equal((command.match(/--region 'us-east-1'/g) ?? []).length, 3);
    assert.match(command, /npm run build --workspace=web/);
    assert.match(WEB_LOCAL_BUNDLE_AWS_CLI_CHECK, /command -v aws/);
  });
});

describe("webDockerBundlingEnvironment", () => {
  it("forwards credential and region keys without embedding secret values in tests", () => {
    const environment = webDockerBundlingEnvironment();
    assert.deepEqual(Object.keys(environment).sort(), [
      "AWS_ACCESS_KEY_ID",
      "AWS_DEFAULT_REGION",
      "AWS_REGION",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]);
    assert.equal(environment.AWS_DEFAULT_REGION, "us-east-1");
    assert.equal(environment.AWS_REGION, "us-east-1");
    assert.equal(typeof environment.AWS_ACCESS_KEY_ID, "string");
    assert.equal(typeof environment.AWS_SECRET_ACCESS_KEY, "string");
    assert.equal(typeof environment.AWS_SESSION_TOKEN, "string");
  });
});
