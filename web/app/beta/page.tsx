import type { Metadata } from "next";
import { BetaAccessDisclosure } from "@/components/BetaAccessDisclosure";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "Chatticus beta | Join the waitlist",
  description:
    "Read beta pricing, costs, and the cross-account IAM policy before you sign up for the Chatticus beta.",
  alternates: {
    canonical: "/beta",
  },
};

export default function BetaPitchPage() {
  return (
    <>
      <Header />
      <main id="main-content">
        <section className="bg-clay text-ink">
          <div className="mx-auto max-w-[92rem] px-5 py-24 sm:px-8 sm:py-32 lg:px-12">
            <div className="max-w-3xl">
              <h1 className="font-display text-[clamp(3rem,6vw,5rem)] leading-[0.9] tracking-[-0.06em]">
                Join the beta
              </h1>
              <div className="mt-8">
                <BetaAccessDisclosure />
              </div>
            </div>
          </div>
        </section>

        <section
          id="beta-costs"
          aria-labelledby="beta-costs-heading"
          className="bg-[var(--surface-0)]"
        >
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 lg:px-12">
            <div className="max-w-3xl rounded-2xl bg-[var(--surface-1)] p-8">
              <h2
                id="beta-costs-heading"
                className="font-display text-3xl tracking-[-0.04em]"
              >
                Beta pricing and costs
              </h2>
              <ul className="mt-6 list-disc space-y-3 pl-5 text-lg">
                <li>
                  <strong>Monthly fee:</strong> $20 a month for the Chatticus
                  control plane.
                </li>
                <li>
                  <strong>Infrastructure:</strong> AWS infrastructure is billed
                  to the customer directly.
                </li>
                <li>
                  <strong>Tokens:</strong> Model tokens (Anthropic or OpenAI) are
                  billed to the customer.
                </li>
                <li>
                  <strong>Setup fee:</strong> $0 for self-setup, or $100
                  one-time for assisted setup with an engineer.
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section
          id="beta-expectations"
          aria-labelledby="beta-expectations-heading"
          className="bg-[var(--surface-1)]"
        >
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 lg:px-12">
            <div className="max-w-3xl rounded-2xl bg-[var(--surface-0)] p-8">
              <h2
                id="beta-expectations-heading"
                className="font-display text-3xl tracking-[-0.04em]"
              >
                What beta means
              </h2>
              <ul className="mt-6 list-disc space-y-3 pl-5 text-lg">
                <li>Features change without notice.</li>
                <li>There is no uptime guarantee.</li>
                <li>The subscription can be cancelled at any time.</li>
                <li>The deployment stays in your account if you leave.</li>
              </ul>
            </div>
          </div>
        </section>

        <section
          id="survey-section"
          aria-labelledby="survey-heading"
          className="bg-[var(--surface-0)]"
        >
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 lg:px-12">
            <div className="max-w-3xl rounded-2xl bg-[var(--surface-1)] p-8">
              <h2
                id="survey-heading"
                className="font-display text-3xl tracking-[-0.04em]"
              >
                Survey questions
              </h2>
              <form className="mt-6">
                <label htmlFor="survey-fit" className="block text-lg">
                  First survey question:
                </label>
                <input
                  id="survey-fit"
                  name="survey-fit"
                  type="text"
                  className="mt-3 w-full rounded-lg bg-[var(--surface-0)] p-3"
                />
              </form>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
