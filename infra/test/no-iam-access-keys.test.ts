import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = join(fileURLToPath(import.meta.url), "../../..");

const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  "cdk.out",
  "out",
  ".next",
  "dist",
  "build",
]);

const SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".yml",
  ".yaml",
  ".json",
  ".md",
  ".feature",
]);

const FORBIDDEN_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "CreateAccessKey API", pattern: /CreateAccessKey/ },
  { name: "create_access_key", pattern: /create_access_key/ },
  { name: "create-access-key CLI", pattern: /create-access-key/ },
  { name: "CDK iam.AccessKey", pattern: /iam\.AccessKey/ },
  { name: "CDK CfnAccessKey", pattern: /CfnAccessKey/ },
  { name: "Terraform aws_iam_access_key", pattern: /aws_iam_access_key/ },
  { name: "CloudFormation AWS::IAM::AccessKey", pattern: /AWS::IAM::AccessKey/ },
  {
    name: "iam:CreateAccessKey grant",
    pattern: /iam:CreateAccessKey/,
  },
];

const ALLOWED_PATH_SUFFIXES = [
  "infra/test/no-iam-access-keys.test.ts",
  "docs/AWS_AUTH.md",
];

function listRepoFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      continue;
    }
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }
      files.push(...listRepoFiles(absolutePath));
      continue;
    }
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    if (!SCAN_EXTENSIONS.has(extension)) {
      continue;
    }
    files.push(absolutePath);
  }
  return files;
}

function relativePath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function isAllowedMatch(relativePath: string, line: string): boolean {
  if (line.includes("doesNotMatch")) {
    return true;
  }
  if (ALLOWED_PATH_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) {
    return true;
  }
  if (
    relativePath === "infra/README.md" &&
    line.includes("do **not** store long-lived `AWS_ACCESS_KEY_ID`")
  ) {
    return true;
  }
  if (
    relativePath === "AGENTS.md" &&
    (line.includes("Do **not** create IAM users") ||
      line.includes("verification commands"))
  ) {
    return true;
  }
  return false;
}

describe("no IAM access key minting", () => {
  it("does not contain CreateAccessKey or long-lived key creation APIs", () => {
    const violations: string[] = [];
    for (const absolutePath of listRepoFiles(repoRoot)) {
      const rel = relativePath(absolutePath);
      const contents = readFileSync(absolutePath, "utf8");
      const lines = contents.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (isAllowedMatch(rel, line)) {
          continue;
        }
        for (const { name, pattern } of FORBIDDEN_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(`${rel}:${index + 1}: ${name}: ${line.trim()}`);
          }
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `found forbidden IAM access key minting patterns:\n${violations.join("\n")}`,
    );
  });

  it("does not store deploy static AWS keys in GitHub workflow secrets", () => {
    const workflowsDir = join(repoRoot, ".github/workflows");
    const violations: string[] = [];
    for (const fileName of readdirSync(workflowsDir)) {
      if (!fileName.endsWith(".yml") && !fileName.endsWith(".yaml")) {
        continue;
      }
      const rel = `.github/workflows/${fileName}`;
      const contents = readFileSync(join(workflowsDir, fileName), "utf8");
      const lines = contents.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (/secrets\.AWS_ACCESS_KEY_ID|secrets\.AWS_SECRET_ACCESS_KEY/.test(line)) {
          violations.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });
});
