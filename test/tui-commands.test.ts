import { describe, expect, it } from "vitest";
import { COMMAND_HELP, parseTuiCommand } from "../src/tui/commands.js";

describe("TUI commands", () => {
  it("leaves normal prompts untouched", () => {
    expect(parseTuiCommand("fix the tests")).toBeNull();
  });

  it.each([
    ["/task improve parser", { type: "task", value: "improve parser" }],
    ["/allow src/**", { type: "allow", value: "src/**" }],
    ["/verify-add npm test", { type: "verify-add", value: "npm test" }],
    ["/new", { type: "new" }],
    ["/TEMP", { type: "temp" }],
    ["/sessions", { type: "sessions", value: "" }],
    ["/sessions 019abc", { type: "sessions", value: "019abc" }],
    ["/EXIT", { type: "quit" }],
    ["/something", { type: "unknown", name: "something" }]
  ])("parses %s", (input, expected) => {
    expect(parseTuiCommand(input)).toEqual(expected);
  });

  it("documents the interactive session commands", () => {
    expect(COMMAND_HELP).toContain("/new                    New session");
    expect(COMMAND_HELP).toContain("/temp                   Temporary session");
    expect(COMMAND_HELP).toContain("/sessions [session-id]  Switch session");
  });
});
