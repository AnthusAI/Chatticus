import { ArrowUpRight, Github } from "lucide-react";
import { Wordmark } from "@/components/Wordmark";
import { Button } from "@/components/ui/button";

export function FinalCta() {
  return (
    <section aria-labelledby="final-cta-title" className="bg-signal p-3 sm:p-5">
      <div className="relative overflow-hidden rounded-[1.8rem] bg-ink px-5 py-20 text-paper sm:px-10 sm:py-24 lg:px-16 lg:py-28">
        <div className="final-cta-orbit absolute -right-16 -top-20 h-80 w-80 rounded-full border border-signal/30" />
        <div className="final-cta-orbit absolute -bottom-44 -left-20 h-96 w-96 rounded-full border border-clay/40 [animation-delay:-2s]" />
        <div className="relative mx-auto max-w-[82rem]">
          <Wordmark inverse />
          <h2
            id="final-cta-title"
            className="mt-14 max-w-6xl font-display text-[clamp(4.2rem,9vw,9rem)] leading-[0.8] tracking-[-0.075em]"
          >
            Give people and bots
            <span className="block italic text-signal">a room of their own.</span>
          </h2>
          <p className="mt-9 max-w-2xl font-body text-lg leading-relaxed text-paper/[0.68] sm:text-xl">
            Meet the current product workspace, or inspect the source and help
            shape what Chatticus becomes.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg">
              <a href="/chat">
                Open the product
                <ArrowUpRight className="h-5 w-5" aria-hidden="true" />
              </a>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="bg-paper/[0.12] text-paper hover:bg-paper hover:text-ink"
            >
              <a href="https://github.com/AnthusAI/Chattic.us">
                <Github className="h-5 w-5" aria-hidden="true" />
                Follow development
              </a>
            </Button>
          </div>
          <div className="mt-16 flex flex-wrap gap-x-8 gap-y-3 rounded-2xl bg-paper/[0.06] px-5 py-4 font-mono text-[0.64rem] uppercase tracking-[0.12em] text-paper/[0.55]">
            <span>Open source</span>
            <span>Your infrastructure</span>
            <span>Human approval boundaries</span>
            <span>No invented metrics</span>
          </div>
        </div>
      </div>
    </section>
  );
}
