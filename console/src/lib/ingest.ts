import { BatchError, normalizeEvent, parseBatch, type EventRow } from "./normalize";
import { verifySignature } from "./signature";

/**
 * The server folds a failed batch into every later one until its `discardAfter`, so the body after
 * an outage can be large; this stays under Cloud Run's 32 MB request limit.
 */
export const MAX_INGEST_BYTES = 25 * 1024 * 1024;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface IngestDeps {
  signingKey: string;
  insert: (rows: EventRow[]) => Promise<number>;
  prune: () => Promise<number>;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Handles the server's event webhook: size limit, signature, parse, store, occasional prune. */
export function createIngestHandler(deps: IngestDeps): (request: Request) => Promise<Response> {
  let lastPruneAt = Number.NEGATIVE_INFINITY;
  return async (request) => {
    const body = await readBody(request, MAX_INGEST_BYTES);
    if (body === null) {
      deps.log({
        severity: "ERROR",
        message: "console.ingest.too-large",
        limitBytes: MAX_INGEST_BYTES,
        declaredBytes: Number(request.headers.get("content-length") ?? "0") || null,
      });
      return reply(413);
    }
    if (!verifySignature(body, request.headers.get("x-signature"), deps.signingKey)) {
      deps.log({ severity: "WARNING", message: "console.ingest.bad-signature", bytes: body.byteLength });
      return reply(401);
    }

    let rows: EventRow[];
    try {
      rows = parseBatch(new TextDecoder().decode(body)).map(normalizeEvent);
    } catch (error) {
      if (error instanceof BatchError) {
        deps.log({ severity: "ERROR", message: "console.ingest.malformed", error: error.message, bytes: body.byteLength });
        return reply(400);
      }
      throw error;
    }

    try {
      await deps.insert(rows);
    } catch (error) {
      deps.log({ severity: "ERROR", message: "console.ingest.store-failed", error: messageOf(error), events: rows.length });
      return reply(503);
    }

    // The events are stored; a failing prune must not make the server resend them.
    const now = deps.now();
    if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = now;
      try {
        await deps.prune();
      } catch (error) {
        deps.log({ severity: "ERROR", message: "console.ingest.prune-failed", error: messageOf(error) });
      }
    }
    return reply(204);
  };
}

function reply(status: number): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length") ?? "0") > limit) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
