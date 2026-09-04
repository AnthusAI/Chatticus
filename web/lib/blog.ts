import fs from "fs";
import path from "path";

export type BlogCategory = "updates" | "agent-zoo";

export const BLOG_CATEGORIES: readonly BlogCategory[] = ["updates", "agent-zoo"] as const;

export type BlogPostFrontmatter = {
  title: string;
  date: string;
  description: string;
  ogHeadline: string;
  ogTagline: string;
  draft?: boolean;
  relatedWiki?: string[];
};

export type BlogPost = {
  slug: string;
  category: BlogCategory;
  frontmatter: BlogPostFrontmatter;
  body: string;
};

const blogRoot = (): string => path.join(process.cwd(), "content", "blog");

const CATEGORY_LABELS: Record<BlogCategory, string> = {
  updates: "Updates",
  "agent-zoo": "Agent Zoo",
};

export function categoryLabel(category: BlogCategory): string {
  return CATEGORY_LABELS[category];
}

export function categoryBasePath(category: BlogCategory): string {
  return `/${category}`;
}

export function postPath(category: BlogCategory, slug: string): string {
  return `${categoryBasePath(category)}/${slug}`;
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

export function parseFrontmatter(raw: string): { frontmatter: BlogPostFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("Post is missing YAML frontmatter delimiters");
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

    if (!inlineValue && (key === "relatedWiki" || key === "relatedPosts")) {
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
  const date = String(scalarFields.date ?? "");
  const description = String(scalarFields.description ?? "");
  const ogHeadline = String(scalarFields.ogHeadline ?? "");
  const ogTagline = String(scalarFields.ogTagline ?? "");
  const draft = scalarFields.draft === true;
  const relatedWiki = listFields.relatedWiki ?? [];

  if (!title || !date || !description || !ogHeadline || !ogTagline) {
    throw new Error("Post frontmatter is missing required fields");
  }

  return {
    frontmatter: {
      title,
      date,
      description,
      ogHeadline,
      ogTagline,
      draft,
      relatedWiki: relatedWiki.length > 0 ? relatedWiki : undefined,
    },
    body: body.trim(),
  };
}

function isBlogCategory(value: string): value is BlogCategory {
  return (BLOG_CATEGORIES as readonly string[]).includes(value);
}

function readPostFile(category: BlogCategory, filename: string): BlogPost | null {
  if (!filename.endsWith(".md")) {
    return null;
  }

  const filePath = path.join(blogRoot(), category, filename);
  const raw = fs.readFileSync(filePath, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);

  return {
    slug: filename.replace(/\.md$/, ""),
    category,
    frontmatter,
    body,
  };
}

function sortPostsNewestFirst(posts: BlogPost[]): BlogPost[] {
  return [...posts].sort((left, right) => {
    const leftTime = Date.parse(left.frontmatter.date);
    const rightTime = Date.parse(right.frontmatter.date);
    if (leftTime === rightTime) {
      return right.slug.localeCompare(left.slug);
    }
    return rightTime - leftTime;
  });
}

export function listPosts(category: BlogCategory, options?: { includeDrafts?: boolean }): BlogPost[] {
  const categoryDir = path.join(blogRoot(), category);
  if (!fs.existsSync(categoryDir)) {
    return [];
  }

  const includeDrafts = options?.includeDrafts ?? false;
  const posts = fs
    .readdirSync(categoryDir)
    .map((filename) => readPostFile(category, filename))
    .filter((post): post is BlogPost => post !== null)
    .filter((post) => includeDrafts || !post.frontmatter.draft);

  return sortPostsNewestFirst(posts);
}

export function getPost(category: BlogCategory, slug: string): BlogPost | null {
  const filename = `${slug}.md`;
  const filePath = path.join(blogRoot(), category, filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readPostFile(category, filename);
}

export function listPublishedPosts(): BlogPost[] {
  const posts = BLOG_CATEGORIES.flatMap((category) =>
    listPosts(category, { includeDrafts: false }),
  );
  return sortPostsNewestFirst(posts);
}

export function assertBlogCategory(value: string): BlogCategory {
  if (!isBlogCategory(value)) {
    throw new Error(`Unknown blog category: ${value}`);
  }
  return value;
}

export function formatPostDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}
