"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MARKETING_NAV_LINKS } from "@/lib/marketing-nav";

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function closeMenu() {
    setOpen(false);
  }

  return (
    <div className="relative lg:hidden">
      <button
        ref={toggleRef}
        type="button"
        className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface-raised text-ink transition hover:bg-surface-high focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/30"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <X className="h-5 w-5" aria-hidden="true" />
        ) : (
          <Menu className="h-5 w-5" aria-hidden="true" />
        )}
      </button>
      {open ? (
        <nav
          id={panelId}
          aria-label="Mobile navigation"
          className="absolute right-0 top-[calc(100%+0.75rem)] z-50 w-[min(18rem,calc(100vw-2.5rem))] rounded-2xl bg-surface-raised p-4 shadow-[4px_4px_0_var(--ink)]"
        >
          <ul className="space-y-1">
            {MARKETING_NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="nav-link block rounded-xl px-3 py-2.5 font-body text-sm font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/30"
                  onClick={closeMenu}
                >
                  {link.label}
                </Link>
              </li>
            ))}
            <li className="pt-2 sm:hidden">
              <Button asChild size="sm" variant="outline" className="w-full">
                <Link href="/beta" onClick={closeMenu}>
                  Join the beta
                </Link>
              </Button>
            </li>
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
