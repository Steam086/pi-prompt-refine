import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { HistoryItem } from "./context.js";

/** No provider-neutral tokenizer is available. One token per UTF-8 byte is a
 * deliberately conservative text estimate, not a provider-reported token count. */
export function estimateTextTokens(text: string): number { return Buffer.byteLength(text, "utf8"); }

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
export interface BudgetModel { contextWindow: number; maxTokens: number }
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

  // Reserve enough for a minimally edited full prompt, JSON escaping, title and
  // modest expansion. Revise must be able to return the entire previous result.
  const outputSize = Math.max(...[packet.draft ?? packet.original_draft ?? "", packet.previous_candidate ?? ""]
    .map((text) => estimateTextTokens(JSON.stringify({ prompt: text }))));
  const answerReserve = Math.ceil(outputSize * 1.25) + 256;
  const reasoning = thinkingLevel !== undefined && thinkingLevel !== "off";
  const desiredThinking = thinkingLevel === "minimal" ? 1024 : thinkingLevel === "low" ? 2048
    : thinkingLevel === "medium" ? 8192 : 16384;
  // Some adapters add thinking to maxTokens; others share it. Reserve for both
  // without depending on provider/model-name heuristics or disabling reasoning.
  const thinkingTokens = reasoning
    ? Math.min(desiredThinking, Math.floor(outputLimit / 4), Math.floor((outputLimit - answerReserve) / 2)) : 0;
  const minimumOutput = answerReserve + Math.max(0, thinkingTokens) * 2;
  if (answerReserve > outputLimit || (reasoning && thinkingTokens < 1024)) {
    return blocked(`full-prompt output reserve (${answerReserve} tokens${reasoning ? " plus reasoning" : ""}) exceeds the usable output limit (${outputLimit}).`);
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
    // Only after exhausting optional background, reduce surplus output room.
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
  return { report, input, maxTokens: report.outputTokens - thinkingTokens,
    ...(reasoning ? { thinkingBudgets: { minimal: thinkingTokens, low: thinkingTokens, medium: thinkingTokens, high: thinkingTokens } } : {}) };
}
