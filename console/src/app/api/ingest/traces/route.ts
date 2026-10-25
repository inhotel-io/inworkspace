import { getConfig, servesIngest } from "@/lib/config";
import { getPool } from "@/lib/db";
import { createIngestHandler } from "@/lib/ingest";
import { addToHistogram } from "@/lib/metricSamples";
import { recordSamples } from "@/lib/metricStore";
import { ingestTimes, traceRow } from "@/lib/traceEvents";
import { insertTraceEvents, pruneTraces } from "@/lib/traceStore";

/** The community edition exports no ingest times; they come from message-ingest events instead. */
const INGEST_TIME = "message-ingest.time";

let handler: ((request: Request) => Promise<Response>) | undefined;

function tracesHandler(): (request: Request) => Promise<Response> {
  if (!handler) {
    const config = getConfig();
    const pool = getPool();
    const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));
    handler = createIngestHandler({
      signingKey: config.webhookSigningKey,
      toRows: (events) => events.map(traceRow),
      insert: async (rows) => {
        const fresh = await insertTraceEvents(pool, rows, ({ row, error }) =>
          log({ severity: "ERROR", message: "console.traces.row-rejected", type: row.type, eventAt: String(row.eventAt), error }),
        );
        const times = ingestTimes(fresh);
        if (times.length > 0) {
          await recordSamples(pool, (previous) => {
            const state = previous.get(INGEST_TIME);
            // A server that exports ingest times itself is not counted twice.
            if (state && state.startNs !== "derived") return { samples: [], states: [] };
            return addToHistogram(state, INGEST_TIME, times);
          });
        }
        return fresh.length;
      },
      prune: () => pruneTraces(pool, config.traceRetentionDays),
      now: () => Date.now(),
      log,
    });
  }
  return handler;
}

/** The tracing webhook: events grouped into delivery traces, and the live feed's source. */
export async function POST(request: Request): Promise<Response> {
  if (!servesIngest(getConfig())) return new Response(null, { status: 404 });
  return tracesHandler()(request);
}
