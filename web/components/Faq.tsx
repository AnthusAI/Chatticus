import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";

const questions = [
  {
    question: "What exactly is a Chatticus teammate?",
    answer:
      "A teammate is a persistent, named bot with its own memory and role. It reads the channel it belongs to, acts only when addressed, and can hand durable work to another teammate without making you carry context between chats.",
  },
  {
    question: "Where does the computer run?",
    answer:
      "The Chatticus computer is a Linux workplace that belongs to the user. The same image can run on AWS or local Docker hardware. Durable workspace files and the browser profile move through an S3 snapshot rather than a live container migration.",
  },
  {
    question: "Does every turn wait for a computer to boot?",
    answer:
      "No. A computerless worker can answer text-only turns immediately. If the turn first reaches for a browser, display, or workspace file, that same turn escalates to a computer-capable worker. Readiness is per capability.",
  },
  {
    question: "What is the difference between a skill and a routine?",
    answer:
      "A skill says how to do reliable work. A routine says when one named teammate should run that skill, including the schedule or event, time zone, input policy, and approval boundary.",
  },
  {
    question: "What still requires a person?",
    answer:
      "Consequential proposals such as sending, publishing, buying, deleting, changing permissions, or making production changes stop for approval. Passwords, passkeys, CAPTCHAs, and identity checks are handed to the person for the blocked step.",
  },
  {
    question: "Is Chatticus ready for general use?",
    answer:
      "Yes. The serverless conversation foundation and computer handoff paths are live in production today. Skills, routines, the approvals UI, and the computer preview keep expanding from here.",
  },
];

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="bg-surface">
      <div className="mx-auto grid max-w-[92rem] gap-12 px-5 py-24 sm:px-8 sm:py-32 lg:grid-cols-[0.7fr_1.3fr] lg:px-12">
        <div>
          <Badge variant="outline">Straight answers</Badge>
          <h2
            id="faq-title"
            className="mt-7 font-display text-[clamp(3.7rem,6vw,6.3rem)] leading-[0.86] tracking-[-0.065em]"
          >
            Before you hand over a task.
          </h2>
          <p className="mt-7 max-w-md font-body text-base leading-relaxed text-ink-soft">
            Chatticus teammates share the same files &mdash; there&rsquo;s no
            always-on socket and no separate machine per bot.
          </p>
        </div>
        <Accordion type="single" collapsible className="grid gap-2">
          {questions.map((item, index) => (
            <AccordionItem key={item.question} value={`question-${index}`}>
              <AccordionTrigger>{item.question}</AccordionTrigger>
              <AccordionContent>{item.answer}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
