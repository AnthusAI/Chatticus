import { postPath } from "@/lib/blog";
import { resolveRelatedPosts, type WikiPage } from "@/lib/wiki";
import { MarkdownContent } from "@/components/content/MarkdownContent";
import { RelatedLinksSection } from "@/components/content/RelatedLinksSection";

type WikiPageViewProps = {
  page: WikiPage;
};

export function WikiPageView({ page }: WikiPageViewProps) {
  const relatedPosts = resolveRelatedPosts(page);

  return (
    <article className="bg-surface">
      <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
        <h1 className="max-w-4xl font-display text-[clamp(2.6rem,6vw,4.8rem)] leading-[0.95] tracking-[-0.05em]">
          {page.frontmatter.title}
        </h1>
        <div className="mt-10">
          <MarkdownContent>{page.body}</MarkdownContent>
        </div>
        <RelatedLinksSection
          heading="Related posts"
          links={relatedPosts.map((post) => ({
            href: postPath(post.category, post.slug),
            title: post.frontmatter.title,
          }))}
        />
      </div>
    </article>
  );
}
