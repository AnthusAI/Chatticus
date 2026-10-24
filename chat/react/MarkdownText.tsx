"use client";

import { Check, Copy } from "lucide-react";
import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { safeLinkTarget } from "./markdown-safety";
import { cn } from "./utils";

const COPIED_RESET_MS = 1800;

type CodeElementProps = { className?: string; children?: ReactNode };

function plainText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plainText).join("");
  if (isValidElement(node)) return plainText((node.props as { children?: ReactNode }).children);
  return "";
}

function languageOf(className: string | undefined): string | null {
  const match = /(?:^|\s)language-([^\s]+)/.exec(className ?? "");
  return match ? match[1] : null;
}

/** A fenced code block: monospace, scrolls sideways, with an accessible copy button. */
export const MarkdownCodeBlock: FC<{ code: string; language: string | null }> = ({ code, language }) => {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(code).then(() => {
      setCopied(true);
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  };

  return (
    <div className="rounded-xl bg-surface" data-testid="markdown-code-block">
      <div className="flex items-center justify-between gap-2 px-3 pt-1.5">
        <span className="font-mono text-[0.68rem] text-surface-foreground/55">{language ?? ""}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Code copied" : "Copy code"}
          className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[0.68rem] font-semibold text-surface-foreground/65 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          <span aria-hidden="true">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre
        tabIndex={0}
        aria-label={language ? `${language} code` : "Code"}
        className="overflow-x-auto px-3 pb-2.5 pt-1 font-mono text-xs leading-5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
      >
        <code>{code}</code>
      </pre>
    </div>
  );
};

const HEADING_CLASSES = {
  h1: "text-base font-bold",
  h2: "text-base font-semibold",
  h3: "text-sm font-bold",
  h4: "text-sm font-semibold",
  h5: "text-sm font-semibold text-surface-foreground/80",
  h6: "text-sm font-semibold text-surface-foreground/65",
} as const;

function heading(level: keyof typeof HEADING_CLASSES): Components["h1"] {
  const Tag = level;
  const HeadingElement: Components["h1"] = ({ children }) => (
    <Tag className={cn("mt-3 first:mt-0", HEADING_CLASSES[level])}>{children}</Tag>
  );
  return HeadingElement;
}

const MARKDOWN_COMPONENTS: Components = {
  h1: heading("h1"),
  h2: heading("h2"),
  h3: heading("h3"),
  h4: heading("h4"),
  h5: heading("h5"),
  h6: heading("h6"),
  p: ({ children }) => <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{children}</p>,
  a: ({ href, children }) => {
    const target = safeLinkTarget(href);
    if (target === null) return <span>{children}</span>;
    return (
      <a
        href={target}
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold text-cobalt underline underline-offset-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
      >
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => {
    const target = typeof src === "string" ? safeLinkTarget(src) : null;
    const text = alt && alt.trim() !== "" ? alt : (target ?? "");
    if (target === null) return <span>{text}</span>;
    return (
      <a
        href={target}
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold text-cobalt underline underline-offset-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
      >
        {text}
      </a>
    );
  },
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children, start }) => (
    <ol start={start ?? undefined} className="list-decimal space-y-1 pl-5">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="[overflow-wrap:anywhere]">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="rounded-xl bg-surface px-3 py-2 text-surface-foreground/80 [&>*+*]:mt-2">
      {children}
    </blockquote>
  ),
  hr: () => <div role="separator" className="my-1 h-1 rounded-full bg-surface" />,
  strong: ({ children }) => <strong className="font-bold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  pre: ({ children }) => {
    const child = (Array.isArray(children) ? children[0] : children) as ReactElement<CodeElementProps> | undefined;
    const props = isValidElement(child) ? child.props : null;
    const code = plainText(props?.children ?? children).replace(/\n$/, "");
    return <MarkdownCodeBlock code={code} language={languageOf(props?.className)} />;
  },
  code: ({ children, className }) => (
    <code className={cn("rounded-md bg-surface px-1 py-0.5 font-mono text-[0.85em]", className)}>{children}</code>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-xl bg-surface">
      <table className="w-full text-left text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="px-3 py-1.5 font-semibold">{children}</th>,
  td: ({ children }) => <td className="px-3 py-1.5 align-top">{children}</td>,
};

/**
 * Renders a bot reply as markdown.
 *
 * Raw HTML is never executed (react-markdown shows it as text), only
 * http, https and mailto links are followed, and images become plain links.
 * Text received so far renders as-is: an unclosed code fence is an open code
 * block, so a streaming reply does not jump when the closing fence arrives.
 */
export const MarkdownText: FC<{ text: string }> = ({ text }) => (
  <div className="flex flex-col gap-2 [&>*]:min-w-0" data-testid="markdown-text">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={MARKDOWN_COMPONENTS}
      urlTransform={(url) => safeLinkTarget(url) ?? ""}
    >
      {text}
    </ReactMarkdown>
  </div>
);
