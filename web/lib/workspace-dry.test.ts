import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const componentsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "components");

/**
 * The marketing hero's live demo (WorkspaceDemo, mounted by Hero.tsx) and the
 * real authenticated app (EnabledWorkspace.tsx) must render the exact same
 * WorkspacePanel component -- one shared component fed differently per
 * surface, not two copies that can drift apart. This guards that by source,
 * since there's no JSX render harness in this project's node:test setup.
 */
describe("shared Workspace component", () => {
  it("EnabledWorkspace and WorkspaceDemo import WorkspacePanel from the same module", () => {
    const enabledWorkspaceSource = readFileSync(join(componentsDir, "EnabledWorkspace.tsx"), "utf8");
    const workspaceDemoSource = readFileSync(join(componentsDir, "workspace", "WorkspaceDemo.tsx"), "utf8");

    assert.match(enabledWorkspaceSource, /import \{ WorkspacePanel \} from "\.\/workspace\/WorkspacePanel"/);
    assert.match(workspaceDemoSource, /import \{ WorkspacePanel \} from "\.\/WorkspacePanel"/);
  });

  it("Hero.tsx mounts the shared demo, not a standalone mockup", () => {
    const heroSource = readFileSync(join(componentsDir, "Hero.tsx"), "utf8");
    assert.match(heroSource, /import \{ WorkspaceDemo \} from "@\/components\/workspace\/WorkspaceDemo"/);
    assert.doesNotMatch(heroSource, /WorkspacePrototype/);
  });
});
