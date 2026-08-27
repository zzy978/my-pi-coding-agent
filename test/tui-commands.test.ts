import { describe, expect, it } from "vitest";
import { parseTuiCommand } from "../src/tui/commands.js";

describe("TUI commands", () => {
  it("leaves normal prompts untouched", () => {
    expect(parseTuiCommand("fix the tests")).toBeNull();
  });

  it.each([
    ["/task improve parser", { type: "task", value: "improve parser" }],
    ["/allow src/**", { type: "allow", value: "src/**" }],
    ["/verify-add npm test", { type: "verify-add", value: "npm test" }],
    ["/EXIT", { type: "quit" }],
    ["/something", { type: "unknown", name: "something" }]
  ])("parses %s", (input, expected) => {
    expect(parseTuiCommand(input)).toEqual(expected);
  });
});

