import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const script = join(__dirname, "..", "rotate-invoke-key.sh");
const contents = readFileSync(script, "utf8");
const dedicatedContents = readFileSync(join(__dirname, "..", "deploy-chatticus-dedicated-account.sh"), "utf8");

function run(args: string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync("sh", [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe("rotate-invoke-key.sh", () => {
  it("is valid POSIX sh", () => {
    assert.equal(execFileSync("sh", ["-n", script]).length, 0);
  });

  it("refuses to run without an explicit environment", () => {
    for (const args of [[], ["--yes"], ["qa", "--yes"], ["all", "--yes"]]) {
      const result = run(args);
      assert.equal(result.status, 2, args.join(" "));
      assert.match(result.stderr, /usage: sh rotate-invoke-key\.sh development\|staging\|production --yes/);
    }
  });

  it("refuses to write without --yes, before any AWS call", () => {
    for (const environment of ["development", "staging", "production"]) {
      const result = run([environment]);
      assert.equal(result.status, 2, environment);
      assert.match(result.stderr, /Refusing to rotate without --yes/);
      assert.equal(result.stdout, "");
    }
  });

  it("rejects an unknown flag", () => {
    assert.equal(run(["development", "--yes", "--force"]).status, 2);
  });

  it("generates the value in memory, passes it through stdin and never echoes it", () => {
    assert.match(contents, /get-random-password --password-length 40 --exclude-punctuation/);
    assert.match(contents, /printf '%s' "\$\{NEW_VALUE\}" \| aws secretsmanager put-secret-value[^\n]*--secret-string file:\/\/\/dev\/stdin/);
    assert.doesNotMatch(contents, /echo[^\n]*(NEW_VALUE|CURRENT_VALUE|HEADER_VALUE)/);
    assert.doesNotMatch(contents, /set -x|set -[a-z]*x/);
  });

  it("only retires the previous value after CloudFront is shown to carry the current one", () => {
    const compare = contents.indexOf('"${HEADER_VALUE}" != "${CURRENT_VALUE}"');
    const retire = contents.indexOf("update-secret-version-stage --secret-id");
    assert.ok(compare > 0 && retire > compare);
  });

  it("refuses to touch a secret outside the account of the session", () => {
    assert.match(contents, /arn:aws:secretsmanager:\$\{AWS_REGION\}:\$\{CALLER_ACCOUNT\}:secret:/);
    assert.doesNotMatch(contents, /\b\d{12}\b/);
  });

  it("makes the web deploy script pin the secret version so a rotation changes the template", () => {
    assert.match(dedicatedContents, /-c invokeKeyVersionId=\$\{INVOKE_KEY_VERSION_ID\}/);
    assert.doesNotMatch(dedicatedContents, /get-secret-value/);
  });
});
