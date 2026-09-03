export function BetaSetupPricing() {
  return (
    <section
      aria-labelledby="beta-setup-pricing-title"
      className="bg-surface text-ink"
    >
      <div className="mx-auto max-w-[92rem] px-5 py-16 sm:px-8 lg:px-12">
        <h2
          id="beta-setup-pricing-title"
          className="max-w-4xl font-display text-[clamp(2.2rem,4.5vw,3.6rem)] leading-[0.95] tracking-[-0.05em]"
        >
          Two ways in. Same $20 a month once you are running.
        </h2>
        <p className="mt-6 max-w-3xl font-body text-lg leading-relaxed text-ink-soft">
          Most customers run the template themselves. Assisted setup is for
          people who would rather not — not because it is worse, but because
          $100 does not cover an engineer session at fully loaded cost.
        </p>

        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <article className="rounded-[1.6rem] bg-surface-raised p-8">
            <h3 className="font-display text-2xl font-semibold tracking-[-0.04em]">
              Self-setup
            </h3>
            <p className="mt-4 font-body leading-relaxed text-ink-soft">
              Run the CloudFormation template yourself in your AWS account. You
              get the template, the IAM policy, and written instructions.
              Anthus operates the deployment and keeps it updated.
            </p>
            <div className="mt-8 space-y-1">
              <p className="font-display text-3xl font-semibold tracking-[-0.04em]">
                $20 a month
              </p>
              <p className="font-body text-ink-soft">No setup fee</p>
            </div>
          </article>

          <article className="rounded-[1.6rem] bg-surface-high p-8">
            <h3 className="font-display text-2xl font-semibold tracking-[-0.04em]">
              Assisted setup
            </h3>
            <p className="mt-4 font-body leading-relaxed text-ink-soft">
              Have us do it with you. A scheduled session with an engineer,
              ending with your first team of bots running. Anthus then operates
              the deployment and keeps it updated.
            </p>
            <div className="mt-8 space-y-1">
              <p className="font-display text-3xl font-semibold tracking-[-0.04em]">
                $20 a month
              </p>
              <p className="font-body text-ink-soft">and $100 once</p>
            </div>
          </article>
        </div>

        <div className="mt-10 rounded-[1.6rem] bg-surface-raised px-8 py-8">
          <h3 className="font-display text-xl font-semibold tracking-[-0.04em]">
            What you pay
          </h3>
          <ul className="mt-4 space-y-2 font-body leading-relaxed text-ink-soft">
            <li>$20 a month for the Chatticus control plane</li>
            <li>AWS infrastructure is billed to the customer</li>
            <li>Model tokens (Anthropic or OpenAI) are billed to the customer</li>
            <li>$0 setup on self-setup, or $100 once on assisted setup</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
