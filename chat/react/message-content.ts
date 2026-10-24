type AppendContentPart = { type: string; text?: string };

export function textFromAppendMessageContent(
  content: readonly AppendContentPart[],
): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}
