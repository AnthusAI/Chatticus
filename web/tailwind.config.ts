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
        ink: "var(--ink)",
        "ink-soft": "var(--ink-soft)",
        signal: "var(--signal)",
        clay: "var(--clay)",
        cobalt: "var(--cobalt)",
        sea: "var(--sea)",
        amber: "var(--amber)",
        surface: "var(--surface-0)",
        "surface-raised": "var(--surface-1)",
        "surface-high": "var(--surface-2)",
        "surface-foreground": "var(--surface-foreground)",
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
        signal: "0 0 0 1px var(--signal), 0 24px 70px rgba(255, 212, 0, 0.14)",
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
        highlightSweep: {
          // Text color rides along with the sweep (ink-soft, matching the
          // surrounding paragraph and adaptive to light/dark mode, up to
          // fixed ink once the signal-yellow fill lands) instead of being
          // fixed dark from the start -- a fixed dark color would be
          // unreadable against a dark-mode page during the pre-sweep
          // delay, when the background is still transparent.
          "0%": { backgroundSize: "0% 88%", color: "var(--ink-soft)" },
          "100%": { backgroundSize: "100% 88%", color: "var(--ink)" },
        },
        typingBounce: {
          "0%, 80%, 100%": { transform: "translateY(0)", opacity: "0.4" },
          "40%": { transform: "translateY(-3px)", opacity: "1" },
        },
        pop: {
          "0%": { transform: "scale(0.4)", opacity: "0" },
          "60%": { transform: "scale(1.08)", opacity: "1" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
      },
      animation: {
        rise: "rise 700ms cubic-bezier(.22,.75,.18,1) both",
        drift: "drift 8s ease-in-out infinite",
        "pulse-rule": "pulseRule 2.8s ease-in-out infinite",
        "accordion-down": "accordionDown 220ms ease-out",
        "accordion-up": "accordionUp 220ms ease-out",
        "highlight-sweep": "highlightSweep 650ms cubic-bezier(.4,0,.2,1) both",
        "typing-bounce": "typingBounce 1.1s ease-in-out infinite",
        pop: "pop 320ms cubic-bezier(.22,.75,.18,1) both",
      },
    },
  },
  plugins: [],
};

export default config;
