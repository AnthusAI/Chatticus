import { ArrowUpRight, Github } from "lucide-react";
import { WorkspaceDemo } from "@/components/workspace/WorkspaceDemo";
import { Wordmark } from "@/components/Wordmark";
import { Button } from "@/components/ui/button";

const proof = [
  ["24/7", "Runs around the clock"],
  ["1 shared computer", "No clones. No silos."],
  ["0% lock-in", "Your data. Your move."],
];

export function Hero() {
  return (
    <section
      id="top"
      aria-labelledby="hero-title"
      className="relative overflow-hidden"
    >
      <div className="hero-grid absolute inset-0 -z-10 opacity-60" />
      <div className="mx-auto grid max-w-[92rem] items-center gap-12 px-5 py-14 sm:px-8 sm:py-16 lg:grid-cols-[1.35fr_0.65fr] lg:gap-10 lg:px-12 lg:py-20">
        <div className="flex max-w-[64rem] flex-col items-start gap-4 sm:flex-row">
          <Wordmark
            reportsPresenceAsHero
            showText={false}
            size={140}
            className="-mt-[29px] shrink-0"
          />
          <div className="min-w-0">
            <h1
              id="hero-title"
              className="animate-rise font-display text-[clamp(3.4rem,7.6vw,7.2rem)] font-medium leading-[0.82] tracking-[-0.075em]"
            >
              Shared spaces for{" "}
              <span className="italic text-clay">
                people <span className="text-surface-foreground">and</span>{" "}
                <span className="relative inline-block">
                  bots.
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
              </span>
            </h1>
            <p className="mt-10 max-w-[42rem] animate-rise font-body text-lg leading-relaxed text-ink-soft [animation-delay:340ms] sm:text-xl">
              Chatticus is{" "}
              <span className="animate-highlight-sweep bg-[image:linear-gradient(var(--signal),var(--signal))] bg-[position:0_88%] bg-no-repeat px-0.5 [animation-delay:2200ms]">
                a shared, collaborative space
              </span>{" "}
              where people and bots work together around common files, tools,
              and a system of authority and approvals —{" "}
              <span className="animate-highlight-sweep bg-[image:linear-gradient(var(--signal),var(--signal))] bg-[position:0_88%] bg-no-repeat px-0.5 [animation-delay:4200ms]">
                like an office, not a chat window
              </span>
              . It&rsquo;s a 24/7 agent farm you can use to grow whatever you
              want, around the clock.
            </p>
            <div className="mt-9 flex animate-rise flex-col gap-3 [animation-delay:430ms] sm:flex-row">
              <Button asChild size="lg">
                <a href="/chat">
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
          </div>
        </div>

        <div className="animate-rise self-center [animation-delay:300ms] lg:pl-3">
          <WorkspaceDemo />
        </div>
      </div>

      <div className="bg-surface-raised">
        <div className="mx-auto grid max-w-[92rem] gap-2 px-5 py-3 sm:px-8 lg:grid-cols-3 lg:px-12">
          {proof.map(([value, label]) => (
            <div key={value} className="flex items-center gap-4 rounded-2xl bg-surface-high px-4 py-4 sm:px-6">
              <span className="font-display text-2xl font-semibold tracking-[-0.04em]">
                {value}
              </span>
              <span className="font-mono text-[0.62rem] uppercase leading-relaxed tracking-[0.1em] text-ink-soft">
                {label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
