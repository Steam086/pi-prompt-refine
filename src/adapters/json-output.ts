/** Bounded, lazy JSON encoding for detached application DTOs. No whole encoded copy. */
export const OUTPUT_BYTES = 36 * 1024; // Divisible by 3: all non-final base64 chunks concatenate safely.

export function retainedBytes(value: unknown, limit: number): number {
  let bytes = 0;
  const seen = new Set<object>();
  function visit(item: unknown) {
    bytes += 32;
    if (typeof item === "string") bytes += item.length * 2;
    else if (item && typeof item === "object") {
      if (seen.has(item)) throw new Error("Non-JSON response");
      seen.add(item);
      for (const [key, child] of Object.entries(item)) { bytes += key.length * 2 + 16; visit(child); }
      seen.delete(item);
    }
    if (bytes > limit) throw new Error("Response capacity reached");
  }
  visit(value); return bytes;
}
function* fragments(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield '"';
    for (let i = 0; i < value.length; i += 4096) yield JSON.stringify(value.slice(i, i + 4096)).slice(1, -1);
    yield '"'; return;
  }
  if (Array.isArray(value)) {
    yield "[";
    for (let i = 0; i < value.length; i++) { if (i) yield ","; yield* fragments(value[i] ?? null); }
    yield "]"; return;
  }
  if (value && typeof value === "object") {
    yield "{";
    let first = true;
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      if (!first) yield ",";
      first = false; yield JSON.stringify(key); yield ":"; yield* fragments(child);
    }
    yield "}"; return;
  }
  yield JSON.stringify(value) ?? "null";
}
export function* outputChunks(value: unknown): Generator<Buffer> {
  let buffer = Buffer.allocUnsafe(OUTPUT_BYTES), used = 0;
  for (const fragment of fragments(value)) {
    const bytes = Buffer.from(fragment);
    let offset = 0;
    while (offset < bytes.length) {
      const length = Math.min(OUTPUT_BYTES - used, bytes.length - offset);
      bytes.copy(buffer, used, offset, offset + length); offset += length; used += length;
      if (used === OUTPUT_BYTES) { yield buffer; buffer = Buffer.allocUnsafe(OUTPUT_BYTES); used = 0; }
    }
  }
  if (used) yield buffer.subarray(0, used);
}
