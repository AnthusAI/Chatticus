"use client";

import { WELCOME_SCREEN_LINES, WELCOME_SCREEN_TITLE } from "../lib/membership-view";

export function WelcomeOrganizationPanel() {
  return (
    <section className="card membership">
      <h2>{WELCOME_SCREEN_TITLE}</h2>
      {WELCOME_SCREEN_LINES.map((line) => (
        <p key={line} className="status">
          {line}
        </p>
      ))}
    </section>
  );
}
