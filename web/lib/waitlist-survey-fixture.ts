import type { WaitlistSurvey } from "./waitlist-api";

/** Full survey fixture for harness rendering and survey-form tests. */
export const FULL_WAITLIST_SURVEY_FIXTURE: WaitlistSurvey = {
  fit: [
    {
      id: "team_size",
      prompt: "How many people in your organization would use Chatticus?",
    },
    {
      id: "work_description",
      prompt:
        "Describe the work you want Chatticus to help with. Include enough detail that we can understand your use case.",
      multiline: true,
    },
  ],
  aws_readiness: [
    {
      id: "has_aws_account",
      prompt: "Do you already have an AWS account for this deployment?",
      choices: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    },
  ],
  setup_path: [
    {
      id: "preferred_path",
      prompt: "Which setup path do you prefer?",
      choices: [
        { value: "self-setup", label: "Self-setup" },
        { value: "assisted setup", label: "Assisted setup" },
      ],
    },
  ],
  price_sensitivity: [
    {
      id: "too_cheap",
      prompt:
        "At what total monthly cost — including AWS infrastructure and model token usage — would Chatticus feel so inexpensive that you would question its quality?",
    },
    {
      id: "bargain",
      prompt:
        "At what total monthly cost — including AWS and model tokens — would Chatticus feel like a bargain?",
    },
    {
      id: "expensive",
      prompt:
        "At what total monthly cost — including AWS and model tokens — would Chatticus start to feel expensive?",
    },
    {
      id: "too_expensive",
      prompt:
        "At what total monthly cost — including AWS and model tokens — would Chatticus feel too expensive?",
    },
  ],
  professional_services_interest: [
    {
      id: "professional_services_interest",
      prompt:
        "Are you interested in optional professional services from Anthus AI Solutions?",
      choices: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    },
  ],
  training_interest: [
    {
      id: "training_interest",
      prompt:
        "Are you interested in optional professional training from Anthus AI Solutions?",
      choices: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    },
  ],
};
