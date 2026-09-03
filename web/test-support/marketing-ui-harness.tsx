import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import BetaPitchPage from "../app/beta/page";
import HomePage from "../app/page";

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
    default:
      throw new Error(`Unknown marketing UI harness command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main();
