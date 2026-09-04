import ReactMarkdown from "react-markdown";
import { categoryLabel, formatPostDate, type BlogPost } from "@/lib/blog";

type BlogPostViewProps = {
  post: BlogPost;
};

export function BlogPostView({ post }: BlogPostViewProps) {
  return (
    <article className="bg-surface">
      <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
        <p className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-ink-soft">
          {categoryLabel(post.category)} · {formatPostDate(post.frontmatter.date)}
        </p>
        <h1 className="mt-5 max-w-4xl font-display text-[clamp(2.6rem,6vw,4.8rem)] leading-[0.95] tracking-[-0.05em]">
          {post.frontmatter.title}
        </h1>
        <div className="prose-chatticus mt-10 max-w-3xl space-y-5 font-body text-lg leading-relaxed text-ink-soft">
          <ReactMarkdown
            components={{
              p: ({ children }) => <p>{children}</p>,
              h2: ({ children }) => (
                <h2 className="font-display text-3xl leading-tight tracking-[-0.04em] text-ink">
                  {children}
                </h2>
              ),
              h3: ({ children }) => (
                <h3 className="font-display text-2xl leading-tight tracking-[-0.04em] text-ink">
                  {children}
                </h3>
              ),
              ul: ({ children }) => <ul className="list-disc space-y-2 pl-6">{children}</ul>,
              ol: ({ children }) => <ol className="list-decimal space-y-2 pl-6">{children}</ol>,
              a: ({ href, children }) => (
                <a
                  href={href}
                  className="font-semibold text-ink underline decoration-2 underline-offset-4 transition hover:text-cobalt"
                >
                  {children}
                </a>
              ),
              code: ({ children }) => (
                <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[0.9em] text-ink">
                  {children}
                </code>
              ),
            }}
          >
            {post.body}
          </ReactMarkdown>
        </div>
      </div>
    </article>
  );
}
