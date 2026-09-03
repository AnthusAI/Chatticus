"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  fetchWaitlistSurvey,
  submitWaitlist,
  WaitlistApiError,
  type PriceSensitivityAnswers,
  type WaitlistSurvey,
  type WaitlistSurveyQuestion,
} from "@/lib/waitlist-api";
import { FULL_WAITLIST_SURVEY_FIXTURE } from "@/lib/waitlist-survey-fixture";

type SurveyBlockKey =
  | "fit"
  | "aws_readiness"
  | "price"
  | "setup_path"
  | "price_sensitivity"
  | "professional_services_interest"
  | "training_interest";

type SurveyView = "loading" | "form" | "thank-you" | "rate-limited";

const SURVEY_BLOCK_ORDER: SurveyBlockKey[] = [
  "fit",
  "aws_readiness",
  "setup_path",
  "price_sensitivity",
  "professional_services_interest",
  "training_interest",
  "price",
];

const BLOCK_HEADINGS: Record<SurveyBlockKey, string> = {
  fit: "Fit",
  aws_readiness: "AWS readiness",
  price: "Pricing",
  setup_path: "Setup path",
  price_sensitivity: "Price sensitivity",
  professional_services_interest: "Professional services",
  training_interest: "Training",
};

const BLOCK_PAYLOAD_FIELDS: Record<
  SurveyBlockKey,
  "fit_answers" | "aws_readiness_answers" | "price_answers" | "setup_path_answers" | null
> = {
  fit: "fit_answers",
  aws_readiness: "aws_readiness_answers",
  price: "price_answers",
  setup_path: "setup_path_answers",
  price_sensitivity: null,
  professional_services_interest: "price_answers",
  training_interest: "price_answers",
};

type BetaWaitlistSurveyFormProps = {
  initialSurvey?: WaitlistSurvey;
  testView?: SurveyView;
};

function emptyAnswerState(): Record<SurveyBlockKey, Record<string, string>> {
  return {
    fit: {},
    aws_readiness: {},
    price: {},
    setup_path: {},
    price_sensitivity: {},
    professional_services_interest: {},
    training_interest: {},
  };
}

function hasAnyAnswer(answers: Record<SurveyBlockKey, Record<string, string>>): boolean {
  return SURVEY_BLOCK_ORDER.some((block) => Object.keys(answers[block]).length > 0);
}

function buildPayload(
  email: string,
  answers: Record<SurveyBlockKey, Record<string, string>>,
  complete: boolean,
): {
  email: string;
  fit_answers: Record<string, string>;
  aws_readiness_answers: Record<string, string>;
  price_answers: Record<string, string>;
  setup_path_answers: Record<string, string>;
  price_sensitivity_answers?: PriceSensitivityAnswers;
  complete: boolean;
} {
  const fit_answers = { ...answers.fit };
  const aws_readiness_answers = { ...answers.aws_readiness };
  const setup_path_answers = { ...answers.setup_path };
  const price_answers = {
    ...answers.price,
    ...answers.professional_services_interest,
    ...answers.training_interest,
  };

  let price_sensitivity_answers: PriceSensitivityAnswers | undefined;
  const priceSensitivity = answers.price_sensitivity;
  if (
    priceSensitivity.too_cheap ||
    priceSensitivity.bargain ||
    priceSensitivity.expensive ||
    priceSensitivity.too_expensive
  ) {
    price_sensitivity_answers = {
      too_cheap: priceSensitivity.too_cheap ?? "",
      bargain: priceSensitivity.bargain ?? "",
      expensive: priceSensitivity.expensive ?? "",
      too_expensive: priceSensitivity.too_expensive ?? "",
    };
  }

  return {
    email,
    fit_answers,
    aws_readiness_answers,
    price_answers,
    setup_path_answers,
    price_sensitivity_answers,
    complete,
  };
}

function SurveyQuestionField({
  block,
  question,
  value,
  onChange,
}: {
  block: SurveyBlockKey;
  question: WaitlistSurveyQuestion;
  value: string;
  onChange: (next: string) => void;
}) {
  const inputId = `survey-${block}-${question.id}`;

  if (question.choices && question.choices.length > 0) {
    return (
      <fieldset className="mt-4">
        <legend className="text-lg">{question.prompt}</legend>
        <div className="mt-3 flex flex-col gap-2">
          {question.choices.map((choice) => (
            <label
              key={choice}
              className="flex items-center gap-3 rounded-lg bg-[var(--surface-0)] p-3"
            >
              <input
                type="radio"
                name={inputId}
                value={choice}
                checked={value === choice}
                onChange={() => onChange(choice)}
              />
              <span>{choice}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  return (
    <label className="mt-4 block text-lg" htmlFor={inputId}>
      {question.prompt}
      <input
        id={inputId}
        name={inputId}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-3 w-full rounded-lg bg-[var(--surface-0)] p-3"
      />
    </label>
  );
}

export function BetaWaitlistSurveyForm({
  initialSurvey,
  testView,
}: BetaWaitlistSurveyFormProps) {
  const [survey, setSurvey] = useState<WaitlistSurvey | null>(initialSurvey ?? null);
  const [view, setView] = useState<SurveyView>(testView ?? "form");
  const [blocksLoading, setBlocksLoading] = useState(!initialSurvey);
  const [email, setEmail] = useState("");
  const [answers, setAnswers] = useState(emptyAnswerState);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const abandonedLeadCaptured = useRef(false);

  const visibleBlocks = useMemo(() => {
    if (!survey) {
      return [] as SurveyBlockKey[];
    }
    return SURVEY_BLOCK_ORDER.filter(
      (block) => survey[block] !== undefined && survey[block]!.length > 0,
    );
  }, [survey]);

  useEffect(() => {
    if (initialSurvey) {
      return;
    }
    let cancelled = false;
    void fetchWaitlistSurvey()
      .then((loadedSurvey) => {
        if (!cancelled) {
          setSurvey(loadedSurvey);
          setBlocksLoading(false);
          if (testView) {
            setView(testView);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSurvey({});
          setBlocksLoading(false);
          if (testView) {
            setView(testView);
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initialSurvey, testView]);

  const setBlockAnswer = useCallback(
    (block: SurveyBlockKey, questionId: string, value: string) => {
      setAnswers((current) => ({
        ...current,
        [block]: {
          ...current[block],
          [questionId]: value,
        },
      }));
    },
    [],
  );

  const captureAbandonedLead = useCallback(async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || abandonedLeadCaptured.current || hasAnyAnswer(answers)) {
      return;
    }
    abandonedLeadCaptured.current = true;
    try {
      await submitWaitlist(buildPayload(trimmedEmail, answers, false));
    } catch (error) {
      if (error instanceof WaitlistApiError && error.status === 429) {
        setView("rate-limited");
      }
    }
  }, [answers, email]);

  const handleEmailBlur = () => {
    void captureAbandonedLead();
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setSubmitError("Enter your work email to join the waitlist.");
      return;
    }
    try {
      await submitWaitlist(buildPayload(trimmedEmail, answers, true));
      setView("thank-you");
    } catch (error) {
      if (error instanceof WaitlistApiError && error.status === 429) {
        setView("rate-limited");
        return;
      }
      setSubmitError("Something went wrong. Try again in a moment.");
    }
  };

  if (view === "loading") {
    return <p className="mt-6 text-lg">Loading survey…</p>;
  }

  if (view === "thank-you") {
    return (
      <div className="mt-6" data-survey-view="thank-you">
        <p className="text-lg">
          Thank you for joining the beta waitlist. We will follow up at your work email.
        </p>
      </div>
    );
  }

  if (view === "rate-limited") {
    return (
      <div className="mt-6" data-survey-view="rate-limited">
        <p className="text-lg">
          Too many submissions from this network. Wait a few minutes and try again.
        </p>
      </div>
    );
  }

  return (
    <form className="mt-6" onSubmit={(event) => void handleSubmit(event)}>
      <label className="block text-lg" htmlFor="survey-email">
        Work email
        <input
          id="survey-email"
          name="survey-email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          onBlur={handleEmailBlur}
          className="mt-3 w-full rounded-lg bg-[var(--surface-0)] p-3"
        />
      </label>

      {blocksLoading ? <p className="mt-6 text-lg">Loading survey questions…</p> : null}

      {visibleBlocks.map((block) => {
        const questions = survey?.[block] ?? [];
        const payloadField = BLOCK_PAYLOAD_FIELDS[block];
        return (
          <section
            key={block}
            id={`survey-block-${block}`}
            aria-labelledby={`survey-block-${block}-heading`}
            className="mt-8"
          >
            <h3
              id={`survey-block-${block}-heading`}
              className="font-display text-2xl tracking-[-0.03em]"
            >
              {BLOCK_HEADINGS[block]}
            </h3>
            {questions.map((question) => (
              <SurveyQuestionField
                key={question.id}
                block={block}
                question={question}
                value={answers[block][question.id] ?? ""}
                onChange={(value) => setBlockAnswer(block, question.id, value)}
              />
            ))}
            {payloadField ? (
              <input type="hidden" name={`survey-payload-${payloadField}`} value={block} readOnly />
            ) : null}
          </section>
        );
      })}

      {submitError ? <p className="mt-4 text-lg text-signal">{submitError}</p> : null}

      <Button type="submit" className="mt-8">
        Join the waitlist
      </Button>
    </form>
  );
}

export { FULL_WAITLIST_SURVEY_FIXTURE };
