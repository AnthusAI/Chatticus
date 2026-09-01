import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        paper: "var(--paper)",
        "paper-raised": "var(--paper-raised)",
        ink: "var(--ink)",
        "ink-soft": "var(--ink-soft)",
        signal: "var(--signal)",
        clay: "var(--clay)",
        cobalt: "var(--cobalt)",
        sea: "var(--sea)",
        amber: "var(--amber)",
        line: "var(--line)",
      },
      fontFamily: {
        display: ["var(--font-display)"],
        body: ["var(--font-body)"],
        mono: ["var(--font-mono)"],
      },
      borderRadius: {
        shell: "2rem",
      },
      boxShadow: {
        hard: "8px 8px 0 var(--ink)",
        signal: "0 0 0 1px var(--signal), 0 24px 70px rgba(184, 243, 74, 0.14)",
      },
      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        drift: {
          "0%, 100%": { transform: "translate3d(0, 0, 0) rotate(-1deg)" },
          "50%": { transform: "translate3d(0, -8px, 0) rotate(1deg)" },
        },
        pulseRule: {
          "0%, 100%": { opacity: "0.28", transform: "scaleX(0.45)" },
          "50%": { opacity: "1", transform: "scaleX(1)" },
        },
        accordionDown: {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        accordionUp: {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        rise: "rise 700ms cubic-bezier(.22,.75,.18,1) both",
        drift: "drift 8s ease-in-out infinite",
        "pulse-rule": "pulseRule 2.8s ease-in-out infinite",
        "accordion-down": "accordionDown 220ms ease-out",
        "accordion-up": "accordionUp 220ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
