/** The web app runs on the server's origin and calls the API from there; no other origin may read it. */
export function corsHeaders(origin: string | null, allowedOrigin: string): Record<string, string> {
  return origin === allowedOrigin
    ? { Vary: "Origin", "Access-Control-Allow-Origin": allowedOrigin }
    : { Vary: "Origin" };
}

export function preflight(origin: string | null, allowedOrigin: string): Response {
  if (origin !== allowedOrigin) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin, allowedOrigin),
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "Authorization",
      "Access-Control-Max-Age": "600",
    },
  });
}
