import * as cdk from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

export const ZONE_NAME = "chattic.us";
export const CLOUDFRONT_ALIAS_HOSTED_ZONE_ID = "Z2FDTNDATAQYW2";

export interface CloudFrontAliasRecord {
  name: string;
  distributionDomain: string;
}

export interface ValidationCnameRecord {
  name: string;
  ttlSeconds: number;
  value: string;
}

export const CLOUDFRONT_ALIAS_RECORDS: readonly CloudFrontAliasRecord[] = [
  { name: "chattic.us", distributionDomain: "d2jp75rstyi891.cloudfront.net" },
  { name: "auth-dev.chattic.us", distributionDomain: "d3pxae0fk95qv8.cloudfront.net" },
  { name: "auth-staging.chattic.us", distributionDomain: "d3mjnl9gysjyje.cloudfront.net" },
  { name: "auth.chattic.us", distributionDomain: "d1eww0h0lp17rx.cloudfront.net" },
  { name: "dev.chattic.us", distributionDomain: "d3gds8al0gg3jl.cloudfront.net" },
  { name: "hey.chattic.us", distributionDomain: "d2snq0rcvb1rdz.cloudfront.net" },
  { name: "staging.chattic.us", distributionDomain: "d3qbbvyz091u6f.cloudfront.net" },
  { name: "www.chattic.us", distributionDomain: "d2jp75rstyi891.cloudfront.net" },
];

export const ACM_VALIDATION_CNAME_RECORDS: readonly ValidationCnameRecord[] = [
  { name: "_104cb2754a66d47b2f837a6980802ff8.chattic.us", ttlSeconds: 300, value: "_d19de9eb69dbb1f35ae0fe37c7a4f0b3.jkddzztszm.acm-validations.aws." },
  { name: "_f3ee14ea611741f8a5770cb9e1fb5655.www.chattic.us", ttlSeconds: 300, value: "_7d1efa15cc5c77e84232073aa235c501.jkddzztszm.acm-validations.aws." },
];

class CloudFrontAliasTarget implements route53.IAliasRecordTarget {
  constructor(private readonly distributionDomain: string) {}

  bind(): route53.AliasRecordTargetConfig {
    return {
      dnsName: this.distributionDomain,
      hostedZoneId: CLOUDFRONT_ALIAS_HOSTED_ZONE_ID,
      evaluateTargetHealth: false,
    };
  }
}

export class ManagementDnsStack extends cdk.Stack {
  public readonly hostedZone: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, { ...props, terminationProtection: true });

    this.hostedZone = new route53.PublicHostedZone(this, "Zone", { zoneName: ZONE_NAME });
    this.hostedZone.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    CLOUDFRONT_ALIAS_RECORDS.forEach((record, index) => {
      const target = route53.RecordTarget.fromAlias(new CloudFrontAliasTarget(record.distributionDomain));
      new route53.ARecord(this, `Alias${index}A`, { zone: this.hostedZone, recordName: record.name, target });
      new route53.AaaaRecord(this, `Alias${index}Aaaa`, { zone: this.hostedZone, recordName: record.name, target });
    });

    ACM_VALIDATION_CNAME_RECORDS.forEach((record, index) => {
      new route53.CnameRecord(this, `Validation${index}`, {
        zone: this.hostedZone,
        recordName: record.name,
        domainName: record.value,
        ttl: cdk.Duration.seconds(record.ttlSeconds),
      });
    });

    new cdk.CfnOutput(this, "NameServers", {
      value: cdk.Fn.join(",", this.hostedZone.hostedZoneNameServers ?? []),
      description: "Set these four name servers at the registrar for chattic.us once every record has been verified.",
    });
    new cdk.CfnOutput(this, "HostedZoneId", { value: this.hostedZone.hostedZoneId });
  }
}
