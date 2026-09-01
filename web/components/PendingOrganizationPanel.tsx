"use client";

export function PendingOrganizationPanel() {
  return (
    <section className="card membership">
      <h2>Organization pending</h2>
      <p className="status">
        Your organization is on the waitlist. You can sign in, but the workspace
        unlocks once an operator enables your household.
      </p>
    </section>
  );
}
