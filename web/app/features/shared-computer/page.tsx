import type { Metadata } from "next";
import { ArrowUpRight, Check, CircleDashed, FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { SHARED_COMPUTER_PAGE_CONTENT } from "./page-content";

export const metadata: Metadata = {
  title: SHARED_COMPUTER_PAGE_CONTENT.title,
  description: SHARED_COMPUTER_PAGE_CONTENT.description,
  alternates: {
    canonical: "/features/shared-computer",
  },
  openGraph: {
    type: "website",
    url: "/features/shared-computer",
    title: SHARED_COMPUTER_PAGE_CONTENT.ogTitle,
    description: SHARED_COMPUTER_PAGE_CONTENT.ogDescription,
    siteName: "Chatticus",
  },
  twitter: {
    card: "summary_large_image",
    title: SHARED_COMPUTER_PAGE_CONTENT.ogTitle,
    description: SHARED_COMPUTER_PAGE_CONTENT.ogDescription,
  },
};

const steps = [
  {
    label: "One workplace, already set up",
    title: "Cookies, sessions, and credentials are already there.",
    body: "The organization gets one computer, not one per bot. Whichever bot picks up the next task finds the same signed-in sessions and command-line credentials the last one left.",
  },
  {
    label: "Its own screen, not its own machine",
    title: "Every bot works its own screen on that computer.",
    body: "Screens are separate work surfaces on the same machine — not separate machines to provision, patch, or lose track of.",
  },
  {
    label: "Durable, not disposable",
    title: "A stopped instance isn't a lost workplace.",
    body: "The computer isn't tied to one physical box. It's captured as a snapshot and can hydrate onto a new host without losing state.",
  },
];

const roadmap = [
  {
    icon: Check,
    label: "Live foundation",
    color: "bg-signal",
    body: "The computer is captured as a durable snapshot, not tied to any one running machine — a Fargate task, a stop/start EC2 instance, or a garage Mac can all host the same workplace identity.",
  },
  {
    icon: FlaskConical,
    label: "Proven in development",
    color: "bg-sea",
    body: "One shared computer already starts correctly across concurrent turns, and a turn that doesn't need the computer never boots one just to sit idle.",
  },
  {
    icon: CircleDashed,
    label: "Shipping next",
    color: "bg-amber",
    body: "A polished computer preview and work history in the product app, instead of relying on the computer's own screen output.",
  },
];

export default function SharedComputerPage() {
  return (
    <>
      <Header />
      <main id="main-content">
        <section className="bg-surface">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
            <Badge variant="clay">One computer, not one login per bot</Badge>
            <h1 className="mt-7 max-w-4xl font-display text-[clamp(3rem,7vw,6rem)] leading-[0.9] tracking-[-0.06em]">
              One computer.
              <span className="block italic text-clay">Every bot already signed in.</span>
            </h1>
            <p className="mt-8 max-w-2xl font-body text-lg leading-relaxed text-ink-soft">
              Every bot in an organization works on the same computer — the
              same browser sessions, the same saved logins, the same
              command-line credentials — instead of each one needing its own
              machine and its own set of logins to keep provisioned. One bot
              can pick up exactly where another left off.
            </p>
          </div>
        </section>

        <section className="bg-surface-raised">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
            <h2 className="max-w-2xl font-display text-[clamp(2.4rem,5vw,4rem)] leading-[0.95] tracking-[-0.05em]">
              How it works
            </h2>
            <div className="mt-12 grid gap-3">
              {steps.map((step, index) => (
                <article
                  key={step.label}
                  className="grid gap-5 rounded-2xl bg-surface p-6 sm:p-8 lg:grid-cols-[6rem_1fr_1.3fr] lg:items-center"
                >
                  <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-clay">
                    0{index + 1}
                  </span>
                  <div>
                    <p className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-ink-soft">
                      {step.label}
                    </p>
                    <h3 className="mt-2 font-display text-2xl leading-none tracking-[-0.04em] sm:text-3xl">
                      {step.title}
                    </h3>
                  </div>
                  <p className="max-w-xl font-body text-base leading-relaxed text-ink-soft">
                    {step.body}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-surface">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
            <Badge variant="outline">Product reality</Badge>
            <h2 className="mt-7 max-w-2xl font-display text-[clamp(2.4rem,5vw,4rem)] leading-[0.95] tracking-[-0.05em]">
              What&rsquo;s built. What&rsquo;s proven. What&rsquo;s next.
            </h2>
            <div className="mt-12 grid gap-3 lg:grid-cols-3">
              {roadmap.map((column) => {
                const Icon = column.icon;
                return (
                  <article key={column.label} className="rounded-2xl bg-surface-raised p-6 sm:p-8">
                    <div className="flex items-center justify-between gap-4">
                      <span className="font-mono text-[0.67rem] uppercase tracking-[0.13em]">
                        {column.label}
                      </span>
                      <span
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink ${column.color}`}
                      >
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                    </div>
                    <p className="mt-8 font-body text-sm leading-relaxed text-ink-soft">
                      {column.body}
                    </p>
                  </article>
                );
              })}
            </div>
            <a
              className="mt-12 inline-flex min-h-11 items-center gap-2 font-mono text-[0.65rem] uppercase tracking-[0.12em] underline decoration-2 underline-offset-4 transition hover:text-cobalt focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
              href="https://github.com/AnthusAI/Chattic.us/blob/develop/docs/PRODUCT.md#one-computer-per-organization"
            >
              Read the product spec
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
