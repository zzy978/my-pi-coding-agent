export function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; text: string } =>
      Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string")
    .map((item) => item.text)
    .join("");
}

export function userFacingMessageText(message: unknown): string {
  const text = messageText(message);
  const marker = "\n\nCurrent instruction:\n";
  const markerIndex = text.lastIndexOf(marker);
  return markerIndex === -1 ? text : text.slice(markerIndex + marker.length);
}

export function toolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "(no result)";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return JSON.stringify(result).slice(0, 1200);
  const text = content
    .filter((item): item is { type: "text"; text: string } =>
      Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string")
    .map((item) => item.text)
    .join("\n");
  return (text || "(no text result)").slice(0, 4000);
}

