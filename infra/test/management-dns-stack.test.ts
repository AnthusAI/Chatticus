import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { DELEGATIONS } from "../lib/dns-delegations";
import { DEDICATED_ACCOUNT_HOSTNAMES } from "../lib/environments";
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

describe("ManagementDnsStack delegations", () => {
  const records = loadZoneRecords(EXAMPLE_EXPORT);
  const four = ["ns-1.awsdns-01.com", "ns-2.awsdns-02.net", "ns-3.awsdns-03.org", "ns-4.awsdns-04.co.uk"];
  const synthWith = (delegations: Array<{ name: string; nameServers: string[] }>) => {
    const app = new cdk.App();
    const stack = new ManagementDnsStack(app, "ChatticusManagementDns", {
      env: { account: "333333333333", region: "us-east-1" },
      records,
      delegations,
    });
    return Template.fromStack(stack);
  };

  it("hands a subdomain to the four name servers of its own zone with a short TTL", () => {
    const template = synthWith([{ name: "develop.chattic.us", nameServers: four }]);
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: "develop.chattic.us.",
      Type: "NS",
      TTL: "300",
      ResourceRecords: four,
    });
    template.resourceCountIs("AWS::Route53::RecordSet", 5 + 1);
  });

  it("adds no NS records when nothing is delegated", () => {
    const template = synthWith([]);
    template.resourceCountIs("AWS::Route53::RecordSet", 5);
  });

  it("refuses a name outside the zone, a name that already has records, and a wrong number of name servers", () => {
    assert.throws(() => synthWith([{ name: "develop.example.com", nameServers: four }]), /not a subdomain of chattic\.us/);
    assert.throws(() => synthWith([{ name: "app.chattic.us", nameServers: four }]), /already has records at that name/);
    assert.throws(() => synthWith([{ name: "develop.chattic.us", nameServers: four.slice(0, 3) }]), /needs the four name servers/);
  });
});

describe("the committed delegations", () => {
  it("delegate exactly every environment's two names, once each", () => {
    const names = DELEGATIONS.map((delegation) => delegation.name).sort();
    const expected = Object.values(DEDICATED_ACCOUNT_HOSTNAMES)
      .flatMap((hostnames) => [hostnames.siteDomain, hostnames.authDomain])
      .sort();
    assert.deepEqual(names, expected);
    assert.equal(expected.length, 6);
    assert.equal(new Set(names).size, names.length);
  });

  it("each carry four distinct Route 53 name servers", () => {
    for (const delegation of DELEGATIONS) {
      assert.equal(new Set(delegation.nameServers).size, 4, delegation.name);
      for (const server of delegation.nameServers) {
        assert.match(server, /^ns-\d+\.awsdns-\d+\.(com|net|org|co\.uk)$/, server);
      }
    }
  });

  it("do not share a name server between the two zones", () => {
    const all = DELEGATIONS.flatMap((delegation) => delegation.nameServers);
    assert.equal(new Set(all).size, all.length);
  });

  it("can be applied on top of the example export without colliding", () => {
    const app = new cdk.App();
    const stack = new ManagementDnsStack(app, "ChatticusManagementDns", {
      env: { account: "333333333333", region: "us-east-1" },
      records: loadZoneRecords(EXAMPLE_EXPORT),
      delegations: DELEGATIONS,
    });
    Template.fromStack(stack).resourceCountIs("AWS::Route53::RecordSet", 5 + DELEGATIONS.length);
  });
});
