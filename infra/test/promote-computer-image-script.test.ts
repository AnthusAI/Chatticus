import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const script = join(__dirname, "..", "promote-computer-image.sh");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NEW_DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const OLD_DIGEST = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

const FAKE_GH = `#!/bin/sh
case "$*" in
  *deploy-controlplane-*.yml*) printf '%s\\n' "\${FAKE_CONTROLPLANE_CONCLUSION-success}" ;;
  *deploy-thinturn-*.yml*) printf '%s\\n' "\${FAKE_THINTURN_CONCLUSION-success}" ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac
`;

const FAKE_AWS = `#!/bin/sh
echo "$*" >> "\${FAKE_LOG}"
case "$*" in
  *"cloudformation describe-stacks"*) echo "123456789012.dkr.ecr.us-east-1.amazonaws.com/chatticuscomputers-computerimage-abc" ;;
  *"ecr describe-images"*"imageTag=sha-"*)
    if [ -n "\${FAKE_SHA_MISSING:-}" ]; then echo "ImageNotFoundException" >&2; exit 254; fi
    echo "\${FAKE_NEW_DIGEST}" ;;
  *"ecr describe-images"*"imageTag=\${FAKE_TAG}"*)
    if grep -q "ecr put-image" "\${FAKE_LOG}"; then echo "\${FAKE_NEW_DIGEST}";
    elif [ -n "\${FAKE_DEV_UNSET:-}" ]; then echo "ImageNotFoundException" >&2; exit 254;
    else echo "\${FAKE_DEV_DIGEST}"; fi ;;
  *"ecr batch-get-image"*"imageManifestMediaType"*) echo "application/vnd.oci.image.manifest.v1+json" ;;
  *"ecr batch-get-image"*) echo '{"schemaVersion":2}' ;;
  *"ecr put-image"*) echo '{}' ;;
  *) echo "unexpected aws $*" >&2; exit 9 ;;
esac
`;

function runPromotion(argument: string | undefined, environment: Record<string, string> = {}, deploymentEnvironment = "development"): { status: number | null; stdout: string; stderr: string; log: string } {
  const directory = mkdtempSync(join(tmpdir(), "promote-"));
  for (const [name, body] of [["gh", FAKE_GH], ["aws", FAKE_AWS]] as const) {
    writeFileSync(join(directory, name), body);
    chmodSync(join(directory, name), 0o755);
  }
  const log = join(directory, "aws.log");
  writeFileSync(log, "");
  const args = argument === undefined ? [script, deploymentEnvironment] : [script, deploymentEnvironment, argument];
  const result = spawnSync("sh", args, {
    encoding: "utf8",
    env: {
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "",
      FAKE_LOG: log,
      FAKE_TAG: { development: "dev", staging: "staging", production: "production" }[deploymentEnvironment] ?? "",
      FAKE_NEW_DIGEST: NEW_DIGEST,
      FAKE_DEV_DIGEST: OLD_DIGEST,
      ...environment,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, log: readFileSync(log, "utf8") };
}

describe("promote-computer-image.sh", () => {
  it("rejects a missing or malformed commit before touching GitHub or AWS", () => {
    for (const argument of [undefined, "dev", "abc123", COMMIT.toUpperCase(), `${COMMIT}0`]) {
      const result = runPromotion(argument);
      assert.equal(result.status, 2, String(argument));
      assert.match(result.stderr, /usage: sh promote-computer-image\.sh/);
      assert.equal(result.log, "");
    }
  });

  it("rejects an unknown environment before touching GitHub or AWS", () => {
    for (const unknown of ["", "dev", "prod", "legacy"]) {
      const result = runPromotion(COMMIT, {}, unknown);
      assert.equal(result.status, 2, unknown);
      assert.match(result.stderr, /usage: sh promote-computer-image\.sh <development\|staging\|production>/);
      assert.equal(result.log, "");
    }
  });

  for (const [deploymentEnvironment, tag, stack] of [
    ["staging", "staging", "ChatticusComputersStaging"],
    ["production", "production", "ChatticusComputers"],
  ]) {
    it(`${deploymentEnvironment}: reads the ${stack} repository and moves only the ${tag} tag after that environment's deploys`, () => {
      const result = runPromotion(COMMIT, {}, deploymentEnvironment);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.log, new RegExp(`describe-stacks --stack-name ${stack} `));
      assert.match(result.log, new RegExp(`ecr put-image .*--image-tag ${tag} `));
      assert.match(result.stdout, new RegExp(`moved ${tag} to sha-${COMMIT}`));
    });

    it(`${deploymentEnvironment}: refuses, and moves nothing, when its ThinTurn deploy of the commit did not succeed`, () => {
      const result = runPromotion(COMMIT, { FAKE_THINTURN_CONCLUSION: "failure" }, deploymentEnvironment);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`deploy-thinturn-${deploymentEnvironment}\\.yml run for .* concluded 'failure'`));
      assert.doesNotMatch(result.log, /put-image/);
    });
  }

  it("refuses, and moves nothing, when the ThinTurn deploy of the commit did not succeed", () => {
    for (const conclusion of ["failure", "cancelled", "none", ""]) {
      const result = runPromotion(COMMIT, { FAKE_THINTURN_CONCLUSION: conclusion });
      assert.equal(result.status, 1, conclusion);
      assert.match(result.stderr, /deploy-thinturn-development\.yml run for .* concluded '/);
      assert.doesNotMatch(result.log, /put-image/);
    }
  });

  it("refuses, and moves nothing, when the ControlPlane deploy of the commit did not succeed", () => {
    const result = runPromotion(COMMIT, { FAKE_CONTROLPLANE_CONCLUSION: "failure" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /deploy-controlplane-development\.yml run for .* concluded 'failure'/);
    assert.doesNotMatch(result.log, /put-image/);
  });

  it("refuses, and moves nothing, when no image was built for the commit", () => {
    const result = runPromotion(COMMIT, { FAKE_SHA_MISSING: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`no image tagged sha-${COMMIT}`));
    assert.doesNotMatch(result.log, /put-image/);
  });

  it("moves dev to the sha tag manifest and prints the previous digest with the rollback command", () => {
    const result = runPromotion(COMMIT);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.log, /ecr put-image .*--image-tag dev .*--image-manifest-media-type application\/vnd\.oci\.image\.manifest\.v1\+json/);
    assert.equal(result.log.split("\n").filter((line) => line.includes("put-image")).length, 1);
    assert.match(result.stdout, new RegExp(`moved dev to sha-${COMMIT} \\(${NEW_DIGEST}\\); previous dev digest ${OLD_DIGEST}`));
    assert.match(result.stdout, new RegExp(`Roll back with: aws ecr put-image .*--image-tag dev .*imageDigest=${OLD_DIGEST}`));
  });

  it("does nothing when dev already points at the commit's image", () => {
    const result = runPromotion(COMMIT, { FAKE_DEV_DIGEST: NEW_DIGEST });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dev already points at/);
    assert.doesNotMatch(result.log, /put-image/);
  });

  it("promotes when dev has never been set, saying there is nothing to roll back to", () => {
    const result = runPromotion(COMMIT, { FAKE_DEV_UNSET: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /previous dev digest none/);
    assert.match(result.stdout, /nothing to roll back to/);
  });

  it("never pushes an image or logs in to the registry", () => {
    const contents = readFileSync(script, "utf8");
    assert.doesNotMatch(contents, /docker /);
    assert.doesNotMatch(contents, /get-login-password/);
  });
});
