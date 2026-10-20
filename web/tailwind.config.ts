import type { Config } from "tailwindcss";
import chatticusTailwindPreset from "./tailwind-preset";

const config: Config = {
  presets: [chatticusTailwindPreset as Config],
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "../node_modules/@kanbus/ui/dist/**/*.js",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        card: "var(--card)",
        "card-muted": "var(--card-muted)",
        frame: "var(--frame)",
        column: "var(--column)",
        foreground: "var(--text-foreground)",
        muted: "var(--text-muted)",
        selected: "var(--text-selected)",
        border: "var(--border)",
      },
    },
  },
  plugins: [],
};

export default config;
