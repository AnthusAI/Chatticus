export type SignupMode = "open" | "invitation_only";

export function parseSignupMode(value: string | undefined): SignupMode {
  if (value?.trim().toLowerCase() === "open") {
    return "open";
  }
  return "invitation_only";
}

export function readSignupModeFromEnv(): SignupMode {
  return parseSignupMode(process.env.NEXT_PUBLIC_CHATTICUS_SIGNUP_MODE);
}
