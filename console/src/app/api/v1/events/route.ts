import { apiPreflight, apiRoute } from "@/lib/api";
import { ApiError } from "@/lib/apiRoute";
import type { EventsResponse } from "@/lib/apiTypes";
import { getPool } from "@/lib/db";
import { parseEventFilters } from "@/lib/eventFilters";
import { queryEvents } from "@/lib/eventStore";
import { parseEventId } from "@/lib/params";

const PAGE_SIZE = 100;
const LIVE_LIMIT = 200;

function idParam(params: URLSearchParams, name: string, allowZero: boolean): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  if (allowZero && raw === "0") return 0;
  const id = parseEventId(raw);
  if (id === null) throw new ApiError(400, "bad_request", `${name} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  return id;
}

export const GET = apiRoute(async ({ request }): Promise<EventsResponse> => {
  const params = new URL(request.url).searchParams;
  const filters = parseEventFilters(params, new Date());
  const beforeId = idParam(params, "before", false);
  const afterId = idParam(params, "after", true);
  if (beforeId !== undefined && afterId !== undefined) {
    throw new ApiError(400, "bad_request", "use before or after, not both");
  }
  const limit = afterId === undefined ? PAGE_SIZE : LIVE_LIMIT;
  const events = await queryEvents(getPool(), { ...filters, beforeId, afterId, limit });
  return { events, pageSize: limit };
});
export const OPTIONS = apiPreflight;
