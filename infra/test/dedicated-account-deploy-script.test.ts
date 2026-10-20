import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("only offers the thin-turn, control-plane, web and auth stacks that belong to the named environment", () => {
    const rows = contents.split("\n").filter((line) => /^\s+(development|staging|production):(thin-turn|control-plane|web|auth)\)/.test(line));
    assert.equal(rows.length, 12);
    for (const environment of ["development", "staging", "production"]) {
      assert.equal(rows.filter((row) => row.includes(`${environment}:`)).length, 4);
    }
    assert.equal(execFileSync("sh", ["-n", script]).length, 0);
  });

  it("maps every shared-by-name stack to the environment's stack id: production keeps its live unsuffixed ids, development and staging are suffixed", () => {
    for (const [stack, base] of [
      ["snapshots", "ChatticusSnapshots"],
      ["computers", "ChatticusComputers"],
      ["zones", "ChatticusEnvironmentZones"],
      ["certificates", "ChatticusEnvironmentCertificates"],
    ]) {
      assert.match(contents, new RegExp(`development:${stack}\\) STACK="${base}Development"`));
      assert.match(contents, new RegExp(`staging:${stack}\\) STACK="${base}Staging"`));
      assert.match(contents, new RegExp(`production:${stack}\\) STACK="${base}"`));
      assert.doesNotMatch(contents, new RegExp(`${base}Production`));
    }
    assert.match(contents, /production:budgets\) STACK="ChatticusBudgets"/);
    assert.match(contents, /production:audit-trail\) STACK="ChatticusAuditTrail"/);
    assert.doesNotMatch(contents, /development:audit-trail/);
    assert.doesNotMatch(contents, /staging:audit-trail/);
    assert.doesNotMatch(contents, /\*:audit-trail/);
    assert.doesNotMatch(contents, /development:budgets/);
    assert.doesNotMatch(contents, /staging:budgets/);
    assert.doesNotMatch(contents, /\*:budgets/);
    assert.doesNotMatch(contents, /\*:(snapshots|computers|zones|certificates)\)/);
  });

  it("refuses to deploy the account-level budget stack for development and staging, before touching AWS", () => {
    for (const environment of ["development", "staging"]) {
      const result = run([environment, "budgets"]);
      assert.equal(result.status, 2, environment);
      assert.match(result.stderr, /usage: sh deploy-chatticus-dedicated-account\.sh/);
    }
  });

  it("refuses to deploy the account-level audit trail stack for development and staging, before touching AWS", () => {
    for (const environment of ["development", "staging"]) {
      const result = run([environment, "audit-trail"]);
      assert.equal(result.status, 2, environment);
      assert.match(result.stderr, /usage: sh deploy-chatticus-dedicated-account\.sh/);
    }
    assert.match(contents, /STACK: budgets audit-trail snapshots/);
  });

  it("accepts the control-plane stack for every environment, mapped to that environment's own stack id", () => {
    assert.match(contents, /development:control-plane\) STACK="ChatticusControlPlaneDevelopment"/);
    assert.match(contents, /staging:control-plane\) STACK="ChatticusControlPlaneStaging"/);
    assert.match(contents, /production:control-plane\) STACK="ChatticusControlPlaneProduction"/);
    for (const environment of ["development", "staging", "production"]) {
      const accepted = run([environment, "control-plane"]);
      assert.notEqual(accepted.status, 2, environment);
    }
    assert.match(contents, /STACK: budgets audit-trail snapshots computers zones certificates thin-turn control-plane web auth/);
  });

  it("passes the integration test role as context for the development and staging control planes only, and refuses it for production, and refuses a malformed ARN before AWS", () => {
    assert.match(contents, /-c integrationTestAllowedRoleArn=/);
    assert.match(contents, /"\$\{ENVIRONMENT\}" = "development" \] \|\| \[ "\$\{ENVIRONMENT\}" = "staging" \]/);
    const production = spawnSync("sh", [script, "production", "control-plane"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN: "arn:aws:iam::123456789012:role/x" },
    });
    assert.equal(production.status, 1);
    assert.match(production.stderr, /must not be set for production/);
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    for (const bad of ["not-an-arn", "arn:aws:iam::123:role/x", "arn:aws:sts::123456789012:assumed-role/x/y", "arn:aws:iam::123456789012:user/x"]) {
      const result = spawnSync("sh", [script, "development", "control-plane"], {
        encoding: "utf8",
        env: { ...env, CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN: bad },
      });
      assert.equal(result.status, 1, bad);
      assert.match(result.stderr, /must be an IAM role ARN/);
    }
    const sso = spawnSync("sh", [script, "development", "control-plane"], {
      encoding: "utf8",
      env: {
        ...env,
        CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN:
          "arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/us-east-2/AWSReservedSSO_Admin_0123abcd",
      },
    });
    assert.doesNotMatch(sso.stderr, /must be an IAM role ARN/);
    const otherStack = spawnSync("sh", [script, "development", "web"], {
      encoding: "utf8",
      env: { ...env, CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN: "not-an-arn" },
    });
    assert.doesNotMatch(otherStack.stderr, /must be an IAM role ARN/);
  });

  describe("when another workflow starts updating the stack between the status check and the deploy", () => {
    const inProgressMessage = "Stack ChatticusWebDevelopment is in UPDATE_IN_PROGRESS state and can not be updated.";

    function runWithStubs(options: { deployOutcomes: Array<{ exitCode: number; output: string }>; stackStatuses: string[] }): {
      status: number | null;
      stdout: string;
      stderr: string;
      synthCalls: number;
      deployCalls: number;
    } {
      const directory = mkdtempSync(join(tmpdir(), "deploy-stub-"));
      try {
        const writeExecutable = (name: string, body: string) => {
          writeFileSync(join(directory, name), body);
          chmodSync(join(directory, name), 0o755);
        };
        writeFileSync(
          join(directory, "deploy-outcomes.txt"),
          options.deployOutcomes.map((outcome) => `${outcome.exitCode}|${outcome.output}`).join("\n") + "\n",
        );
        writeFileSync(join(directory, "stack-statuses.txt"), options.stackStatuses.join("\n") + "\n");
        writeExecutable(
          "aws",
          `#!/bin/sh
case "$*" in
  *"sts get-caller-identity"*) exit 0 ;;
  *"--stack-name ChatticusDns"*) exit 255 ;;
  *"ssm get-parameter"*) echo secret-reference; exit 0 ;;
  *"secretsmanager list-secret-version-ids"*) echo 0123456789abcdef0123456789abcdef; exit 0 ;;
  *"describe-stacks"*)
    count=$(cat "${directory}/status-calls" 2>/dev/null || echo 0)
    count=$((count + 1))
    echo "$count" > "${directory}/status-calls"
    total=$(wc -l < "${directory}/stack-statuses.txt")
    [ "$count" -gt "$total" ] && count="$total"
    sed -n "\${count}p" "${directory}/stack-statuses.txt"
    exit 0 ;;
esac
exit 0
`,
        );
        writeExecutable(
          "npx",
          `#!/bin/sh
if [ "$1" = "cdk" ] && [ "$2" = "synth" ]; then
  echo synth >> "${directory}/synth-calls"
  exit 0
fi
echo deploy >> "${directory}/deploy-calls"
count=$(wc -l < "${directory}/deploy-calls")
total=$(wc -l < "${directory}/deploy-outcomes.txt")
[ "$count" -gt "$total" ] && count="$total"
line=$(sed -n "\${count}p" "${directory}/deploy-outcomes.txt")
echo "\${line#*|}"
exit "\${line%%|*}"
`,
        );
        const result = spawnSync("sh", [script, "development", "web"], {
          encoding: "utf8",
          env: {
            PATH: `${directory}:/usr/bin:/bin`,
            HOME: process.env.HOME ?? "",
            CHATTICUS_STACK_POLL_SECONDS: "0",
          },
        });
        const countLines = (name: string) => {
          try {
            return readFileSync(join(directory, name), "utf8").split("\n").filter(Boolean).length;
          } catch {
            return 0;
          }
        };
        return {
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          synthCalls: countLines("synth-calls"),
          deployCalls: countLines("deploy-calls"),
        };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    it("retries the deploy after the stack settles, synthesizing only once", () => {
      const result = runWithStubs({
        deployOutcomes: [
          { exitCode: 1, output: inProgressMessage },
          { exitCode: 0, output: "deployed" },
        ],
        stackStatuses: ["UPDATE_COMPLETE", "UPDATE_IN_PROGRESS", "UPDATE_COMPLETE"],
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.deployCalls, 2);
      assert.equal(result.synthCalls, 1);
      assert.match(result.stdout, /ChatticusWebDevelopment deploy attempt 1 hit an in-progress update/);
      assert.match(result.stdout, /ChatticusWebDevelopment is UPDATE_IN_PROGRESS \(another workflow deploying it\); waiting\./);
      assert.doesNotMatch(result.stdout + result.stderr, /\b\d{12}\b/);
    });

    it("does not retry any other failure and exits with its code immediately", () => {
      const result = runWithStubs({
        deployOutcomes: [{ exitCode: 3, output: "AccessDenied: not authorized" }],
        stackStatuses: ["UPDATE_COMPLETE"],
      });
      assert.equal(result.status, 3);
      assert.equal(result.deployCalls, 1);
      assert.match(result.stdout, /AccessDenied: not authorized/);
    });

    it("gives up after a bounded number of attempts and reports the last exit code", () => {
      const result = runWithStubs({
        deployOutcomes: [{ exitCode: 1, output: inProgressMessage }],
        stackStatuses: ["UPDATE_COMPLETE"],
      });
      assert.equal(result.status, 1);
      assert.equal(result.deployCalls, 5);
      assert.match(result.stderr, /lost the race to another workflow 5 times; giving up/);
    });

    const overlappingDeployMessages = [
      "Cannot delete ChangeSet in status CREATE_IN_PROGRESS",
      "AlreadyExistsException: ChangeSet cdk-deploy-change-set already exists",
      "ConcurrentModificationException: a concurrent update of the stack was detected",
      "An error occurred (ValidationError): a concurrent update is in progress",
    ];

    for (const message of overlappingDeployMessages) {
      it(`retries after the stack settles when two deploys of one stack overlap: ${message}`, () => {
        const result = runWithStubs({
          deployOutcomes: [
            { exitCode: 1, output: message },
            { exitCode: 0, output: "deployed" },
          ],
          stackStatuses: ["UPDATE_COMPLETE", "UPDATE_IN_PROGRESS", "UPDATE_COMPLETE"],
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.deployCalls, 2);
        assert.equal(result.synthCalls, 1);
      });

      it(`still gives up after the attempt bound when the overlap persists: ${message}`, () => {
        const result = runWithStubs({
          deployOutcomes: [{ exitCode: 1, output: message }],
          stackStatuses: ["UPDATE_COMPLETE"],
        });
        assert.equal(result.status, 1);
        assert.equal(result.deployCalls, 5);
      });
    }

    it("does not retry an unrelated change set or stack error", () => {
      for (const output of ["ChangeSet creation failed: Template format error", "Stack ChatticusWebDevelopment is in ROLLBACK_COMPLETE state", "Resource handler returned message: already exists as a bucket"]) {
        const result = runWithStubs({
          deployOutcomes: [{ exitCode: 4, output }],
          stackStatuses: ["UPDATE_COMPLETE"],
        });
        assert.equal(result.status, 4, output);
        assert.equal(result.deployCalls, 1, output);
      }
    });

    it("keeps the overlap messages in one named list in the script", () => {
      assert.match(contents, /OVERLAPPING_DEPLOY_MESSAGE_PATTERNS=/);
      assert.match(contents, /Cannot delete ChangeSet in status CREATE_IN_PROGRESS/);
    });

    it("keeps the retry loop, the matched error text and the attempt bound in the script", () => {
      assert.match(contents, /is in \[A-Z_\]\*IN_PROGRESS state and can not be updated/);
      assert.match(contents, /DEPLOY_MAXIMUM_ATTEMPTS=5/);
      assert.match(contents, /cdk synth/);
      assert.match(contents, /--app "\$\{CLOUD_ASSEMBLY_DIRECTORY\}"/);
    });
  });
});

describe("deploy-chatticus-account-deploy.sh", () => {
  const accountDeploy = readFileSync(join(__dirname, "..", "deploy-chatticus-account-deploy.sh"), "utf8");

  it("deploys each environment's own deploy-role stack, production under the name it already has, development and staging suffixed", () => {
    assert.match(accountDeploy, /development\) ENVIRONMENT="\$1"; STACK="ChatticusAccountDeployDevelopment" ;;/);
    assert.match(accountDeploy, /staging\) ENVIRONMENT="\$1"; STACK="ChatticusAccountDeployStaging" ;;/);
    assert.match(accountDeploy, /production\) ENVIRONMENT="\$1"; STACK="ChatticusAccountDeploy" ;;/);
    assert.match(accountDeploy, /cdk deploy "\$\{STACK\}" --exclusively --require-approval never/);
    assert.doesNotMatch(accountDeploy.split("\n").filter((line) => !line.startsWith("#")).join("\n"), /--all/);
  });

  it("says in its header that all three environments share the production account", () => {
    assert.match(accountDeploy, /all three\s+# environments live/);
    assert.doesNotMatch(accountDeploy, /Development's account/);
  });

  describe("refuses to run outside the shared production account", () => {
    const accountDeployScript = join(__dirname, "..", "deploy-chatticus-account-deploy.sh");

    function runWithAccount(environment: string, stacksPresent: string[]): { status: number | null; stderr: string; deployed: boolean } {
      const directory = mkdtempSync(join(tmpdir(), "account-deploy-stub-"));
      try {
        writeFileSync(
          join(directory, "aws"),
          `#!/bin/sh
case "$*" in
  *"sts get-caller-identity"*) exit 0 ;;
esac
for stack in ${stacksPresent.join(" ")}; do
  case "$*" in *"--stack-name $stack "*|*"--stack-name $stack") exit 0 ;; esac
done
exit 255
`,
        );
        writeFileSync(join(directory, "npx"), `#!/bin/sh\necho deployed > "${directory}/deployed"\nexit 0\n`);
        chmodSync(join(directory, "aws"), 0o755);
        chmodSync(join(directory, "npx"), 0o755);
        const result = spawnSync("sh", [accountDeployScript, environment], {
          encoding: "utf8",
          env: { PATH: `${directory}:/usr/bin:/bin`, HOME: process.env.HOME ?? "" },
        });
        return { status: result.status, stderr: result.stderr, deployed: existsSync(join(directory, "deployed")) };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    it("refuses an account without the CDKToolkit stack", () => {
      const result = runWithAccount("development", ["ChatticusAccountDeploy"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /no CDKToolkit stack/);
      assert.equal(result.deployed, false);
    });

    it("refuses development and staging in an account without production's ChatticusAccountDeploy", () => {
      for (const environment of ["development", "staging"]) {
        const result = runWithAccount(environment, ["CDKToolkit"]);
        assert.equal(result.status, 1, environment);
        assert.match(result.stderr, /no production ChatticusAccountDeploy stack/);
        assert.equal(result.deployed, false);
      }
    });

    it("refuses the legacy account", () => {
      const result = runWithAccount("development", ["CDKToolkit", "ChatticusAccountDeploy", "ChatticusDns"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /legacy ChatticusDns/);
    });

    it("deploys development and staging in the shared account, and production where its own stack does not exist yet", () => {
      for (const environment of ["development", "staging"]) {
        const result = runWithAccount(environment, ["CDKToolkit", "ChatticusAccountDeploy"]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.deployed, true);
      }
      const production = runWithAccount("production", ["CDKToolkit"]);
      assert.equal(production.status, 0, production.stderr);
      assert.equal(production.deployed, true);
    });
  });

  it("has no separate OIDC provider script or stack: the production deploy stack owns the provider", () => {
    assert.equal(existsSync(join(__dirname, "..", "deploy-chatticus-oidc-provider.sh")), false);
    assert.equal(existsSync(join(__dirname, "..", "lib", "github-oidc-provider-stack.ts")), false);
    assert.doesNotMatch(accountDeploy, /oidc-provider|githubOidcProvider/);
  });
});
