import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import {
  MAIL_RAW_RETENTION_DAYS,
  MAIL_RECEIPT_RULE_SET_NAME,
  type ChatticusCloudEnvironment,
} from "./environments";

export interface MailStackProps extends cdk.StackProps {
  chatticusEnvironment: ChatticusCloudEnvironment;
  mailDomain: string;
  receiptRuleSet: ses.CfnReceiptRuleSet;
  /**
   * The zone that delegates the mail zone with one NS record, in the same
   * account. Absent for production, whose mail domain is delegated by the owner
   * from the management account (docs/MAIL_INFRASTRUCTURE.md).
   */
  delegationParentZone?: route53.IHostedZone;
}

/** Where the raw message bytes land in the raw mail bucket. */
export const RAW_MAIL_OBJECT_KEY_PREFIX = "raw/";

/** The outbound sending events delivered to the mail events topic. */
export const MAIL_EVENT_TYPES = [
  ses.EmailSendingEvent.SEND,
  ses.EmailSendingEvent.BOUNCE,
  ses.EmailSendingEvent.COMPLAINT,
  ses.EmailSendingEvent.DELIVERY,
  ses.EmailSendingEvent.REJECT,
];

/**
 * The mail side of one environment: its delegated mail zone, an SES domain
 * identity with Easy DKIM and a custom MAIL FROM domain, MX records that point
 * the whole mail domain at SES inbound, one receipt rule in the shared rule
 * set that stores raw mail in a private bucket, and the outbound configuration
 * set whose events go to one SNS topic.
 *
 * The receipt rule has only the S3 action here; the ingress Lambda action is
 * added with the Lambda itself. Rules of other environments are never read or
 * edited: this stack adds one rule named for its own environment.
 *
 * SES stays in the sandbox: nothing here requests production access or a quota.
 */
export class MailStack extends cdk.Stack {
  public readonly mailZone: route53.PublicHostedZone;
  public readonly rawMailBucket: s3.Bucket;
  public readonly eventsTopic: sns.Topic;
  public readonly configurationSet: ses.ConfigurationSet;

  constructor(scope: Construct, id: string, props: MailStackProps) {
    super(scope, id, { ...props, terminationProtection: true });
    const { chatticusEnvironment, mailDomain } = props;
    const stack = cdk.Stack.of(this);

    this.mailZone = new route53.PublicHostedZone(this, "MailZone", { zoneName: mailDomain });
    this.mailZone.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    if (props.delegationParentZone !== undefined) {
      new route53.NsRecord(this, "MailZoneDelegation", {
        zone: props.delegationParentZone,
        recordName: mailDomain,
        values: this.mailZone.hostedZoneNameServers ?? [],
      });
    }

    this.eventsTopic = new sns.Topic(this, "MailEventsTopic", {
      topicName: `chatticus-${chatticusEnvironment}-mail-events`,
    });
    this.eventsTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowSesOfThisAccountToPublish",
        principals: [new iam.ServicePrincipal("ses.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [this.eventsTopic.topicArn],
        conditions: { StringEquals: { "AWS:SourceAccount": stack.account } },
      }),
    );

    this.configurationSet = new ses.ConfigurationSet(this, "OutboundConfigurationSet", {
      configurationSetName: `chatticus-${chatticusEnvironment}-outbound`,
      reputationMetrics: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    this.configurationSet.addEventDestination("MailEvents", {
      destination: ses.EventDestination.snsTopic(this.eventsTopic),
      events: MAIL_EVENT_TYPES,
    });

    new ses.EmailIdentity(this, "MailDomainIdentity", {
      identity: ses.Identity.publicHostedZone(this.mailZone),
      dkimSigning: true,
      mailFromDomain: `bounce.${mailDomain}`,
      mailFromBehaviorOnMxFailure: ses.MailFromBehaviorOnMxFailure.REJECT_MESSAGE,
      configurationSet: this.configurationSet,
    });

    new route53.TxtRecord(this, "MailDmarc", {
      zone: this.mailZone,
      recordName: `_dmarc.${mailDomain}`,
      values: ["v=DMARC1; p=none; adkim=s; aspf=s"],
    });

    const inboundEndpoint = `inbound-smtp.${stack.region}.amazonaws.com`;
    new route53.MxRecord(this, "MailInboundBare", {
      zone: this.mailZone,
      values: [{ priority: 10, hostName: inboundEndpoint }],
    });
    new route53.MxRecord(this, "MailInboundWildcard", {
      zone: this.mailZone,
      recordName: `*.${mailDomain}`,
      values: [{ priority: 10, hostName: inboundEndpoint }],
    });

    this.rawMailBucket = new s3.Bucket(this, "RawMailBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "ExpireRawMail",
          expiration: cdk.Duration.days(MAIL_RAW_RETENTION_DAYS),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
    });

    const receiptRuleName = `chatticus-${chatticusEnvironment}-mail`;
    this.rawMailBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowSesReceiptRuleToStoreRawMail",
        principals: [new iam.ServicePrincipal("ses.amazonaws.com")],
        actions: ["s3:PutObject"],
        resources: [this.rawMailBucket.arnForObjects(`${RAW_MAIL_OBJECT_KEY_PREFIX}*`)],
        conditions: {
          StringEquals: {
            "aws:SourceAccount": stack.account,
            "aws:SourceArn": stack.formatArn({
              service: "ses",
              resource: "receipt-rule-set",
              resourceName: `${MAIL_RECEIPT_RULE_SET_NAME}:receipt-rule/${receiptRuleName}`,
              arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
            }),
          },
        },
      }),
    );

    const receiptRule = new ses.CfnReceiptRule(this, "ReceiptRule", {
      ruleSetName: props.receiptRuleSet.ref,
      rule: {
        name: receiptRuleName,
        enabled: true,
        scanEnabled: true,
        tlsPolicy: "Optional",
        recipients: [mailDomain],
        actions: [
          {
            s3Action: {
              bucketName: this.rawMailBucket.bucketName,
              objectKeyPrefix: RAW_MAIL_OBJECT_KEY_PREFIX,
            },
          },
        ],
      },
    });
    receiptRule.node.addDependency(this.rawMailBucket);

    new cdk.CfnOutput(this, "MailDomain", { value: mailDomain });
    new cdk.CfnOutput(this, "MailZoneNameServers", {
      value: cdk.Fn.join(",", this.mailZone.hostedZoneNameServers ?? []),
      description:
        props.delegationParentZone === undefined
          ? `Delegate ${mailDomain} to these name servers from the management zone.`
          : `${mailDomain} is already delegated from the environment site zone.`,
    });
    new cdk.CfnOutput(this, "RawMailBucketName", { value: this.rawMailBucket.bucketName });
    new cdk.CfnOutput(this, "OutboundConfigurationSetName", { value: this.configurationSet.configurationSetName });
    new cdk.CfnOutput(this, "MailEventsTopicArn", { value: this.eventsTopic.topicArn });
  }
}
