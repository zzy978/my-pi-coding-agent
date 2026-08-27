import chalk from "chalk";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  Markdown,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TuiMainScreen,
  type TUI
} from "@earendil-works/pi-tui";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiRuntime } from "../runtime/pi-runtime.js";
import type { TaskSpec } from "../task/task-spec.js";
import { formatTaskPrompt } from "../task/task-spec.js";
import type { WorkspaceInfo } from "../workspace/git.js";
import { getDiff } from "../workspace/git.js";
import { formatVerificationSummary, runVerification, type VerificationReport } from "../verifier/verifier.js";
import { writeRunReport } from "../report/report.js";
import { COMMAND_HELP, parseTuiCommand, type TuiCommand } from "./commands.js";
import { messageText, toolResultText, userFacingMessageText } from "./message-format.js";
import { editorTheme, markdownTheme } from "./theme.js";

interface TuiAppOptions {
  runtime: PiRuntime;
  task: TaskSpec;
  workspace: WorkspaceInfo;
  initialPrompt?: string;
}

export class CodingAgentTui {
  private readonly tui: TUI;
  private readonly editor: Editor;
  private readonly transcript = new Container();
  private readonly header: Text;
  private readonly status = new Text("Ready", 1, 0);
  private readonly toolComponents = new Map<string, Text>();
  private assistantComponent: Markdown | undefined;
  private assistantText = "";
  private busy = false;
  private shuttingDown = false;
  private unsubscribe?: () => void;

  constructor(private readonly options: TuiAppOptions) {
    const terminal = new ProcessTerminal();
    this.tui = new TuiMainScreen(terminal);
    this.header = new Text(this.headerText(), 1, 1);
    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
      { name: "task", description: "Set task objective" },
      { name: "allow", description: "Add an allowed path glob" },
      { name: "verify-add", description: "Add a verification command" },
      { name: "run", description: "Run the current objective" },
      { name: "verify", description: "Run verification commands" },
      { name: "diff", description: "Show Git changes" },
      { name: "status", description: "Show runtime status" },
      { name: "abort", description: "Abort current turn" },
      { name: "clear", description: "Clear visible transcript" },
      { name: "quit", description: "Exit safely" }
    ], this.options.workspace.workspace));
    this.editor.onSubmit = (value) => {
      this.editor.setText("");
      void this.handleInput(value).catch((error: unknown) => this.showError(error));
    };

    this.tui.addChild(this.header);
    this.tui.addChild(this.transcript);
    this.tui.addChild(this.status);
    this.tui.addChild(this.editor);
    this.tui.addChild(new Text(chalk.dim("Enter: send  •  Shift+Enter: newline  •  Esc: abort  •  Ctrl+C: abort/quit  •  /help"), 1, 0));
    this.tui.setFocus(this.editor);

    this.tui.addInputListener((data) => {
      if (matchesKey(data, Key.escape) && this.busy) {
        void this.abortActive();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("c"))) {
        if (this.busy) void this.abortActive();
        else void this.shutdown();
        return { consume: true };
      }
      return undefined;
    });
  }

  start(): void {
    this.renderRestoredMessages();
    this.unsubscribe = this.options.runtime.subscribe((event) => this.handleEvent(event));
    for (const diagnostic of this.options.runtime.diagnostics) {
      this.addPlain(`${diagnostic.type.toUpperCase()}: ${diagnostic.message}`, diagnostic.type === "error" ? "error" : "info");
    }
    if (this.options.runtime.modelFallbackMessage) {
      this.addPlain(`Model notice: ${this.options.runtime.modelFallbackMessage}`, "warning");
    }
    this.addPlain(`Workspace: ${this.options.workspace.workspace}\nBranch: ${this.options.workspace.branch}`, "info");
    this.tui.start();
    const initialPrompt = this.options.initialPrompt;
    if (initialPrompt) {
      setTimeout(() => {
        void this.runPrompt(initialPrompt).catch((error: unknown) => this.showError(error));
      }, 0);
    }
  }

  private headerText(): string {
    const model = this.options.runtime.session.model;
    const modelText = model ? `${model.provider}/${model.id}` : "no model";
    const isolation = this.options.workspace.managedWorktree ? "managed worktree" : "in-place";
    return chalk.bold.cyan("PI TUI CODING AGENT") + `  ${modelText}  •  ${isolation}  •  ${this.options.workspace.branch}`;
  }

  private renderRestoredMessages(): void {
    const messages = this.options.runtime.session.state.messages.slice(-40);
    if (!messages.length) return;
    this.addPlain(`Restored ${messages.length} recent session message(s).`, "info");
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text = message.role === "user" ? userFacingMessageText(message) : messageText(message);
      if (text) this.addMarkdown(message.role === "user" ? `**You**\n\n${text}` : `**Agent**\n\n${text}`);
    }
  }

  private handleEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.setStatus("Agent is working…");
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          this.assistantText = "";
          this.assistantComponent = this.addMarkdown("**Agent**\n\n");
        }
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          this.assistantText += event.assistantMessageEvent.delta;
          this.assistantComponent?.setText(`**Agent**\n\n${this.assistantText}`);
          this.tui.requestRender();
        } else if (event.assistantMessageEvent.type === "thinking_delta") {
          this.setStatus("Agent is reasoning…");
        }
        break;
      case "message_end":
        if (event.message.role === "assistant" && this.assistantComponent) {
          const finalText = messageText(event.message);
          if (finalText) this.assistantComponent.setText(`**Agent**\n\n${finalText}`);
          this.assistantComponent = undefined;
          this.assistantText = "";
          this.tui.requestRender();
        }
        break;
      case "tool_execution_start": {
        const component = new Text(chalk.yellow(`▶ ${event.toolName}`) + ` ${JSON.stringify(event.args).slice(0, 500)}`, 1, 0);
        this.toolComponents.set(event.toolCallId, component);
        this.transcript.addChild(component);
        this.setStatus(`Running tool: ${event.toolName}`);
        break;
      }
      case "tool_execution_end": {
        const component = this.toolComponents.get(event.toolCallId);
        const label = event.isError ? chalk.red(`✗ ${event.toolName}`) : chalk.green(`✓ ${event.toolName}`);
        component?.setText(`${label}\n${chalk.dim(toolResultText(event.result))}`);
        this.toolComponents.delete(event.toolCallId);
        this.tui.requestRender();
        break;
      }
      case "compaction_start":
        this.setStatus("Compacting context…");
        break;
      case "auto_retry_start":
        this.setStatus(`Retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms…`);
        break;
      case "agent_settled":
        this.setStatus("Agent settled; preparing verification…");
        break;
      default:
        break;
    }
  }

  private async handleInput(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return;
    const command = parseTuiCommand(trimmed);
    if (command) {
      await this.handleCommand(command);
      return;
    }
    await this.runPrompt(trimmed);
  }

  private async handleCommand(command: TuiCommand): Promise<void> {
    switch (command.type) {
      case "help": this.addPlain(COMMAND_HELP, "info"); break;
      case "quit": await this.shutdown(); break;
      case "abort": await this.abortActive(); break;
      case "verify": await this.verifyAndReport(); break;
      case "diff": this.addPlain(await getDiff(this.options.workspace.workspace), "info"); break;
      case "status": this.showStatus(); break;
      case "clear":
        this.transcript.children.splice(0, this.transcript.children.length);
        this.tui.requestRender();
        break;
      case "run": await this.runPrompt(this.options.task.objective); break;
      case "task":
        if (!command.value) this.addPlain("Usage: /task <objective>", "warning");
        else {
          this.options.task.objective = command.value;
          this.addPlain(`Task objective updated: ${command.value}`, "info");
        }
        break;
      case "allow":
        if (!command.value) this.addPlain("Usage: /allow <glob>", "warning");
        else if (!this.options.task.allowedPaths.includes(command.value)) {
          this.options.task.allowedPaths.push(command.value);
          this.addPlain(`Allowed path added: ${command.value}`, "info");
        }
        break;
      case "verify-add":
        if (!command.value) this.addPlain("Usage: /verify-add <command>", "warning");
        else {
          this.options.task.verify.push({ command: command.value, timeoutMs: 120_000 });
          this.addPlain(`Verification command added: ${command.value}`, "info");
        }
        break;
      case "unknown": this.addPlain(`Unknown command: /${command.name}. Use /help.`, "warning"); break;
    }
  }

  private async runPrompt(instruction: string): Promise<void> {
    if (this.busy) {
      this.addPlain("A turn or verification is already running.", "warning");
      return;
    }
    if (this.options.task.objective === "Interactive coding task") this.options.task.objective = instruction;
    this.addMarkdown(`**You**\n\n${instruction}`);
    this.setBusy(true);
    try {
      await this.options.runtime.prompt(formatTaskPrompt(this.options.task, instruction));
      await this.verifyAndReport(true);
    } finally {
      this.setBusy(false);
    }
  }

  private async verifyAndReport(alreadyBusy = false): Promise<VerificationReport | undefined> {
    if (this.busy && !alreadyBusy) {
      this.addPlain("A turn or verification is already running.", "warning");
      return undefined;
    }
    if (!alreadyBusy) this.setBusy(true);
    try {
      const report = await runVerification(
        this.options.workspace.workspace,
        this.options.task,
        (command, index, total) => this.setStatus(`Verifying ${index + 1}/${total}: ${command}`)
      );
      const summary = formatVerificationSummary(report);
      this.addPlain(summary, report.success ? "success" : "warning");
      const model = this.options.runtime.session.model;
      const paths = await writeRunReport({
        version: 1,
        createdAt: new Date().toISOString(),
        task: this.options.task,
        workspace: this.options.workspace,
        sessionId: this.options.runtime.session.sessionId,
        ...(this.options.runtime.session.sessionFile ? { sessionFile: this.options.runtime.session.sessionFile } : {}),
        ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
        verification: report
      });
      this.addPlain(`Report: ${paths.markdownPath}`, "info");
      this.setStatus(report.success ? "Ready • last verification passed" : "Ready • last verification incomplete/failed");
      return report;
    } catch (error) {
      this.showError(error);
      return undefined;
    } finally {
      if (!alreadyBusy) this.setBusy(false);
    }
  }

  private showStatus(): void {
    const stats = this.options.runtime.session.getSessionStats();
    const model = this.options.runtime.session.model;
    this.addPlain([
      `Task: ${this.options.task.objective}`,
      `Allowed: ${this.options.task.allowedPaths.join(", ")}`,
      `Verifiers: ${this.options.task.verify.map((item) => item.command).join("; ") || "not configured"}`,
      `Workspace: ${this.options.workspace.workspace}`,
      `Branch: ${this.options.workspace.branch}`,
      `Model: ${model ? `${model.provider}/${model.id}` : "not configured"}`,
      `Session: ${stats.sessionId}`,
      `Tokens: ${stats.tokens.total}`,
      `Cost: $${stats.cost.toFixed(4)}`
    ].join("\n"), "info");
  }

  private async abortActive(): Promise<void> {
    if (!this.busy) {
      this.addPlain("Nothing is running.", "info");
      return;
    }
    this.setStatus("Aborting…");
    await this.options.runtime.abort();
    this.setBusy(false);
    this.addPlain("Active turn aborted.", "warning");
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    this.editor.disableSubmit = value;
    if (!value && !this.shuttingDown) this.setStatus("Ready");
    this.tui.requestRender();
  }

  private setStatus(text: string): void {
    this.status.setText(chalk.dim(text));
    this.tui.requestRender();
  }

  private addMarkdown(text: string): Markdown {
    const component = new Markdown(text, 1, 1, markdownTheme);
    this.transcript.addChild(component);
    this.tui.requestRender();
    return component;
  }

  private addPlain(text: string, kind: "info" | "warning" | "error" | "success"): void {
    const color = kind === "error" ? chalk.red : kind === "warning" ? chalk.yellow : kind === "success" ? chalk.green : chalk.white;
    this.transcript.addChild(new Text(color(text), 1, 1));
    this.transcript.addChild(new Spacer(1));
    this.tui.requestRender();
  }

  private showError(error: unknown): void {
    this.addPlain(error instanceof Error ? error.message : String(error), "error");
    this.setBusy(false);
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.editor.disableSubmit = true;
    try {
      await this.options.runtime.abort();
    } finally {
      this.unsubscribe?.();
      this.options.runtime.dispose();
      this.tui.stop();
    }
  }
}
