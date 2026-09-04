import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
  table: ({ children }) => (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[36rem] border-separate border-spacing-y-2">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => (
    <th className="bg-surface-high px-4 py-3 text-left align-top font-mono text-[0.62rem] uppercase tracking-[0.14em] text-ink-soft first:rounded-l-2xl last:rounded-r-2xl">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="bg-surface-raised px-4 py-3 align-top text-base leading-relaxed first:rounded-l-2xl last:rounded-r-2xl">
      {children}
    </td>
  ),
};

type MarkdownContentProps = {
  children: string;
};

export function MarkdownContent({ children }: MarkdownContentProps) {
  return (
    <div className="prose-chatticus max-w-3xl space-y-5 font-body text-lg leading-relaxed text-ink-soft">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
