import chalk from "chalk";
import { Container, SelectList, Text, type Component } from "@earendil-works/pi-tui";
import type { StoredSessionInfo } from "../runtime/session-store.js";
import { selectListTheme } from "./theme.js";

function compact(text: string, maximum = 72): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= maximum ? singleLine : `${singleLine.slice(0, maximum - 1)}…`;
}

export class SessionPicker implements Component {
  private readonly container = new Container();
  private readonly list: SelectList;
  private readonly sessionsByPath: Map<string, StoredSessionInfo>;
  onSelect?: (session: StoredSessionInfo) => void;
  onCancel?: () => void;

  constructor(sessions: StoredSessionInfo[], currentSessionId?: string) {
    this.sessionsByPath = new Map(sessions.map((session) => [session.path, session]));
    this.list = new SelectList(sessions.map((session) => ({
      value: session.path,
      label: session.name?.trim() ? `${session.name.trim()} (${session.id.slice(0, 8)})` : session.id,
      description: `${session.modified.toLocaleString()} • ${session.materialized ? `${session.messageCount} messages` : "empty"} • ${compact(session.objective ?? session.firstMessage)}`
    })), Math.min(sessions.length, 10), selectListTheme);
    const currentIndex = sessions.findIndex((session) => session.id === currentSessionId);
    if (currentIndex >= 0) this.list.setSelectedIndex(currentIndex);
    this.list.onSelect = (item) => {
      const session = this.sessionsByPath.get(item.value);
      if (session) this.onSelect?.(session);
    };
    this.list.onCancel = () => this.onCancel?.();
    this.container.addChild(new Text(chalk.cyan.bold("Switch session"), 1, 0));
    this.container.addChild(this.list);
    this.container.addChild(new Text(chalk.dim("↑↓ navigate • Enter switch • Esc cancel"), 1, 0));
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }
}
