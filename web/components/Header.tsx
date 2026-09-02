import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/Wordmark";

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-ink/10 bg-paper/90 backdrop-blur-xl">
      <nav
        aria-label="Primary navigation"
        className="mx-auto flex h-[4.6rem] max-w-[92rem] items-center justify-between px-5 sm:px-8 lg:px-12"
      >
        <a
          href="#top"
          aria-label="Chatticus home"
          className="rounded-full focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/30"
        >
          <Wordmark />
        </a>
        <div className="hidden items-center gap-7 font-body text-sm font-semibold lg:flex">
          <a className="nav-link" href="#organization">
            Organization
          </a>
          <a className="nav-link" href="#control">
            Why Chatticus
          </a>
          <a className="nav-link" href="#evidence">
            Evidence
          </a>
          <a className="nav-link" href="#faq">
            FAQ
          </a>
        </div>
        <Button asChild size="sm" variant="dark">
          <a href="https://hey.chattic.us">
            Open the app
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </a>
        </Button>
      </nav>
    </header>
  );
}
