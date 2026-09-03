import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import HomePage from "../app/page";

(globalThis as any).React = React;

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  let result = {};

  switch (command) {
    case "render":
      const html = renderToStaticMarkup(React.createElement(HomePage));
      // Very basic HTML tag removal to just get text content.
      // Replacing tags with spaces helps ensure words don't merge.
      const text = html.replace(/<[^>]*>?/gm, ' ');
      result = { visibleText: text };
      break;
    default:
      throw new Error(`Unknown marketing UI harness command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main();
