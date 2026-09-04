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

export function parseFrontmatter(raw: string): { frontmatter: BlogPostFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("Post is missing YAML frontmatter delimiters");
  }

  const [, yamlBlock, body] = match;
  const frontmatter: Record<string, string | boolean> = {};

  for (const line of yamlBlock.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === "true") {
      frontmatter[key] = true;
    } else if (value === "false") {
      frontmatter[key] = false;
    } else {
      frontmatter[key] = value;
    }
  }

  const title = String(frontmatter.title ?? "");
  const date = String(frontmatter.date ?? "");
  const description = String(frontmatter.description ?? "");
  const ogHeadline = String(frontmatter.ogHeadline ?? "");
  const ogTagline = String(frontmatter.ogTagline ?? "");
  const draft = frontmatter.draft === true;

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

export const STATIC_EXPORT_PLACEHOLDER_SLUG = "__placeholder__";

export function buildStaticParams(category: BlogCategory): { slug: string }[] {
  const posts = listPosts(category).map((post) => ({ slug: post.slug }));
  if (posts.length === 0) {
    return [{ slug: STATIC_EXPORT_PLACEHOLDER_SLUG }];
  }
  return posts;
}

export function isStaticExportPlaceholder(slug: string): boolean {
  return slug === STATIC_EXPORT_PLACEHOLDER_SLUG;
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
