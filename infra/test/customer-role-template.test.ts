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

function readCustomerRoleTemplate(): string {
  const templatePath = path.join(repoRoot, CUSTOMER_ROLE_TEMPLATE_REPO_PATH);
  return readFileSync(templatePath, "utf8");
}

describe("customer-role template publish helper", () => {
  it("reads the single repo template for deploy (never a second file)", () => {
    const repoTemplate = readCustomerRoleTemplate();
    assert.match(repoTemplate, /ChatticusCrossAccountRole/);
    assert.doesNotMatch(repoTemplate, /AdministratorAccess/);

    const source = customerRoleTemplateDeploySource(repoRoot);
    assert.equal(typeof source.bind, "function");
  });

  it("grants IAM actions required for ChatticusComputers CreateStack", () => {
    const repoTemplate = readCustomerRoleTemplate();
    assert.match(repoTemplate, /ec2:DescribeInternetGateways/);
    assert.match(repoTemplate, /ec2:ModifySubnetAttribute/);
    assert.match(repoTemplate, /Sid: ECSServiceLinkedRole/);
    assert.match(
      repoTemplate,
      /Sid: ECSServiceLinkedRole[\s\S]*?iam:CreateServiceLinkedRole[\s\S]*?iam:AWSServiceName': 'ecs\.amazonaws\.com'/,
    );
    const serviceLinkedRoleMatches = repoTemplate.match(/iam:CreateServiceLinkedRole/g);
    assert.equal(serviceLinkedRoleMatches?.length, 1);
  });

  it("forbids bootstrap SSM, cross-account snapshot S3, and AdministratorAccess", () => {
    const repoTemplate = readCustomerRoleTemplate();
    assert.doesNotMatch(repoTemplate, /ssm:\*/);
    assert.doesNotMatch(repoTemplate, /s3:\*/);
    assert.doesNotMatch(repoTemplate, /AdministratorAccess/);
    const roleSection = repoTemplate.split("ChatticusCrossAccountRole:", 1)[1] ?? "";
    assert.doesNotMatch(roleSection, /s3:[A-Za-z*]+/);
  });

  it("declares a retained organization snapshot bucket with SnapshotBucketName output", () => {
    const repoTemplate = readCustomerRoleTemplate();
    assert.match(repoTemplate, /OrganizationSnapshotBucket:/);
    assert.match(repoTemplate, /BucketName: !Sub 'chatticus-snapshots-\$\{OrganizationId\}'/);
    assert.match(repoTemplate, /DeletionPolicy: Retain/);
    assert.match(repoTemplate, /SnapshotBucketName:/);
    assert.match(repoTemplate, /!Ref OrganizationSnapshotBucket/);
  });

  it("uses the stable S3 object key under provisioning/", () => {
    assert.equal(CUSTOMER_ROLE_TEMPLATE_OBJECT_KEY, "provisioning/customer-role.yml");
    assert.equal(
      customerRoleTemplateUrl("hey.chattic.us"),
      "https://hey.chattic.us/provisioning/customer-role.yml",
    );
  });
});
