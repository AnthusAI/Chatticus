import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WEB_BUNDLE_DOCKER_IMAGE,
  WEB_LOCAL_BUNDLE_AWS_CLI_CHECK,
  webBuildEnvExports,
  webDockerBundleCommand,
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
});

describe("web bundle commands", () => {
  it("uses preinstalled aws cli in the docker image without apt-get", () => {
    const command = webDockerBundleCommand("development");
    assert.doesNotMatch(command, /apt-get/);
    assert.match(command, /aws ssm get-parameter/);
    assert.match(command, /npm run build --workspace=web/);
    assert.match(command, /cp -r web\/out\/\. \/asset-output\//);
    assert.match(WEB_BUNDLE_DOCKER_IMAGE, /sam\/build-nodejs/);
  });

  it("uses aws cli during local tryBundle when available", () => {
    const command = webLocalBundleCommand("staging");
    assert.match(command, /\/chatticus\/staging\/web\/cognito-user-pool-id/);
    assert.match(command, /npm run build --workspace=web/);
    assert.match(WEB_LOCAL_BUNDLE_AWS_CLI_CHECK, /command -v aws/);
  });
});
