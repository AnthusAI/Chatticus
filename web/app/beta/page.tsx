import type { Metadata } from "next";
import { BetaAccessDisclosure } from "@/components/BetaAccessDisclosure";
import { BetaSetupPricing } from "@/components/BetaSetupPricing";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "Chatticus beta | Join the waitlist",
  description:
    "Read the cross-account IAM policy and CloudFormation template before you sign up for the Chatticus beta.",
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
                What Chatticus needs in your AWS account
              </h1>
              <div className="mt-8">
                <BetaAccessDisclosure />
              </div>
            </div>
          </div>
        </section>
        <BetaSetupPricing />
      </main>
      <Footer />
    </>
  );
}
