import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { wikiPagePath, type WikiPage } from "@/lib/wiki";

type WikiIndexProps = {
  badge: string;
  title: string;
  description: string;
  pages: WikiPage[];
};

function WikiPageList({ pages }: { pages: WikiPage[] }) {
  return (
    <ul className="mt-8 grid gap-3">
      {pages.map((page) => (
        <li key={page.slug}>
          <article className="rounded-2xl bg-surface-raised p-6 sm:p-8">
            <h2 className="font-display text-3xl leading-none tracking-[-0.04em]">
              <Link
                href={wikiPagePath(page.slug)}
                className="transition hover:text-cobalt focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
              >
                {page.frontmatter.title}
              </Link>
            </h2>
            <p className="mt-4 max-w-2xl font-body text-base leading-relaxed text-ink-soft">
              {page.frontmatter.description}
            </p>
            <Link
              href={wikiPagePath(page.slug)}
              className="mt-5 inline-flex min-h-8 items-center gap-1.5 font-mono text-[0.65rem] uppercase tracking-[0.12em] underline decoration-2 underline-offset-4 transition hover:text-cobalt focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
            >
              Read
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </article>
        </li>
      ))}
    </ul>
  );
}

export function WikiIndex({ badge, title, description, pages }: WikiIndexProps) {
  const listed = pages.filter((page) => page.listed !== false);
  const ideaPages = listed.filter((page) => page.collection !== "product");
  const productPages = listed.filter((page) => page.collection === "product");

  return (
    <section className="bg-surface">
      <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
        <Badge variant="clay">{badge}</Badge>
        <h1 className="mt-7 max-w-4xl font-display text-[clamp(3rem,7vw,6rem)] leading-[0.9] tracking-[-0.06em]">
          {title}
        </h1>
        <p className="mt-8 max-w-2xl font-body text-lg leading-relaxed text-ink-soft">
          {description}
        </p>

        {ideaPages.length > 0 ? (
          <div className="mt-14">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.13em] text-ink-soft">
              Ideas
            </h2>
            <WikiPageList pages={ideaPages} />
          </div>
        ) : null}

        {productPages.length > 0 ? (
          <div className="mt-14">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.13em] text-ink-soft">
              Product
            </h2>
            <WikiPageList pages={productPages} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
