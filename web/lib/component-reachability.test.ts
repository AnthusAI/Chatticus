import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";

/**
 * Guard for chatticus-77c09b: a component that nothing imports ships as nothing,
 * however well its lib module and feature file are tested (chatticus-930da7).
 *
 * Walks the import graph from every file under app/, plus every file the root
 * package.json exports (the shared surface the marketing package imports), and
 * fails for any file under components/ that is not reached. This proves
 * reachability by import, not that the component renders; an import inside a
 * dead branch still counts.
 */
const webRoot = join(__dirname, "..");
const EXTENSIONS = [".ts", ".tsx"];

function isSource(file: string): boolean {
  return EXTENSIONS.some((ext) => file.endsWith(ext)) && !/\.test\.tsx?$/.test(file);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : isSource(full) ? [full] : [];
  });
}

function specifiers(text: string): string[] {
  const found: string[] = [];
  const pattern =
    /(?:import|export)\s[^'";]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    found.push(match[1] ?? match[2] ?? match[3]);
  }
  return found;
}

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(webRoot, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else return null;
  const candidates = [
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => join(base, "index" + ext)),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function exportedFiles(): string[] {
  const pkg = JSON.parse(readFileSync(join(webRoot, "..", "package.json"), "utf8")) as {
    exports?: Record<string, string>;
  };
  return Object.values(pkg.exports ?? {}).flatMap((target) => {
    const path = resolve(webRoot, "..", target);
    const star = path.indexOf("*");
    if (star === -1) return existsSync(path) ? [path] : [];
    const prefix = path.slice(0, star);
    const suffix = path.slice(star + 1);
    return walk(dirname(prefix)).filter((file) => file.startsWith(prefix) && file.endsWith(suffix));
  });
}

export function unreachableComponents(): string[] {
  const roots = [...walk(join(webRoot, "app")), ...exportedFiles()];
  const seen = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      const target = resolveImport(file, specifier);
      if (target !== null && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return walk(join(webRoot, "components"))
    .filter((file) => !seen.has(file))
    .map((file) => relative(webRoot, file));
}

describe("component reachability", () => {
  it("every component is reachable from an app route or the package exports", () => {
    const orphans = unreachableComponents();
    assert.deepEqual(orphans, [], `Components nothing imports: ${orphans.join(", ")}`);
  });
});
