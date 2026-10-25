import { getConfig, servesApi } from "@/lib/config";
import { uiShell } from "@/lib/services";
import { SHELL_FILE } from "@/lib/uiBundle";

/**
 * The shell the server downloads. Every version name returns the current shell, so the server
 * never gets a 404 when it fetches again after its copy expires.
 */
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }): Promise<Response> {
  if (!servesApi(getConfig())) return new Response(null, { status: 404 });
  const { file } = await context.params;
  if (!SHELL_FILE.test(file)) return new Response(null, { status: 404 });
  const shell = await uiShell();
  return new Response(shell.zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(shell.zip.byteLength),
      "Cache-Control": "no-cache",
    },
  });
}
