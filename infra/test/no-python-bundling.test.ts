import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const infraRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(join(infraRoot, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(infraRoot, directory, entry.name));
}

const PYTHON_BUNDLING_PATTERNS: Array<[string, RegExp]> = [
  ["a path into the python directory", /\.\.\/\.\.\/python/],
  ["a Python Lambda runtime", /Runtime\.PYTHON/],
  ["a pip install", /pip install/],
  ["the Lambda Web Adapter layer", /LambdaAdapterLayer/],
  ["the chatticus-python package", /chatticus-python/],
];

describe("infra does not bundle or deploy Python", () => {
  for (const file of [...sourceFiles("lib"), ...sourceFiles("bin")]) {
    const contents = readFileSync(file, "utf8");
    for (const [label, pattern] of PYTHON_BUNDLING_PATTERNS) {
      it(`${file.slice(infraRoot.length + 1)} has no ${label}`, () => {
        assert.equal(pattern.test(contents), false);
      });
    }
  }
});
