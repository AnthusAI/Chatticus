"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import {
  consumeWaitlistInvitation,
  type WaitlistInviteResponse,
  type WaitlistInviteStatus,
} from "@/lib/waitlist-api";

type InviteViewState =
  | { kind: "loading" }
  | { kind: "result"; result: WaitlistInviteResponse }
  | { kind: "error"; message: string };

function headingForStatus(status: WaitlistInviteStatus): string {
  switch (status) {
    case "accepted":
      return "Invitation accepted";
    case "invalid_token":
      return "Invalid invitation link";
    case "expired":
      return "Invitation expired";
    case "already_used":
      return "Invitation already used";
  }
}

function statusClassName(status: WaitlistInviteStatus): string {
  switch (status) {
    case "accepted":
      return "text-sea";
    case "invalid_token":
    case "expired":
    case "already_used":
      return "text-clay";
  }
}

export function WaitlistInvitePanel() {
  const searchParams = useSearchParams();
  const [viewState, setViewState] = useState<InviteViewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const token = searchParams.get("token");
    if (!token) {
      setViewState({
        kind: "result",
        result: {
          status: "invalid_token",
          message:
            "This invitation link is invalid. Ask your Chatticus contact for a new invitation.",
        },
      });
      return;
    }

    void (async () => {
      try {
        const result = await consumeWaitlistInvitation(token);
        if (!cancelled) {
          setViewState({ kind: "result", result });
        }
      } catch (caught) {
        if (!cancelled) {
          setViewState({
            kind: "error",
            message: caught instanceof Error ? caught.message : "invitation failed",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  let heading = "Checking your invitation…";
  let message = "Verifying your invitation link.";
  let messageClassName = "text-ink/70";
  let signInUrl: string | null = null;

  if (viewState.kind === "result") {
    heading = headingForStatus(viewState.result.status);
    message = viewState.result.message;
    messageClassName = statusClassName(viewState.result.status);
    signInUrl = viewState.result.sign_in_url ?? null;
  } else if (viewState.kind === "error") {
    heading = "Invitation failed";
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
              {signInUrl ? (
                <Link
                  href={signInUrl}
                  className="mt-8 inline-flex rounded-full bg-sea px-6 py-3 text-base font-medium text-white"
                >
                  Continue to sign in
                </Link>
              ) : null}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
