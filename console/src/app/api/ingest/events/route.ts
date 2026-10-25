import { getConfig, servesIngest } from "@/lib/config";
import { getPool } from "@/lib/db";
import { insertEvents, pruneEvents } from "@/lib/eventStore";
import { createIngestHandler } from "@/lib/ingest";

let handler: ((request: Request) => Promise<Response>) | undefined;

function ingestHandler(): (request: Request) => Promise<Response> {
  if (!handler) {
    const config = getConfig();
    const pool = getPool();
    handler = createIngestHandler({
      signingKey: config.webhookSigningKey,
      insert: (rows) => insertEvents(pool, rows),
      prune: () => pruneEvents(pool, config.retentionDays),
      now: () => Date.now(),
      log: (entry) => console.log(JSON.stringify(entry)),
    });
  }
  return handler;
}

export async function POST(request: Request): Promise<Response> {
  if (!servesIngest(getConfig())) return new Response(null, { status: 404 });
  return ingestHandler()(request);
}
