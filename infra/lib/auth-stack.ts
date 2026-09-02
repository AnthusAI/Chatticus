import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  AUTH_DOMAIN_NAMES,
  ChatticusCloudEnvironment,
  WEB_SITE_DOMAINS,
  webParameterPrefix,
} from "./environments";

export interface AuthStackProps extends cdk.StackProps {
  chatticusEnvironment: ChatticusCloudEnvironment;
  hostedZone: route53.IHostedZone;
  siteCertificate: acm.ICertificate;
  /** When set, Cognito flood alarms notify this SNS topic (ChatticusBudgets). */
  budgetsAlertsTopicArn?: string;
}

/**
 * Cognito user pool with Google federation for SPA authorization code + PKCE.
 *
 * Cognito authenticates only. Membership and roles live in DynamoDB, not
 * Cognito groups. Identity is keyed on verified email, never Cognito sub.
 */
export class AuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const environmentName = props.chatticusEnvironment;
    const authDomainName = AUTH_DOMAIN_NAMES[environmentName];
    const siteDomain = WEB_SITE_DOMAINS[environmentName];
    const webPrefix = webParameterPrefix(environmentName);
    const retainData = environmentName !== "development";
    cdk.Tags.of(this).add("chatticus:environment", environmentName);

    const googleOAuth = secretsmanager.Secret.fromSecretNameV2(
      this,
      "GoogleOAuth",
      `chatticus/${environmentName}/oauth/google`,
    );

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `chatticus-${environmentName}`,
      signInCaseSensitive: false,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      removalPolicy: retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const googleProvider = new cognito.UserPoolIdentityProviderGoogle(this, "Google", {
      userPool,
      clientId: googleOAuth.secretValueFromJson("client_id").toString(),
      clientSecretValue: googleOAuth.secretValueFromJson("client_secret"),
      scopes: ["openid", "email", "profile"],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        emailVerified: cognito.ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
        givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
        familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
      },
    });
    userPool.registerIdentityProvider(googleProvider);

    const spaClient = userPool.addClient("SpaClient", {
      userPoolClientName: `chatticus-web-${environmentName}`,
      generateSecret: false,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [`https://${siteDomain}/auth/callback`],
        logoutUrls: [
          `https://${siteDomain}/`,
          `https://${siteDomain}/auth/signout-callback`,
        ],
      },
      authSessionValidity: cdk.Duration.minutes(3),
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      enableTokenRevocation: true,
    });
    spaClient.node.addDependency(googleProvider);

    const authDomain = userPool.addDomain("AuthDomain", {
      customDomain: {
        domainName: authDomainName,
        certificate: props.siteCertificate,
      },
    });

    new route53.ARecord(this, "AuthAliasRecord", {
      zone: props.hostedZone,
      recordName: authDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.UserPoolDomainTarget(authDomain),
      ),
    });
    new route53.AaaaRecord(this, "AuthAliasRecordV6", {
      zone: props.hostedZone,
      recordName: authDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.UserPoolDomainTarget(authDomain),
      ),
    });

    new ssm.StringParameter(this, "CognitoUserPoolIdParameter", {
      parameterName: `${webPrefix}/cognito-user-pool-id`,
      stringValue: userPool.userPoolId,
      description: `Cognito user pool id for ${environmentName} Google sign-in.`,
    });
    new ssm.StringParameter(this, "CognitoAppClientIdParameter", {
      parameterName: `${webPrefix}/cognito-app-client-id`,
      stringValue: spaClient.userPoolClientId,
      description: `Cognito public app client id for ${environmentName} SPA PKCE.`,
    });
    new ssm.StringParameter(this, "CognitoAuthDomainParameter", {
      parameterName: `${webPrefix}/cognito-auth-domain`,
      stringValue: authDomainName,
      description: `Cognito custom auth hostname for ${environmentName}.`,
    });

    const federationFloodAlarm = new cloudwatch.Alarm(this, "CognitoFederationFlood", {
      alarmName: `chatticus-${environmentName}-cognito-federation-flood`,
      alarmDescription:
        "Leading indicator only: counts all successful Google federated auths " +
        "in this user pool, not billed MAU and not first-time sign-ins alone. " +
        "True MAU is billing-sourced. Threshold is well below the 10,000 MAU " +
        "free tier so operators learn about a flood from an alarm, not an invoice.",
      metric: new cloudwatch.Metric({
        namespace: "AWS/Cognito",
        metricName: "FederationSuccesses",
        statistic: "Sum",
        period: cdk.Duration.days(1),
        dimensionsMap: {
          UserPool: userPool.userPoolId,
        },
      }),
      threshold: 2000,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    if (props.budgetsAlertsTopicArn) {
      federationFloodAlarm.addAlarmAction(
        new cloudwatchActions.SnsAction(
          sns.Topic.fromTopicArn(this, "BudgetsAlertsTopic", props.budgetsAlertsTopicArn),
        ),
      );
    }

    new cdk.CfnOutput(this, "ChatticusEnvironment", { value: environmentName });
    new cdk.CfnOutput(this, "CognitoUserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "CognitoAppClientId", {
      value: spaClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "CognitoAuthDomain", { value: authDomainName });
    new cdk.CfnOutput(this, "CognitoAuthBaseUrl", {
      value: `https://${authDomainName}`,
    });
  }
}
