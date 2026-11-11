import { describe, expect, it, vi } from "vitest";
import { outputChunks, OUTPUT_BYTES, retainedBytes } from "../../src/adapters/json-output.js";

describe("lazy JSON output encoding", () => {
  it("round-trips Unicode, split/unpaired surrogates, escapes and optional fields", () => {
    const value = { text: "a".repeat(4095) + "😀" + "\ud800\udc00\ud800x\udc00\u0000\"\\\n中".repeat(8000),
      omitted: undefined, nested: [null, undefined, 1, true, { optional: undefined }] };
    const chunks = [...outputChunks(value)];
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.length).toBe(OUTPUT_BYTES);
    const encoded = chunks.map((chunk) => chunk.toString("base64")).join("");
    expect(Buffer.from(encoded, "base64")).toEqual(Buffer.concat(chunks));
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual(JSON.parse(JSON.stringify(value)));
  });
  it("encodes only bounded string fragments, not the complete escaped document", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const iterator = outputChunks({ text: "\u0000".repeat(2_097_152) });
      expect(stringify).not.toHaveBeenCalled();
      expect(iterator.next().value?.length).toBe(OUTPUT_BYTES);
      expect(stringify.mock.calls.every(([value]) => typeof value !== "string" || value.length <= 4096)).toBe(true);
      expect(stringify.mock.calls.length).toBeLessThan(10);
      iterator.return(undefined);
    } finally { stringify.mockRestore(); }
  });
  it("rejects retained-data capacity and cycles without constructing encoded output", () => {
    expect(retainedBytes({ text: "small" }, 1000)).toBeLessThan(1000);
    expect(() => retainedBytes({ text: "x".repeat(10000) }, 1000)).toThrow("capacity");
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    expect(() => retainedBytes(cyclic, 1000)).toThrow("Non-JSON");
  });
});
