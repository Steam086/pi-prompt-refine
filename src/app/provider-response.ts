import type { AssistantMessage, TextSignatureV1 } from "@earendil-works/pi-ai";

function textPhase(signature: string | undefined): TextSignatureV1["phase"] {
  if (!signature?.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(signature) as Partial<TextSignatureV1> | null;
    if (value?.v === 1 && typeof value.id === "string" &&
        (value.phase === "commentary" || value.phase === "final_answer")) return value.phase;
  } catch { return undefined; }
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

const transportCodes = new Set([
  "EAI_AGAIN", "ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED",
  "ENETDOWN", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH", "EPIPE", "ETIMEDOUT",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const transportMessages = [
  /^(?:socket hang up|other side closed|connection reset by peer)\b/i,
  /^connect timeout error\b/i,
  /^websocket stream closed before response\.completed\b/i,
  /^client network socket disconnected before secure TLS connection was established\b/i,
  /^(?:self-signed certificate|certificate has expired|unable to verify the first certificate)\b/i,
  /^(?:unable to get local issuer certificate|hostname\/IP does not match certificate's altnames)\b/i,
];

function hasTransportMessage(message: string): boolean {
  // Pi flattens transport causes into errorMessage. Match the leading cause,
  // since an HTTP error body can contain arbitrary text, including socket codes.
  const cause = message.trimStart().replace(/^(?:(?:fetch failed|terminated|connection error\.?|request to \S+ failed, reason):[ \t]*)+/i, "");
  const code = /^(?:(?:read|write|connect|getaddrinfo) )?([A-Z][A-Z0-9_]*)(?=$|[\s:])/.exec(cause)?.[1];
  return (code !== undefined && transportCodes.has(code)) || transportMessages.some((pattern) => pattern.test(cause));
}

function isHttpFailure(status: unknown): boolean {
  return typeof status === "number" && status >= 400 && status < 600;
}

export function isTransportError(error: unknown, httpStatus?: number): boolean {
  // Some SDK adapters unwrap the HTTP body into the error message. The last
  // HTTP failure makes a text-only diagnostic ambiguous, including after retries.
  const classifyMessage = !isHttpFailure(httpStatus);
  if (typeof error === "string") return classifyMessage && hasTransportMessage(error);
  // A thrown SDK error can still carry Node's structured code on its cause.
  for (let depth = 0; error instanceof Error && depth < 5; depth++, error = error.cause) {
    if (("status" in error && isHttpFailure(error.status)) ||
        ("statusCode" in error && isHttpFailure(error.statusCode))) return false;
    if (("code" in error && typeof error.code === "string" && transportCodes.has(error.code)) ||
        (classifyMessage && hasTransportMessage(error.message))) return true;
  }
  return false;
}
