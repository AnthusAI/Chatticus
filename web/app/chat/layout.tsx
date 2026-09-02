import type { ReactNode } from "react";
import { AuthShell } from "../../components/AuthShell";
import "./chat.css";

export default function ChatLayout({ children }: { children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
