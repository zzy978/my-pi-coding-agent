export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

export function extractTodoItems(text: string): TodoItem[] {
  const header = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:Plan|计划|实施计划)(?:\*\*)?\s*[:：]?(?:\*\*)?\s*$/im.exec(text);
  if (!header) return [];
  const section = text.slice(header.index + header[0].length).split(/\n\s*#{1,6}\s/)[0] ?? "";
  const items: TodoItem[] = [];
  for (const match of section.matchAll(/^\s*\d+[.)、]\s+(.+)$/gm)) {
    const value = match[1]?.trim();
    if (value) items.push({ step: items.length + 1, text: value, completed: false });
  }
  return items;
}

export function markCompletedSteps(text: string, items: TodoItem[]): void {
  for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
    const item = items.find((item) => item.step === Number(match[1]));
    if (item) item.completed = true;
  }
}
