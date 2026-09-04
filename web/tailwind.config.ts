import type { Config } from "tailwindcss";
import chatticusTailwindPreset from "./tailwind-preset";

const config: Config = {
  presets: [chatticusTailwindPreset as Config],
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  plugins: [],
};

export default config;
