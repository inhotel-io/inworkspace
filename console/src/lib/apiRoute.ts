import type { ApiErrorBody, ApiErrorCode } from "./apiTypes";
import { AuthError, RateLimitError, requirePermissions, VerifierUnavailableError, type Operator } from "./auth";
import { corsHeaders, preflight } from "./cors";
import { JmapError } from "./jmap";

/** A failure a handler reports on purpose: bad parameters, or an unknown mailbox or thread. */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiRouteDeps {
  /** Whether this process serves the api role. */
  enabled: () => boolean;
  allowedOrigin: () => string;
  verify: (headers: Headers) => Promise<Operator>;
  /** What a route needs when it names nothing else: the console's operator permission. */
  permission: () => string;
  log: (entry: Record<string, unknown>) => void;
}

export interface ApiContext<P> {
  request: Request;
  operator: Operator;
  params: P;
}

type HeaderMap = Record<string, string>;

function errorResponse(error: unknown, cors: HeaderMap, log: ApiRouteDeps["log"]): Response {
  const send = (status: number, code: ApiErrorCode, message: string, extra: HeaderMap = {}) =>
    Response.json({ error: { code, message } } satisfies ApiErrorBody, {
      status,
      headers: { ...cors, "Cache-Control": "no-store", ...extra },
    });
  if (error instanceof AuthError) {
    return error.status === 401
      ? send(401, "unauthenticated", error.message, { "WWW-Authenticate": 'Bearer realm="inworkspace-console"' })
      : send(403, "forbidden", error.message);
  }
  if (error instanceof RateLimitError) return send(429, "rate_limited", error.message, { "Retry-After": "60" });
  if (error instanceof ApiError) return send(error.status, error.code, error.message);
  if (error instanceof VerifierUnavailableError) {
    log({ severity: "ERROR", message: "console.auth.unavailable", error: error.message });
    return send(503, "unavailable", "The mail server could not check the session. Try again shortly.");
  }
  if (error instanceof JmapError) {
    log({ severity: "ERROR", message: "console.jmap.failed", type: error.type, error: error.message });
    return send(502, "upstream_failed", `The mail server could not be read: ${error.message}`);
  }
  log({ severity: "ERROR", message: "console.api.failed", error: error instanceof Error ? error.message : String(error) });
  return send(500, "internal", "The console failed to answer.");
}

export interface ApiRouteOptions {
  /** The server permissions an operator needs here, instead of the console's operator permission. */
  permissions?: readonly string[];
}

/** Every API handler runs behind this: role, CORS, the operator's token and permissions, then JSON either way. */
export function createApiRoute(deps: ApiRouteDeps) {
  return function apiRoute<P = unknown>(handler: (context: ApiContext<P>) => Promise<unknown>, options: ApiRouteOptions = {}) {
    return async (request: Request, context: { params: Promise<P> }): Promise<Response> => {
      if (!deps.enabled()) return new Response(null, { status: 404 });
      const cors = corsHeaders(request.headers.get("origin"), deps.allowedOrigin());
      try {
        const operator = await deps.verify(request.headers);
        requirePermissions(operator, options.permissions ?? [deps.permission()]);
        const body = await handler({ request, operator, params: await context.params });
        return Response.json(body, { headers: { ...cors, "Cache-Control": "no-store" } });
      } catch (error) {
        return errorResponse(error, cors, deps.log);
      }
    };
  };
}

export function createPreflight(deps: Pick<ApiRouteDeps, "enabled" | "allowedOrigin">, acceptsBody = false) {
  return (request: Request): Response => {
    if (!deps.enabled()) return new Response(null, { status: 404 });
    return preflight(request.headers.get("origin"), deps.allowedOrigin(), acceptsBody);
  };
}
