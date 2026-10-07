import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const releaseConfig = JSON.parse(
  readFileSync(join(repositoryRoot, ".releaserc.json"), "utf8"),
) as {
  branches: string[];
  tagFormat: string;
  plugins: Array<string | [string, Record<string, unknown>]>;
};

function pluginOptions(name: string): Record<string, unknown> {
  const entry = releaseConfig.plugins.find((plugin) =>
    Array.isArray(plugin) ? plugin[0] === name : plugin === name,
  );
  assert.ok(entry, `${name} must be configured`);
  return Array.isArray(entry) ? entry[1] : {};
}

describe("release configuration", () => {
  it("releases only from main and keeps the existing v-prefixed tag format", () => {
    assert.deepEqual(releaseConfig.branches, ["main"]);
    assert.equal(releaseConfig.tagFormat, "v${version}");
  });

  it("maps breaking changes to a minor release so the version stays below 1.0.0", () => {
    assert.deepEqual(pluginOptions("@semantic-release/commit-analyzer").releaseRules, [
      { breaking: true, release: "minor" },
    ]);
  });

  it("commits the version files and changelog without publishing to npm", () => {
    assert.equal(pluginOptions("@semantic-release/npm").npmPublish, false);
    assert.deepEqual(pluginOptions("@semantic-release/git").assets, [
      "package.json",
      "package-lock.json",
      "CHANGELOG.md",
    ]);
    assert.match(String(pluginOptions("@semantic-release/git").message), /\[skip ci\]/);
  });

  it("runs from the repository root without Python or registry secrets", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/semantic-release.yml"),
      "utf8",
    );
    assert.match(workflow, /npx semantic-release/);
    assert.doesNotMatch(workflow, /python|pip |twine|PYPI_TOKEN|working-directory/i);
  });
});
