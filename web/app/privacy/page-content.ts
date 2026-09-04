export const PRIVACY_PAGE_CONTENT = {
  title: "Privacy Policy | Chatticus",
  description:
    "How Chatticus handles information during the public beta on chattic.us and in the product workspace.",
  ogTitle: "Privacy Policy",
  ogDescription:
    "What Chatticus collects during public beta, where it is stored, and how to reach us.",
  body: `
## Overview

Chatticus is operated by Anthus AI Solutions. This policy describes how we handle information on **chattic.us**, on the beta waitlist, and in the product workspace during the **public beta**. We will update it as the product moves toward general availability.

## What this site collects

**Marketing pages on chattic.us** do not run product account signup. Visiting those pages does not create a Chatticus account by itself.

**Beta waitlist at /beta** collects the information you submit in the survey form, including contact details and your answers about fit, AWS readiness, setup path, and pricing preferences. That data is sent to Chatticus-controlled infrastructure so we can review beta applications and follow up.

**Contact forms** at /contact/services and /contact/training collect the fields shown on each form and the message you send so Anthus AI Solutions can respond.

**Lightweight analytics on this site** may record page views and conversion events in your browser session, including UTM campaign parameters when they are present in the URL. We use this to understand which pages and campaigns lead people to the beta or product workspace.

## What the product workspace collects

When you sign in at /chat, authentication is handled through Amazon Cognito. Your organization, channel messages, bot configuration, and workspace files are stored in **your AWS account** under the deployment model described on the beta page. Anthus may access your deployment under the cross-account IAM role you approve for managed operation.

We do not sell personal information.

## How we use information

We use beta waitlist and contact submissions to review applications, respond to inquiries, and improve Chatticus. Product data is used to run the workspace you control. Session analytics help us understand marketing effectiveness during beta.

## Sharing and processors

We use cloud providers such as Amazon Web Services to host marketing and control-plane services. Support requests during beta are handled through [GitHub Issues](https://github.com/AnthusAI/Chatticus/issues) on the public repository.

## Retention and changes

Beta waitlist and contact records are kept while they are needed to operate the beta program. Product data retention follows your deployment and AWS configuration. Because Chatticus is in public beta, this policy may change as surfaces mature; we will post updates on this page.

## Contact

Questions about privacy during beta can be opened as a GitHub issue on [AnthusAI/Chatticus](https://github.com/AnthusAI/Chatticus/issues). Choose the **Support** label when it is available so we can find it quickly.
`.trim(),
} as const;
