import { FlatCompat } from "@eslint/eslintrc";

const compatibility = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const config = [
  ...compatibility.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [".next/**", "out/**", "node_modules/**", "next-env.d.ts"],
  },
];

export default config;
