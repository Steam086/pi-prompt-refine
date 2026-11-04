import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { HistoryItem } from "./context.js";

/** A practical heuristic, not a tokenizer or a provider-reported count.
 * UTF-8 bytes / 3 avoids treating each Chinese character as three tokens. */
export function estimateTextTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, "utf8") / 3); }

export interface BudgetReport {
  status: "ok" | "trimmed" | "blocked";
  inputTokens: number;
  outputTokens: number;
  safetyTokens: number;
  contextWindow: number;
  outputLimit: number;
  removedMessages: number;
  removedProjectParts: string[];
  message?: string;
}
export interface BudgetModel { contextWindow: number; maxTokens: number; api?: string }
interface Packet {
  draft?: string;
  original_draft?: string;
  previous_candidate?: string;
  revision_instruction?: string;
  project_context: string | null;
  conversation: {
    status: string;
    selected_message_count: number;
    omitted_message_count: number;
    excerpted_message_count: number;
    items: HistoryItem[];
  };
  budget_omissions?: string[];
}
export interface BudgetResult {
  report: BudgetReport;
  input: string;
  /** streamSimple may add the explicitly bounded thinking budget to this value. */
  maxTokens: number;
  thinkingBudgets?: { minimal: number; low: number; medium: number; high: number };
}

/** Budget the actual serialized input, not history.text or the character caps.
 * Work on a copy: a smaller model must not destroy the round/retry source. */
export function budgetRequest(systemPrompt: string, preparedInput: string, model: BudgetModel,
  configuredOutputLimit: number, thinkingLevel?: ModelThinkingLevel): BudgetResult {
  const packet = JSON.parse(preparedInput) as Packet;
  let input = preparedInput;
  const validLimit = (n: number): boolean => Number.isSafeInteger(n) && n > 0;
  const contextWindow = validLimit(model.contextWindow) ? model.contextWindow : 0;
  const outputLimit = validLimit(model.maxTokens) && validLimit(configuredOutputLimit)
    ? Math.min(model.maxTokens, configuredOutputLimit) : 0;
  // Covers message framing, provider-added instructions and tokenizer uncertainty.
  // At least the host streamSimple adapter's own 4096-token safety allowance.
  const safetyTokens = 4096 + Math.ceil(contextWindow * 0.01);
  const inputSize = (): number => estimateTextTokens(systemPrompt) + estimateTextTokens(input);
  const report: BudgetReport = { status: "ok", inputTokens: inputSize(), outputTokens: outputLimit,
    safetyTokens, contextWindow, outputLimit, removedMessages: 0, removedProjectParts: [] };
  const blocked = (reason: string): BudgetResult => {
    report.status = "blocked";
    report.inputTokens = inputSize();
    report.message = `Request not sent: ${reason} Draft unchanged. Use a larger-capacity model, shorten the input yourself, or adjust the output limit.`;
    return { report, input, maxTokens: 0 };
  };
  if (!contextWindow || !outputLimit) return blocked("model context/output limits are missing or invalid.");

  // Prefer room for the full result, but do not reject requests based on an
  // estimated answer length: rewriting can shorten it, and tokenization varies.
  const outputSize = Math.max(...[packet.draft ?? packet.original_draft ?? "", packet.previous_candidate ?? ""]
    .map((text) => estimateTextTokens(JSON.stringify({ prompt: text }))));
  const preferredAnswer = Math.ceil(outputSize * 1.25) + 256;
  const reasoning = thinkingLevel !== undefined && thinkingLevel !== "off";
  // Match the host adapters' answer-room floor when thinking is enabled.
  const minimumAnswer = Math.min(reasoning ? 1024 : 256, outputLimit);
  const desiredThinking = thinkingLevel === "minimal" ? 1024 : thinkingLevel === "low" ? 2048
    : thinkingLevel === "medium" ? 8192 : 16384;
  // Anthropic/Bedrock streamSimple adapters add thinking to maxTokens; other
  // adapters share the supplied ceiling. Do not reserve the same thinking twice.
  const additiveThinking = model.api === "anthropic-messages" || model.api === "bedrock-converse-stream";
  const thinkingTokens = reasoning
    ? Math.min(desiredThinking, Math.max(1024, Math.floor(outputLimit / 4)), outputLimit - minimumAnswer) : 0;
  const minimumOutput = minimumAnswer + thinkingTokens;
  if (reasoning && thinkingTokens < 1024) {
    return blocked(`output limit (${outputLimit}) leaves insufficient room for reasoning and an answer; increase maxOutputTokens or turn thinking off.`);
  }

  const refresh = (): void => {
    if (report.removedMessages) {
      const history = packet.conversation;
      history.status = "partial";
      history.selected_message_count = history.items.length;
      history.excerpted_message_count = history.items.filter((item) => item.status === "excerpted").length;
    }
    packet.budget_omissions = [
      ...report.removedProjectParts.map((part) => `${part} omitted by request token budget`),
      ...(report.removedMessages ? [`${report.removedMessages} additional history messages omitted by request token budget`] : []),
    ];
    input = JSON.stringify(packet);
    report.inputTokens = inputSize();
  };
  const fits = (): boolean => report.inputTokens + report.outputTokens + safetyTokens <= contextWindow;
  const removeProjectPart = (marker: string, label: string): void => {
    const index = packet.project_context?.indexOf(marker) ?? -1;
    if (index < 0) return;
    packet.project_context = packet.project_context!.slice(0, index);
    report.removedProjectParts.push(label);
    refresh();
  };
  // Give up surplus output allowance before discarding useful background.
  if (!fits()) {
    report.outputTokens = Math.min(outputLimit, Math.max(minimumOutput, preferredAnswer + thinkingTokens,
      contextWindow - report.inputTokens - safetyTokens));
  }
  if (!fits()) removeProjectPart("\n\nPROJECT TREE (names only, partial):\n", "project tree");
  if (!fits()) removeProjectPart("\n\nMAIN AGENT SKILLS (metadata only; not optimizer tools):\n", "skill metadata");

  const items = packet.conversation.items;
  const newestFirst = [...items].reverse();
  const latestUser = newestFirst.find((item) => item.role === "user");
  const latestAssistant = newestFirst.find((item) => item.role === "assistant");
  const removeMessage = (item: HistoryItem): void => {
    items.splice(items.indexOf(item), 1);
    report.removedMessages++;
    packet.conversation.omitted_message_count++;
    refresh();
  };
  // Whole messages only: avoid introducing additional broken constraints/code.
  for (const item of [...items]) {
    if (fits()) break;
    if (item !== latestUser && item !== latestAssistant) removeMessage(item);
  }
  if (!fits() && packet.project_context) {
    packet.project_context = null;
    report.removedProjectParts.push("remaining project context (including rules)");
    refresh();
  }
  for (const item of [latestAssistant, latestUser]) {
    if (fits()) break;
    if (item && items.includes(item)) removeMessage(item);
  }
  if (!fits()) {
    // After exhausting optional background, even the preferred full-answer
    // allowance is negotiable. Mandatory input is never cut.
    report.outputTokens = Math.min(outputLimit, contextWindow - report.inputTokens - safetyTokens);
    if (report.outputTokens < minimumOutput) {
      report.outputTokens = minimumOutput;
      return blocked(`input (${report.inputTokens}) + minimum output (${minimumOutput}) + safety (${safetyTokens}) exceeds context window (${contextWindow}).`);
    }
  }
  if (report.removedMessages || report.removedProjectParts.length) {
    report.status = "trimmed";
    report.message = `Budget trimmed background: ${report.removedMessages} history messages; ${report.removedProjectParts.join(", ") || "no project sections"}. Draft unchanged.`;
  }
  return { report, input, maxTokens: report.outputTokens - (additiveThinking ? thinkingTokens : 0),
    ...(reasoning ? { thinkingBudgets: { minimal: thinkingTokens, low: thinkingTokens, medium: thinkingTokens, high: thinkingTokens } } : {}) };
}
