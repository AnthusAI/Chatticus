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

export type ClassElement = { attributes: Record<string, string>; text: string; innerHtml: string };

function attributesOfTag(attributeText: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of attributeText.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g)) attributes[match[1]] = match[2];
  return attributes;
}

/** Every element of rendered markup that has the class among its classes, with its attributes, text and inner markup, in order of opening. */
export function elementsWithClassOfMarkup(html: string, className: string): ClassElement[] {
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g;
  const stack: Array<{ start: number; attributes: Record<string, string> | null; order: number }> = [];
  const found: Array<ClassElement & { order: number }> = [];
  let order = 0;
  for (let match = tagPattern.exec(html); match !== null; match = tagPattern.exec(html)) {
    const [whole, closing, , attributeText, selfClosing] = match;
    if (closing === "/") {
      const open = stack.pop();
      if (open && open.attributes !== null) {
        const innerHtml = html.slice(open.start, match.index);
        found.push({ attributes: open.attributes, text: textOfMarkup(innerHtml), innerHtml, order: open.order });
      }
      continue;
    }
    if (selfClosing === "/") continue;
    const attributes = attributesOfTag(attributeText);
    const matches = (attributes.class ?? "").split(/\s+/).includes(className);
    order += 1;
    stack.push({ start: match.index + whole.length, attributes: matches ? attributes : null, order });
  }
  return found.sort((left, right) => left.order - right.order).map(({ attributes, text, innerHtml }) => ({ attributes, text, innerHtml }));
}
