import type { Metadata } from "next";
import { ContactForm } from "@/components/ContactForm";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "Professional services | Chatticus",
  description:
    "Contact Anthus AI Solutions about custom Chatticus integrations, workflow design, and deployment support.",
  alternates: {
    canonical: "/contact/services",
  },
};

export default function ContactServicesPage() {
  return (
    <>
      <Header />
      <main id="main-content">
        <section className="bg-[var(--surface-0)]">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 lg:px-12">
            <ContactForm
              contactType="professional_services"
              conversionEvent="contact_services"
              title="Professional services"
              description="Tell us about the integrations and workflows you want Chatticus to support. Anthus AI Solutions will follow up with a quote."
              detailFields={[
                {
                  id: "resources-to-integrate",
                  label: "What resources do you want to integrate?",
                  name: "resources_to_integrate",
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
