import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  ACM_VALIDATION_CNAME_RECORDS,
  CLOUDFRONT_ALIAS_HOSTED_ZONE_ID,
  CLOUDFRONT_ALIAS_RECORDS,
  ManagementDnsStack,
  ZONE_NAME,
} from "../lib/management-dns-stack";

function synth(): { template: Template; stack: ManagementDnsStack } {
  const app = new cdk.App();
  const stack = new ManagementDnsStack(app, "ChatticusManagementDns", {
    env: { account: "333333333333", region: "us-east-1" },
  });
  return { template: Template.fromStack(stack), stack };
}

const EXPECTED_ALIAS_NAMES = [
  "chattic.us",
  "www.chattic.us",
  "dev.chattic.us",
  "auth-dev.chattic.us",
  "staging.chattic.us",
  "auth-staging.chattic.us",
  "hey.chattic.us",
  "auth.chattic.us",
];

describe("ManagementDnsStack", () => {
  const { template, stack } = synth();

  it("owns the chattic.us public zone and never deletes it with the stack", () => {
    template.resourceCountIs("AWS::Route53::HostedZone", 1);
    template.hasResourceProperties("AWS::Route53::HostedZone", { Name: "chattic.us." });
    const zones = template.findResources("AWS::Route53::HostedZone");
    for (const zone of Object.values(zones)) {
      assert.equal((zone as { DeletionPolicy?: string }).DeletionPolicy, "Retain");
    }
    assert.equal(ZONE_NAME, "chattic.us");
  });

  it("is protected against stack termination", () => {
    assert.equal(stack.terminationProtection, true);
  });

  it("covers every name the live zone serves, each with an A and an AAAA alias", () => {
    assert.deepEqual(
      CLOUDFRONT_ALIAS_RECORDS.map((record) => record.name).sort(),
      [...EXPECTED_ALIAS_NAMES].sort(),
    );
    template.resourceCountIs("AWS::Route53::RecordSet", 8 * 2 + 2);
    for (const record of CLOUDFRONT_ALIAS_RECORDS) {
      for (const type of ["A", "AAAA"]) {
        template.hasResourceProperties("AWS::Route53::RecordSet", {
          Name: `${record.name}.`,
          Type: type,
          AliasTarget: {
            DNSName: record.distributionDomain,
            HostedZoneId: CLOUDFRONT_ALIAS_HOSTED_ZONE_ID,
            EvaluateTargetHealth: false,
          },
        });
      }
    }
  });

  it("reproduces every record the legacy zone served on 2026-09-30, exactly", () => {
    type ExportedRecord = {
      Name: string;
      Type: string;
      TTL?: number;
      ResourceRecords?: Array<{ Value: string }>;
      AliasTarget?: { DNSName: string; HostedZoneId: string; EvaluateTargetHealth: boolean };
    };
    const exported = JSON.parse(
      readFileSync(join(__dirname, "fixtures", "chattic-us-legacy-zone-2026-09-30.json"), "utf8"),
    ) as ExportedRecord[];
    assert.equal(exported.length, 18);
    for (const record of exported) {
      const expected: Record<string, unknown> = { Name: record.Name, Type: record.Type };
      if (record.AliasTarget) {
        expected.AliasTarget = {
          DNSName: record.AliasTarget.DNSName.replace(/\.$/, ""),
          HostedZoneId: record.AliasTarget.HostedZoneId,
          EvaluateTargetHealth: record.AliasTarget.EvaluateTargetHealth,
        };
      } else {
        expected.TTL = String(record.TTL);
        expected.ResourceRecords = record.ResourceRecords?.map((entry) => entry.Value);
      }
      template.hasResourceProperties("AWS::Route53::RecordSet", expected);
    }
  });

  it("keeps the marketing apex and www pointing at one distribution", () => {
    const byName = Object.fromEntries(CLOUDFRONT_ALIAS_RECORDS.map((record) => [record.name, record.distributionDomain]));
    assert.equal(byName["chattic.us"], byName["www.chattic.us"]);
  });

  it("carries both ACM validation CNAMEs so the marketing certificates keep renewing", () => {
    assert.equal(ACM_VALIDATION_CNAME_RECORDS.length, 2);
    for (const record of ACM_VALIDATION_CNAME_RECORDS) {
      assert.match(record.value, /\.acm-validations\.aws\.$/);
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: `${record.name}.`,
        Type: "CNAME",
        TTL: String(record.ttlSeconds),
        ResourceRecords: [record.value],
      });
    }
  });

  it("does not declare the apex NS or SOA, which Route 53 creates itself", () => {
    const recordSets = template.findResources("AWS::Route53::RecordSet", {
      Properties: { Type: Match.anyValue() },
    });
    const types = new Set(Object.values(recordSets).map((resource) => (resource as { Properties: { Type: string } }).Properties.Type));
    assert.deepEqual([...types].sort(), ["A", "AAAA", "CNAME"]);
  });

  it("outputs the name servers and zone id needed for the registrar step", () => {
    const outputs = template.toJSON().Outputs as Record<string, unknown>;
    assert.ok("NameServers" in outputs);
    assert.ok("HostedZoneId" in outputs);
  });
});
