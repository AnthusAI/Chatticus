export type TestElement = { testId: string; text: string };

/** The text of rendered markup with the tags, entities and runs of white space taken out. */
export function textOfMarkup(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every element of rendered markup that carries a data-testid, with its text, in order of closing. */
export function testElementsOfMarkup(html: string): TestElement[] {
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g;
  const stack: Array<{ start: number; testId: string | null }> = [];
  const found: TestElement[] = [];
  for (let match = tagPattern.exec(html); match !== null; match = tagPattern.exec(html)) {
    const [whole, closing, , attributes, selfClosing] = match;
    if (closing === "/") {
      const open = stack.pop();
      if (open && open.testId !== null) found.push({ testId: open.testId, text: textOfMarkup(html.slice(open.start, match.index)) });
      continue;
    }
    if (selfClosing === "/") continue;
    stack.push({ start: match.index + whole.length, testId: /data-testid="([^"]*)"/.exec(attributes)?.[1] ?? null });
  }
  return found;
}
