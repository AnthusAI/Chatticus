import {
  BrainCircuit,
  Clock3,
  HardDrive,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const foundation = [
  {
    icon: BrainCircuit,
    number: "01",
    eyebrow: "Identity",
    title: "A teammate, not a blank chat.",
    description:
      "Each bot has a name, durable memory, and a role in the work. Context compounds instead of disappearing at the end of a prompt.",
    status: "Live foundation",
    accent: "bg-cobalt",
  },
  {
    icon: HardDrive,
    number: "02",
    eyebrow: "Computer",
    title: "One workplace the team can share.",
    description:
      "Your teammates use the same browser sessions, files, and command-line credentials, with a separate screen for each active worker.",
    status: "Development path",
    accent: "bg-sea",
  },
  {
    icon: ShieldCheck,
    number: "03",
    eyebrow: "Control",
    title: "Consequences stop with you.",
    description:
      "Sending, publishing, buying, deleting, and changing permissions pause at an approval boundary you can inspect.",
    status: "Policy kernel",
    accent: "bg-clay",
  },
  {
    icon: Clock3,
    number: "04",
    eyebrow: "Continuity",
    title: "Work can outlast the open laptop.",
    description:
      "Routines can wake a named teammate on a schedule or event. The computer is summoned only when the work actually needs it.",
    status: "Designed path",
    accent: "bg-amber",
  },
];

export function OrganizationStory() {
  return (
    <section
      id="organization"
      aria-labelledby="organization-title"
      className="bg-ink text-paper"
    >
      <div className="mx-auto max-w-[92rem] px-5 py-24 sm:px-8 sm:py-32 lg:px-12">
        <div className="grid gap-12 pb-16 lg:grid-cols-[0.82fr_1.18fr] lg:items-end">
          <div>
            <Badge variant="signal">From assistant to organization</Badge>
            <p className="mt-8 max-w-md font-mono text-[0.7rem] uppercase leading-relaxed tracking-[0.15em] text-paper/[0.55]">
              Several minds. One room. A human still in charge.
            </p>
          </div>
          <h2
            id="organization-title"
            className="font-display text-[clamp(3.5rem,7vw,7.6rem)] leading-[0.88] tracking-[-0.065em]"
          >
            The next step isn&rsquo;t a smarter assistant.
            <span className="block italic text-signal">
              It&rsquo;s a better organization.
            </span>
          </h2>
        </div>

        <div className="mt-16 grid gap-5 md:grid-cols-2">
          {foundation.map((item, index) => {
            const Icon = item.icon;
            return (
              <Card
                key={item.number}
                className={`group overflow-hidden bg-paper/[0.06] text-paper transition duration-300 hover:-translate-y-1 hover:bg-paper/[0.1] ${index === 0 || index === 3 ? "md:min-h-[27rem]" : "md:translate-y-12"}`}
              >
                <CardHeader className="flex-row items-start justify-between gap-8 p-7 sm:p-9">
                  <div>
                    <p className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-paper/50">
                      {item.number} · {item.eyebrow}
                    </p>
                    <CardTitle className="mt-14 max-w-md text-3xl leading-[0.98] tracking-[-0.04em] text-paper sm:text-4xl">
                      {item.title}
                    </CardTitle>
                  </div>
                  <span
                    className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-ink ${item.accent}`}
                  >
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                </CardHeader>
                <CardContent className="px-7 pb-7 sm:px-9 sm:pb-9">
                  <CardDescription className="max-w-lg text-base text-paper/[0.65]">
                    {item.description}
                  </CardDescription>
                  <div className="mt-8 flex items-center gap-3 font-mono text-[0.62rem] uppercase tracking-[0.12em] text-paper/[0.55]">
                    <span className={`h-2 w-2 rounded-full ${item.accent}`} />
                    {item.status}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="mt-28 grid gap-8 rounded-2xl bg-paper/[0.04] p-8 pt-12 lg:grid-cols-[1fr_1.4fr]">
          <div className="flex items-center gap-4">
            <UsersRound className="h-8 w-8 text-signal" aria-hidden="true" />
            <p className="font-display text-3xl tracking-[-0.04em]">
              A channel is the room.
            </p>
          </div>
          <p className="max-w-3xl font-body text-lg leading-relaxed text-paper/[0.68]">
            Every teammate in a channel reads the same compacted view. Only the
            teammate you address acts. Handoffs happen in the work instead of
            turning you into the router between agents.
          </p>
        </div>
      </div>
    </section>
  );
}
