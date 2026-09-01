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
import type { InteractiveSessionTarget, TuiSessionController } from "../runtime/interactive-sessions.js";
import type { TaskSpec } from "../task/task-spec.js";
import { formatTaskPrompt, INTERACTIVE_TASK_OBJECTIVE } from "../task/task-spec.js";
import type { WorkspaceInfo } from "../workspace/git.js";
import { getDiff } from "../workspace/git.js";
import { formatVerificationSummary, runVerification, type VerificationReport } from "../verifier/verifier.js";
import { writeRunReport } from "../report/report.js";
import { COMMAND_HELP, parseTuiCommand, type TuiCommand } from "./commands.js";
import { messageText, toolResultText, userFacingMessageText } from "./message-format.js";
import { editorTheme, markdownTheme } from "./theme.js";
import { SessionPicker } from "./session-picker.js";

interface TuiAppOptions {
  runtime: PiRuntime;
  task: TaskSpec;
  workspace: WorkspaceInfo;
  sessionController?: TuiSessionController;
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
  private initialPromptTimer: ReturnType<typeof setTimeout> | undefined;
  private nextTurnId = 0;
  private activeTurnId: number | undefined;
  private activePhase: "prompt" | "verification" | undefined;
  private readonly abortedTurns = new Set<number>();
  private runtime: PiRuntime;

  constructor(private readonly options: TuiAppOptions) {
    this.runtime = options.runtime;
    const terminal = new ProcessTerminal();
    this.tui = new TuiMainScreen(terminal);
    this.header = new Text(this.headerText(), 1, 1);
    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
      { name: "task", description: "Set task objective" },
      { name: "allow", description: "Add an allowed path glob" },
      { name: "verify-add", description: "Add a verification command" },
      { name: "run", description: "Run the current objective" },
      { name: "new", description: "New session" },
      { name: "temp", description: "Temporary session" },
      { name: "sessions", description: "Switch session" },
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
    this.unsubscribe = this.runtime.subscribe((event) => this.handleEvent(event));
    for (const diagnostic of this.runtime.diagnostics) {
      this.addPlain(`${diagnostic.type.toUpperCase()}: ${diagnostic.message}`, diagnostic.type === "error" ? "error" : "info");
    }
    if (this.runtime.modelFallbackMessage) {
      this.addPlain(`Model notice: ${this.runtime.modelFallbackMessage}`, "warning");
    }
    this.addPlain(`Workspace: ${this.options.workspace.workspace}\nBranch: ${this.options.workspace.branch}`, "info");
    this.tui.start();
    const initialPrompt = this.options.initialPrompt;
    if (initialPrompt) {
      this.initialPromptTimer = setTimeout(() => {
        this.initialPromptTimer = undefined;
        if (this.shuttingDown) return;
        void this.runPrompt(initialPrompt).catch((error: unknown) => this.showError(error));
      }, 0);
    }
  }

  private headerText(): string {
    const model = this.runtime.session.model;
    const modelText = model ? `${model.provider}/${model.id}` : "no model";
    const isolation = this.options.workspace.managedWorktree ? "managed worktree" : "current checkout";
    return chalk.bold.cyan("PI TUI CODING AGENT") + `  ${modelText}  •  ${isolation}  •  ${this.options.workspace.branch}`;
  }

  private renderRestoredMessages(): void {
    const messages = this.runtime.session.state.messages.slice(-40);
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
      case "new": await this.replaceSession({ type: "new" }, "Started new persistent session"); break;
      case "temp": await this.replaceSession({ type: "temporary" }, "Started temporary session"); break;
      case "sessions": await this.showSessions(command.value); break;
      case "task":
        if (!command.value) this.addPlain("Usage: /task <objective>", "warning");
        else {
          await this.setConversationObjective(command.value);
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

  private async showSessions(sessionId: string): Promise<void> {
    if (this.busy) {
      this.addPlain("A turn or verification is already running.", "warning");
      return;
    }
    const controller = this.options.sessionController;
    if (!controller) {
      this.addPlain("Session switching is not available in this run.", "warning");
      return;
    }
    this.setBusy(true);
    let sessions;
    try {
      sessions = await controller.list();
    } finally {
      this.setBusy(false);
    }
    if (!sessions.length) {
      this.addPlain("No persistent sessions are available for this workspace.", "info");
      return;
    }
    if (sessionId) {
      const exact = sessions.find((session) => session.id === sessionId);
      const matches = exact ? [exact] : sessions.filter((session) => session.id.startsWith(sessionId));
      if (matches.length === 0) {
        this.addPlain(`No session matches ${sessionId}.`, "warning");
        return;
      }
      if (matches.length > 1) {
        this.addPlain(`Session ID prefix ${sessionId} is ambiguous.`, "warning");
        return;
      }
      const selected = matches[0];
      if (selected) await this.switchToStoredSession(selected);
      return;
    }
    const picker = new SessionPicker(sessions, this.runtime.session.sessionId);
    const overlay = this.tui.showOverlay(picker, { anchor: "center", width: "90%" });
    picker.onCancel = () => {
      overlay.hide();
      this.tui.setFocus(this.editor);
    };
    picker.onSelect = (session) => {
      overlay.hide();
      this.tui.setFocus(this.editor);
      void this.switchToStoredSession(session).catch((error: unknown) => this.showError(error));
    };
  }

  private async switchToStoredSession(session: Awaited<ReturnType<TuiSessionController["list"]>>[number]): Promise<void> {
    if (session.id === this.runtime.session.sessionId) {
      this.addPlain(`Session ${session.id} is already active.`, "info");
      return;
    }
    await this.replaceSession({ type: "open", session }, `Switched to session ${session.id}`);
    if (session.cwd && session.cwd !== this.options.workspace.workspace) {
      this.addPlain(
        "Conversation context was restored into the current workspace; files and branch state were not restored from the previous workspace.",
        "warning"
      );
    }
  }

  private async replaceSession(target: InteractiveSessionTarget, notice: string): Promise<void> {
    if (this.busy) {
      this.addPlain("A turn or verification is already running.", "warning");
      return;
    }
    const controller = this.options.sessionController;
    if (!controller) {
      this.addPlain("Session switching is not available in this run.", "warning");
      return;
    }
    const currentModel = this.runtime.session.model;
    const preferences = target.type === "open" ? undefined : {
      ...(currentModel ? { model: { provider: currentModel.provider, id: currentModel.id } } : {}),
      thinkingLevel: this.runtime.session.thinkingLevel
    };
    this.setBusy(true);
    let replacement: PiRuntime;
    try {
      replacement = await controller.create(target, preferences);
    } catch (error) {
      this.setBusy(false);
      throw error;
    }
    let replacementSubscription: () => void;
    try {
      replacementSubscription = replacement.subscribe((event) => this.handleEvent(event));
    } catch (error) {
      replacement.dispose();
      this.setBusy(false);
      throw error;
    }
    const previous = this.runtime;
    this.unsubscribe?.();
    this.runtime = replacement;
    this.options.task.objective = replacement.conversationObjective || INTERACTIVE_TASK_OBJECTIVE;
    this.unsubscribe = replacementSubscription;
    previous.dispose();
    this.resetTranscript();
    this.header.setText(this.headerText());
    this.addPlain(`${notice}: ${this.runtime.session.sessionId}`, "info");
    this.renderRestoredMessages();
    this.setBusy(false);
  }

  private resetTranscript(): void {
    this.transcript.children.splice(0, this.transcript.children.length);
    this.toolComponents.clear();
    this.assistantComponent = undefined;
    this.assistantText = "";
    this.tui.requestRender();
  }

  private async runPrompt(instruction: string): Promise<void> {
    if (this.shuttingDown) return;
    if (this.busy) {
      this.addPlain("A turn or verification is already running.", "warning");
      return;
    }
    if (this.options.task.objective === INTERACTIVE_TASK_OBJECTIVE) {
      await this.setConversationObjective(instruction);
    }
    this.addMarkdown(`**You**\n\n${instruction}`);
    const turnId = ++this.nextTurnId;
    this.activeTurnId = turnId;
    this.activePhase = "prompt";
    this.setBusy(true);
    try {
      await this.runtime.prompt(formatTaskPrompt(this.options.task, instruction));
      if (this.shuttingDown || this.abortedTurns.has(turnId) || this.activeTurnId !== turnId) return;
      this.activePhase = "verification";
      await this.verifyAndReport(true);
    } finally {
      this.abortedTurns.delete(turnId);
      if (this.activeTurnId === turnId) {
        this.activeTurnId = undefined;
        this.activePhase = undefined;
        this.setBusy(false);
      }
    }
  }

  private async setConversationObjective(objective: string): Promise<void> {
    const normalized = objective.trim() || INTERACTIVE_TASK_OBJECTIVE;
    const controller = this.options.sessionController;
    if (controller) await controller.updateObjective(this.runtime, normalized);
    else this.runtime.setConversationObjective?.(normalized);
    this.options.task.objective = normalized;
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
      const model = this.runtime.session.model;
      const paths = await writeRunReport({
        version: 1,
        createdAt: new Date().toISOString(),
        task: this.options.task,
        workspace: this.options.workspace,
        sessionId: this.runtime.session.sessionId,
        ...(this.runtime.session.sessionFile ? { sessionFile: this.runtime.session.sessionFile } : {}),
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
    const stats = this.runtime.session.getSessionStats();
    const model = this.runtime.session.model;
    this.addPlain([
      `Task: ${this.options.task.objective}`,
      `Allowed: ${this.options.task.allowedPaths.join(", ")}`,
      `Verifiers: ${this.options.task.verify.map((item) => item.command).join("; ") || "not configured"}`,
      `Workspace: ${this.options.workspace.workspace}`,
      `Branch: ${this.options.workspace.branch}`,
      `Model: ${model ? `${model.provider}/${model.id}` : "not configured"}`,
      `Session: ${stats.sessionId}`,
      `Session mode: ${this.runtime.session.sessionFile ? "persistent" : "temporary"}`,
      `Tokens: ${stats.tokens.total}`,
      `Cost: $${stats.cost.toFixed(4)}`
    ].join("\n"), "info");
  }

  private async abortActive(): Promise<void> {
    if (!this.busy) {
      this.addPlain("Nothing is running.", "info");
      return;
    }
    if (this.activePhase === "verification" || this.activeTurnId === undefined) {
      this.addPlain("Verification is already running and cannot be aborted safely.", "warning");
      return;
    }
    this.abortedTurns.add(this.activeTurnId);
    this.setStatus("Aborting…");
    await this.runtime.abort();
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
    if (this.initialPromptTimer) {
      clearTimeout(this.initialPromptTimer);
      this.initialPromptTimer = undefined;
    }
    if (this.activeTurnId !== undefined) this.abortedTurns.add(this.activeTurnId);
    this.editor.disableSubmit = true;
    try {
      await this.runtime.abort();
    } finally {
      this.unsubscribe?.();
      this.runtime.dispose();
      this.tui.stop();
    }
  }
}
