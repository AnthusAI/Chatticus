import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatPostDate, postPath, type BlogCategory, type BlogPost } from "@/lib/blog";

type BlogIndexProps = {
  category: BlogCategory;
  badge: string;
  title: ReactNode;
  description: string;
  crossLink: {
    label: string;
    href: string;
    blurb: string;
  };
  posts: BlogPost[];
};

export function BlogIndex({
  category,
  badge,
  title,
  description,
  crossLink,
  posts,
}: BlogIndexProps) {
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
        <p className="mt-6 max-w-2xl font-body text-base leading-relaxed text-ink-soft">
          {crossLink.blurb}{" "}
          <Link
            href={crossLink.href}
            className="inline-flex min-h-8 items-center gap-1.5 font-semibold text-ink underline decoration-2 underline-offset-4 transition hover:text-cobalt focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
          >
            {crossLink.label}
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </p>

        {posts.length > 0 ? (
          <ul className="mt-14 grid gap-3">
            {posts.map((post) => (
              <li key={post.slug}>
                <article className="rounded-2xl bg-surface-raised p-6 sm:p-8">
                  <p className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-ink-soft">
                    {formatPostDate(post.frontmatter.date)}
                  </p>
                  <h2 className="mt-3 font-display text-3xl leading-none tracking-[-0.04em]">
                    <Link
                      href={postPath(category, post.slug)}
                      className="transition hover:text-cobalt focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
                    >
                      {post.frontmatter.title}
                    </Link>
                  </h2>
                  <p className="mt-4 max-w-2xl font-body text-base leading-relaxed text-ink-soft">
                    {post.frontmatter.description}
                  </p>
                  <Link
                    href={postPath(category, post.slug)}
                    className="mt-5 inline-flex min-h-8 items-center gap-1.5 font-mono text-[0.65rem] uppercase tracking-[0.12em] underline decoration-2 underline-offset-4 transition hover:text-cobalt focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
                  >
                    Read
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </article>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
