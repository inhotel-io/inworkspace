import { apiPreflight, apiRoute } from "@/lib/api";
import { getPool } from "@/lib/db";
import { LIVE_TRACING_PERMISSIONS, parseLiveTracing, type TracingResponse } from "@/lib/insights";
import { liveTraceEvents } from "@/lib/traceStore";

/** A new feed starts with the last minute's events, so the page is not empty while it waits. */
const BACKLOG_MS = 60_000;
const LIMIT = 500;

/** Live Tracing: the events after the cursor, polled every few seconds. */
export const GET = apiRoute(
  async ({ request }): Promise<TracingResponse> => {
    const query = parseLiveTracing(new URL(request.url).searchParams);
    return liveTraceEvents(getPool(), { ...query, since: new Date(Date.now() - BACKLOG_MS), limit: LIMIT });
  },
  { permissions: LIVE_TRACING_PERMISSIONS },
);
export const OPTIONS = apiPreflight;
