import { ArrowDownRight, ArrowUpRight, Github } from "lucide-react";
import { WorkspaceDemo } from "@/components/workspace/WorkspaceDemo";
import { Wordmark } from "@/components/Wordmark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const proof = [
  ["Public source", "Inspect the system"],
  ["3 environments", "Named cloud boundaries"],
  ["1 computer", "Shared by your teammates"],
];

export function Hero() {
  return (
    <section
      id="top"
      aria-labelledby="hero-title"
      className="relative overflow-hidden border-b-2 border-ink"
    >
      <div className="hero-grid absolute inset-0 -z-10 opacity-60" />
      <div className="mx-auto grid max-w-[92rem] items-center gap-12 px-5 py-14 sm:px-8 sm:py-16 lg:grid-cols-[1.08fr_0.92fr] lg:gap-10 lg:px-12 lg:py-20">
        <div className="max-w-[46rem]">
          <Wordmark
            reportsPresenceAsHero
            showText={false}
            size={72}
            className="animate-rise mb-6"
          />
          <Badge variant="outline" className="animate-rise">
            Named teammates · one shared computer
          </Badge>
          <h1
            id="hero-title"
            className="mt-7 font-display text-[clamp(4.2rem,9.2vw,8.8rem)] font-medium leading-[0.79] tracking-[-0.075em] text-ink"
          >
            <span className="block animate-rise [animation-delay:80ms]">
              Build the AI
            </span>
            <span className="block animate-rise [animation-delay:160ms]">
              organization
            </span>
            <span className="relative inline-block animate-rise italic text-clay [animation-delay:240ms]">
              you control.
              <svg
                aria-hidden="true"
                className="absolute -bottom-3 left-0 h-4 w-full text-signal"
                viewBox="0 0 560 24"
                preserveAspectRatio="none"
              >
                <path
                  d="M4 14C123 2 274 23 556 8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          </h1>
          <p className="mt-10 max-w-[42rem] animate-rise font-body text-lg leading-relaxed text-ink-soft [animation-delay:340ms] sm:text-xl">
            Chatticus gives persistent, named AI teammates a computer, memory,
            skills, and routines inside a boundary you own. They work together.
            You set direction and keep the consequential decisions.
          </p>
          <div className="mt-9 flex animate-rise flex-col gap-3 [animation-delay:430ms] sm:flex-row">
            <Button asChild size="lg">
              <a href="https://hey.chattic.us">
                Explore the workspace
                <ArrowUpRight className="h-5 w-5" aria-hidden="true" />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href="https://github.com/AnthusAI/Chattic.us">
                <Github className="h-5 w-5" aria-hidden="true" />
                Read the source
              </a>
            </Button>
          </div>
          <a
            href="#organization"
            className="mt-8 inline-flex min-h-11 items-center gap-2 rounded-full font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-soft transition hover:text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
          >
            See how the team works
            <ArrowDownRight className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>

        <div className="animate-rise self-center [animation-delay:300ms] lg:pl-3">
          <WorkspaceDemo />
        </div>
      </div>

      <div className="border-t border-ink/20 bg-paper-raised">
        <div className="mx-auto grid max-w-[92rem] divide-y divide-ink/[0.15] px-5 sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:px-8 lg:px-12">
          {proof.map(([value, label]) => (
            <div key={value} className="flex items-center gap-4 py-5 sm:px-6 sm:first:pl-0">
              <span className="font-display text-2xl font-semibold tracking-[-0.04em]">
                {value}
              </span>
              <span className="max-w-32 font-mono text-[0.62rem] uppercase leading-relaxed tracking-[0.1em] text-ink-soft">
                {label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
