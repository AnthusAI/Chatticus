import { categoryLabel, formatPostDate, type BlogPost } from "@/lib/blog";
import { resolveRelatedWiki } from "@/lib/wiki";
import { MarkdownContent } from "@/components/content/MarkdownContent";
import { RelatedLinksSection } from "@/components/content/RelatedLinksSection";

type BlogPostViewProps = {
  post: BlogPost;
};

export function BlogPostView({ post }: BlogPostViewProps) {
  const relatedWikiPages = resolveRelatedWiki(post);

  return (
    <article className="bg-surface">
      <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
        <p className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-ink-soft">
          {categoryLabel(post.category)} · {formatPostDate(post.frontmatter.date)}
        </p>
        <h1 className="mt-5 max-w-4xl font-display text-[clamp(2.6rem,6vw,4.8rem)] leading-[0.95] tracking-[-0.05em]">
          {post.frontmatter.title}
        </h1>
        <div className="mt-10">
          <MarkdownContent>{post.body}</MarkdownContent>
        </div>
        <RelatedLinksSection
          heading="Related wiki"
          links={relatedWikiPages.map((page) => ({
            href: `/wiki/${page.slug}`,
            title: page.frontmatter.title,
          }))}
        />
      </div>
    </article>
  );
}
