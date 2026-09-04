import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

export type RelatedLinkItem = {
  href: string;
  title: string;
};

type RelatedLinksSectionProps = {
  heading: string;
  links: RelatedLinkItem[];
};

export function RelatedLinksSection({ heading, links }: RelatedLinksSectionProps) {
  if (links.length === 0) {
    return null;
  }

  return (
    <section className="mt-14 max-w-3xl">
      <h2 className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-ink-soft">
        {heading}
      </h2>
      <ul className="mt-5 grid gap-3">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="flex min-h-12 items-center justify-between gap-4 rounded-2xl bg-surface-raised p-5 font-display text-xl leading-tight tracking-[-0.03em] transition hover:text-cobalt focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25 sm:p-6"
            >
              <span>{link.title}</span>
              <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
