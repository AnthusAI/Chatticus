import fs from "fs";
import path from "path";
import { getPost, type BlogCategory, type BlogPost } from "@/lib/blog";

export type WikiPageFrontmatter = {
  title: string;
  description: string;
  ogHeadline: string;
  ogTagline: string;
  draft?: boolean;
  relatedPosts?: string[];
};

export type WikiPage = {
  slug: string;
  frontmatter: WikiPageFrontmatter;
  body: string;
};

const wikiRoot = (): string => path.join(process.cwd(), "content", "wiki");

const BLOG_CATEGORIES: readonly BlogCategory[] = ["updates", "agent-zoo"] as const;

function isBlogCategory(value: string): value is BlogCategory {
  return (BLOG_CATEGORIES as readonly string[]).includes(value);
}

function parseYamlListBlock(
  lines: string[],
  startIndex: number,
): { items: string[]; nextIndex: number } {
  const items: string[] = [];
  let index = startIndex + 1;

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (!trimmed.startsWith("- ")) {
      break;
    }

    let value = trimmed.slice(2).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    items.push(value);
    index += 1;
  }

  return { items, nextIndex: index };
}

export function parseFrontmatter(raw: string): { frontmatter: WikiPageFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("Wiki page is missing YAML frontmatter delimiters");
  }

  const [, yamlBlock, body] = match;
  const lines = yamlBlock.split(/\r?\n/);
  const scalarFields: Record<string, string | boolean> = {};
  const listFields: Record<string, string[]> = {};

  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      index += 1;
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const inlineValue = trimmed.slice(separator + 1).trim();

    if (!inlineValue && (key === "relatedPosts" || key === "relatedWiki")) {
      const parsedList = parseYamlListBlock(lines, index);
      listFields[key] = parsedList.items;
      index = parsedList.nextIndex;
      continue;
    }

    let value = inlineValue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value === "true") {
      scalarFields[key] = true;
    } else if (value === "false") {
      scalarFields[key] = false;
    } else {
      scalarFields[key] = value;
    }
    index += 1;
  }

  const title = String(scalarFields.title ?? "");
  const description = String(scalarFields.description ?? "");
  const ogHeadline = String(scalarFields.ogHeadline ?? "");
  const ogTagline = String(scalarFields.ogTagline ?? "");
  const draft = scalarFields.draft === true;
  const relatedPosts = listFields.relatedPosts ?? [];

  if (!title || !description || !ogHeadline || !ogTagline) {
    throw new Error("Wiki page frontmatter is missing required fields");
  }

  return {
    frontmatter: {
      title,
      description,
      ogHeadline,
      ogTagline,
      draft,
      relatedPosts: relatedPosts.length > 0 ? relatedPosts : undefined,
    },
    body: body.trim(),
  };
}

function readPageFile(filename: string): WikiPage | null {
  if (!filename.endsWith(".md") || filename === "AGENTS.md") {
    return null;
  }

  const filePath = path.join(wikiRoot(), filename);
  const raw = fs.readFileSync(filePath, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);

  return {
    slug: filename.replace(/\.md$/, ""),
    frontmatter,
    body,
  };
}

function sortPagesAlphabetically(pages: WikiPage[]): WikiPage[] {
  return [...pages].sort((left, right) => left.slug.localeCompare(right.slug));
}

export function wikiPagePath(slug: string): string {
  return `/wiki/${slug}`;
}

export function listPages(options?: { includeDrafts?: boolean }): WikiPage[] {
  const root = wikiRoot();
  if (!fs.existsSync(root)) {
    return [];
  }

  const includeDrafts = options?.includeDrafts ?? false;
  const pages = fs
    .readdirSync(root)
    .map((filename) => readPageFile(filename))
    .filter((page): page is WikiPage => page !== null)
    .filter((page) => includeDrafts || !page.frontmatter.draft);

  return sortPagesAlphabetically(pages);
}

export function getPage(slug: string): WikiPage | null {
  const filename = `${slug}.md`;
  const filePath = path.join(wikiRoot(), filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readPageFile(filename);
}

export function resolveRelatedPosts(page: WikiPage): BlogPost[] {
  const refs = page.frontmatter.relatedPosts ?? [];
  const posts: BlogPost[] = [];

  for (const ref of refs) {
    const slashIndex = ref.indexOf("/");
    if (slashIndex === -1) {
      continue;
    }

    const category = ref.slice(0, slashIndex);
    const postSlug = ref.slice(slashIndex + 1);
    if (!postSlug || !isBlogCategory(category)) {
      continue;
    }

    const post = getPost(category, postSlug);
    if (post && !post.frontmatter.draft) {
      posts.push(post);
    }
  }

  return posts;
}

export function resolveRelatedWiki(post: BlogPost): WikiPage[] {
  const slugs = post.frontmatter.relatedWiki ?? [];
  const pages: WikiPage[] = [];

  for (const slug of slugs) {
    const page = getPage(slug);
    if (page && !page.frontmatter.draft) {
      pages.push(page);
    }
  }

  return pages;
}
