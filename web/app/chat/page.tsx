import type { Metadata } from "next";
import { MembershipShell } from "../../components/MembershipShell";
import { CHAT_PAGE_CONTENT } from "./page-content";

export const metadata: Metadata = {
  title: CHAT_PAGE_CONTENT.title,
  description: CHAT_PAGE_CONTENT.description,
  alternates: {
    canonical: "/chat",
  },
  openGraph: {
    type: "website",
    url: "/chat",
    title: CHAT_PAGE_CONTENT.ogTitle,
    description: CHAT_PAGE_CONTENT.ogDescription,
    siteName: "Chatticus",
  },
  twitter: {
    card: "summary_large_image",
    title: CHAT_PAGE_CONTENT.ogTitle,
    description: CHAT_PAGE_CONTENT.ogDescription,
  },
};

export default function ChatPage() {
  return <MembershipShell />;
}
