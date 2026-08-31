import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

const SITE_DOMAIN = "chattic.us";

/**
 * Shared public DNS for chattic.us.
 *
 * After deploy, set the domain registrar name servers to the NameServers
 * output (four Route 53 NS records).
 */
export class DnsStack extends cdk.Stack {
  readonly hostedZone: route53.IHostedZone;
  readonly siteCertificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const zone = new route53.PublicHostedZone(this, "ChatticUsZone", {
      zoneName: SITE_DOMAIN,
      comment: "Public DNS for chattic.us and environment subdomains.",
    });
    this.hostedZone = zone;

    const certificate = new acm.Certificate(this, "SiteCertificate", {
      domainName: SITE_DOMAIN,
      subjectAlternativeNames: [`*.${SITE_DOMAIN}`, `www.${SITE_DOMAIN}`],
      validation: acm.CertificateValidation.fromDns(zone),
    });
    this.siteCertificate = certificate;

    new cdk.CfnOutput(this, "HostedZoneId", {
      value: zone.hostedZoneId,
      description: "Route 53 hosted zone id for chattic.us.",
      exportName: "ChatticusDns-HostedZoneId",
    });
    new cdk.CfnOutput(this, "NameServers", {
      value: cdk.Fn.join(",", zone.hostedZoneNameServers ?? []),
      description:
        "Set these four name servers at the chattic.us domain registrar.",
    });
    new cdk.CfnOutput(this, "SiteCertificateArn", {
      value: certificate.certificateArn,
      description: "ACM certificate for chattic.us and *.chattic.us (us-east-1).",
      exportName: "ChatticusDns-SiteCertificateArn",
    });
  }
}
