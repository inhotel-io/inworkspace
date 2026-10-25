import { getConfig, servesIngest } from "@/lib/config";
import { getPool } from "@/lib/db";
import { insertEvents, pruneEvents } from "@/lib/eventStore";
import { createIngestHandler } from "@/lib/ingest";

let handler: ((request: Request) => Promise<Response>) | undefined;

function ingestHandler(): (request: Request) => Promise<Response> {
  if (!handler) {
    const config = getConfig();
    const pool = getPool();
    const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));
    handler = createIngestHandler({
      signingKey: config.webhookSigningKey,
      insert: (rows) =>
        insertEvents(pool, rows, ({ row, error }) =>
          log({ severity: "ERROR", message: "console.ingest.row-rejected", type: row.type, eventAt: String(row.eventAt), error }),
        ),
      prune: () => pruneEvents(pool, config.retentionDays),
      now: () => Date.now(),
      log,
    });
  }
  return handler;
}

export async function POST(request: Request): Promise<Response> {
  if (!servesIngest(getConfig())) return new Response(null, { status: 404 });
  return ingestHandler()(request);
}
