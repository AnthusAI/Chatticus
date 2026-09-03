import { ArrowUpRight, Boxes, GitBranch, ShieldCheck } from "lucide-react";
import { BetaAccessDisclosure } from "@/components/BetaAccessDisclosure";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

const evidence = [
  {
    initials: "GH",
    icon: GitBranch,
    title: "Already in your account",
    body: "Your file system and encrypted secrets live in your AWS account from the start — not something trapped behind an API only we control.",
    href: "https://github.com/AnthusAI/Chattic.us",
    link: "Open the repository",
  },
  {
    initials: "AWS",
    icon: Boxes,
    title: "Take it to another host",
    body: "The same infrastructure-as-code that runs Chatticus for you can stand up your bot farm on any cloud account — yours, ours, or someone else's.",
    href: "https://github.com/AnthusAI/Chattic.us/tree/develop/infra",
    link: "Read the infrastructure",
  },
  {
    initials: "BDD",
    icon: ShieldCheck,
    title: "No hidden rules",
    body: "Every approval, escalation, and recovery rule is a written, testable specification — not tribal knowledge you'd lose by switching providers.",
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
            <Badge variant="default">Control and access</Badge>
            <h2
              id="evidence-title"
              className="mt-7 max-w-4xl font-display text-[clamp(4rem,8vw,8rem)] leading-[0.84] tracking-[-0.07em]"
            >
              Control without lock-in. Access without a queue.
            </h2>
          </div>
          <div className="max-w-xl lg:justify-self-end">
            <BetaAccessDisclosure />
            <p className="mt-5 font-display text-3xl leading-tight tracking-[-0.035em]">
              The code is MIT licensed. Free to copy, change, and run. Run your bot
              farm on our infrastructure, or take the whole stack and run it yourself.
            </p>
            <p className="mt-5 font-body text-base leading-relaxed text-ink/75">
              But control alone reads as more work for you. The second half of the pitch is access: Anthus runs its own organizations on Chatticus. Buying the managed service puts you next to them. Managed customers run what Anthus runs, giving you access to the developers instead of a support queue.
            </p>
            <a
              className="mt-5 inline-flex min-h-11 items-center gap-2 font-mono text-[0.65rem] uppercase tracking-[0.12em] underline decoration-2 underline-offset-4 transition hover:text-cobalt focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-cobalt/25"
              href="https://anth.us"
            >
              Get migration help
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </a>
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
