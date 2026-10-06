import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const script = join(__dirname, "..", "deploy-chatticus-dedicated-account.sh");
const contents = readFileSync(script, "utf8");

function run(args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync("sh", [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  return { status: result.status, stderr: result.stderr };
}

describe("deploy-chatticus-dedicated-account.sh", () => {
  it("deploys one named stack exclusively and never everything", () => {
    assert.match(contents, /cdk deploy "\$\{STACK\}" --exclusively --require-approval never/);
    const deployLines = contents.split("\n").filter((line) => line.includes("cdk deploy"));
    assert.equal(deployLines.length, 1);
    assert.doesNotMatch(deployLines[0], /--all/);
    assert.doesNotMatch(contents, /npm run deploy/);
  });

  it("refuses the legacy account by the presence of its ChatticusDns stack, without any account id", () => {
    assert.match(contents, /describe-stacks --stack-name ChatticusDns/);
    assert.match(contents, /Refusing: this account has the legacy ChatticusDns stack/);
    assert.doesNotMatch(contents, /\b\d{12}\b/);
  });

  it("sources the budgets context so the budget stack is never deployed without its settings", () => {
    assert.match(contents, /\. \.\/budgets-deploy-context\.sh/);
  });

  it("rejects a missing or unknown environment and stack before touching AWS", () => {
    for (const args of [[], ["development"], ["qa", "zones"], ["development", "everything"], ["development", "--all"]]) {
      const result = run(args);
      assert.equal(result.status, 2, args.join(" "));
      assert.match(result.stderr, /usage: sh deploy-chatticus-dedicated-account\.sh/);
    }
  });

  it("only offers the thin-turn, web and auth stacks that belong to the named environment", () => {
    const rows = contents.split("\n").filter((line) => /^\s+(development|staging|production):(thin-turn|web|auth)\)/.test(line));
    assert.equal(rows.length, 9);
    for (const environment of ["development", "staging", "production"]) {
      assert.equal(rows.filter((row) => row.includes(`${environment}:`)).length, 3);
    }
    assert.equal(execFileSync("sh", ["-n", script]).length, 0);
  });

  it("accepts the control-plane stack for development only", () => {
    assert.match(contents, /development:control-plane\) STACK="ChatticusControlPlane"/);
    assert.doesNotMatch(contents, /staging:control-plane/);
    assert.doesNotMatch(contents, /production:control-plane/);
    for (const environment of ["staging", "production"]) {
      const result = run([environment, "control-plane"]);
      assert.equal(result.status, 2, environment);
      assert.match(result.stderr, /usage: sh deploy-chatticus-dedicated-account\.sh/);
    }
    const accepted = run(["development", "control-plane"]);
    assert.notEqual(accepted.status, 2);
  });
});
