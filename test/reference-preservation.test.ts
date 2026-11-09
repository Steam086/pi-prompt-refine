import { describe, expect, it } from "vitest";
import { buildRefineInput, buildRefineSystemPrompt, selectHistory } from "../src/context.js";
import { minimalEditInstruction, screen, screenDraft } from "./fixtures/reference-preservation.js";

const message = (role: string, text: string) => ({ type: "message", message: { role, content: [{ type: "text", text }] } });

describe("draft reference versus external background", () => {
  it("serializes the complete literal screenshot inside draft with and without editing instructions", () => {
    const history = selectHistory([message("assistant", "Unrelated earlier proposal")], 12, 2000);
    for (const instruction of [undefined, minimalEditInstruction]) {
      const packet = JSON.parse(buildRefineInput(screenDraft, history, "Unrelated project rules", undefined, instruction));
      expect(packet.draft).toBe(screenDraft);
      expect(packet.draft).toContain(screen);
      expect(packet.project_context).toBe("Unrelated project rules");
      expect(packet.conversation.items[0].text).toContain("Unrelated earlier proposal");
      expect(packet.editing_instruction).toBe(instruction);
    }
  });

  it("keeps source/background boundaries in the fixed protocol even with custom editing policy", () => {
    for (const policy of [undefined, "Prefer shorter prompts."]) {
      const prompt = buildRefineSystemPrompt(false, policy);
      expect(prompt).toContain("The entire draft field is the user's current message");
      expect(prompt).toContain("including any pasted screenshot, terminal output, log, example, or quoted reference");
      expect(prompt).toContain("unless the user explicitly asks to remove or edit that material");
      expect(prompt).toContain("this does not permit removing content from the draft field");
      expect(prompt).toContain("Avoid copying extra conversation or project background");
    }
  });
});
