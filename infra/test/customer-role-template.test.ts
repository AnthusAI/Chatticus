import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  CUSTOMER_ROLE_TEMPLATE_OBJECT_KEY,
  CUSTOMER_ROLE_TEMPLATE_REPO_PATH,
  customerRoleTemplateDeploySource,
  customerRoleTemplateUrl,
} from "../lib/customer-role-template";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("customer-role template publish helper", () => {
  it("reads the single repo template for deploy (never a second file)", () => {
    const templatePath = path.join(repoRoot, CUSTOMER_ROLE_TEMPLATE_REPO_PATH);
    const repoTemplate = readFileSync(templatePath, "utf8");
    assert.match(repoTemplate, /ChatticusCrossAccountRole/);
    assert.doesNotMatch(repoTemplate, /AdministratorAccess/);

    const source = customerRoleTemplateDeploySource(repoRoot);
    assert.equal(typeof source.bind, "function");
  });

  it("uses the stable S3 object key under provisioning/", () => {
    assert.equal(CUSTOMER_ROLE_TEMPLATE_OBJECT_KEY, "provisioning/customer-role.yml");
    assert.equal(
      customerRoleTemplateUrl("hey.chattic.us"),
      "https://hey.chattic.us/provisioning/customer-role.yml",
    );
  });
});
