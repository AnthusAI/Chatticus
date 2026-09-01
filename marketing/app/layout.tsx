import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Manrope, Newsreader } from "next/font/google";
import "./globals.css";

const display = Newsreader({
  subsets: ["latin"],
  variable: "--font-display",
  style: ["normal", "italic"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const body = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://chattic.us"),
  title: "Chatticus | Build the AI organization you control",
  description:
    "Persistent, named AI teammates with memory, skills, routines, approvals, and one shared computer inside a boundary you control.",
  keywords: [
    "AI teammates",
    "AI organization",
    "self-hosted AI agents",
    "agent computer",
    "AI approvals",
  ],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    title: "Build the AI organization you control",
    description:
      "Named AI teammates on one shared computer, inside a boundary you own.",
    siteName: "Chatticus",
    images: [
      {
        url: "/og-card.svg",
        width: 1200,
        height: 630,
        alt: "Chatticus — Build the AI organization you control",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Build the AI organization you control",
    description:
      "Named AI teammates on one shared computer, inside a boundary you own.",
    images: ["/og-card.svg"],
  },
  icons: {
    icon: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#f2efe7",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
