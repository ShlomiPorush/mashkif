import type { MiddlewareHandler } from "hono";

/** Largest request body the admin and auth routes accept. A passkey registration is about 2 KB. */
export const ADMIN_BODY_LIMIT_BYTES = 16 * 1024;
/** Time a client has to send the whole body. */
export const ADMIN_BODY_TIMEOUT_MS = 5_000;

type ReadResult = Uint8Array | "too_large" | "timeout" | "aborted";

async function readBounded(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  timeoutMs: number,
): Promise<ReadResult> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === "timeout") {
        return "timeout";
      }
      if (next.done) {
        break;
      }
      size += next.value.length;
      if (size > maxBytes) {
        return "too_large";
      }
      chunks.push(next.value);
    }
  } catch {
    return "aborted";
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Reads the whole request body, bounded by size and by time, before any
 * route sees the request, and hands the route a request rebuilt from it. So a
 * client that sends its body slowly never holds the admin lock, and nothing
 * parses an oversized body. Works with and without a Content-Length.
 */
export function boundedBody(
  maxBytes = ADMIN_BODY_LIMIT_BYTES,
  timeoutMs = ADMIN_BODY_TIMEOUT_MS,
): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.raw;
    if (raw.body === null) {
      return next();
    }
    const declared = Number(raw.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    const result = await readBounded(raw.body, maxBytes, timeoutMs);
    if (result === "too_large") {
      return c.json({ error: "payload_too_large" }, 413);
    }
    if (result === "timeout") {
      return c.json({ error: "request_timeout" }, 408);
    }
    if (result === "aborted") {
      return c.json({ error: "request_aborted" }, 400);
    }
    c.req.raw = new Request(raw.url, { method: raw.method, headers: raw.headers, body: result });
    return next();
  };
}
