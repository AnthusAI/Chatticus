import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const workflowsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows",
);

const EXPECTED_DEPLOY_WORKFLOWS: Record<
  string,
  { environment: string; script: string; pushBranch: string }
> = {
  "deploy-auth-development.yml": {
    environment: "development",
    script: "deploy-chatticus-auth-development.sh",
    pushBranch: "develop",
  },
  "deploy-auth-staging.yml": {
    environment: "staging",
    script: "deploy-chatticus-auth-staging.sh",
    pushBranch: "main",
  },
  "deploy-auth-production.yml": {
    environment: "production",
    script: "deploy-chatticus-auth-production.sh",
    pushBranch: "main",
  },
  "deploy-thinturn-development.yml": {
    environment: "development",
    script: "deploy-chatticus-thinturn-development.sh",
    pushBranch: "develop",
  },
  "deploy-thinturn-staging.yml": {
    environment: "staging",
    script: "deploy-chatticus-thinturn-staging.sh",
    pushBranch: "main",
  },
  "deploy-thinturn-production.yml": {
    environment: "production",
    script: "deploy-chatticus-thinturn-production.sh",
    pushBranch: "main",
  },
  "deploy-web-development.yml": {
    environment: "development",
    script: "deploy-chatticus-web-development.sh",
    pushBranch: "develop",
  },
  "deploy-web-staging.yml": {
    environment: "staging",
    script: "deploy-chatticus-web-staging.sh",
    pushBranch: "main",
  },
  "deploy-web-production.yml": {
    environment: "production",
    script: "deploy-chatticus-web-production.sh",
    pushBranch: "main",
  },
};

function deployWorkflowFiles(): string[] {
  return readdirSync(workflowsDir)
    .filter((name) => name.startsWith("deploy-") && name.endsWith(".yml"))
    .sort();
}

describe("deploy workflow YAML", () => {
  it("lists every deploy workflow with one script and environment", () => {
    assert.deepEqual(deployWorkflowFiles(), Object.keys(EXPECTED_DEPLOY_WORKFLOWS).sort());
  });

  for (const [fileName, expected] of Object.entries(EXPECTED_DEPLOY_WORKFLOWS)) {
    describe(fileName, () => {
      const contents = readFileSync(join(workflowsDir, fileName), "utf8");

      it("triggers on push to its deploy branch, with workflow_dispatch as a manual fallback", () => {
        assert.match(
          contents,
          new RegExp(`^on:\\n  workflow_dispatch:\\n  push:\\n    branches: \\[${expected.pushBranch}\\]\\n`, "m"),
        );
        assert.doesNotMatch(contents, /^  pull_request:/m);
        assert.doesNotMatch(contents, /^  release:/m);
      });

      it("binds the expected GitHub environment and deploy script", () => {
        assert.match(contents, new RegExp(`environment: ${expected.environment}`));
        assert.match(contents, new RegExp(`sh ${expected.script}`));
      });

      it("does not invoke cdk deploy --all", () => {
        assert.doesNotMatch(contents, /--all/);
        assert.doesNotMatch(contents, /cdk deploy --all/);
      });
    });
  }
});
