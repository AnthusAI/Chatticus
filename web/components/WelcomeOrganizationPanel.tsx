"use client";

import { AuthCard, authStatusClassName } from "./AuthCard";
import { WELCOME_SCREEN_LINES, WELCOME_SCREEN_TITLE } from "../lib/membership-view";

export function WelcomeOrganizationPanel() {
  return (
    <AuthCard title={WELCOME_SCREEN_TITLE}>
      {WELCOME_SCREEN_LINES.map((line) => (
        <p key={line} className={authStatusClassName}>
          {line}
        </p>
      ))}
    </AuthCard>
  );
}
