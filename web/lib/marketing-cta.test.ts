import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const marketingCtaComponents = [
  "components/Header.tsx",
  "components/Hero.tsx",
  "components/Footer.tsx",
  "components/FinalCta.tsx",
];

describe("marketing CTA links", () => {
  for (const relativePath of marketingCtaComponents) {
    it(`${relativePath} links to same-origin /chat`, () => {
      const source = fs.readFileSync(
        path.join(process.cwd(), relativePath),
        "utf8",
      );
      assert.doesNotMatch(source, /hey\.chattic\.us/);
      assert.match(source, /["']\/chat["']/);
    });
  }
});
