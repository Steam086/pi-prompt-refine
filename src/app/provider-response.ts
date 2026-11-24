import type { AssistantMessage, TextSignatureV1 } from "@earendil-works/pi-ai";

function textPhase(signature: string | undefined): TextSignatureV1["phase"] {
  if (!signature?.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(signature) as Partial<TextSignatureV1> | null;
    if (value?.v === 1 && typeof value.id === "string" &&
        (value.phase === "commentary" || value.phase === "final_answer")) return value.phase;
  } catch { /* Treat an unrecognized signature as unphased text. */ }
  return undefined;
}

export function finalResponseText(content: AssistantMessage["content"]): string {
  const final: string[] = [];
  const unphased: string[] = [];
  for (const block of content) {
    if (block.type !== "text") continue;
    const phase = textPhase(block.textSignature);
    if (phase === "final_answer") final.push(block.text);
    else if (phase !== "commentary") unphased.push(block.text);
  }
  return (final.length ? final : unphased).join("\n");
}
