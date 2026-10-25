import { getConfig, servesApi } from "@/lib/config";
import { uiBundle } from "@/lib/services";
import { BUNDLE_FILE } from "@/lib/uiBundle";

/**
 * The bundle the server downloads. Every version name returns the current bundle, so the server
 * never gets a 404 when it fetches again after its copy expires.
 */
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }): Promise<Response> {
  if (!servesApi(getConfig())) return new Response(null, { status: 404 });
  const { file } = await context.params;
  if (!BUNDLE_FILE.test(file)) return new Response(null, { status: 404 });
  const bundle = await uiBundle();
  return new Response(bundle.zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(bundle.zip.byteLength),
      "Cache-Control": "no-cache",
    },
  });
}
