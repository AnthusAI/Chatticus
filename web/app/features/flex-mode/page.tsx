import type { Metadata } from "next";
import { ArrowUpRight, Check, CircleDashed, FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { FLEX_MODE_PAGE_CONTENT } from "./page-content";

export const metadata: Metadata = {
  title: FLEX_MODE_PAGE_CONTENT.title,
  description: FLEX_MODE_PAGE_CONTENT.description,
  alternates: {
    canonical: "/features/flex-mode",
  },
  openGraph: {
    type: "website",
    url: "/features/flex-mode",
    title: FLEX_MODE_PAGE_CONTENT.ogTitle,
    description: FLEX_MODE_PAGE_CONTENT.ogDescription,
    siteName: "Chatticus",
  },
  twitter: {
    card: "summary_large_image",
    title: FLEX_MODE_PAGE_CONTENT.ogTitle,
    description: FLEX_MODE_PAGE_CONTENT.ogDescription,
  },
};

const steps = [
  {
    label: "Triggered",
    title: "A routine kicks off with no one waiting.",
    body: "A scheduled task or event trigger starts the work. There's no chat window open and no spinner — nobody's staring at the first token.",
  },
  {
    label: "Queued with patience",
    title: "If the deadline allows it, it waits in the cheap lane.",
    body: "The same request goes out on OpenAI or Anthropic's Batch or Flex lane instead of the interactive one — slower to start, priced for patience.",
  },
  {
    label: "Delivered on schedule",
    title: "The result lands before the deadline.",
    body: "Same model, same prompt, same tools — just paid for like scheduled work instead of a live conversation.",
  },
];

const roadmap = [
  {
    icon: Check,
    label: "Live foundation",
    color: "bg-signal",
    body: "A named teammate's background work already runs asynchronously — turns move through queues and journals with server-sent progress, not a live socket waiting on a reply.",
  },
  {
    icon: FlaskConical,
    label: "Proven in the memo",
    color: "bg-sea",
    body: "The cost math and provider facts — OpenAI and Anthropic's Batch pricing, rate limits, and completion windows, checked against their current docs and worked through with real numbers.",
  },
  {
    icon: CircleDashed,
    label: "Shipping next",
    color: "bg-amber",
    body: "The scheduler that actually decides, per task, whether there's enough slack before the deadline to route it through Batch or Flex instead of the interactive API.",
  },
];

export default function FlexModePage() {
  return (
    <>
      <Header />
      <main id="main-content">
        <section className="bg-surface">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
            <Badge variant="clay">How the bill works</Badge>
            <h1 className="mt-7 max-w-4xl font-display text-[clamp(3rem,7vw,6rem)] leading-[0.9] tracking-[-0.06em]">
              Your bots don&rsquo;t need to be fast.
              <span className="block italic text-clay">They need to be cheap and right.</span>
            </h1>
            <p className="mt-8 max-w-2xl font-body text-lg leading-relaxed text-ink-soft">
              A named teammate&rsquo;s scheduled and background work isn&rsquo;t
              like chat — nobody&rsquo;s watching it happen. Flex Mode is how
              Chatticus is being built to notice that difference and spend it:
              work that isn&rsquo;t due for hours or days can run through a
              slower, cheaper lane on the exact same model, instead of paying
              for interactive speed it doesn&rsquo;t need.
            </p>
          </div>
        </section>

        <section className="bg-ink text-paper">
          <div className="mx-auto max-w-[92rem] px-5 py-16 sm:px-8 lg:px-12">
            <p className="max-w-3xl font-display text-3xl italic leading-snug tracking-[-0.03em] sm:text-4xl">
              &ldquo;Do not replace the model with a cheaper brain. Give the
              same brain more time.&rdquo;
            </p>
            <p className="mt-5 font-mono text-[0.62rem] uppercase tracking-[0.14em] text-paper/60">
              From the design memo — see the full argument below
            </p>
          </div>
        </section>

        <section className="bg-surface">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
            <h2 className="max-w-2xl font-display text-[clamp(2.4rem,5vw,4rem)] leading-[0.95] tracking-[-0.05em]">
              How it works
            </h2>
            <div className="mt-12 grid gap-3">
              {steps.map((step, index) => (
                <article
                  key={step.label}
                  className="grid gap-5 rounded-2xl bg-surface-raised p-6 sm:p-8 lg:grid-cols-[6rem_1fr_1.3fr] lg:items-center"
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

        <section className="bg-surface-raised">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
            <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
              <div>
                <Badge variant="outline">The two numbers</Badge>
                <h2 className="mt-7 max-w-lg font-display text-[clamp(2.2rem,4.5vw,3.4rem)] leading-[0.98] tracking-[-0.05em]">
                  What this actually saves
                </h2>
              </div>
              <div className="max-w-xl">
                <p className="font-body text-base leading-relaxed text-ink-soft">
                  OpenAI and Anthropic both discount their Batch and Flex
                  lanes by about 50% — but that&rsquo;s 50% off eligible
                  <em> token spend specifically</em>, not 50% off the whole
                  bot farm&rsquo;s bill. Total savings depend on how much of
                  your spend is inference in the first place, and how much of
                  that inference can actually wait.
                </p>
                <div className="mt-6 rounded-2xl bg-surface p-6 sm:p-7">
                  <p className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-ink-soft">
                    A worked example
                  </p>
                  <p className="mt-3 font-display text-2xl leading-tight tracking-[-0.03em] sm:text-3xl">
                    60% inference × 70% eligible × 50% off = 21% total savings.
                  </p>
                  <p className="mt-4 font-body text-sm leading-relaxed text-ink-soft">
                    Still real money — just not the number you&rsquo;d get by
                    rounding &ldquo;up to 50% off&rdquo; and applying it to
                    the whole bill.
                  </p>
                </div>
              </div>
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
              href="/wiki/cost-vs-sla"
            >
              Read the full argument
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
