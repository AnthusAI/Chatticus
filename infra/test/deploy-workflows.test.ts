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
  { environment: string; script: string; pushBranch: string | null }
> = {
  "deploy-auth-development.yml": {
    environment: "development",
    script: "deploy-chatticus-dedicated-account.sh development auth",
    pushBranch: "develop",
  },
  "deploy-auth-staging.yml": {
    environment: "staging",
    script: "deploy-chatticus-dedicated-account.sh staging auth",
    pushBranch: null,
  },
  "deploy-auth-production.yml": {
    environment: "production",
    script: "deploy-chatticus-dedicated-account.sh production auth",
    pushBranch: null,
  },
  "deploy-controlplane-development.yml": {
    environment: "development",
    script: "deploy-chatticus-dedicated-account.sh development control-plane",
    pushBranch: "develop",
  },
  "deploy-controlplane-staging.yml": {
    environment: "staging",
    script: "deploy-chatticus-dedicated-account.sh staging control-plane",
    pushBranch: null,
  },
  "deploy-controlplane-production.yml": {
    environment: "production",
    script: "deploy-chatticus-dedicated-account.sh production control-plane",
    pushBranch: null,
  },
  "deploy-thinturn-development.yml": {
    environment: "development",
    script: "deploy-chatticus-dedicated-account.sh development thin-turn",
    pushBranch: "develop",
  },
  "deploy-thinturn-staging.yml": {
    environment: "staging",
    script: "deploy-chatticus-dedicated-account.sh staging thin-turn",
    pushBranch: null,
  },
  "deploy-thinturn-production.yml": {
    environment: "production",
    script: "deploy-chatticus-dedicated-account.sh production thin-turn",
    pushBranch: null,
  },
  "deploy-web-development.yml": {
    environment: "development",
    script: "deploy-chatticus-dedicated-account.sh development web",
    pushBranch: "develop",
  },
  "deploy-web-staging.yml": {
    environment: "staging",
    script: "deploy-chatticus-dedicated-account.sh staging web",
    pushBranch: null,
  },
  "deploy-web-production.yml": {
    environment: "production",
    script: "deploy-chatticus-dedicated-account.sh production web",
    pushBranch: null,
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

      it(expected.pushBranch === null ? "is manual dispatch only, with no push trigger" : "triggers on push to its deploy branch, with workflow_dispatch as a manual fallback", () => {
        if (expected.pushBranch === null) {
          assert.match(contents, /^on:\n  workflow_dispatch:\n\npermissions:/m);
          assert.doesNotMatch(contents, /^  push:/m);
        } else {
          assert.match(
            contents,
            new RegExp(`^on:\\n  workflow_dispatch:\\n  push:\\n    branches: \\[${expected.pushBranch}\\]\\n`, "m"),
          );
        }
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

      it("passes the installation name so the stack keeps its chatticus:installation tag", () => {
        assert.match(
          contents,
          /CHATTICUS_INSTALLATION_NAME: \$\{\{ vars\.CHATTICUS_INSTALLATION_NAME \}\}/,
        );
      });

      it("authenticates with GitHub OIDC role assumption only", () => {
        assert.match(contents, /id-token:\s*write/);
        assert.match(contents, /configure-aws-credentials@v4/);
        assert.match(contents, /role-to-assume:/);
        assert.doesNotMatch(contents, /secrets\.AWS_ACCESS_KEY_ID/);
        assert.doesNotMatch(contents, /secrets\.AWS_SECRET_ACCESS_KEY/);
      });
    });
  }

  it("passes the integration test role variable to every development and staging workflow that deploys control-plane, and never to production or auth", () => {
    const pattern = /CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN: \$\{\{ vars\.CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN \}\}/;
    const carriers = [
      "deploy-controlplane-development.yml",
      "deploy-web-development.yml",
      "deploy-thinturn-development.yml",
      "deploy-controlplane-staging.yml",
      "deploy-web-staging.yml",
      "deploy-thinturn-staging.yml",
    ];
    for (const fileName of deployWorkflowFiles()) {
      const contents = readFileSync(join(workflowsDir, fileName), "utf8");
      if (carriers.includes(fileName)) assert.match(contents, pattern, fileName);
      else assert.doesNotMatch(contents, /INTEGRATION_TEST_ALLOWED_ROLE_ARN/, fileName);
    }
  });

  const THIN_TURN_SCRIPT = (environment: string): string => `deploy-chatticus-dedicated-account.sh ${environment} thin-turn`;
  const WEB_SCRIPT = (environment: string): string => `deploy-chatticus-dedicated-account.sh ${environment} web`;

  function deployRunLines(fileName: string): string[] {
    return readFileSync(join(workflowsDir, fileName), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("run: sh deploy-chatticus-"))
      .map((line) => line.slice("run: sh ".length));
  }

  it("no workflow bound to the staging or production GitHub environment has a push, pull_request or schedule trigger", () => {
    for (const fileName of readdirSync(workflowsDir).filter((name) => name.endsWith(".yml"))) {
      const contents = readFileSync(join(workflowsDir, fileName), "utf8");
      if (!/^\s+environment: (staging|production)\s*$/m.test(contents)) continue;
      assert.doesNotMatch(contents, /^  (push|pull_request|pull_request_target|schedule|workflow_run):/m, fileName);
    }
  });

  for (const environment of ["development", "staging", "production"]) {
    const controlPlane = `deploy-chatticus-dedicated-account.sh ${environment} control-plane`;

    it(`${environment}: consumers deploy before producers, control-plane then web then thin-turn`, () => {
      assert.deepEqual(deployRunLines(`deploy-controlplane-${environment}.yml`), [controlPlane]);
      assert.deepEqual(deployRunLines(`deploy-web-${environment}.yml`), [controlPlane, WEB_SCRIPT(environment)]);
      assert.deepEqual(deployRunLines(`deploy-thinturn-${environment}.yml`), [
        controlPlane,
        WEB_SCRIPT(environment),
        THIN_TURN_SCRIPT(environment),
      ]);
    });

    it(`${environment}: every deploy workflow shares one queueing concurrency group`, () => {
      const names = deployWorkflowFiles().filter((name) => name.endsWith(`-${environment}.yml`));
      assert.deepEqual(
        names,
        ["auth", "controlplane", "thinturn", "web"].map((kind) => `deploy-${kind}-${environment}.yml`),
      );
      for (const name of names) {
        const contents = readFileSync(join(workflowsDir, name), "utf8");
        assert.match(
          contents,
          new RegExp(`^concurrency:\\n  group: deploy-${environment}\\n  cancel-in-progress: false\\n`, "m"),
          name,
        );
      }
    });
  }
});
