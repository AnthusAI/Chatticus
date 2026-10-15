import type { MembershipBranch } from "./membership-state";
import type { SignupMode } from "./signup-mode";

export type MembershipView =
  | "sign-in"
  | "create-organization"
  | "invitation-only"
  | "welcome"
  | "enabled-workspace"
  | "loading";

export const WELCOME_SCREEN_TITLE = "Welcome to Chatticus";

export const WELCOME_SCREEN_LINES = [
  "Your organization is pending AWS cross-account setup.",
  "Run the Chatticus cross-account CloudFormation template in your AWS account, then submit your account id and RoleArn below.",
] as const;

export const CROSS_ACCOUNT_SELF_SETUP_FORM_TITLE =
  "Submit AWS account and RoleArn";

export function welcomeScreenText(): string {
  return [WELCOME_SCREEN_TITLE, ...WELCOME_SCREEN_LINES].join("\n");
}

export function resolveMembershipView(
  branch: MembershipBranch,
  signupMode: SignupMode,
): MembershipView {
  if (branch === "signed-out") {
    return "sign-in";
  }
  if (branch === "no-org") {
    return signupMode === "open" ? "create-organization" : "invitation-only";
  }
  if (branch === "pending") {
    return "welcome";
  }
  if (branch === "enabled") {
    return "enabled-workspace";
  }
  return "sign-in";
}

export function membershipViewText(view: MembershipView): string {
  switch (view) {
    case "create-organization":
      return "Create your organization";
    case "invitation-only":
      return "No organization\nAsk an operator to invite you before using the workspace.";
    case "welcome":
      return welcomeScreenText();
    case "sign-in":
      return "Sign in with Google";
    case "enabled-workspace":
      return "Workspace";
    case "loading":
      return "Loading membership";
  }
}
