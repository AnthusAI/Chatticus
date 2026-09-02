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
  { environment: string; script: string }
> = {
  "deploy-auth-development.yml": {
    environment: "development",
    script: "deploy-chatticus-auth-development.sh",
  },
  "deploy-auth-staging.yml": {
    environment: "staging",
    script: "deploy-chatticus-auth-staging.sh",
  },
  "deploy-auth-production.yml": {
    environment: "production",
    script: "deploy-chatticus-auth-production.sh",
  },
  "deploy-thinturn-development.yml": {
    environment: "development",
    script: "deploy-chatticus-thinturn-development.sh",
  },
  "deploy-thinturn-staging.yml": {
    environment: "staging",
    script: "deploy-chatticus-thinturn-staging.sh",
  },
  "deploy-thinturn-production.yml": {
    environment: "production",
    script: "deploy-chatticus-thinturn-production.sh",
  },
  "deploy-web-development.yml": {
    environment: "development",
    script: "deploy-chatticus-web-development.sh",
  },
  "deploy-web-staging.yml": {
    environment: "staging",
    script: "deploy-chatticus-web-staging.sh",
  },
  "deploy-web-production.yml": {
    environment: "production",
    script: "deploy-chatticus-web-production.sh",
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

      it("uses workflow_dispatch only", () => {
        assert.match(contents, /^on:\n  workflow_dispatch:\n/m);
        assert.doesNotMatch(contents, /^  push:/m);
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
