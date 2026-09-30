import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  CLOUDFRONT_ALIAS_HOSTED_ZONE_ID,
  type ExportedRecordSet,
  ManagementDnsStack,
  loadZoneRecords,
} from "../lib/management-dns-stack";

const EXAMPLE_EXPORT = join(__dirname, "fixtures", "example-zone-export.json");

function synth(records: readonly ExportedRecordSet[]): { template: Template; stack: ManagementDnsStack } {
  const app = new cdk.App();
  const stack = new ManagementDnsStack(app, "ChatticusManagementDns", {
    env: { account: "333333333333", region: "us-east-1" },
    records,
  });
  return { template: Template.fromStack(stack), stack };
}

describe("ManagementDnsStack", () => {
  const records = loadZoneRecords(EXAMPLE_EXPORT);
  const { template, stack } = synth(records);

  it("owns the chattic.us public zone and never deletes it with the stack", () => {
    template.resourceCountIs("AWS::Route53::HostedZone", 1);
    template.hasResourceProperties("AWS::Route53::HostedZone", { Name: "chattic.us." });
    for (const zone of Object.values(template.findResources("AWS::Route53::HostedZone"))) {
      assert.equal((zone as { DeletionPolicy?: string }).DeletionPolicy, "Retain");
    }
  });

  it("is protected against stack termination", () => {
    assert.equal(stack.terminationProtection, true);
  });

  it("reproduces every non-apex-NS/SOA record of the input export exactly", () => {
    const expectedRecords = records.filter((record) => !(record.Name === "chattic.us." && ["NS", "SOA"].includes(record.Type)));
    assert.equal(expectedRecords.length, 5);
    template.resourceCountIs("AWS::Route53::RecordSet", expectedRecords.length);
    for (const record of expectedRecords) {
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

  it("does not declare the apex NS or SOA, which Route 53 creates itself", () => {
    const recordSets = template.findResources("AWS::Route53::RecordSet", { Properties: { Type: Match.anyValue() } });
    const types = new Set(Object.values(recordSets).map((resource) => (resource as { Properties: { Type: string } }).Properties.Type));
    assert.deepEqual([...types].sort(), ["A", "AAAA", "CNAME"]);
  });

  it("outputs the name servers and zone id needed for the registrar step", () => {
    const outputs = template.toJSON().Outputs as Record<string, unknown>;
    assert.ok("NameServers" in outputs);
    assert.ok("HostedZoneId" in outputs);
  });
});

describe("ManagementDnsStack refuses what it cannot reproduce faithfully", () => {
  it("rejects a record type it does not support instead of dropping it", () => {
    assert.throws(
      () => synth([{ Name: "chattic.us.", Type: "MX", TTL: 300, ResourceRecords: [{ Value: "10 mail.example." }] }]),
      /Unsupported record MX chattic\.us\./,
    );
  });

  it("rejects an alias that does not target CloudFront", () => {
    assert.throws(
      () =>
        synth([
          {
            Name: "app.chattic.us.",
            Type: "A",
            AliasTarget: { HostedZoneId: "Z0000000000000", DNSName: "lb.example.", EvaluateTargetHealth: false },
          },
        ]),
      /does not target CloudFront/,
    );
    assert.equal(CLOUDFRONT_ALIAS_HOSTED_ZONE_ID, "Z2FDTNDATAQYW2");
  });

  it("rejects a CNAME without exactly one value and a TTL", () => {
    assert.throws(() => synth([{ Name: "x.chattic.us.", Type: "CNAME", ResourceRecords: [{ Value: "a." }] }]), /Unsupported record CNAME/);
  });

  it("rejects a file that is not a Route 53 record set export", () => {
    assert.throws(() => loadZoneRecords(join(__dirname, "fixtures", "..", "..", "package.json")), /not a Route 53 record set export/);
  });
});
