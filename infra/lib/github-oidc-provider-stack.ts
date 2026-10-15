import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { GITHUB_OIDC_PROVIDER_URL } from "./account-github-deploy-stack";

/**
 * The GitHub Actions OIDC identity provider of an AWS account that holds more
 * than one environment. AWS allows one provider per issuer URL per account, so it
 * is created here once and each environment's deploy stack imports it by ARN.
 * It is retained: deleting it would lock every environment's deploy role out.
 */
export class GitHubOidcProviderStack extends cdk.Stack {
  public readonly provider: iam.OidcProviderNative;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, { ...props, terminationProtection: true });

    this.provider = new iam.OidcProviderNative(this, "GitHubOidc", {
      url: `https://${GITHUB_OIDC_PROVIDER_URL}`,
      clientIds: ["sts.amazonaws.com"],
    });
    this.provider.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    new cdk.CfnOutput(this, "GithubOidcProviderArn", {
      value: this.provider.oidcProviderArn,
      description: "Imported by name by ChatticusAccountDeployStaging and ChatticusAccountDeployProduction.",
    });
  }
}
