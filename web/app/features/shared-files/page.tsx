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
    label: "Talk and think, nothing running",
    title: "A bot can respond with no computer at all.",
    body: "Reasoning and plenty of tools don't need a browser or a desktop underneath them — a bot can act on those the moment it's addressed.",
  },
  {
    label: "Reading needs nothing running",
    title: "A file read serves straight from storage.",
    body: "No host has to be up at all — reading a shared file doesn't wait on a computer to start, let alone on the browser stack inside it. Writing needs a host's disk loaded, but still never waits on the browser.",
  },
  {
    label: "The full computer, only when the work needs it",
    title: "A real browser starts only for work that needs one.",
    body: "A site with no API, a form only a browser can fill — that's what actually pulls in the full computer, the slowest capability to come up. Most work never needs it.",
  },
];

const roadmap = [
  {
    icon: Check,
    label: "Live foundation",
    color: "bg-signal",
    body: "Files in the shared workspace are visible to every bot in the organization today, and reading one is its own capability gate — separate from waiting on the full browser stack.",
  },
  {
    icon: FlaskConical,
    label: "Proven in development",
    color: "bg-sea",
    body: "The same durable snapshot mechanism that reliably starts one shared computer across concurrent turns already carries the files with it, host to host.",
  },
  {
    icon: CircleDashed,
    label: "Shipping next",
    color: "bg-amber",
    body: "A single, organization-wide filing cabinet on EFS — one source of truth every bot and every computer reads and writes directly, instead of each host hydrating its own copy from a snapshot.",
  },
];

export default function SharedFilesPage() {
  return (
    <>
      <Header />
      <main id="main-content">
        <section className="bg-surface">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
            <Badge variant="clay">Three separate things, not one bundle</Badge>
            <h1 className="mt-7 max-w-4xl font-display text-[clamp(3rem,7vw,6rem)] leading-[0.9] tracking-[-0.06em]">
              A bot doesn&rsquo;t need a computer
              <span className="block italic text-clay">to read a file.</span>
            </h1>
            <p className="mt-8 max-w-2xl font-body text-lg leading-relaxed text-ink-soft">
              Talking to a bot, running a computer, and reading a shared file
              are three separate capabilities in Chatticus — they don&rsquo;t
              all boot together as one bundle. All three read and write the
              same filing cabinet: a file one bot saves is already there for
              the next one to read, computer or not.
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
              href="/wiki/computer-manifold"
            >
              Read the design memo
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
