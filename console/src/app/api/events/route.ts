import { connection, type NextRequest } from "next/server";
import { AuthError, authenticate } from "@/lib/auth";
import { getConfig, servesWeb } from "@/lib/config";
import { getPool } from "@/lib/db";
import { parseEventFilters } from "@/lib/eventFilters";
import { queryEvents } from "@/lib/eventStore";

export async function GET(request: NextRequest): Promise<Response> {
  // Never prerender: everything below depends on the request and on runtime configuration.
  await connection();
  const config = getConfig();
  if (!servesWeb(config)) return new Response(null, { status: 404 });
  try {
    await authenticate(request.headers, config);
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ error: "forbidden" }, { status: 403 });
    throw error;
  }
  const params = request.nextUrl.searchParams;
  const after = Number(params.get("after"));
  if (!Number.isSafeInteger(after) || after < 0) {
    return Response.json({ error: "after must be a non-negative integer" }, { status: 400 });
  }
  const filters = parseEventFilters(params, new Date());
  const events = await queryEvents(getPool(), { ...filters, afterId: after, limit: 200 });
  return Response.json({ events }, { headers: { "Cache-Control": "no-store" } });
}
