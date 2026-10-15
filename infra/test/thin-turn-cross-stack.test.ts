import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Template } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import { ControlPlaneStack } from "../lib/control-plane-stack";
import {
  CHATTICUS_CLOUD_ENVIRONMENTS,
  CONTROL_PLANE_STACK_IDS,
  THIN_TURN_STACK_IDS,
  WEB_SITE_DOMAINS,
  WEB_STACK_IDS,
} from "../lib/environments";
import { ThinTurnStack } from "../lib/thin-turn-stack";
import { stubWebsiteDeploySource } from "../lib/web-bundle-stub";
import { WebStack } from "../lib/web-stack";

const env = { account: "111111111111", region: "us-east-1" };

function importedNames(template: Template): string[] {
  return [
    ...JSON.stringify(template.toJSON()).matchAll(/"Fn::ImportValue":"([^"]+)"/g),
  ].map((match) => match[1]!);
}

function exportedNames(template: Template): string[] {
  return Object.values((template.toJSON().Outputs ?? {}) as Record<string, any>)
    .map((output) => output.Export?.Name as string | undefined)
    .filter((name): name is string => name !== undefined);
}

describe("ThinTurnStack exports the control plane and web stacks import", () => {
  for (const environmentName of CHATTICUS_CLOUD_ENVIRONMENTS) {
    describe(environmentName, () => {
      const app = new cdk.App({ context: { computerHostStart: "noop" } });
      const thinTurn = new ThinTurnStack(app, THIN_TURN_STACK_IDS[environmentName], {
        env,
        chatticusEnvironment: environmentName,
      });
      const controlPlane = new ControlPlaneStack(app, CONTROL_PLANE_STACK_IDS[environmentName], {
        env,
        chatticusEnvironment: environmentName,
        messagingTable: thinTurn.messagingTable,
      });
      const deps = new cdk.Stack(app, "Deps", { env });
      const web = new WebStack(app, WEB_STACK_IDS[environmentName], {
        env,
        chatticusEnvironment: environmentName,
        siteDomain: WEB_SITE_DOMAINS[environmentName],
        hostedZone: route53.HostedZone.fromHostedZoneAttributes(deps, "Zone", {
          hostedZoneId: "Z1234567890ABC",
          zoneName: "chattic.us",
        }),
        siteCertificate: acm.Certificate.fromCertificateArn(
          deps,
          "Cert",
          "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000",
        ),
        frontDoorFunctionUrl: controlPlane.frontDoorFunctionUrl,
        invokeSecret: thinTurn.invokeSecret,
        websiteDeploySource: stubWebsiteDeploySource,
      });
      const exported = exportedNames(Template.fromStack(thinTurn));
      const controlPlaneImports = importedNames(Template.fromStack(controlPlane));
      const webImports = importedNames(Template.fromStack(web));
      const stackId = THIN_TURN_STACK_IDS[environmentName];

      it("exports the Messaging table name and ARN and the InvokeKey ref", () => {
        for (const pattern of [
          new RegExp(`^${stackId}:ExportsOutputRefMessaging4C94D7F8`),
          new RegExp(`^${stackId}:ExportsOutputFnGetAttMessaging4C94D7F8Arn`),
          new RegExp(`^${stackId}:ExportsOutputRefInvokeKey${"581783BE"}`),
        ]) {
          assert.ok(
            exported.some((name) => pattern.test(name)),
            `expected an export matching ${pattern}`,
          );
        }
      });

      it("resolves every control plane import against a ThinTurn export", () => {
        assert.ok(controlPlaneImports.length >= 2);
        for (const imported of controlPlaneImports) {
          assert.ok(exported.includes(imported), `${imported} must still be exported`);
        }
      });

      it("resolves every web import of ThinTurn against a ThinTurn export", () => {
        const thinTurnImports = webImports.filter((imported) => imported.startsWith(stackId));
        assert.ok(thinTurnImports.length >= 1);
        for (const imported of thinTurnImports) {
          assert.ok(exported.includes(imported), `${imported} must still be exported`);
        }
      });

      it("keeps the named secret ARN exports and drops the function URL export", () => {
        assert.ok(exported.includes(`Chatticus-${environmentName}-thin-turn-invoke-key-secret-arn`));
        assert.ok(exported.includes(`Chatticus-${environmentName}-thin-turn-operator-key-secret-arn`));
        assert.equal(
          exported.some((name) => name.endsWith("function-url")),
          false,
        );
      });
    });
  }
});
