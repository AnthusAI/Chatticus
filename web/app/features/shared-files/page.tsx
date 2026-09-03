import type { Metadata } from "next";
import { ArrowUpRight, Check, CircleDashed, FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { SHARED_FILES_PAGE_CONTENT } from "./page-content";

export const metadata: Metadata = {
  title: SHARED_FILES_PAGE_CONTENT.title,
  description: SHARED_FILES_PAGE_CONTENT.description,
  alternates: {
    canonical: "/features/shared-files",
  },
  openGraph: {
    type: "website",
    url: "/features/shared-files",
    title: SHARED_FILES_PAGE_CONTENT.ogTitle,
    description: SHARED_FILES_PAGE_CONTENT.ogDescription,
    siteName: "Chatticus",
  },
  twitter: {
    card: "summary_large_image",
    title: SHARED_FILES_PAGE_CONTENT.ogTitle,
    description: SHARED_FILES_PAGE_CONTENT.ogDescription,
  },
};

const steps = [
  {
    label: "One place, not one inbox each",
    title: "A file saved by one bot is visible to every bot.",
    body: "Files live in one shared workspace for the organization, not a separate folder or inbox per bot — nothing gets stuck behind a single bot that isn't running right now.",
  },
  {
    label: "Pick up, not start over",
    title: "The next bot continues from what's already there.",
    body: "A bot can keep working from files a different bot saved earlier — no re-explaining the task, no re-uploading the same document.",
  },
  {
    label: "Durable, not disposable",
    title: "A restart doesn't empty the cabinet.",
    body: "Files live in the same durable snapshot as the rest of the computer, so they survive a restart or a handoff between hosts.",
  },
];

const roadmap = [
  {
    icon: Check,
    label: "Live foundation",
    color: "bg-signal",
    body: "Files placed on the computer are visible to every bot and person in the organization — not sandboxed per bot — and durable across restarts.",
  },
  {
    icon: FlaskConical,
    label: "Proven in development",
    color: "bg-sea",
    body: "The same snapshot mechanism that reliably starts one shared computer across concurrent turns carries the files with it, host to host.",
  },
  {
    icon: CircleDashed,
    label: "Shipping next",
    color: "bg-amber",
    body: "A dedicated file browser in the product app, instead of relying on the computer's own file system view.",
  },
];

export default function SharedFilesPage() {
  return (
    <>
      <Header />
      <main id="main-content">
        <section className="bg-surface">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
            <Badge variant="clay">One filing cabinet, not one inbox each</Badge>
            <h1 className="mt-7 max-w-4xl font-display text-[clamp(3rem,7vw,6rem)] leading-[0.9] tracking-[-0.06em]">
              One filing cabinet.
              <span className="block italic text-clay">Every bot can reach it.</span>
            </h1>
            <p className="mt-8 max-w-2xl font-body text-lg leading-relaxed text-ink-soft">
              Every bot and every person in the organization reads and writes
              the same files, in the same shared workspace. A document one
              bot drafts is already there for the next one — no separate
              copy, no re-uploading, no hunting through a bot&rsquo;s own
              private folder to find it.
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
