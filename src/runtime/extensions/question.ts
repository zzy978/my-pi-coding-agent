/**
 * Question Tool - Single question with options
 * Full custom UI: options list + inline editor for "自行输入.."
 * Escape in editor returns to options, Escape in options cancels
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { dialogCompletion } from "./dialog-completion.js";

interface OptionWithDesc {
  label: string;
  description?: string;
}

type DisplayOption = OptionWithDesc & { isOther?: boolean };

interface QuestionDetails {
  question: string;
  options: string[];
  answer: string | null;
  wasCustom?: boolean;
}

// Options with labels and optional descriptions
const OptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
});

export default function question(pi: ExtensionAPI) {
  pi.registerTool({
    name: "question",
    label: "向你提问",
    description: "Ask the user a question and let them pick from options. Use when you need user input to proceed.",
    parameters: QuestionParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const signal = _signal && ctx.signal ? AbortSignal.any([_signal, ctx.signal]) : _signal ?? ctx.signal;
      if (signal?.aborted) return {
        content: [{ type: "text", text: "提问已中止，未取得用户回答。" }],
        details: { question: params.question, options: [], answer: null } as QuestionDetails
      };
      if (ctx.mode !== "tui") {
        return {
          content: [{ type: "text", text: "当前模式没有交互界面，未取得用户回答。" }],
          details: {
            question: params.question,
            options: params.options.map((o) => o.label),
            answer: null,
          } as QuestionDetails,
        };
      }

      if (params.options.length === 0) {
        return {
          content: [{ type: "text", text: "未提供可选项。" }],
          details: { question: params.question, options: [], answer: null } as QuestionDetails,
        };
      }

      const allOptions: DisplayOption[] = [...params.options, { label: "自行输入", isOther: true }];

      const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
        (tui, theme, _kb, resolve) => {
          const { done, dispose } = dialogCompletion<{ answer: string; wasCustom: boolean; index?: number } | null>(signal, resolve, null);
          let optionIndex = 0;
          let editMode = false;
          let cachedLines: string[] | undefined;
          let cachedWidth: number | undefined;

          const editorTheme: EditorTheme = {
            borderColor: (s) => theme.fg("accent", s),
            selectList: {
              selectedPrefix: (t) => theme.fg("accent", t),
              selectedText: (t) => theme.fg("accent", t),
              description: (t) => theme.fg("muted", t),
              scrollInfo: (t) => theme.fg("dim", t),
              noMatch: (t) => theme.fg("warning", t),
            },
          };
          const editor = new Editor(tui, editorTheme);

          editor.onSubmit = (value) => {
            const trimmed = value.trim();
            if (trimmed) {
              done({ answer: trimmed, wasCustom: true });
            } else {
              editMode = false;
              editor.setText("");
              refresh();
            }
          };

          function refresh() {
            cachedLines = undefined;
            tui.requestRender();
          }

          function handleInput(data: string) {
            if (editMode) {
              if (matchesKey(data, Key.escape)) {
                editMode = false;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            if (matchesKey(data, Key.up)) {
              optionIndex = Math.max(0, optionIndex - 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
              refresh();
              return;
            }

            if (matchesKey(data, Key.enter)) {
              const selected = allOptions[optionIndex];
              if (!selected) return;
              if (selected.isOther) {
                editMode = true;
                refresh();
              } else {
                done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 });
              }
              return;
            }

            if (matchesKey(data, Key.escape)) {
              done(null);
            }
          }

          function render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;
            cachedWidth = width;

            const lines: string[] = [];
            const renderWidth = Math.max(1, width);

            function addWrapped(text: string) {
              lines.push(...wrapTextWithAnsi(text, renderWidth));
            }

            function addWrappedWithPrefix(prefix: string, text: string) {
              const prefixWidth = visibleWidth(prefix);
              if (prefixWidth >= renderWidth) {
                addWrapped(prefix + text);
                return;
              }
              const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
              const continuationPrefix = " ".repeat(prefixWidth);
              for (let i = 0; i < wrapped.length; i++) {
                lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
              }
            }

            lines.push(theme.fg("accent", "─".repeat(renderWidth)));
            addWrappedWithPrefix(" ", theme.fg("text", params.question));
            lines.push("");

            for (let i = 0; i < allOptions.length; i++) {
              const opt = allOptions[i];
              if (!opt) continue;
              const selected = i === optionIndex;
              const isOther = opt.isOther === true;
              const prefix = selected ? theme.fg("accent", "> ") : "  ";
              const label = `${i + 1}. ${opt.label}${isOther && editMode ? " ✎" : ""}`;
              const color = selected || (isOther && editMode) ? "accent" : "text";

              addWrappedWithPrefix(prefix, theme.fg(color, label));

              // Show description if present
              if (opt.description) {
                addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
              }
            }

            if (editMode) {
              lines.push("");
              addWrappedWithPrefix(" ", theme.fg("muted", "你的回答："));
              for (const line of editor.render(Math.max(1, renderWidth - 2))) {
                lines.push(` ${line}`);
              }
            }

            lines.push("");
            if (editMode) {
              addWrappedWithPrefix(" ", theme.fg("dim", "Enter 提交 · Esc 返回"));
            } else {
              addWrappedWithPrefix(" ", theme.fg("dim", "↑↓ 选择 · Enter 确认 · Esc 取消"));
            }
            lines.push(theme.fg("accent", "─".repeat(renderWidth)));

            cachedLines = lines;
            return lines;
          }

          return {
            dispose,
            render,
            invalidate: () => {
              cachedLines = undefined;
            },
            handleInput,
          };
        },
      );

      // Build simple options list for details
      const simpleOptions = params.options.map((o) => o.label);

      if (!result) {
        return {
          content: [{ type: "text", text: "用户已取消，未作出选择。" }],
          details: { question: params.question, options: simpleOptions, answer: null } as QuestionDetails,
        };
      }

      if (result.wasCustom) {
        return {
          content: [{ type: "text", text: `用户输入： ${result.answer}` }],
          details: {
            question: params.question,
            options: simpleOptions,
            answer: result.answer,
            wasCustom: true,
          } as QuestionDetails,
        };
      }
      return {
        content: [{ type: "text", text: `用户选择： ${result.index}. ${result.answer}` }],
        details: {
          question: params.question,
          options: simpleOptions,
          answer: result.answer,
          wasCustom: false,
        } as QuestionDetails,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
      const opts = Array.isArray(args.options) ? args.options : [];
      if (opts.length) {
        const labels = opts.map((o: OptionWithDesc) => o.label);
        const numbered = [...labels, "自行输入"].map((o, i) => `${i + 1}. ${o}`);
        text += `\n${theme.fg("dim", `  选项： ${numbered.join(", ")}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as QuestionDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      if (details.answer === null) {
        return new Text(theme.fg("warning", "已取消"), 0, 0);
      }

      if (details.wasCustom) {
        return new Text(
          theme.fg("success", "✓ ") + theme.fg("muted", "（自行输入）") + theme.fg("accent", details.answer),
          0,
          0,
        );
      }
      const idx = details.options.indexOf(details.answer) + 1;
      const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
      return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
    },
  });
}


