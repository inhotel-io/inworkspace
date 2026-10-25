import type { BundleManifest } from "@/lib/apiTypes";
import { getConfig, servesApi } from "@/lib/config";
import { uiBundle } from "@/lib/services";

/** Which bundle the server should download; the setup script reads it. */
export async function GET(): Promise<Response> {
  if (!servesApi(getConfig())) return new Response(null, { status: 404 });
  const bundle = await uiBundle();
  const manifest: BundleManifest = { version: bundle.version, file: bundle.fileName };
  return Response.json(manifest, { headers: { "Cache-Control": "no-store" } });
}
