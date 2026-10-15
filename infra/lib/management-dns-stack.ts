import { readFileSync } from "node:fs";
import * as cdk from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import type { Delegation } from "./dns-delegations";

export const ZONE_NAME = "chattic.us";
export const CLOUDFRONT_ALIAS_HOSTED_ZONE_ID = "Z2FDTNDATAQYW2";

export interface ExportedRecordSet {
  Name: string;
  Type: string;
  TTL?: number;
  ResourceRecords?: Array<{ Value: string }>;
  AliasTarget?: { DNSName: string; HostedZoneId: string; EvaluateTargetHealth: boolean };
}

export function loadZoneRecords(path: string): ExportedRecordSet[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const records = Array.isArray(parsed) ? parsed : (parsed as { ResourceRecordSets?: unknown }).ResourceRecordSets;
  if (!Array.isArray(records)) {
    throw new Error(`${path} is not a Route 53 record set export (expected a list or ResourceRecordSets).`);
  }
  return records as ExportedRecordSet[];
}

class ExportedAliasTarget implements route53.IAliasRecordTarget {
  constructor(private readonly target: NonNullable<ExportedRecordSet["AliasTarget"]>) {}

  bind(): route53.AliasRecordTargetConfig {
    return {
      dnsName: this.target.DNSName.replace(/\.$/, ""),
      hostedZoneId: this.target.HostedZoneId,
      evaluateTargetHealth: this.target.EvaluateTargetHealth,
    };
  }
}

function isApexNameServerOrStartOfAuthority(record: ExportedRecordSet): boolean {
  return record.Name === `${ZONE_NAME}.` && (record.Type === "NS" || record.Type === "SOA");
}

function constructId(record: ExportedRecordSet): string {
  return `${record.Type}${record.Name.replace(/[^A-Za-z0-9]/g, "")}`;
}

export interface ManagementDnsStackProps extends cdk.StackProps {
  records: readonly ExportedRecordSet[];
  delegations?: readonly Delegation[];
}

export class ManagementDnsStack extends cdk.Stack {
  public readonly hostedZone: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, props: ManagementDnsStackProps) {
    const { records, delegations = [], ...stackProps } = props;
    super(scope, id, { ...stackProps, terminationProtection: true });

    this.hostedZone = new route53.PublicHostedZone(this, "Zone", { zoneName: ZONE_NAME });
    this.hostedZone.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    for (const record of records) {
      if (isApexNameServerOrStartOfAuthority(record)) {
        continue;
      }
      const recordName = record.Name.replace(/\.$/, "");
      const logicalId = constructId(record);
      if (record.AliasTarget && (record.Type === "A" || record.Type === "AAAA")) {
        if (record.AliasTarget.HostedZoneId !== CLOUDFRONT_ALIAS_HOSTED_ZONE_ID) {
          throw new Error(`Alias ${record.Type} ${record.Name} does not target CloudFront; only CloudFront aliases are supported.`);
        }
        const target = route53.RecordTarget.fromAlias(new ExportedAliasTarget(record.AliasTarget));
        const properties = { zone: this.hostedZone, recordName, target };
        if (record.Type === "A") {
          new route53.ARecord(this, logicalId, properties);
        } else {
          new route53.AaaaRecord(this, logicalId, properties);
        }
      } else if (record.Type === "CNAME" && record.ResourceRecords?.length === 1 && record.TTL !== undefined) {
        new route53.CnameRecord(this, logicalId, {
          zone: this.hostedZone,
          recordName,
          domainName: record.ResourceRecords[0].Value,
          ttl: cdk.Duration.seconds(record.TTL),
        });
      } else {
        throw new Error(`Unsupported record ${record.Type} ${record.Name}; add support and a test before moving it.`);
      }
    }

    const recordedNames = new Set(records.map((record) => record.Name.replace(/\.$/, "")));
    for (const delegation of delegations) {
      if (!delegation.name.endsWith(`.${ZONE_NAME}`)) {
        throw new Error(`Delegation ${delegation.name} is not a subdomain of ${ZONE_NAME}.`);
      }
      if (recordedNames.has(delegation.name)) {
        throw new Error(`Cannot delegate ${delegation.name}: the zone already has records at that name.`);
      }
      if (delegation.nameServers.length !== 4) {
        throw new Error(`Delegation ${delegation.name} needs the four name servers of its zone, got ${delegation.nameServers.length}.`);
      }
      new route53.NsRecord(this, `Delegation${delegation.name.replace(/[^A-Za-z0-9]/g, "")}`, {
        zone: this.hostedZone,
        recordName: delegation.name,
        values: [...delegation.nameServers],
        ttl: cdk.Duration.seconds(300),
      });
    }

    new cdk.CfnOutput(this, "NameServers", {
      value: cdk.Fn.join(",", this.hostedZone.hostedZoneNameServers ?? []),
      description: "Set these four name servers at the registrar for chattic.us once every record has been verified.",
    });
    new cdk.CfnOutput(this, "HostedZoneId", { value: this.hostedZone.hostedZoneId });
  }
}
