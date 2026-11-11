import type { Hello, Mutation, Reply } from "../../src/app/api.js";
import type { SessionBus } from "../../src/adapters/session-events.js";
import { REQUEST_EVENT, RESPONSE_EVENT } from "../../src/adapters/wire.js";

let next = 0;
export function wirePacket(bus: SessionBus, call: unknown, connectionId = "test-connection"): Promise<any> {
  const requestId = `request-${++next}`;
  return new Promise((resolve) => {
    const off = bus.on(RESPONSE_EVENT, (data: any) => {
      if (data.connectionId !== connectionId || data.requestId !== requestId) return;
      off(); resolve(data.result);
    });
    bus.emit(REQUEST_EVENT, { connectionId, requestId, call });
  });
}
export async function wireRequest<T>(bus: SessionBus, call: unknown, connectionId = "test-connection"): Promise<Reply<T>> {
  const reply = await wirePacket(bus, call, connectionId);
  if (!reply?.output) return reply;
  const chunks: string[] = [];
  try {
    for (let index = 0; index < 2048; index++) {
      const result = await wirePacket(bus, { action: "readOutput", outputId: reply.output.id, index }, connectionId);
      if (!result.part || result.part.index !== index) throw new Error(result.code ?? "Invalid output page");
      chunks.push(result.part.text);
      if (result.part.done) return JSON.parse(Buffer.from(chunks.join(""), "base64").toString("utf8"));
    }
    throw new Error("Output limit reached");
  } finally { await wirePacket(bus, { action: "releaseOutput", outputId: reply.output.id }, connectionId); }
}
export function wireMutation<T>(bus: SessionBus, hello: Hello, mutation: Mutation, operationId = `op-${++next}`) {
  return wireRequest<T>(bus, { action: "mutate", meta: { binding: hello.binding, clientLeaseId: hello.lease.id, operationId }, mutation });
}
export function requireValue<T>(reply: Reply<T>): T {
  if (reply.kind !== "ok") throw new Error(`${reply.kind}: ${reply.code}`);
  return reply.value;
}
