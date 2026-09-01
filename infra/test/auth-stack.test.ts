import {
  CHATTICUS_CLOUD_ENVIRONMENTS,
  AUTH_DOMAIN_NAMES,
} from "../lib/environments";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authStackExpectations, synthAuthStack } from "./auth-stack-harness";

const SECRETS_MANAGER_DYNAMIC_REF = /\{\{resolve:secretsmanager:/;

function cloudFormationValueToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "Fn::Join" in value &&
    Array.isArray((value as { "Fn::Join": unknown[] })["Fn::Join"])
  ) {
    const [, parts] = (value as { "Fn::Join": [string, unknown[]] })["Fn::Join"];
    return parts.map(cloudFormationValueToString).join("");
  }
  return JSON.stringify(value);
}

describe("AuthStack", () => {
  for (const environmentName of CHATTICUS_CLOUD_ENVIRONMENTS) {
    describe(environmentName, () => {
      const template = synthAuthStack(environmentName);
      const { authDomainName, callbackUrl, webPrefix } =
        authStackExpectations(environmentName);

      it("creates a case-insensitive user pool", () => {
        template.hasResourceProperties("AWS::Cognito::UserPool", {
          UsernameConfiguration: { CaseSensitive: false },
          AdminCreateUserConfig: {
            AllowAdminCreateUserOnly: true,
          },
        });
      });

      it("creates a public SPA client with authorization code and PKCE", () => {
        template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
          GenerateSecret: false,
          AllowedOAuthFlows: ["code"],
          AllowedOAuthFlowsUserPoolClient: true,
          SupportedIdentityProviders: ["Google"],
          CallbackURLs: [callbackUrl],
          RefreshTokenValidity: 43200,
          TokenValidityUnits: {
            RefreshToken: "minutes",
          },
        });
        template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
      });

      it("does not create Cognito groups", () => {
        template.resourceCountIs("AWS::Cognito::UserPoolGroup", 0);
      });

      it("wires Google IdP with Secrets Manager dynamic refs, not plaintext", () => {
        template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
          ProviderType: "Google",
          ProviderDetails: {
            authorize_scopes: "openid email profile",
          },
        });

        const providers = template.findResources(
          "AWS::Cognito::UserPoolIdentityProvider",
        );
        const provider = Object.values(providers)[0] as {
          Properties: {
            ProviderDetails: {
              client_id: unknown;
              client_secret: unknown;
            };
          };
        };
        const clientId = cloudFormationValueToString(
          provider.Properties.ProviderDetails.client_id,
        );
        const clientSecret = cloudFormationValueToString(
          provider.Properties.ProviderDetails.client_secret,
        );
        assert.match(clientId, SECRETS_MANAGER_DYNAMIC_REF);
        assert.match(clientSecret, SECRETS_MANAGER_DYNAMIC_REF);
        assert.doesNotMatch(
          clientId,
          /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/,
        );
      });

      it("uses the custom auth domain on the shared certificate", () => {
        template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
          Domain: authDomainName,
        });
        const domains = template.findResources("AWS::Cognito::UserPoolDomain");
        const domain = Object.values(domains)[0] as {
          Properties: {
            CustomDomainConfig: { CertificateArn: string };
          };
        };
        assert.ok(domain.Properties.CustomDomainConfig?.CertificateArn);
      });

      it("creates Route 53 alias records for the auth domain", () => {
        template.hasResourceProperties("AWS::Route53::RecordSet", {
          Name: `${authDomainName}.`,
          Type: "A",
        });
        template.hasResourceProperties("AWS::Route53::RecordSet", {
          Name: `${authDomainName}.`,
          Type: "AAAA",
        });
      });

      it("publishes Cognito identifiers to SSM under the web prefix", () => {
        template.hasResourceProperties("AWS::SSM::Parameter", {
          Name: `${webPrefix}/cognito-user-pool-id`,
        });
        template.hasResourceProperties("AWS::SSM::Parameter", {
          Name: `${webPrefix}/cognito-app-client-id`,
        });
        template.hasResourceProperties("AWS::SSM::Parameter", {
          Name: `${webPrefix}/cognito-auth-domain`,
          Value: authDomainName,
        });
      });
    });
  }

  it("maps auth domains to single-label hostnames covered by *.chattic.us", () => {
    assert.equal(AUTH_DOMAIN_NAMES.development, "auth-dev.chattic.us");
    assert.equal(AUTH_DOMAIN_NAMES.staging, "auth-staging.chattic.us");
    assert.equal(AUTH_DOMAIN_NAMES.production, "auth.chattic.us");
  });
});
