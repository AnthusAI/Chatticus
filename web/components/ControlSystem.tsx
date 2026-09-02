import {
  AlarmClock,
  BookOpenCheck,
  CircleCheckBig,
  Hand,
  Play,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

const concepts = [
  {
    icon: Wrench,
    label: "Skill",
    title: "Teach the method once.",
    body: "A skill records how to do reliable work: inputs, access, sequence, validation, and approval boundaries.",
    note: "Reusable instructions",
  },
  {
    icon: AlarmClock,
    label: "Routine",
    title: "Wake it when it matters.",
    body: "A routine gives one teammate a schedule or event trigger, a time zone, and a clear no-data policy.",
    note: "Scheduled or event-driven",
  },
  {
    icon: BookOpenCheck,
    label: "Review",
    title: "Evidence travels with the work.",
    body: "Reviewers can inspect results, tests, and provenance before the task moves forward or returns for repair.",
    note: "Quality before motion",
  },
  {
    icon: Hand,
    label: "Approval",
    title: "A proposal waits for a person.",
    body: "Consequential actions pause before they happen. Approval controls the proposed action; it never pretends to undo completed work.",
    note: "Human consequence boundary",
  },
];

export function ControlSystem() {
  return (
    <section
      id="control"
      aria-labelledby="control-title"
      className="relative overflow-hidden bg-surface"
    >
      <div className="mx-auto max-w-[92rem] px-5 py-24 sm:px-8 sm:py-32 lg:px-12">
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <Badge variant="clay">Control is the product</Badge>
            <p className="mt-8 max-w-lg font-body text-lg leading-relaxed text-ink-soft">
              Any model can talk. What&rsquo;s missing is discipline: who did
              what, on whose authority, and what happens when it&rsquo;s wrong.
              Chatticus gives the organization rules for method, timing,
              quality, and consequence.
            </p>
          </div>
          <h2
            id="control-title"
            className="font-display text-[clamp(3.6rem,7vw,7.2rem)] leading-[0.87] tracking-[-0.065em]"
          >
            Four different controls.
            <span className="block italic text-clay">None of them are chat.</span>
          </h2>
        </div>

        <div className="mt-16 grid gap-3">
          {concepts.map((concept, index) => {
            const Icon = concept.icon;
            return (
              <article
                key={concept.label}
                className="group grid gap-7 rounded-2xl bg-surface-raised p-6 transition-colors hover:bg-signal/20 sm:p-8 lg:grid-cols-[7rem_1fr_1.1fr_auto] lg:items-center"
              >
                <div className="flex items-center justify-between lg:block">
                  <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-clay">
                    0{index + 1}
                  </span>
                  <Icon className="mt-0 h-6 w-6 lg:mt-12" aria-hidden="true" />
                </div>
                <div>
                  <p className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-ink-soft">
                    {concept.label}
                  </p>
                  <h3 className="mt-3 font-display text-3xl leading-none tracking-[-0.045em] sm:text-4xl">
                    {concept.title}
                  </h3>
                </div>
                <p className="max-w-xl font-body text-base leading-relaxed text-ink-soft">
                  {concept.body}
                </p>
                <span className="inline-flex w-fit items-center gap-2 rounded-full bg-surface-high px-3 py-2 font-mono text-[0.58rem] uppercase tracking-[0.1em]">
                  {index === 3 ? (
                    <CircleCheckBig className="h-3.5 w-3.5 text-clay" aria-hidden="true" />
                  ) : (
                    <Play className="h-3.5 w-3.5 text-cobalt" aria-hidden="true" />
                  )}
                  {concept.note}
                </span>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
