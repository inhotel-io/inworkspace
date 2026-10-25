import { apiBodyPreflight, apiRoute } from "@/lib/api";
import { ApiError } from "@/lib/apiRoute";
import { getPool } from "@/lib/db";
import { readBody } from "@/lib/ingest";
import { handleTraceJmap } from "@/lib/insights";
import { getDeliveryTraces, queryDeliveryTraces } from "@/lib/traceStore";

const MAX_BODY_BYTES = 64 * 1024;

/** `x:Trace/query` and `x:Trace/get` for the History lists; each method checks its own permission. */
export const POST = apiRoute(
  async ({ request, operator }) => {
    // Read no further than the limit: any account the console accepts can call this.
    const bytes = await readBody(request, MAX_BODY_BYTES);
    if (bytes === null) throw new ApiError(400, "bad_request", "the request is too large");
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ApiError(400, "bad_request", "the body is not JSON");
    }
    const pool = getPool();
    return handleTraceJmap(body, operator, {
      query: (query) => queryDeliveryTraces(pool, query),
      get: (ids, withEvents) => getDeliveryTraces(pool, ids, withEvents),
    });
  },
  { permissions: [] },
);
export const OPTIONS = apiBodyPreflight;
