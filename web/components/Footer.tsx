import { ArrowUpRight } from "lucide-react";
import { Wordmark } from "@/components/Wordmark";

const groups = [
  {
    title: "Product",
    links: [
      ["Hey, Chatticus...", "/chat"],
      ["Join the beta", "/beta"],
      ["Product model", "https://github.com/AnthusAI/Chattic.us/blob/develop/docs/PRODUCT.md"],
      ["Roadmap", "https://github.com/AnthusAI/Chattic.us/blob/develop/docs/ROADMAP.md"],
    ],
  },
  {
    title: "Features",
    links: [
      ["Shared Files", "/features/shared-files"],
      ["Flexible Compute", "/features/flexible-compute"],
      ["Approvals", "/features/approvals"],
      ["Flex Mode", "/features/flex-mode"],
    ],
  },
  {
    title: "Build",
    links: [
      ["Source", "https://github.com/AnthusAI/Chattic.us"],
      ["Architecture", "https://github.com/AnthusAI/Chattic.us/blob/develop/docs/ARCHITECTURE.md"],
      ["Open an issue", "https://github.com/AnthusAI/Chattic.us/issues"],
      ["Vultus avatars", "https://github.com/AnthusAI/Vultus"],
      ["License", "https://github.com/AnthusAI/Chattic.us/blob/develop/LICENSE"],
      ["Anth.us", "https://anth.us"],
    ],
  },
  {
    title: "News",
    links: [
      ["Updates", "/updates"],
      ["Agent Zoo", "/agent-zoo"],
    ],
  },
];

export function Footer() {
  return (
    <footer className="bg-surface-raised">
      <div className="mx-auto max-w-[92rem] px-5 py-14 sm:px-8 lg:px-12">
        <div className="grid gap-12 lg:grid-cols-[1.25fr_1.75fr]">
          <div>
            <a
              href="#top"
              aria-label="Back to the top"
              className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
            >
              <Wordmark iconPosition="end" />
            </a>
            <p className="mt-6 max-w-sm font-display text-2xl leading-tight tracking-[-0.035em]">
              Bots with roles, a shared space you control.
            </p>
            <p className="mt-5 max-w-md font-body text-sm leading-relaxed text-ink-soft">
              The marketing site collects no signup form data. Product account,
              privacy, and support surfaces will be published before general
              availability.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-8 lg:grid-cols-4">
            {groups.map((group) => (
              <div key={group.title}>
                <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.13em] text-ink-soft">
                  {group.title}
                </h2>
                <ul className="mt-5 space-y-3">
                  {group.links.map(([label, href]) => (
                    <li key={label}>
                      <a
                        className="inline-flex min-h-8 items-center gap-1.5 font-body text-sm font-semibold transition hover:text-cobalt focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
                        href={href}
                      >
                        {label}
                        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-10 flex flex-col gap-3 rounded-2xl bg-surface-high px-5 py-4 font-mono text-[0.62rem] uppercase tracking-[0.11em] text-ink-soft sm:flex-row sm:items-center sm:justify-between">
          <p>Chatticus · Live in production</p>
          <p>Your teammates. Your computer. Your call.</p>
        </div>
      </div>
    </footer>
  );
}
