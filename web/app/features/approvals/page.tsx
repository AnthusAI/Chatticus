import type { Metadata } from "next";
import { ArrowUpRight, Check, CircleDashed, FlaskConical } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { APPROVALS_PAGE_CONTENT } from "./page-content";

export const metadata: Metadata = {
  title: APPROVALS_PAGE_CONTENT.title,
  description: APPROVALS_PAGE_CONTENT.description,
  alternates: {
    canonical: "/features/approvals",
  },
  openGraph: {
    type: "website",
    url: "/features/approvals",
    title: APPROVALS_PAGE_CONTENT.ogTitle,
    description: APPROVALS_PAGE_CONTENT.ogDescription,
    siteName: "Chatticus",
  },
  twitter: {
    card: "summary_large_image",
    title: APPROVALS_PAGE_CONTENT.ogTitle,
    description: APPROVALS_PAGE_CONTENT.ogDescription,
  },
};

const steps = [
  {
    label: "Proposed, not done",
    title: "An approval controls what's about to happen.",
    body: "It never pretends to undo work that already completed — it stops the consequential step before it happens, not after.",
  },
  {
    label: "Narrow rules, human default",
    title: "A require-approval rule always wins.",
    body: "Auto-review rules can require approval, always allow, or never allow a specific action — but if a require-approval rule and an always-allow rule both match, approval wins. Broad rules like \"allow everything in the browser\" aren't accepted.",
  },
  {
    label: "Locked steps stay locked",
    title: "Passwords and payments hand back to a person.",
    body: "For passwords, two-factor codes, CAPTCHAs, and payments, the computer hands back to a person for that one step, then returns control — nothing sensitive is pasted into a transcript.",
  },
];

const keptBehindApproval = [
  "Sending messages or invitations",
  "Publishing content",
  "Purchases and financial transfers",
  "Deleting or overwriting data",
  "Changing permissions",
  "Production changes",
  "Accepting legal terms",
];

const roadmap = [
  {
    icon: Check,
    label: "Live foundation",
    color: "bg-signal",
    body: "A consequential action reached with no one watching the screen stops on its own or waits on a pre-authorized rule — it never proceeds silently.",
  },
  {
    icon: FlaskConical,
    label: "Proven in development",
    color: "bg-sea",
    body: "Policy checks run at every consequential system sink — the point where an action would actually take effect, not just where it was requested.",
  },
  {
    icon: CircleDashed,
    label: "Shipping next",
    color: "bg-amber",
    body: "Approval cards and human takeover directly in the product app, instead of resolving a hold entirely on the computer's own screen.",
  },
];

export default function ApprovalsPage() {
  return (
    <>
      <Header />
      <main id="main-content">
        <section className="bg-surface">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
            <Badge variant="clay">Consequences stop with a person</Badge>
            <h1 className="mt-7 max-w-4xl font-display text-[clamp(3rem,7vw,6rem)] leading-[0.9] tracking-[-0.06em]">
              Every consequential action
              <span className="block italic text-clay">waits for a person.</span>
            </h1>
            <p className="mt-8 max-w-2xl font-body text-lg leading-relaxed text-ink-soft">
              An office runs on sign-off: someone with authority reviews the
              consequential step before it goes out. Chatticus applies the
              same boundary to every bot in the organization — sending,
              publishing, buying, deleting, and changing permissions all
              pause at an approval a person controls.
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
            <Badge variant="outline">Kept behind approval</Badge>
            <h2 className="mt-7 max-w-xl font-display text-[clamp(2.2rem,4.5vw,3.4rem)] leading-[0.98] tracking-[-0.05em]">
              What always waits for a person
            </h2>
            <ul className="mt-10 grid gap-3 sm:grid-cols-2">
              {keptBehindApproval.map((item) => (
                <li
                  key={item}
                  className="rounded-xl bg-surface-raised px-5 py-4 font-body text-base leading-relaxed"
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="bg-surface-raised">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
            <Badge variant="clay">Product reality</Badge>
            <h2 className="mt-7 max-w-2xl font-display text-[clamp(2.4rem,5vw,4rem)] leading-[0.95] tracking-[-0.05em]">
              What&rsquo;s built. What&rsquo;s proven. What&rsquo;s next.
            </h2>
            <div className="mt-12 grid gap-3 lg:grid-cols-3">
              {roadmap.map((column) => {
                const Icon = column.icon;
                return (
                  <article key={column.label} className="rounded-2xl bg-surface p-6 sm:p-8">
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
              href="/wiki/product#approvals-and-takeover"
            >
              Read the product spec
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
