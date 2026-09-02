import assert from "node:assert/strict";
import { Match } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import {
  CHATTICUS_CLOUD_ENVIRONMENTS,
  openAiApiKeyParameterName,
} from "../lib/environments";
import { synthThinTurnStack } from "./thin-turn-stack-harness";

const SHARED_DESK_OPENAI_PARAMETER = "/amplify/shared/papyrus/OPENAI_API_KEY";

function lambdaEnvironment(template: ReturnType<typeof synthThinTurnStack>): string {
  const resources = template.findResources("AWS::Lambda::Function");
  return JSON.stringify(resources);
}

describe("ThinTurnStack OpenAI key", () => {
  for (const environmentName of CHATTICUS_CLOUD_ENVIRONMENTS) {
    describe(environmentName, () => {
      const openAiParameterName = openAiApiKeyParameterName(environmentName);
      const template = synthThinTurnStack(environmentName);

      it("reads the deployment-scoped SSM parameter, not the shared desk key", () => {
        const serialized = lambdaEnvironment(template);
        assert.ok(
          serialized.includes(openAiParameterName),
          `expected ${openAiParameterName} in Lambda environment`,
        );
        assert.equal(
          serialized.includes(SHARED_DESK_OPENAI_PARAMETER),
          false,
          "must not reference the shared desk OpenAI parameter",
        );
      });

      it("sets OPENAI_API_KEY_PARAMETER on front door and worker Lambdas", () => {
        template.hasResourceProperties("AWS::Lambda::Function", {
          Environment: {
            Variables: Match.objectLike({
              OPENAI_API_KEY_PARAMETER: openAiParameterName,
            }),
          },
        });
      });

      it("grants SSM read on the deployment OpenAI parameter", () => {
        template.hasResourceProperties("AWS::IAM::Policy", {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: "ssm:GetParameter",
                Resource: Match.arrayWith([
                  `arn:aws:ssm:us-east-1:111111111111:parameter${openAiParameterName}`,
                ]),
              }),
            ]),
          },
        });
      });
    });
  }
});
