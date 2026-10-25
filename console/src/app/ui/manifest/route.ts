import type { BundleManifest } from "@/lib/apiTypes";
import { getConfig, servesApi } from "@/lib/config";
import { uiShell } from "@/lib/services";

/** Which shell the server should host; the setup script reads it. */
export async function GET(): Promise<Response> {
  if (!servesApi(getConfig())) return new Response(null, { status: 404 });
  const shell = await uiShell();
  const manifest: BundleManifest = { version: shell.version, file: shell.fileName };
  return Response.json(manifest, { headers: { "Cache-Control": "no-store" } });
}
