import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

const display = localFont({
  src: [
    { path: "../../node_modules/@fontsource/newsreader/files/newsreader-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../node_modules/@fontsource/newsreader/files/newsreader-latin-400-italic.woff2", weight: "400", style: "italic" },
    { path: "../../node_modules/@fontsource/newsreader/files/newsreader-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../../node_modules/@fontsource/newsreader/files/newsreader-latin-500-italic.woff2", weight: "500", style: "italic" },
    { path: "../../node_modules/@fontsource/newsreader/files/newsreader-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../../node_modules/@fontsource/newsreader/files/newsreader-latin-600-italic.woff2", weight: "600", style: "italic" },
  ],
  variable: "--font-display",
  display: "swap",
});

const body = localFont({
  src: [
    { path: "../../node_modules/@fontsource/manrope/files/manrope-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../node_modules/@fontsource/manrope/files/manrope-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../../node_modules/@fontsource/manrope/files/manrope-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../../node_modules/@fontsource/manrope/files/manrope-latin-700-normal.woff2", weight: "700", style: "normal" },
    { path: "../../node_modules/@fontsource/manrope/files/manrope-latin-800-normal.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-body",
  display: "swap",
});

const mono = localFont({
  src: [
    { path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-mono",
  display: "swap",
});

/**
 * Only truly site-wide metadata lives here. Title, description, keywords,
 * canonical, openGraph, and twitter are per-page (see page-content.ts and
 * each route's own metadata export) so a shared link's preview actually
 * describes the page being shared, not always the workspace root -- each
 * route also gets its own opengraph-image.tsx built from the same copy.
 */
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://hey.chattic.us"),
  icons: {
    icon: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2efe7" },
    { media: "(prefers-color-scheme: dark)", color: "#11130f" },
  ],
  colorScheme: "light dark",
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
