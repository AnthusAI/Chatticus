import { CircleAlert } from "lucide-react";

import type { MeOrganization } from "../lib/me";

const FALLBACK_REASON = "Computer work is paused at the monthly AWS spend ceiling.";

export function ComputerPausedNotice({ organization }: { organization: MeOrganization | undefined }) {
  if (!organization?.computer_work_paused) return null;
  return (
    <div role="status" className="mx-4 mb-2 flex items-start gap-2 rounded-xl bg-clay/15 px-3 py-2 text-xs">
      <CircleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">Computer work is paused</p>
        <p>{organization.computer_work_paused_reason ?? FALLBACK_REASON}</p>
        <p className="text-surface-foreground/70">
          You can still read your channels and message bots. Ask an operator if this looks wrong or you need computer
          work sooner.
        </p>
      </div>
    </div>
  );
}
