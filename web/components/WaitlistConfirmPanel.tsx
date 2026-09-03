"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import {
  confirmWaitlistEmail,
  type WaitlistConfirmResponse,
  type WaitlistConfirmStatus,
} from "@/lib/waitlist-api";

type ConfirmViewState =
  | { kind: "loading" }
  | { kind: "result"; result: WaitlistConfirmResponse }
  | { kind: "error"; message: string };

function headingForStatus(status: WaitlistConfirmStatus): string {
  switch (status) {
    case "confirmed":
      return "Email confirmed";
    case "already_confirmed":
      return "Already confirmed";
    case "invalid_token":
      return "Invalid confirmation link";
  }
}

function statusClassName(status: WaitlistConfirmStatus): string {
  switch (status) {
    case "confirmed":
    case "already_confirmed":
      return "text-sea";
    case "invalid_token":
      return "text-clay";
  }
}

export function WaitlistConfirmPanel() {
  const searchParams = useSearchParams();
  const [viewState, setViewState] = useState<ConfirmViewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const email = searchParams.get("email");
    const token = searchParams.get("token");
    if (!email || !token) {
      setViewState({
        kind: "result",
        result: {
          status: "invalid_token",
          message:
            "This confirmation link is invalid or has expired. Request a new confirmation email from the beta page.",
        },
      });
      return;
    }

    void (async () => {
      try {
        const result = await confirmWaitlistEmail(email, token);
        if (!cancelled) {
          setViewState({ kind: "result", result });
        }
      } catch (caught) {
        if (!cancelled) {
          setViewState({
            kind: "error",
            message: caught instanceof Error ? caught.message : "confirmation failed",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  let heading = "Confirming your email…";
  let message = "Checking your confirmation link.";
  let messageClassName = "text-ink/70";

  if (viewState.kind === "result") {
    heading = headingForStatus(viewState.result.status);
    message = viewState.result.message;
    messageClassName = statusClassName(viewState.result.status);
  } else if (viewState.kind === "error") {
    heading = "Confirmation failed";
    message = viewState.message;
    messageClassName = "text-clay";
  }

  return (
    <>
      <Header />
      <main id="main-content">
        <section className="bg-[var(--surface-0)]">
          <div className="mx-auto max-w-[92rem] px-5 py-20 sm:px-8 lg:px-12">
            <div className="max-w-2xl rounded-2xl bg-[var(--surface-1)] p-8">
              <h1 className="font-display text-3xl tracking-[-0.04em]">{heading}</h1>
              <p className={`mt-6 text-lg ${messageClassName}`}>{message}</p>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
