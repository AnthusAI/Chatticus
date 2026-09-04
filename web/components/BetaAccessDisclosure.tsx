export function BetaAccessDisclosure() {
  return (
    <p className="font-display text-3xl leading-tight tracking-[-0.035em]">
      Your Chatticus organization runs in an AWS account you own, on your network,
      under your logging. We access it via a{" "}
      <a
        href="https://github.com/AnthusAI/Chatticus/blob/main/infra/customer-role.yml"
        className="underline decoration-2 underline-offset-4 transition-colors hover:text-signal"
      >
        cross-account CloudFormation template
      </a>{" "}
      and{" "}
      <a
        href="https://github.com/AnthusAI/Chatticus/blob/main/infra/customer-role.yml#L26"
        className="underline decoration-2 underline-offset-4 transition-colors hover:text-signal"
      >
        scoped IAM policy
      </a>
      .
    </p>
  );
}
