import { ArrowUpRight, Check, CircleDashed, FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const columns = [
  {
    icon: Check,
    label: "Live foundation",
    color: "bg-signal",
    items: [
      "Durable named bot records and memory",
      "Turn-scoped progress over server-sent events",
      "Household tasks and turn journals",
      "Development, staging, and production boundaries",
    ],
  },
  {
    icon: FlaskConical,
    label: "Proven in development",
    color: "bg-sea",
    items: [
      "Computerless turns that escalate on first computer use",
      "One shared computer start across concurrent turns",
      "Durable handoff and recovery across worker failure",
      "Policy checks at consequential system sinks",
    ],
  },
  {
    icon: CircleDashed,
    label: "Designed next",
    color: "bg-amber",
    items: [
      "A complete skills and routines authoring surface",
      "Approval cards and human takeover in the product app",
      "Role and reporting-line controls for named teammates",
      "A polished computer preview and work history",
    ],
  },
];

const reading = [
  {
    title: "Grok Bot Gave My Coding Agents a Boss",
    href: "https://anth.us/blog/grok-bot-gave-my-coding-agents-a-boss/",
  },
  {
    title: "From pair programmer to executive",
    href: "https://anth.us/blog/from-pair-programmer-to-executive/",
  },
  {
    title: "The Year Coding Became a Commodity",
    href: "https://anth.us/blog/ai-coding-cost-collapse-2026/",
  },
  {
    title: "Maximize Value, Not Intelligence",
    href: "https://anth.us/blog/maximize-value-not-intelligence/",
  },
];

export function RealityLedger() {
  return (
    <section aria-labelledby="ledger-title" className="bg-paper-raised">
      <div className="mx-auto max-w-[92rem] px-5 py-24 sm:px-8 sm:py-32 lg:px-12">
        <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:items-end">
          <div>
            <Badge variant="outline">Product reality</Badge>
            <h2
              id="ledger-title"
              className="mt-7 font-display text-[clamp(3.7rem,7vw,7rem)] leading-[0.86] tracking-[-0.065em]"
            >
              The roadmap is not a testimonial.
            </h2>
          </div>
          <p className="max-w-2xl font-body text-lg leading-relaxed text-ink-soft lg:justify-self-end">
            Chatticus is under active development. This ledger separates the
            foundation that is live, behavior proven in the development system,
            and the product experience still being designed.
          </p>
        </div>

        <div className="mt-16 grid border-l-2 border-t-2 border-ink lg:grid-cols-3">
          {columns.map((column) => {
            const Icon = column.icon;
            return (
              <article
                key={column.label}
                className="border-b-2 border-r-2 border-ink bg-paper p-6 sm:p-8"
              >
                <div className="flex items-center justify-between gap-4">
                  <span className="font-mono text-[0.67rem] uppercase tracking-[0.13em]">
                    {column.label}
                  </span>
                  <span
                    className={`flex h-10 w-10 items-center justify-center rounded-full border border-ink ${column.color}`}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                </div>
                <ul className="mt-16 space-y-0">
                  {column.items.map((item) => (
                    <li
                      key={item}
                      className="border-t border-ink/20 py-4 font-body text-sm leading-relaxed text-ink-soft first:border-t-2 first:border-ink"
                    >
                      {item}
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>

        <div className="mt-20 grid gap-10 border-t-2 border-ink pt-10 lg:grid-cols-[0.7fr_1.3fr]">
          <div>
            <p className="font-mono text-[0.68rem] uppercase tracking-[0.14em] text-ink-soft">
              The thinking behind Chatticus
            </p>
            <p className="mt-5 max-w-sm font-display text-3xl leading-tight tracking-[-0.04em]">
              Why organization, ownership, and attention matter more than one
              more model benchmark.
            </p>
          </div>
          <div className="border-t border-ink">
            {reading.map((item) => (
              <a
                key={item.title}
                className="group flex min-h-16 items-center justify-between gap-5 border-b border-ink py-4 font-display text-xl tracking-[-0.025em] transition hover:bg-signal/30 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25 sm:text-2xl"
                href={item.href}
              >
                {item.title}
                <ArrowUpRight
                  className="h-5 w-5 shrink-0 transition-transform group-hover:-translate-y-1 group-hover:translate-x-1"
                  aria-hidden="true"
                />
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
