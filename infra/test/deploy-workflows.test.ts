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

  describe("post-deploy acceptance smoke test", () => {
    const SMOKE_TEST_CALLERS: Record<string, string> = {
      "deploy-controlplane-development.yml": "development",
      "deploy-thinturn-development.yml": "development",
      "deploy-controlplane-staging.yml": "staging",
      "deploy-web-staging.yml": "staging",
      "deploy-thinturn-staging.yml": "staging",
    };

    for (const [fileName, environment] of Object.entries(SMOKE_TEST_CALLERS)) {
      it(`${fileName} runs the smoke test for ${environment} only after its deploy job succeeds`, () => {
        const contents = readFileSync(join(workflowsDir, fileName), "utf8");
        assert.match(
          contents,
          new RegExp(
            `\\n  smoke-test:\\n    needs: deploy\\n    permissions:\\n      contents: read\\n      id-token: write\\n    uses: \\./\\.github/workflows/acceptance-smoke-test\\.yml\\n    with:\\n      environment: ${environment}\\n`,
          ),
        );
      });
    }

    it("the reusable workflow runs the black-box runner under the integration test principal and fails loudly when it is not wired", () => {
      const contents = readFileSync(join(workflowsDir, "acceptance-smoke-test.yml"), "utf8");
      assert.match(contents, /^on:\n  workflow_call:/m);
      assert.match(contents, /environment: \$\{\{ inputs\.environment \}\}/);
      assert.match(contents, /role-to-assume: \$\{\{ vars\.CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN \}\}/);
      assert.match(contents, /if \[ -z "\$INTEGRATION_TEST_ROLE_ARN" \]; then[\s\S]*?::error::[\s\S]*?exit 1/);
      assert.match(contents, /npx tsx bin\/acceptance\.ts --environment "\$TARGET_ENVIRONMENT"/);
      assert.doesNotMatch(contents, /secrets\.AWS_ACCESS_KEY_ID|secrets\.AWS_SECRET_ACCESS_KEY/);
    });
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

  it("no workflow bound to the staging or production GitHub environment has a push, pull_request or schedule trigger, except the image build that writes only an inert sha tag", () => {
    for (const fileName of readdirSync(workflowsDir).filter((name) => name.endsWith(".yml") && name !== "build-computer-image-release.yml")) {
      const contents = readFileSync(join(workflowsDir, fileName), "utf8");
      if (!/^\s+environment: (staging|production)\s*$/m.test(contents)) continue;
      assert.doesNotMatch(contents, /^  (push|pull_request|pull_request_target|schedule|workflow_run):/m, fileName);
    }
  });

  for (const environment of ["development", "staging", "production"]) {
    const controlPlane = `deploy-chatticus-dedicated-account.sh ${environment} control-plane`;

    if (environment === "development") {
      it("development: each workflow deploys only the stack it is named for", () => {
        assert.deepEqual(deployRunLines("deploy-controlplane-development.yml"), [controlPlane]);
        assert.deepEqual(deployRunLines("deploy-web-development.yml"), [WEB_SCRIPT(environment)]);
        assert.deepEqual(deployRunLines("deploy-thinturn-development.yml"), [THIN_TURN_SCRIPT(environment)]);
      });

      it("development: every stack is deployed by exactly one workflow", () => {
        const owners = new Map<string, string[]>();
        for (const fileName of deployWorkflowFiles().filter((name) => name.endsWith("-development.yml"))) {
          for (const line of deployRunLines(fileName)) {
            owners.set(line, [...(owners.get(line) ?? []), fileName]);
          }
        }
        assert.ok(owners.size >= 4);
        for (const [line, files] of owners) assert.equal(files.length, 1, `${line} is deployed by ${files.join(", ")}`);
      });
    } else {
      it(`${environment}: consumers deploy before producers, control-plane then web then thin-turn`, () => {
        assert.deepEqual(deployRunLines(`deploy-controlplane-${environment}.yml`), [controlPlane]);
        assert.deepEqual(deployRunLines(`deploy-web-${environment}.yml`), [controlPlane, WEB_SCRIPT(environment)]);
        assert.deepEqual(deployRunLines(`deploy-thinturn-${environment}.yml`), [
          controlPlane,
          WEB_SCRIPT(environment),
          THIN_TURN_SCRIPT(environment),
        ]);
      });
    }

    it(`${environment}: the four deploy workflows exist`, () => {
      const names = deployWorkflowFiles().filter((name) => name.endsWith(`-${environment}.yml`));
      assert.deepEqual(
        names,
        ["auth", "controlplane", "thinturn", "web"].map((kind) => `deploy-${kind}-${environment}.yml`),
      );
    });
  }

  for (const environment of ["staging", "production"]) {
    it(`${environment}: manual dispatches share one queueing concurrency group`, () => {
      for (const kind of ["auth", "controlplane", "thinturn", "web"]) {
        const name = `deploy-${kind}-${environment}.yml`;
        const contents = readFileSync(join(workflowsDir, name), "utf8");
        assert.match(
          contents,
          new RegExp(`^concurrency:\\n  group: deploy-${environment}\\n  cancel-in-progress: false\\n`, "m"),
          name,
        );
      }
    });
  }

  const DEVELOPMENT_PUSH_WORKFLOWS = [
    ...["auth", "controlplane", "thinturn", "web"].map((kind) => ({
      fileName: `deploy-${kind}-development.yml`,
      group: `deploy-${kind}-development`,
    })),
    {
      fileName: "build-computer-image-development.yml",
      group: "build-computer-image-development",
    },
  ];

  function concurrencyBlock(fileName: string): { group: string; cancelInProgress: string } {
    const contents = readFileSync(join(workflowsDir, fileName), "utf8");
    const match = contents.match(/^concurrency:\n  group: (\S+)\n  cancel-in-progress: (\S+)\n/m);
    assert.ok(match, `${fileName} has a concurrency block`);
    return { group: match[1], cancelInProgress: match[2] };
  }

  describe("development push-triggered workflows do not displace each other", () => {
    it("gives each workflow its own concurrency group named for the workflow and environment", () => {
      for (const { fileName, group } of DEVELOPMENT_PUSH_WORKFLOWS) {
        assert.equal(concurrencyBlock(fileName).group, group, fileName);
      }
    });

    it("never lets two development workflows share a concurrency group", () => {
      const groups = DEVELOPMENT_PUSH_WORKFLOWS.map(({ fileName }) => concurrencyBlock(fileName).group);
      assert.equal(new Set(groups).size, groups.length);
      for (const group of groups) assert.notEqual(group, "deploy-development");
    });

    it("never cancels a run that is already deploying", () => {
      for (const fileName of readdirSync(workflowsDir).filter((name) => name.endsWith(".yml"))) {
        const contents = readFileSync(join(workflowsDir, fileName), "utf8");
        assert.doesNotMatch(contents, /cancel-in-progress:\s*true/, fileName);
      }
    });

    it("checks out the commit the run was triggered for, so a replaced pending run is always superseded by a later commit", () => {
      for (const kind of ["auth", "controlplane", "thinturn", "web"]) {
        const contents = readFileSync(join(workflowsDir, `deploy-${kind}-development.yml`), "utf8");
        assert.match(contents, /- uses: actions\/checkout@v4\n        with:\n          ref: \$\{\{ github\.sha \}\}\n/, kind);
      }
    });
  });

  it("the deploy script waits for a stack that another workflow is updating instead of racing it", () => {
    const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../deploy-chatticus-dedicated-account.sh"), "utf8");
    const waitIndex = script.indexOf("*_IN_PROGRESS");
    assert.ok(waitIndex > 0);
    assert.ok(waitIndex < script.indexOf("npx cdk deploy"));
  });
});

describe("computer image tag rule: an environment tag moves only after the server side is verified", () => {
  const repositoryRoot = join(workflowsDir, "..", "..");
  const promoteScript = readFileSync(join(repositoryRoot, "infra", "promote-computer-image.sh"), "utf8");
  const TAGS: Record<string, string> = { development: "dev", staging: "staging", production: "production" };
  const STACKS: Record<string, string> = {
    development: "ChatticusComputersDevelopment",
    staging: "ChatticusComputersStaging",
    production: "ChatticusComputers",
  };

  function pushSection(contents: string, environment: string): string {
    const start = contents.indexOf(`  push-${environment}:`);
    assert.ok(start >= 0, `push-${environment} job exists`);
    const next = contents.indexOf("\n  push-", start + 1);
    return contents.slice(start, next < 0 ? undefined : next);
  }

  function assertBuildNeverMovesTag(build: string) {
    assert.match(build, /docker push "\$\{REPO\}:\$\{SHA_TAG\}"/);
    assert.doesNotMatch(build, /:(dev|staging|production)\b/);
    assert.doesNotMatch(build, /imageTag=(dev|staging|production)\b/);
    assert.doesNotMatch(build, /put-image/);
  }

  it("the development build pushes the immutable sha tag and never the dev tag, into the development Computers stack's repository", () => {
    const build = readFileSync(join(workflowsDir, "build-computer-image-development.yml"), "utf8");
    assertBuildNeverMovesTag(build);
    assert.match(build, /--stack-name "\$\{COMPUTERS_STACK\}"/);
    assert.match(build, /COMPUTERS_STACK: ChatticusComputersDevelopment\n/);
    assert.doesNotMatch(build, /--stack-name ChatticusComputers\b/);
    assert.equal(build.split("\n").filter((line) => /docker (tag|push)/.test(line)).length, 2);
  });

  describe("the staging and production build builds once and pushes only the sha tag to each repository", () => {
    const build = readFileSync(join(workflowsDir, "build-computer-image-release.yml"), "utf8");

    it("triggers on main and manual dispatch, queues behind itself only", () => {
      assert.match(build, /^on:\n  workflow_dispatch:\n  push:\n    branches: \[main\]\n/m);
      assert.match(build, /^concurrency:\n  group: build-computer-image-release\n  cancel-in-progress: false\n/m);
      assert.doesNotMatch(build, /secrets\.AWS_ACCESS_KEY_ID/);
    });

    it("builds and runs the container checks exactly once, before any push job", () => {
      assert.equal((build.match(/docker\/build-push-action@v6/g) ?? []).length, 1);
      assert.equal((build.match(/sh computer\/test_owner_container\.sh/g) ?? []).length, 1);
      assert.ok(build.indexOf("test_owner_container.sh") < build.indexOf("  push-staging:"));
    });

    for (const environment of ["staging", "production"]) {
      it(`${environment}: pushes through its own environment role and its own Computers stack`, () => {
        const section = pushSection(build, environment);
        assert.match(section, /needs: build/);
        assert.match(section, new RegExp(`environment: ${environment}\\n`));
        assert.match(section, /role-to-assume: \$\{\{ secrets\.AWS_DEPLOY_ROLE_ARN \}\}/);
        assert.match(section, new RegExp(`COMPUTERS_STACK: ${STACKS[environment]}\\n`));
        assertBuildNeverMovesTag(section);
      });
    }
  });

  for (const environment of Object.keys(TAGS)) {
    const promote = readFileSync(join(workflowsDir, `promote-computer-image-${environment}.yml`), "utf8");

    it(`${environment}: the promotion is a manual dispatch with a required commit input and no other trigger`, () => {
      assert.match(promote, /^on:\n  workflow_dispatch:\n    inputs:\n      commit:\n[\s\S]*?required: true\n/m);
      assert.doesNotMatch(promote, /^  (push|pull_request|pull_request_target|schedule|workflow_run|release):/m);
    });

    it(`${environment}: the promotion reads workflow runs, assumes its role by OIDC, queues behind itself only, needs no approval`, () => {
      assert.match(promote, /^  actions: read$/m);
      assert.match(promote, /id-token:\s*write/);
      assert.match(promote, new RegExp(`environment: ${environment}\\n`));
      assert.match(promote, /role-to-assume: \$\{\{ secrets\.AWS_DEPLOY_ROLE_ARN \}\}/);
      assert.match(
        promote,
        new RegExp(`^concurrency:\\n  group: promote-computer-image-${environment}\\n  cancel-in-progress: false\\n`, "m"),
      );
      assert.doesNotMatch(promote, /secrets\.AWS_ACCESS_KEY_ID/);
    });

    it(`${environment}: the promotion passes the commit through the environment, never into the shell text`, () => {
      assert.match(promote, /PROMOTE_COMMIT: \$\{\{ inputs\.commit \}\}/);
      assert.match(promote, new RegExp(`run: sh promote-computer-image\\.sh ${environment} "\\$\\{PROMOTE_COMMIT\\}"`));
      assert.doesNotMatch(promote.replace(/PROMOTE_COMMIT: \$\{\{ inputs\.commit \}\}/, ""), /\$\{\{ inputs\.commit \}\}/);
    });
  }

  it("the promotion script maps each environment to its tag and Computers stack", () => {
    for (const environment of Object.keys(TAGS)) {
      assert.ok(
        promoteScript.includes(`${environment}) TAG="${TAGS[environment]}"; STACK="${STACKS[environment]}" ;;`),
        environment,
      );
    }
  });

  it("the promotion script checks the ControlPlane and ThinTurn deploys of the commit before it writes the tag", () => {
    assert.match(
      promoteScript,
      /SERVER_SIDE_WORKFLOWS="deploy-controlplane-\$\{ENVIRONMENT\}\.yml deploy-thinturn-\$\{ENVIRONMENT\}\.yml"/,
    );
    assert.match(promoteScript, /gh run list --workflow "\$\{WORKFLOW\}" --limit 50 --json headSha,conclusion/);
    assert.ok(promoteScript.indexOf("gh run list") < promoteScript.indexOf("ecr put-image"));
    assert.ok(promoteScript.indexOf("imageTag=${TAG}") < promoteScript.indexOf("ecr put-image"));
  });

  it("no other workflow or script moves an environment tag", () => {
    const candidates = [
      ...readdirSync(workflowsDir).map((name) => join(workflowsDir, name)),
      ...readdirSync(join(repositoryRoot, "infra")).filter((name) => name.endsWith(".sh")).map((name) => join(repositoryRoot, "infra", name)),
      ...readdirSync(join(repositoryRoot, "computer")).filter((name) => name.endsWith(".sh")).map((name) => join(repositoryRoot, "computer", name)),
    ];
    const writers = candidates.filter((file) => /ecr put-image|--image-tag dev|\$\{(ANTHUS_)?REPO\}:dev|docker push [^\n]*\$\{(ANTHUS_)?REPO\}:dev\b/.test(readFileSync(file, "utf8")));
    assert.deepEqual(writers.map((file) => file.slice(repositoryRoot.length + 1)), ["infra/promote-computer-image.sh"]);
  });

  it("the break-glass scripts push an immutable manual tag to the development repository, never dev", () => {
    for (const name of ["push-computer-image.sh", "push-customer-computer-image.sh"]) {
      const contents = readFileSync(join(repositoryRoot, "computer", name), "utf8");
      assert.match(contents, /MANUAL_TAG="manual-\$\(date -u/, name);
      assert.match(contents, /docker push "\$\{(ANTHUS_)?REPO\}:\$\{MANUAL_TAG\}"/, name);
    }
  });
});
