import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ses from "aws-cdk-lib/aws-ses";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { MAIL_RECEIPT_RULE_SET_NAME } from "./environments";

/**
 * The one SES receipt rule set of the account and region, and its activation.
 *
 * SES allows a single active receipt rule set per account and region, and all
 * three environments share one account, so this stack owns the set and each
 * environment's mail stack adds only its own rule to it. CloudFormation cannot
 * activate a rule set, so a custom resource calls SetActiveReceiptRuleSet on
 * create and update, and calls it with no name on delete, because an active
 * rule set cannot be deleted. The activation is deleted before the rule set.
 *
 * The stack holds no receipt rule of its own and never touches an SES identity.
 * Environment mail stacks import the rule set name, so CloudFormation refuses
 * to delete this stack while any environment still has a rule in the set.
 * It is deployed first and by name, never for staging or production in M1.
 */
export class MailIngressStack extends cdk.Stack {
  public readonly ruleSet: ses.CfnReceiptRuleSet;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, { ...props, terminationProtection: true });

    this.ruleSet = new ses.CfnReceiptRuleSet(this, "ReceiptRuleSet", {
      ruleSetName: MAIL_RECEIPT_RULE_SET_NAME,
    });

    const activationCall: cr.AwsSdkCall = {
      service: "SES",
      action: "setActiveReceiptRuleSet",
      parameters: { RuleSetName: this.ruleSet.ref },
      physicalResourceId: cr.PhysicalResourceId.of(MAIL_RECEIPT_RULE_SET_NAME),
    };
    const activation = new cr.AwsCustomResource(this, "ActivateReceiptRuleSet", {
      installLatestAwsSdk: false,
      onCreate: activationCall,
      onUpdate: activationCall,
      onDelete: {
        service: "SES",
        action: "setActiveReceiptRuleSet",
        parameters: {},
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["ses:SetActiveReceiptRuleSet"],
          resources: ["*"],
        }),
      ]),
    });
    activation.node.addDependency(this.ruleSet);

    new cdk.CfnOutput(this, "ReceiptRuleSetName", { value: this.ruleSet.ref });
  }
}
