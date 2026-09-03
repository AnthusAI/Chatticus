const INSTALLATION_OPTIONS = [
  { key: "self-install", label: "Self-install", fee: "$0" },
  { key: "turn-key", label: "Turn-key install", fee: "$100 once" },
] as const;

const MANAGEMENT_OPTIONS = [
  {
    key: "self-hosted",
    label: "Self-hosted",
    fee: "$0/month",
    description:
      "You run the Chatticus control plane yourself in your own AWS account. There is no monthly management fee to Anthus.",
  },
  {
    key: "managed",
    label: "Managed service",
    fee: "$20/month",
    description:
      "Anthus runs the core Chatticus management infrastructure and plugs your AWS account into it. We are responsible for availability, continuous upgrades, ever-evolving security scanning and privacy safeguards, and all ITSM in general.",
  },
] as const;

function scenarioTotal(
  installationFee: string,
  managementFee: string,
): { installation: string; management: string } {
  return { installation: installationFee, management: managementFee };
}

const PRICING_SCENARIOS = MANAGEMENT_OPTIONS.flatMap((management) =>
  INSTALLATION_OPTIONS.map((installation) => ({
    management,
    installation,
    total: scenarioTotal(installation.fee, management.fee),
  })),
);

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
          Four ways in. Both fees are optional.
        </h2>
        <p className="mt-6 max-w-3xl font-body text-lg leading-relaxed text-ink-soft">
          Chatticus pricing has two independent dimensions: who runs the control
          plane, and who handles installation. You choose one option on each
          axis. The $20/month management fee and the $100 turn-key installation
          fee are both optional.
        </p>

        <p className="mt-6 max-w-3xl font-body leading-relaxed text-ink-soft">
          Either way, the heavy resources like EC2 instances and the private
          information like your file system volume and your encrypted secrets
          are all stored within your AWS account and you pay for those. You
          bring your own AWS account and may bring your own AI API accounts,
          such as OpenAI, Anthropic, xAI, DeepSeek, Moonshot, or Amazon
          Bedrock.
        </p>

        <div className="mt-10 space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,1fr))]">
            <div className="hidden lg:block" aria-hidden="true" />
            {INSTALLATION_OPTIONS.map((installation) => (
              <div
                key={installation.key}
                className="rounded-[1.6rem] bg-surface-raised px-6 py-5"
              >
                <p className="font-display text-sm font-semibold uppercase tracking-[0.08em] text-ink-soft">
                  Installation
                </p>
                <h3 className="mt-2 font-display text-xl font-semibold tracking-[-0.04em]">
                  {installation.label}
                </h3>
                <p className="mt-2 font-body text-ink-soft">
                  {installation.fee}
                  {installation.key === "turn-key" ? " (optional)" : ""}
                </p>
              </div>
            ))}
          </div>

          {MANAGEMENT_OPTIONS.map((management) => (
            <div
              key={management.key}
              className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,1fr))]"
            >
              <div className="rounded-[1.6rem] bg-surface-raised px-6 py-5">
                <p className="font-display text-sm font-semibold uppercase tracking-[0.08em] text-ink-soft">
                  Management
                </p>
                <h3 className="mt-2 font-display text-xl font-semibold tracking-[-0.04em]">
                  {management.label}
                </h3>
                <p className="mt-2 font-body text-ink-soft">
                  {management.fee}
                  {management.key === "managed" ? " (optional)" : ""}
                </p>
                <p className="mt-4 font-body text-sm leading-relaxed text-ink-soft">
                  {management.description}
                </p>
                {management.key === "managed" ? (
                  <p className="mt-4 font-body text-sm leading-relaxed text-ink-soft">
                    Your AWS account, file system, and encrypted secrets stay in
                    your account.
                  </p>
                ) : null}
              </div>

              {INSTALLATION_OPTIONS.map((installation) => {
                const scenario = PRICING_SCENARIOS.find(
                  (entry) =>
                    entry.management.key === management.key &&
                    entry.installation.key === installation.key,
                );
                if (!scenario) {
                  return null;
                }

                return (
                  <div
                    key={`${management.key}-${installation.key}`}
                    className="rounded-[1.6rem] bg-surface-high px-6 py-5"
                    aria-label={`${management.label} with ${installation.label}`}
                  >
                    <p className="font-display text-sm font-semibold uppercase tracking-[0.08em] text-ink-soft">
                      Total
                    </p>
                    <p className="mt-3 font-display text-2xl font-semibold tracking-[-0.04em]">
                      {scenario.total.installation}
                    </p>
                    <p className="mt-1 font-display text-2xl font-semibold tracking-[-0.04em]">
                      {scenario.total.management}
                    </p>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <article className="rounded-[1.6rem] bg-surface-raised p-8">
            <h3 className="font-display text-xl font-semibold tracking-[-0.04em]">
              Professional services
            </h3>
            <p className="mt-4 font-body leading-relaxed text-ink-soft">
              Optional professional services from Anthus AI Solutions. We adapt
              Chatticus to your needs — custom integrations, workflow design,
              and deployment support beyond the standard install.
            </p>
            <p className="mt-6">
              <a
                href="/contact/services"
                className="font-body text-sm font-semibold text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink"
              >
                Contact us about professional services
              </a>
            </p>
          </article>

          <article className="rounded-[1.6rem] bg-surface-raised p-8">
            <h3 className="font-display text-xl font-semibold tracking-[-0.04em]">
              Professional training
            </h3>
            <p className="mt-4 font-body leading-relaxed text-ink-soft">
              Optional professional training from Anthus AI Solutions. Learn how
              to run your organization on Chatticus, from day-to-day operations
              to advanced bot and routine design.
            </p>
            <p className="mt-6">
              <a
                href="/contact/training"
                className="font-body text-sm font-semibold text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink"
              >
                Contact us about professional training
              </a>
            </p>
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
