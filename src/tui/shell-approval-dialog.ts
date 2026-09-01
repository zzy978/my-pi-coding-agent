import chalk from "chalk";
import { Container, SelectList, Text, type Component } from "@earendil-works/pi-tui";
import type { ShellApprovalRequest } from "../policy/shell-approval.js";
import { selectListTheme } from "./theme.js";

function boundedCommand(command: string, maximum = 1_200): string {
  let visible = "";
  for (const character of command) {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafeControl = (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069);
    visible += unsafeControl ? `\\u${codePoint.toString(16).padStart(4, "0")}` : character;
  }
  return visible.length <= maximum ? visible : `${visible.slice(0, maximum - 1)}…`;
}

export class ShellApprovalDialog implements Component {
  private readonly container = new Container();
  private readonly list: SelectList;
  onDecision?: (approved: boolean) => void;

  constructor(request: ShellApprovalRequest) {
    this.list = new SelectList([
      { value: "deny", label: "Deny", description: "Do not execute this command" },
      { value: "approve", label: "Approve once", description: "Execute this command one time" }
    ], 2, selectListTheme);
    this.list.setSelectedIndex(0);
    this.list.onSelect = (item) => this.onDecision?.(item.value === "approve");
    this.list.onCancel = () => this.onDecision?.(false);
    this.container.addChild(new Text(chalk.yellow.bold("Deletion approval required"), 1, 0));
    this.container.addChild(new Text(`${request.reason}:\n\n${boundedCommand(request.command)}`, 1, 0));
    this.container.addChild(this.list);
    this.container.addChild(new Text(chalk.dim("↑↓ navigate • Enter confirm • Esc deny"), 1, 0));
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
