import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./styles.css";
export const metadata: Metadata = {
  title: "Chatticus | The AI organization you control",
  description:
    "Run persistent AI teammates with the models, infrastructure, access boundaries, and approval gates you choose.",
};
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
