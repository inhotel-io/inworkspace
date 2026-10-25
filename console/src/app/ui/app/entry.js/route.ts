import { getConfig, servesApi } from "@/lib/config";
import { corsHeaders } from "@/lib/cors";
import { uiApp } from "@/lib/services";

/**
 * The module the shell loads from the server's origin. Browsers load module scripts with CORS,
 * and it is never cached without a check, so a new console version takes effect on the next visit.
 */
export async function GET(request: Request): Promise<Response> {
  const config = getConfig();
  if (!servesApi(config)) return new Response(null, { status: 404 });
  const app = await uiApp();
  return new Response(app.entry, {
    headers: {
      ...corsHeaders(request.headers.get("origin"), new URL(config.jmapUrl).origin),
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
