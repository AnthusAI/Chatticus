import type { Metadata } from "next";
import { ArrowUpRight, Check, CircleDashed, FlaskConical } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { FLEXIBLE_COMPUTE_PAGE_CONTENT } from "./page-content";

export const metadata: Metadata = {
  title: FLEXIBLE_COMPUTE_PAGE_CONTENT.title,
  description: FLEXIBLE_COMPUTE_PAGE_CONTENT.description,
  alternates: {
    canonical: "/features/flexible-compute",
  },
  openGraph: {
    type: "website",
    url: "/features/flexible-compute",
    title: FLEXIBLE_COMPUTE_PAGE_CONTENT.ogTitle,
    description: FLEXIBLE_COMPUTE_PAGE_CONTENT.ogDescription,
    siteName: "Chatticus",
  },
  twitter: {
    card: "summary_large_image",
    title: FLEXIBLE_COMPUTE_PAGE_CONTENT.ogTitle,
    description: FLEXIBLE_COMPUTE_PAGE_CONTENT.ogDescription,
  },
};

const steps = [
  {
    label: "One identity, more than one possible host",
    title: "A computer is a workplace, not a machine.",
    body: "The workplace identity is what's durable. It can run on a scale-to-zero container today or on hardware you already own — same files, same sessions, either way.",
  },
  {
    label: "Async work gets its own short-lived container",
    title: "Background work doesn't sit on a dedicated machine.",
    body: "A routine or background task summons a container just for that job, does the work, publishes the result, and exits — nothing idles per bot waiting for the next task.",
  },
  {
    label: "Heavier work, when it's actually heavier",
    title: "The container fits the task, not the other way around.",
    body: "Most work runs light. Work that genuinely needs more — a bigger instance, a full desktop — is meant to ask for that by name, not force every task onto the same fixed shape.",
  },
];

const roadmap = [
  {
    icon: Check,
    label: "Live foundation",
    color: "bg-signal",
    body: "A computer is a workplace identity, not one fixed machine — it runs on a scale-to-zero container today, or on hardware you already own, with the same durable files either way.",
  },
  {
    icon: FlaskConical,
    label: "Proven in development",
    color: "bg-sea",
    body: "Background work already summons its own short-lived container, does the job, and publishes — no dedicated machine sits around per bot waiting for the next task.",
  },
  {
    icon: CircleDashed,
    label: "Shipping next",
    color: "bg-amber",
    body: "Bigger instances and full desktop sessions as host shapes a task can ask for by name, chosen automatically for the work instead of configured by hand.",
  },
];

export default function FlexibleComputePage() {
  return (
    <>
      <Header />
      <main id="main-content">
        <section className="bg-surface">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
            <Badge variant="clay">Not one fixed machine for everyone</Badge>
            <h1 className="mt-7 max-w-4xl font-display text-[clamp(3rem,7vw,6rem)] leading-[0.9] tracking-[-0.06em]">
              The files are shared.
              <span className="block italic text-clay">The compute isn&rsquo;t fixed.</span>
            </h1>
            <p className="mt-8 max-w-2xl font-body text-lg leading-relaxed text-ink-soft">
              Some systems give every bot the same single computer with a
              different view onto it. Chatticus keeps the files constant —
              one shared filing cabinet every bot reads and writes — and
              lets the compute underneath vary: a light container for most
              work, something heavier for work that actually needs it,
              picked per task instead of fixed for the whole team.
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
            <Link
              className="mt-12 inline-flex min-h-11 items-center gap-2 font-mono text-[0.65rem] uppercase tracking-[0.12em] underline decoration-2 underline-offset-4 transition hover:text-cobalt focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
              href="/wiki/computer-manifold"
            >
              Read the design memo
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
