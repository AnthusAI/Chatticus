export const TERMS_PAGE_CONTENT = {
  title: "Terms of Service | Chatticus",
  description:
    "Beta terms for using Chatticus marketing surfaces and the product workspace.",
  ogTitle: "Terms of Service",
  ogDescription:
    "Public beta terms for Chatticus, including expectations, managed service boundaries, and open-source licensing.",
  body: `
## Public beta terms

Chatticus is in **public beta**. By using chattic.us, submitting the beta waitlist, signing in to the product workspace, or operating a managed deployment, you agree to these terms for the beta period.

## The service

Chatticus provides persistent named bots, a shared organization workspace, approvals, and an optional Linux computer inside infrastructure you control. During beta, features change without notice, documentation may lag the product, and **there is no uptime guarantee**.

The open-source software is available under the [MIT License](https://github.com/AnthusAI/Chattic.us/blob/develop/LICENSE). If you fork and self-host, you operate that deployment yourself and these beta service terms apply only to Anthus-operated surfaces such as the marketing site, waitlist, and managed operation of your deployment.

## Managed operation

If you choose a managed setup path described on the [beta page](/beta), Anthus AI Solutions may access your AWS deployment through the cross-account IAM role you approve. You remain responsible for AWS charges in your account. Cancelling managed service stops Anthus operation of the deployment; it does not delete resources in your account.

## Acceptable use

Do not use Chatticus to break the law, attack third-party systems, or process data you are not authorized to handle. You are responsible for approvals and consequential actions taken through bots in your organization.

## Disclaimers

Chatticus is provided during beta **as is**, without warranties of merchantability, fitness for a particular purpose, or non-infringement. Anthus AI Solutions is not liable for indirect, incidental, or consequential damages arising from beta use to the fullest extent permitted by law.

## Changes

We may update these terms as the beta progresses. Continued use after an update means you accept the revised terms. A fuller general-availability agreement will replace this document before Chatticus leaves beta.

## Support

During beta, support is handled through [GitHub Issues](https://github.com/AnthusAI/Chattic.us/issues) on the Chatticus repository. Use the **Support** label when it is available.
`.trim(),
} as const;
