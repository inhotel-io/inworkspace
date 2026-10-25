import { describe, expect, it } from "vitest";
import { ApiFailure, createApiClient } from "./api";
import type { SessionEnvironment, Store } from "./auth/session";

const API = "https://console-api.example.com";
const ORIGIN = "https://mail.example.com";
const NOW = Date.parse("2026-10-26T10:00:00Z");
const TOKENS = "inworkspace-console:tokens";

function memoryStore(tokens?: { accessToken: string; refreshToken: string | null; expiresAt: number }): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (tokens) data.set(TOKENS, JSON.stringify(tokens));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

interface Seen {
  url: string;
  authorization: string | null;
}

/** The API answers 401 to every token in `expired`; the token endpoint hands out access-2, access-3, … */
function servers(options: { expired?: string[]; refuseRefresh?: boolean; apiStatus?: number; apiBody?: unknown } = {}) {
  const seen: Seen[] = [];
  let issued = 1;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url === `${ORIGIN}/auth/token`) {
      if (options.refuseRefresh) return Response.json({ error: "invalid_grant" }, { status: 400 });
      issued += 1;
      return Response.json({ access_token: `access-${issued}`, expires_in: 3600 });
    }
    const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    if (options.expired?.includes(token)) return Response.json({ error: { code: "unauthenticated", message: "ended" } }, { status: 401 });
    return Response.json(options.apiBody ?? { ok: token }, { status: options.apiStatus ?? 200 });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

function clientFor(store: Store, server: ReturnType<typeof servers>) {
  let ended = 0;
  const session: SessionEnvironment = { origin: ORIGIN, basePath: "/console", clientId: "inworkspace-console", store, fetch: server.fetch, now: () => NOW };
  const get = createApiClient({ apiUrl: API, session, onSessionEnded: () => (ended += 1) });
  return { get, ended: () => ended };
}

describe("createApiClient", () => {
  it("calls the API with the access token", async () => {
    const server = servers();
    const { get } = clientFor(memoryStore({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000 }), server);
    await expect(get<{ ok: string }>("overview")).resolves.toEqual({ ok: "access-1" });
    expect(server.seen).toEqual([{ url: `${API}/api/v1/overview`, authorization: "Bearer access-1" }]);
  });

  it("refreshes first when the access token is about to expire", async () => {
    const server = servers();
    const { get } = clientFor(memoryStore({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 10_000 }), server);
    await expect(get("me")).resolves.toEqual({ ok: "access-2" });
  });

  it("refreshes once on a 401 and retries", async () => {
    const server = servers({ expired: ["access-1"] });
    const { get, ended } = clientFor(memoryStore({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000 }), server);
    await expect(get("me")).resolves.toEqual({ ok: "access-2" });
    expect(ended()).toBe(0);
  });

  it("ends the session when the token is refused and cannot be refreshed", async () => {
    const store = memoryStore({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000 });
    const { get, ended } = clientFor(store, servers({ expired: ["access-1"], refuseRefresh: true }));
    await expect(get("me")).rejects.toMatchObject({ name: "ApiFailure", status: 401 });
    expect(ended()).toBe(1);
    expect(store.data.has(TOKENS)).toBe(false);
  });

  it("ends the session without a request when there are no tokens", async () => {
    const server = servers();
    const { get, ended } = clientFor(memoryStore(), server);
    await expect(get("me")).rejects.toBeInstanceOf(ApiFailure);
    expect(ended()).toBe(1);
    expect(server.seen).toHaveLength(0);
  });

  it("turns an error answer into a failure with its code and message", async () => {
    const server = servers({ apiStatus: 403, apiBody: { error: { code: "forbidden", message: "admin does not have the impersonate permission" } } });
    const { get } = clientFor(memoryStore({ accessToken: "access-1", refreshToken: null, expiresAt: NOW + 3_600_000 }), server);
    await expect(get("me")).rejects.toMatchObject({ status: 403, code: "forbidden", message: "admin does not have the impersonate permission" });
  });

  it("refreshes once for requests that fail together", async () => {
    const server = servers({ expired: ["access-1"] });
    const { get } = clientFor(memoryStore({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000 }), server);
    await Promise.all([get("me"), get("overview"), get("agents")]);
    expect(server.seen.filter((call) => call.url === `${ORIGIN}/auth/token`)).toHaveLength(1);
  });
});
