import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const EXPLORATION_TOOLS = new Set(["read", "grep", "find", "ls", "question", "questionnaire"]);

/** One owner for tool selection: plan mode always intersects the selected preset. */
export class WorkflowTools {
  constructor(private readonly allowShell: boolean) {}
  planning = false;
  private selected: string[] = [];

  initialize(pi: ExtensionAPI): void {
    this.selected = pi.getActiveTools();
  }

  getSelected(): string[] {
    return [...this.selected];
  }

  isAllowed(name: string): boolean {
    if (name !== "bash" && name !== "powershell") return true;
    return this.allowShell && name === (process.platform === "win32" ? "powershell" : "bash");
  }

  select(pi: ExtensionAPI, names: string[]): void {
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    this.selected = [...new Set(names)].filter((name) => available.has(name) && this.isAllowed(name));
    this.apply(pi);
  }

  apply(pi: ExtensionAPI): void {
    pi.setActiveTools(this.selected.filter((name) => !this.planning || EXPLORATION_TOOLS.has(name)));
  }
}
