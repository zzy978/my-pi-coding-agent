import { describe, expect, it } from "vitest";
import { messageText, toolResultText, userFacingMessageText } from "../src/tui/message-format.js";

describe("TUI message formatting", () => {
  it("joins text blocks and ignores non-text content", () => {
    expect(messageText({ content: [
      { type: "text", text: "one" },
      { type: "image", data: "ignored" },
      { type: "text", text: " two" }
    ] })).toBe("one two");
  });

  it("hides the host task envelope from restored user messages", () => {
    const content = "Task ID: x\nObjective: y\n\nCurrent instruction:\nFix the parser";
    expect(userFacingMessageText({ content })).toBe("Fix the parser");
    expect(userFacingMessageText({ content: "ordinary prompt" })).toBe("ordinary prompt");
  });

  it("bounds tool output shown in the transcript", () => {
    expect(toolResultText({ content: [{ type: "text", text: "x".repeat(5_000) }] })).toHaveLength(4_000);
  });
});
