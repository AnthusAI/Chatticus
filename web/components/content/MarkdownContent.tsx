import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";

export const markdownComponents: Components = {
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
};

type MarkdownContentProps = {
  children: string;
};

export function MarkdownContent({ children }: MarkdownContentProps) {
  return (
    <div className="prose-chatticus max-w-3xl space-y-5 font-body text-lg leading-relaxed text-ink-soft">
      <ReactMarkdown components={markdownComponents}>{children}</ReactMarkdown>
    </div>
  );
}
