import { BatchError, normalizeEvent, parseBatch, type EventRow } from "./normalize";
import { verifySignature } from "./signature";

export const MAX_INGEST_BYTES = 5 * 1024 * 1024;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface IngestDeps {
  signingKey: string;
  insert: (rows: EventRow[]) => Promise<number>;
  prune: () => Promise<number>;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
}

/** Handles the server's event webhook: size limit, signature, parse, store, occasional prune. */
export function createIngestHandler(deps: IngestDeps): (request: Request) => Promise<Response> {
  let lastPruneAt = Number.NEGATIVE_INFINITY;
  return async (request) => {
    const body = await readBody(request, MAX_INGEST_BYTES);
    if (body === null) return reply(413);
    if (!verifySignature(body, request.headers.get("x-signature"), deps.signingKey)) {
      deps.log({ severity: "WARNING", message: "console.ingest.bad-signature" });
      return reply(401);
    }

    let rows: EventRow[];
    try {
      rows = parseBatch(new TextDecoder().decode(body)).map(normalizeEvent);
    } catch (error) {
      if (error instanceof BatchError) return reply(400);
      throw error;
    }

    try {
      await deps.insert(rows);
      const now = deps.now();
      if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
        lastPruneAt = now;
        await deps.prune();
      }
    } catch (error) {
      deps.log({
        severity: "ERROR",
        message: "console.ingest.store-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return reply(503);
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
