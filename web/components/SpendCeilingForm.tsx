"use client";

import { useState } from "react";
import type { FormEvent } from "react";

import { setMonthlyAwsSpendCeiling } from "../lib/api";
import type { ActiveOrg } from "../lib/membership-state";
import {
  SPEND_CEILING_FORM_TITLE,
  parseSpendCeilingInput,
  spendCeilingConfirmationText,
  spendCeilingErrorText,
} from "../lib/spend-ceiling";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type SpendCeilingFormProps = {
  activeOrg: ActiveOrg;
  currentCeiling: string | null | undefined;
  onRaised: () => Promise<void>;
};

export function SpendCeilingForm({ activeOrg, currentCeiling, onRaised }: SpendCeilingFormProps) {
  const [amount, setAmount] = useState(currentCeiling ?? "");
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConfirmation(null);
    const parsed = parseSpendCeilingInput(amount);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await setMonthlyAwsSpendCeiling(activeOrg, parsed.amount);
      setConfirmation(spendCeilingConfirmationText(result.monthly_aws_spend_ceiling_usd));
    } catch (caught) {
      setError(spendCeilingErrorText(caught));
      setSaving(false);
      return;
    }
    try {
      await onRaised();
    } catch {
      setError("Saved, but this page could not refresh. Reload to see the update.");
    }
    setSaving(false);
  }

  return (
    <form className="mt-2 grid gap-2" aria-label={SPEND_CEILING_FORM_TITLE} onSubmit={(event) => void submit(event)}>
      <label className="grid gap-1">
        <span className="font-semibold">{SPEND_CEILING_FORM_TITLE}</span>
        <span className="text-surface-foreground/70">New monthly ceiling in US dollars</span>
        <Input
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="500"
          className="h-10 max-w-48 rounded-xl bg-surface px-3"
        />
      </label>
      <div>
        <Button type="submit" size="sm" className="shadow-none" disabled={saving}>
          {saving ? "Saving" : "Raise ceiling"}
        </Button>
      </div>
      {error ? <p role="alert" className="text-clay">{error}</p> : null}
      {confirmation ? <p role="status">{confirmation}</p> : null}
    </form>
  );
}
