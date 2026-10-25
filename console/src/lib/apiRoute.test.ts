import { describe, expect, it } from "vitest";
import { ApiError, createApiRoute, createPreflight, type ApiRouteDeps } from "./apiRoute";
import { AuthError, RateLimitError, VerifierUnavailableError, type Operator } from "./auth";
import { JmapError } from "./jmap";

const SERVER = "https://mail.example.com";

function depsWith(verify: (headers: Headers) => Promise<Operator>, enabled = true) {
  const logged: Record<string, unknown>[] = [];
  const deps: ApiRouteDeps = {
    enabled: () => enabled,
    allowedOrigin: () => SERVER,
    verify,
    permission: () => "impersonate",
    log: (entry) => logged.push(entry),
  };
  return { deps, logged };
}

const admin = async (): Promise<Operator> => ({ login: "admin", permissions: new Set(["impersonate", "liveMetrics"]) });
const context = { params: Promise.resolve({ address: "a1@agents.example.com" }) };

function request(path = "/api/v1/me", origin: string | null = SERVER): Request {
  return new Request(`https://console-api.example.com${path}`, { headers: origin ? { Origin: origin } : {} });
}

describe("createApiRoute", () => {
  it("answers the handler's value as JSON, with CORS and no-store", async () => {
    const { deps } = depsWith(admin);
    const route = createApiRoute(deps)<{ address: string }>(async ({ operator, params }) => ({ who: operator.login, address: params.address }));
    const response = await route(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ who: "admin", address: "a1@agents.example.com" });
    expect(response.headers.get("access-control-allow-origin")).toBe(SERVER);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires the operator permission, or the route's own permissions", async () => {
    const viewer = async (): Promise<Operator> => ({ login: "jane@example.com", permissions: new Set(["liveMetrics"]) });
    let ran = 0;
    const handler = async () => {
      ran += 1;
      return {};
    };
    const refused = await createApiRoute(depsWith(viewer).deps)(handler)(request(), context);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: { code: "forbidden", message: "jane@example.com does not have the impersonate permission" } });
    expect(ran).toBe(0);
    const allowed = await createApiRoute(depsWith(viewer).deps)(handler, { permissions: ["liveMetrics"] })(request(), context);
    expect(allowed.status).toBe(200);
    const stricter = await createApiRoute(depsWith(admin).deps)(handler, { permissions: ["liveMetrics", "liveTracing"] })(request(), context);
    expect(stricter.status).toBe(403);
    expect(ran).toBe(1);
  });

  it("is a 404 outside the api role, before any check", async () => {
    const { deps } = depsWith(async () => {
      throw new Error("must not verify");
    }, false);
    const response = await createApiRoute(deps)(async () => ({}))(request(), context);
    expect(response.status).toBe(404);
  });

  it("never runs the handler for an unverified request", async () => {
    let ran = false;
    const { deps } = depsWith(async () => {
      throw new AuthError(401, "sign-in required");
    });
    const response = await createApiRoute(deps)(async () => {
      ran = true;
      return {};
    })(request(), context);
    expect(ran).toBe(false);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthenticated", message: "sign-in required" } });
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="inworkspace-console"');
    expect(response.headers.get("access-control-allow-origin")).toBe(SERVER);
  });

  it("maps each failure to its status and code", async () => {
    const cases: [unknown, number, string][] = [
      [new AuthError(403, "admin does not have the impersonate permission"), 403, "forbidden"],
      [new RateLimitError("Too many sign-in checks. Try again in a minute."), 429, "rate_limited"],
      [new VerifierUnavailableError("the mail server did not answer"), 503, "unavailable"],
      [new ApiError(404, "not_found", "There is no agent at this address."), 404, "not_found"],
      [new JmapError("cannot reach the mail server: fetch failed", "network"), 502, "upstream_failed"],
      [new Error("boom"), 500, "internal"],
    ];
    for (const [error, status, code] of cases) {
      const { deps } = depsWith(admin);
      const response = await createApiRoute(deps)(async () => {
        throw error;
      })(request(), context);
      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });

  it("logs failures without sending their details to the browser", async () => {
    const { deps, logged } = depsWith(admin);
    const response = await createApiRoute(deps)(async () => {
      throw new Error("password authentication failed for user console");
    })(request(), context);
    expect(JSON.stringify(await response.json())).not.toContain("password");
    expect(logged).toEqual([expect.objectContaining({ severity: "ERROR", message: "console.api.failed" })]);
  });

  it("sends no CORS headers to another origin", async () => {
    const { deps } = depsWith(admin);
    const response = await createApiRoute(deps)(async () => ({}))(request("/api/v1/me", "https://attacker.example"), context);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("createPreflight", () => {
  it("answers preflights in the api role only", () => {
    expect(createPreflight(depsWith(admin).deps)(request()).status).toBe(204);
    expect(createPreflight(depsWith(admin, false).deps)(request()).status).toBe(404);
  });
});
