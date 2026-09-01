import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "out", "index.html"), "utf8");
const cssDirectory = join(root, "out", "_next", "static", "css");
const styles = readdirSync(cssDirectory)
  .filter((file) => file.endsWith(".css"))
  .map((file) => readFileSync(join(cssDirectory, file), "utf8"))
  .join("\n");

describe("Chatticus marketing experience", () => {
  it("leads with the control-first promise and a living named roster", () => {
    assert.match(html, /Build the AI/);
    assert.match(html, /organization/);
    assert.match(html, /you control\./);
    for (const teammate of ["Marin", "Nell", "June", "Sol"]) {
      assert.match(html, new RegExp(teammate));
    }
    for (const role of ["Editor", "Reporter", "Copy Writer", "Illustrator"]) {
      assert.match(html, new RegExp(role));
    }
  });

  it("offers direct product and public-source paths", () => {
    assert.match(html, /https:\/\/hey\.chattic\.us/);
    assert.match(html, /https:\/\/github\.com\/AnthusAI\/Chattic\.us/);
    assert.match(html, /Explore the workspace/);
    assert.match(html, /Read the source/);
  });

  it("explains the shared computer and distinct control concepts", () => {
    assert.match(html, /One workplace the team can share/);
    for (const concept of ["Skill", "Routine", "Review", "Approval"]) {
      assert.match(html, new RegExp(`>${concept}<`));
    }
    assert.match(html, /same browser sessions, files, and command-line credentials/);
  });

  it("distinguishes shipped, development, and designed behavior", () => {
    assert.match(html, /Live foundation/);
    assert.match(html, /Proven in development/);
    assert.match(html, /Designed next/);
    assert.match(html, /not inventing customer quotes or adoption numbers/);
    assert.doesNotMatch(html, /5,000\+|five-star|star rating/i);
  });

  it("includes FAQ, final action, footer, and reduced-motion parity", () => {
    assert.equal((html.match(/<h1/g) ?? []).length, 1);
    assert.match(html, /Before you hand over a task/);
    assert.match(html, /Give your AI team/);
    assert.match(html, /Open an issue/);
    assert.match(styles, /prefers-reduced-motion:reduce/);
    assert.match(styles, /overflow-x:hidden/);
  });

  it("offers explicit motion controls and separates manual announcements", () => {
    const organizationSource = readFileSync(
      join(root, "components", "LivingOrganization.tsx"),
      "utf8",
    );
    assert.match(organizationSource, /Pause motion/);
    assert.match(organizationSource, /Resume motion/);
    assert.match(organizationSource, /setAutoplay\(false\)/);
    assert.match(organizationSource, /aria-live=\{announceChanges \? "polite" : "off"\}/);
  });
});
