"use client";

import type { ReactNode } from "react";

import { MembershipProvider } from "../lib/membership-context";

export function AuthShell({ children }: { children: ReactNode }) {
  return <MembershipProvider>{children}</MembershipProvider>;
}
