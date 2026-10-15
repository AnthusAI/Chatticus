import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

export interface EnvironmentCertificatesStackProps extends cdk.StackProps {
  siteDomain: string;
  authDomain: string;
  siteZone: route53.IHostedZone;
  authZone: route53.IHostedZone;
}

/**
 * The certificates for one environment's two names, each validated by DNS inside
 * its own delegated zone. Deploy this only after the management zone delegates
 * both names to EnvironmentZonesStack: until then validation cannot complete and
 * the deploy waits. Separate from the zones so the zones can be created, their
 * name servers read, and the delegations made first.
 */
export class EnvironmentCertificatesStack extends cdk.Stack {
  public readonly siteCertificate: acm.ICertificate;
  public readonly authCertificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: EnvironmentCertificatesStackProps) {
    super(scope, id, props);

    this.siteCertificate = new acm.Certificate(this, "SiteCertificate", {
      domainName: props.siteDomain,
      validation: acm.CertificateValidation.fromDns(props.siteZone),
    });
    this.authCertificate = new acm.Certificate(this, "AuthCertificate", {
      domainName: props.authDomain,
      validation: acm.CertificateValidation.fromDns(props.authZone),
    });

    new cdk.CfnOutput(this, "SiteCertificateArn", { value: this.siteCertificate.certificateArn });
    new cdk.CfnOutput(this, "AuthCertificateArn", { value: this.authCertificate.certificateArn });
  }
}
