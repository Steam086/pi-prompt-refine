/** Recognize only a small set of direct, whole-reference editing requests.
 * Questions, negations and requests to change UI elements are not authorization
 * to discard the pasted source. Unknown wording deliberately fails closed. */
function requestsRemoval(text: string): boolean {
  const chinese = /^(?:请)?(?:删除|删掉|去掉|移除|省略|不保留)(?:整个|全部|这张|这段|上述|下面的|上面的)?(?:截图|屏幕截图|表格|原文|引用|参考材料)$/u;
  const english = /^(?:please\s+)?(?:remove|omit|drop|delete)\s+(?:(?:the|this|entire|whole|pasted|following|above|below)\s+)*(?:screenshot|table|reference)(?:\s+from\s+(?:the\s+)?prompt)?$/iu;
  // Split sentences, but retain question marks and only inspect the leading
  // clause: "discuss whether ..., remove ..." must not become an imperative.
  return text.split(/[\n。！!；;.]/u).some((sentence) => {
    const directive = sentence.split(/[,，:：]/u)[0].trim();
    // Pasted TUI footers sometimes share their final line with "请…".
    // Accept that polite imperative only without discussion/question qualifiers.
    const polite = /(?:^|\s)(请[^\n]+)$/u.exec(directive)?.[1];
    const hypothetical = /讨论|分析|评估|能否|是否|可否|[?？]|\b(?:discuss|whether|could|should|can)\b/iu.test(directive);
    return !hypothetical && (chinese.test(polite ?? directive) || english.test(directive));
  });
}

function rewritingInstructions(instruction: string): string {
  let task = false;
  return instruction.split("\n").filter((line) => {
    if (/^(?:Prompt rewriting instructions|Saved editing requirements|Main-agent task requirements) \(manually selected\):$|^Current user instructions:$/u.test(line)) {
      task = line.startsWith("Main-agent task requirements");
      return false;
    }
    return !task;
  }).join("\n");
}

/** Fail conservatively when a refine result drops almost all of a pasted TUI
 * screenshot. This is not a general semantic verifier: unknown formats and
 * intentional source edits remain the model/user's responsibility. */
export function preserveDroppedTuiReference(draft: string, result: string, editingInstruction = ""): { text: string; restored: boolean } {
  const lines = draft.split("\n").filter((line) => line.includes("│") && line.trim().length >= 24);
  if (lines.length < 3 || result.length * 2 >= draft.length) return { text: result, restored: false };

  // Inspect both sides of the table, never its cells. Initial manual rewriting
  // requirements can also authorize removal; main-agent task requirements cannot.
  const surrounding = draft.slice(0, draft.indexOf(lines[0])) + "\n" +
    draft.slice(draft.lastIndexOf(lines.at(-1)!) + lines.at(-1)!.length);
  const instructions = surrounding + "\n" + rewritingInstructions(editingInstruction);
  // Contradictory/negative requests are deliberately left for explicit Revise.
  const preserve = /(?:不要|别|禁止|不得).{0,20}(?:删除|删掉|去掉|移除|省略)|(?<!不)保留.{0,12}(?:截图|原文|引用|参考)|\b(?:do not|don't|never)\s+(?:remove|omit|drop|delete)|\b(?:keep|preserve|retain)\s+(?:(?:the|this|entire|whole|pasted)\s+)*(?:screenshot|table|reference)/iu.test(instructions);
  if (!preserve && requestsRemoval(instructions)) return { text: result, restored: false };

  const retained = lines.filter((line) => result.includes(line.trimEnd())).length;
  if (retained * 2 >= lines.length) return { text: result, restored: false };
  return { text: draft, restored: true };
}
