import type { Hello, Mutation, Reply } from "../../src/app/api.js";
import type { SessionBus } from "../../src/adapters/session-events.js";
import { REQUEST_EVENT, RESPONSE_EVENT } from "../../src/adapters/wire.js";

let next = 0;
export function wireRequest<T>(bus: SessionBus, call: unknown, connectionId = "test-connection"): Promise<Reply<T>> {
  const requestId = `request-${++next}`;
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const off = bus.on(RESPONSE_EVENT, (data: any) => {
      if (data.connectionId !== connectionId || data.requestId !== requestId) return;
      if (data.part) {
        chunks[data.part.index] = data.part.text;
        if (chunks.filter((part) => part !== undefined).length !== data.part.total) return;
        off(); resolve(JSON.parse(Buffer.from(chunks.join(""), "base64").toString("utf8")));
      } else { off(); resolve(data.result); }
    });
    bus.emit(REQUEST_EVENT, { connectionId, requestId, call });
  });
}
export function wireMutation<T>(bus: SessionBus, hello: Hello, mutation: Mutation, operationId = `op-${++next}`) {
  return wireRequest<T>(bus, { action: "mutate", meta: { binding: hello.binding, clientLeaseId: hello.lease.id, operationId }, mutation });
}
export function requireValue<T>(reply: Reply<T>): T {
  if (reply.kind !== "ok") throw new Error(`${reply.kind}: ${reply.code}`);
  return reply.value;
}
