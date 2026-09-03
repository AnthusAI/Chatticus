import type { Metadata } from "next";
import { Suspense } from "react";

import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { WaitlistConfirmPanel } from "@/components/WaitlistConfirmPanel";

export const metadata: Metadata = {
  title: "Confirm your email | Chatticus beta",
  description: "Confirm your Chatticus beta waitlist signup.",
  alternates: {
    canonical: "/waitlist/confirm",
  },
};

function WaitlistConfirmFallback() {
  return (
    <>
      <Header />
      <main id="main-content">
        <section className="bg-[var(--surface-0)]">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 lg:px-12">
            <div className="max-w-2xl rounded-2xl bg-[var(--surface-1)] p-8">
              <h1 className="font-display text-3xl tracking-[-0.04em]">
                Confirming your email…
              </h1>
              <p className="mt-6 text-lg text-ink/70">
                Checking your confirmation link.
              </p>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

export default function WaitlistConfirmPage() {
  return (
    <Suspense fallback={<WaitlistConfirmFallback />}>
      <WaitlistConfirmPanel />
    </Suspense>
  );
}
