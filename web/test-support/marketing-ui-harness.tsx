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

function robotsMetaTagFromMetadata(metadata: { robots?: unknown } | undefined): string {
  const robots = metadata?.robots;
  if (!robots || typeof robots !== "object") {
    return "";
  }

  const directives: string[] = [];
  const robotsRecord = robots as Record<string, boolean | string | undefined>;
  if (robotsRecord.index === false) {
    directives.push("noindex");
  }
  if (robotsRecord.follow === false) {
    directives.push("nofollow");
  }

  if (directives.length === 0) {
    return "";
  }

  return `<meta name="robots" content="${directives.join(", ")}">`;
}

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
    case "render-wiki": {
      const wikiModule = await import("../app/wiki/page");
      const html = renderToStaticMarkup(React.createElement(wikiModule.default));
      const robotsMeta = robotsMetaTagFromMetadata(wikiModule.metadata);
      const htmlWithHead = `${robotsMeta}${html}`;
      const text = htmlWithHead.replace(/<[^>]*>?/gm, " ");
      result = { visibleText: text, html: htmlWithHead };
      break;
    }
    default:
      throw new Error(`Unknown marketing UI harness command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main();
