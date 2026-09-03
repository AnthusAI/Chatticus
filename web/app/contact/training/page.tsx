import type { Metadata } from "next";
import { ContactForm } from "@/components/ContactForm";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "Professional training | Chatticus",
  description:
    "Contact Anthus AI Solutions about professional training for running your organization on Chatticus.",
  alternates: {
    canonical: "/contact/training",
  },
};

export default function ContactTrainingPage() {
  return (
    <>
      <Header />
      <main id="main-content">
        <section className="bg-[var(--surface-0)]">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 lg:px-12">
            <ContactForm
              contactType="professional_training"
              conversionEvent="contact_training"
              title="Professional training"
              description="Tell us about your team and what you want to learn. Anthus AI Solutions will follow up with training options."
              detailFields={[
                {
                  id: "team-size",
                  label: "Team size",
                  name: "team_size",
                  required: true,
                },
                {
                  id: "topics-of-interest",
                  label: "Topics of interest",
                  name: "topics_of_interest",
                  required: true,
                  multiline: true,
                },
              ]}
            />
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
