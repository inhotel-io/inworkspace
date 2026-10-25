import { getConfig, servesApi } from "@/lib/config";
import { corsHeaders } from "@/lib/cors";
import { uiApp } from "@/lib/services";

/** A file of the web app's build; its name carries a content hash, so it never changes. */
export async function GET(request: Request, context: { params: Promise<{ file: string }> }): Promise<Response> {
  const config = getConfig();
  if (!servesApi(config)) return new Response(null, { status: 404 });
  const { file } = await context.params;
  // Only names the build produced: the lookup never touches the file system.
  const asset = (await uiApp()).assets.get(file);
  if (!asset) return new Response(null, { status: 404 });
  return new Response(asset.content, {
    headers: {
      ...corsHeaders(request.headers.get("origin"), new URL(config.jmapUrl).origin),
      "Content-Type": asset.type,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
