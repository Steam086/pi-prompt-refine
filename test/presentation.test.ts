import { describe, expect, it } from "vitest";
import { matchesKey, parseKey } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../src/presentation.js";

describe("presentation helpers", () => {
  it("normalizes display-only CRLF and tabs without permitting cursor controls", () => {
    expect(sanitizeTerminalText("one\r\n\tcode\r\x1b[2J")).toBe("one\n    code��[2J");
  });

  it("recognizes Control+backslash without Kitty keyboard protocol", () => {
    expect(parseKey("\x1c")).toBe("ctrl+\\");
    expect(matchesKey("\x1c", "ctrl+\\")).toBe(true);
  });
});
