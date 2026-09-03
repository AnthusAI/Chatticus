import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/Wordmark";

export function Header() {
  return (
    <header className="sticky top-0 z-50 bg-surface/90 backdrop-blur-xl">
      <nav
        aria-label="Primary navigation"
        className="mx-auto flex h-[4.6rem] max-w-[92rem] items-center justify-between px-5 sm:px-8 lg:px-12"
      >
        <a
          href="/#top"
          aria-label="Chatticus home"
          className="rounded-full focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/30"
        >
          <Wordmark animated="auto" iconPosition="end" />
        </a>
        <div className="hidden items-center gap-7 font-body text-sm font-semibold lg:flex">
          <a className="nav-link" href="/#organization">
            Organization
          </a>
          <a className="nav-link" href="/#control">
            Why Chatticus
          </a>
          <a className="nav-link" href="/#evidence">
            Evidence
          </a>
          <a className="nav-link" href="/#faq">
            FAQ
          </a>
        </div>
        <div className="flex items-center gap-3">
          <Button asChild size="sm" variant="outline" className="hidden sm:inline-flex">
            <a href="/beta">Join the beta</a>
          </Button>
          {/* Shaped and colored like the logo mark's backdrop bubble (CHATTICUS_MARK_MODEL's shadow bubble: 8/8/1.85/8 corner radii, --surface-2 fill). */}
          <Button
            asChild
            size="sm"
            variant="dark"
            className="rounded-[22px_22px_5px_22px] bg-[var(--mark-shadow)] text-surface-foreground hover:bg-cobalt hover:text-white"
          >
            <a href="/chat">
              Hey, Chatticus...
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
        </div>
      </nav>
    </header>
  );
}
