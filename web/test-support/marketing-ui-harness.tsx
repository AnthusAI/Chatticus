import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import BetaPitchPage from "../app/beta/page";
import ContactServicesPage from "../app/contact/services/page";
import ContactTrainingPage from "../app/contact/training/page";
import HomePage from "../app/page";
import {
  BetaWaitlistSurveyForm,
  FULL_WAITLIST_SURVEY_FIXTURE,
} from "../components/BetaWaitlistSurveyForm";

(globalThis as any).React = React;

(AccordionPrimitive.Content as any).defaultProps = {
  ...((AccordionPrimitive.Content as any).defaultProps || {}),
  forceMount: true,
};

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  let result = {};

  switch (command) {
    case "render":
    case "render-beta": {
      const page = command === "render-beta" ? BetaPitchPage : HomePage;
      const html = renderToStaticMarkup(React.createElement(page));
      const text = html.replace(/<[^>]*>?/gm, " ");
      result = { visibleText: text, html: html };
      break;
    }
    case "render-beta-survey": {
      const html = renderToStaticMarkup(
        React.createElement(BetaWaitlistSurveyForm, {
          initialSurvey: FULL_WAITLIST_SURVEY_FIXTURE,
        }),
      );
      const text = html.replace(/<[^>]*>?/gm, " ");
      result = { visibleText: text, html };
      break;
    }
    case "render-beta-survey-thank-you": {
      const html = renderToStaticMarkup(
        React.createElement(BetaWaitlistSurveyForm, {
          initialSurvey: FULL_WAITLIST_SURVEY_FIXTURE,
          testView: "thank-you",
        }),
      );
      const text = html.replace(/<[^>]*>?/gm, " ");
      result = { visibleText: text, html };
      break;
    }
    case "render-beta-survey-rate-limited": {
      const html = renderToStaticMarkup(
        React.createElement(BetaWaitlistSurveyForm, {
          initialSurvey: FULL_WAITLIST_SURVEY_FIXTURE,
          testView: "rate-limited",
        }),
      );
      const text = html.replace(/<[^>]*>?/gm, " ");
      result = { visibleText: text, html };
      break;
    }
    case "render-contact-services": {
      const html = renderToStaticMarkup(React.createElement(ContactServicesPage));
      const text = html.replace(/<[^>]*>?/gm, " ");
      result = { visibleText: text, html };
      break;
    }
    case "render-contact-training": {
      const html = renderToStaticMarkup(React.createElement(ContactTrainingPage));
      const text = html.replace(/<[^>]*>?/gm, " ");
      result = { visibleText: text, html };
      break;
    }
    case "render-updates": {
      const { default: UpdatesPage } = await import("../app/updates/page");
      const html = renderToStaticMarkup(React.createElement(UpdatesPage));
      const text = html.replace(/<[^>]*>?/gm, " ");
      result = { visibleText: text, html };
      break;
    }
    case "render-agent-zoo": {
      const { default: AgentZooPage } = await import("../app/agent-zoo/page");
      const html = renderToStaticMarkup(React.createElement(AgentZooPage));
      const text = html.replace(/<[^>]*>?/gm, " ");
      result = { visibleText: text, html };
      break;
    }
    default:
      throw new Error(`Unknown marketing UI harness command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main();
