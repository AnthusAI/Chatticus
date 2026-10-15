import * as cdk from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

export interface EnvironmentZonesStackProps extends cdk.StackProps {
  siteDomain: string;
  authDomain: string;
}

/**
 * The two delegated zones of one environment account: one for the web site's
 * name and one for the auth name. The management account's chattic.us zone
 * points each name here with NS records, so each environment's certificates and
 * alias records live and validate inside its own account.
 */
export class EnvironmentZonesStack extends cdk.Stack {
  public readonly siteZone: route53.PublicHostedZone;
  public readonly authZone: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, props: EnvironmentZonesStackProps) {
    super(scope, id, { ...props, terminationProtection: true });

    this.siteZone = new route53.PublicHostedZone(this, "SiteZone", { zoneName: props.siteDomain });
    this.siteZone.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    this.authZone = new route53.PublicHostedZone(this, "AuthZone", { zoneName: props.authDomain });
    this.authZone.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    new cdk.CfnOutput(this, "SiteNameServers", {
      value: cdk.Fn.join(",", this.siteZone.hostedZoneNameServers ?? []),
      description: `Delegate ${props.siteDomain} to these name servers from the management zone.`,
    });
    new cdk.CfnOutput(this, "AuthNameServers", {
      value: cdk.Fn.join(",", this.authZone.hostedZoneNameServers ?? []),
      description: `Delegate ${props.authDomain} to these name servers from the management zone.`,
    });
  }
}
