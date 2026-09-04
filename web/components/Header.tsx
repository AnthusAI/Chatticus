import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { MobileNav } from "@/components/MobileNav";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/Wordmark";
import { MARKETING_NAV_LINKS } from "@/lib/marketing-nav";

export function Header() {
  return (
    <header className="sticky top-0 z-50 bg-surface/90 backdrop-blur-xl">
      <nav
        aria-label="Primary navigation"
        className="relative mx-auto flex h-[4.6rem] max-w-[92rem] items-center justify-between px-5 sm:px-8 lg:px-12"
      >
        <Link
          href="/#top"
          aria-label="Chatticus home"
          className="rounded-full focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/30"
        >
          <Wordmark animated="auto" iconPosition="end" />
        </Link>
        <div className="hidden items-center gap-7 font-body text-sm font-semibold lg:flex">
          {MARKETING_NAV_LINKS.map((link) => (
            <Link key={link.href} className="nav-link" href={link.href}>
              {link.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Button asChild size="sm" variant="outline" className="hidden sm:inline-flex">
            <a href="/beta">Join the beta</a>
          </Button>
          <MobileNav />
          <Button
            asChild
            size="sm"
            variant="dark"
            className="rounded-[22px_22px_5px_22px] bg-[var(--mark-shadow)] text-surface-foreground hover:bg-cobalt hover:text-white"
          >
            <a href="/chat">
              Sign in
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
        </div>
      </nav>
    </header>
  );
}
