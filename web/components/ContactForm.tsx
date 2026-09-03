"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  submitContact,
  ContactApiError,
  type ContactType,
} from "@/lib/contact-api";
import { trackConversion, type ConversionEventName } from "@/lib/conversion-tracking";

type ContactFormField = {
  id: string;
  label: string;
  name: string;
  required?: boolean;
  multiline?: boolean;
};

type ContactFormProps = {
  contactType: ContactType;
  conversionEvent: ConversionEventName;
  title: string;
  description: string;
  detailFields: ContactFormField[];
};

type FormView = "form" | "thank-you";

export function ContactForm({
  contactType,
  conversionEvent,
  title,
  description,
  detailFields,
}: ContactFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [organization, setOrganization] = useState("");
  const [detailValues, setDetailValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<FormView>("form");

  if (view === "thank-you") {
    return (
      <div className="rounded-2xl bg-[var(--surface-1)] p-8">
        <h2 className="font-display text-3xl tracking-[-0.04em]">Thank you</h2>
        <p className="mt-4 font-body text-lg leading-relaxed text-ink-soft">
          We received your message and will follow up at {email}.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-[var(--surface-1)] p-8">
      <h1 className="font-display text-[clamp(2.2rem,4.5vw,3.6rem)] leading-[0.95] tracking-[-0.05em]">
        {title}
      </h1>
      <p className="mt-6 max-w-3xl font-body text-lg leading-relaxed text-ink-soft">
        {description}
      </p>
      <form
        className="mt-10 grid max-w-xl gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmedEmail = email.trim();
          if (!trimmedEmail || submitting) {
            return;
          }
          setSubmitting(true);
          setError(null);
          void submitContact({
            email: trimmedEmail,
            contact_type: contactType,
            name: name.trim() || undefined,
            organization: organization.trim() || undefined,
            details: detailValues,
          })
            .then(() => {
              trackConversion(conversionEvent);
              setView("thank-you");
            })
            .catch((caught) => {
              if (caught instanceof ContactApiError) {
                setError("We could not send your message. Please try again.");
              } else {
                setError("Something went wrong. Please try again.");
              }
            })
            .finally(() => {
              setSubmitting(false);
            });
        }}
      >
        <div>
          <label htmlFor="contact-name" className="font-body text-sm text-ink-soft">
            Name
          </label>
          <Input
            id="contact-name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={submitting}
            className="mt-2"
          />
        </div>
        <div>
          <label htmlFor="contact-email" className="font-body text-sm text-ink-soft">
            Email
          </label>
          <Input
            id="contact-email"
            name="email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={submitting}
            className="mt-2"
          />
        </div>
        <div>
          <label
            htmlFor="contact-organization"
            className="font-body text-sm text-ink-soft"
          >
            Organization
          </label>
          <Input
            id="contact-organization"
            name="organization"
            value={organization}
            onChange={(event) => setOrganization(event.target.value)}
            disabled={submitting}
            className="mt-2"
          />
        </div>
        {detailFields.map((field) => (
          <div key={field.id}>
            <label htmlFor={field.id} className="font-body text-sm text-ink-soft">
              {field.label}
            </label>
            {field.multiline ? (
              <textarea
                id={field.id}
                name={field.name}
                required={field.required}
                value={detailValues[field.name] ?? ""}
                onChange={(event) =>
                  setDetailValues((current) => ({
                    ...current,
                    [field.name]: event.target.value,
                  }))
                }
                disabled={submitting}
                className="mt-2 flex min-h-28 w-full rounded-2xl bg-surface-high px-5 py-4 font-body text-sm text-surface-foreground outline-none placeholder:text-surface-foreground/50 focus-visible:ring-4 focus-visible:ring-cobalt/25 disabled:cursor-not-allowed disabled:opacity-50"
              />
            ) : (
              <Input
                id={field.id}
                name={field.name}
                required={field.required}
                value={detailValues[field.name] ?? ""}
                onChange={(event) =>
                  setDetailValues((current) => ({
                    ...current,
                    [field.name]: event.target.value,
                  }))
                }
                disabled={submitting}
                className="mt-2"
              />
            )}
          </div>
        ))}
        {error ? <p className="font-body text-sm text-amber">{error}</p> : null}
        <Button type="submit" disabled={submitting || !email.trim()}>
          Send message
        </Button>
      </form>
    </div>
  );
}
