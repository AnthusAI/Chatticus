import { ArrowUpRight, Boxes, GitBranch, ShieldCheck } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

const evidence = [
  {
    initials: "GH",
    icon: GitBranch,
    title: "Inspect the source",
    body: "The control plane, worker protocol, architecture decisions, and executable behavior live in a public repository.",
    href: "https://github.com/AnthusAI/Chattic.us",
    link: "Open the repository",
  },
  {
    initials: "AWS",
    icon: Boxes,
    title: "Named cloud boundaries",
    body: "Development, staging, and production are separate environments. Infrastructure exists as code, not as an invisible hosted service.",
    href: "https://github.com/AnthusAI/Chattic.us/tree/develop/infra",
    link: "Read the infrastructure",
  },
  {
    initials: "BDD",
    icon: ShieldCheck,
    title: "Behavior before claims",
    body: "Gherkin specifications cover tenant boundaries, turn recovery, approvals, computer escalation, and the web contract.",
    href: "https://github.com/AnthusAI/Chattic.us/tree/develop/features",
    link: "Read the specifications",
  },
];

export function Evidence() {
  return (
    <section
      id="evidence"
      aria-labelledby="evidence-title"
      className="bg-clay text-ink"
    >
      <div className="mx-auto max-w-[92rem] px-5 py-24 sm:px-8 sm:py-32 lg:px-12">
        <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
          <div>
            <Badge variant="default">Proof, not praise</Badge>
            <h2
              id="evidence-title"
              className="mt-7 max-w-4xl font-display text-[clamp(4rem,8vw,8rem)] leading-[0.84] tracking-[-0.07em]"
            >
              No borrowed credibility.
            </h2>
          </div>
          <div className="max-w-xl lg:justify-self-end">
            <p className="font-display text-3xl leading-tight tracking-[-0.035em]">
              No fake customer quotes, no invented adoption numbers, no growth
              chart pointing up and to the right.
            </p>
            <p className="mt-5 font-body text-base leading-relaxed text-ink/75">
              Check the source, the specifications, and the deployed system
              yourself. Everything on this page is live and running exactly
              as described.
            </p>
          </div>
        </div>

        <div className="mt-16 grid gap-4 lg:grid-cols-3">
          {evidence.map((item) => {
            const Icon = item.icon;
            return (
              <Card
                key={item.title}
                className="group bg-paper text-ink shadow-[5px_5px_0_var(--ink)] transition hover:-translate-y-1 hover:shadow-[8px_8px_0_var(--ink)]"
              >
                <CardContent className="flex h-full flex-col p-7 sm:p-8">
                  <div className="flex items-center justify-between">
                    <Avatar className="h-11 w-11">
                      <AvatarFallback className="bg-signal font-bold text-ink">
                        {item.initials}
                      </AvatarFallback>
                    </Avatar>
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h3 className="mt-12 font-display text-3xl leading-none tracking-[-0.045em]">
                    {item.title}
                  </h3>
                  {/* text-[#3f463d]: this card is a fixed bg-paper/text-ink island regardless of site theme, so its muted text must not follow --ink-soft's dark-mode swap. */}
                  <p className="mt-5 flex-1 font-body text-base leading-relaxed text-[#3f463d]">
                    {item.body}
                  </p>
                  <a
                    className="mt-8 inline-flex min-h-11 items-center gap-2 pt-4 font-mono text-[0.65rem] uppercase tracking-[0.12em] transition hover:text-cobalt focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
                    href={item.href}
                  >
                    {item.link}
                    <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                  </a>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </section>
  );
}
