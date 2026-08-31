import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chatticus",
  description: "Named-teammate bots with a shared computer.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
