import type { ReactNode } from "react";
import { AuthShell } from "../../components/AuthShell";

export default function ChatLayout({ children }: { children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
