import { describe, expect, it } from "vitest";
import {
  AuthError,
  LOCAL_OPERATOR,
  RateLimitError,
  VerifierUnavailableError,
  bearerToken,
  createTokenVerifier,
  forwardedClient,
  requirePermissions,
} from "./auth";

const NOW = Date.parse("2026-10-26T10:00:00Z");
const SERVER = "https://mail.example.com";
const PRINCIPAL = { username: "console@example.com", password: "principal-secret" };
const TOKEN = "sw1.dG9rZW4tZm9yLWFkbWlu";

interface FakeServer {
  active?: boolean;
  /** Seconds the token lives: an hour for an access token, a month for a refresh token. */
  lifetime?: number;
  omitLifetime?: boolean;
  permissions?: string[];
  username?: string;
  introspectStatus?: number;
  introspectBody?: string;
  /** The principal is at its limit of concurrent requests for this many introspections. */
  introspectAtLimit?: number;
  /** Answers for /api/account, in order; the last one repeats. "limit": the account is at its limit of concurrent requests. */
  accountStatuses?: (number | "limit")[];
  failWith?: Error;
}

interface Call {
  path: string;
  authorization: string | null;
  body: string | null;
}

function fakeServer(options: FakeServer = {}) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let accountCalls = 0;
  let introspections = 0;
  const atLimit = () => Response.json({ type: "urn:ietf:params:jmap:error:limit", status: 400, limit: "maxConcurrentRequests" }, { status: 400 });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (options.failWith) throw options.failWith;
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    if (url.pathname === "/auth/introspect") {
      introspections += 1;
      if (introspections <= (options.introspectAtLimit ?? 0)) return atLimit();
      if (options.introspectStatus) return new Response("", { status: options.introspectStatus });
      if (options.introspectBody !== undefined) return new Response(options.introspectBody, { status: 200 });
      const iat = NOW / 1000 - 60;
      return Response.json(
        options.omitLifetime
          ? { active: options.active ?? true }
          : { active: options.active ?? true, iat, exp: iat + (options.lifetime ?? 3600) },
      );
    }
    if (url.pathname === "/api/account") {
      const statuses = options.accountStatuses ?? [200];
      const status = statuses[Math.min(accountCalls, statuses.length - 1)]!;
      accountCalls += 1;
      if (status === "limit") return atLimit();
      if (status !== 200) return new Response("", { status });
      return Response.json({ permissions: options.permissions ?? ["authenticate", "impersonate"], edition: "community", locale: "en" });
    }
    if (url.pathname === "/jmap/session") return Response.json({ username: options.username ?? "admin", accounts: {} });
    return new Response("", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, maxInFlight: () => maxInFlight };
}

function bearer(token = TOKEN, client?: string): Headers {
  return new Headers({ Authorization: `Bearer ${token}`, ...(client ? { "X-Forwarded-For": client } : {}) });
}

function verifierFor(
  server: ReturnType<typeof fakeServer>,
  clock = { now: NOW },
  extra: { allowedAccounts?: string[]; perMinute?: number; perClientPerMinute?: number; trustedProxyHops?: number } = {},
) {
  return createTokenVerifier({
    serverUrl: SERVER,
    principal: PRINCIPAL,
    allowedAccounts: extra.allowedAccounts ?? [],
    introspectionsPerMinute: extra.perMinute,
    introspectionsPerClientPerMinute: extra.perClientPerMinute,
    clientOf: forwardedClient(extra.trustedProxyHops ?? 1),
    fetch: server.fetch,
    now: () => clock.now,
    sleep: async () => {},
  });
}

describe("bearerToken", () => {
  it("reads a bearer token", () => {
    expect(bearerToken(bearer())).toBe(TOKEN);
    expect(bearerToken(new Headers({ Authorization: `bearer  ${TOKEN} ` }))).toBe(TOKEN);
  });

  it("refuses a missing, malformed or oversized token", () => {
    const values = [null, "Basic YWRtaW46c2VjcmV0", "Bearer", "Bearer a b", "Bearer <script>", "Bearer short", `Bearer ${"a".repeat(1001)}`];
    for (const value of values) {
      const headers = new Headers(value === null ? {} : { Authorization: value });
      expect(() => bearerToken(headers)).toThrow(AuthError);
    }
  });

  it("refuses characters a server token never has, which would also outgrow the introspection form", () => {
    for (const character of ["+", "/", "=", "~"]) {
      expect(() => bearerToken(new Headers({ Authorization: `Bearer sw1.${character.repeat(400)}` }))).toThrow(AuthError);
    }
  });
});

describe("forwardedClient", () => {
  it("takes the address the trusted proxies appended", () => {
    const headers = new Headers({ "X-Forwarded-For": "203.0.113.9, 198.51.100.7" });
    expect(forwardedClient(1)(headers)).toBe("198.51.100.7");
    expect(forwardedClient(2)(headers)).toBe("203.0.113.9");
  });

  it("counts an IPv6 client by its /64, and a mapped IPv4 address as IPv4", () => {
    const of = (address: string) => forwardedClient(1)(new Headers({ "X-Forwarded-For": address }));
    expect(of("2001:db8:abcd:12:1::5")).toBe("2001:db8:abcd:12::/64");
    expect(of("2001:DB8:ABCD:0012:ffff:ffff:ffff:ffff")).toBe("2001:db8:abcd:12::/64");
    expect(of("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(of("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(of("198.51.100.7")).toBe("198.51.100.7");
  });

  it("knows no client without trusted proxies or the header", () => {
    expect(forwardedClient(0)(new Headers({ "X-Forwarded-For": "203.0.113.9" }))).toBeNull();
    expect(forwardedClient(1)(new Headers())).toBeNull();
    expect(forwardedClient(3)(new Headers({ "X-Forwarded-For": "203.0.113.9" }))).toBeNull();
  });
});

describe("createTokenVerifier", () => {
  it("accepts an active access token from an account with the permission", async () => {
    const server = fakeServer();
    await expect(verifierFor(server)(bearer())).resolves.toMatchObject({ login: "admin" });
    expect(server.calls.map((call) => call.path)).toEqual(["/auth/introspect", "/api/account", "/jmap/session"]);
  });

  it("introspects as the console principal, and reads the account with the operator's token", async () => {
    const server = fakeServer();
    await verifierFor(server)(bearer());
    const [introspect, account, session] = server.calls;
    expect(introspect?.authorization).toBe(`Basic ${Buffer.from("console@example.com:principal-secret").toString("base64")}`);
    expect(introspect?.body).toBe(`token=${TOKEN}`);
    expect(account?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(session?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("asks the server one thing at a time, and once for requests that arrive together", async () => {
    const server = fakeServer();
    const verify = verifierFor(server);
    const operators = await Promise.all([verify(bearer()), verify(bearer()), verify(bearer())]);
    expect(operators.map((operator) => operator.login)).toEqual(["admin", "admin", "admin"]);
    expect(server.calls).toHaveLength(3);
    expect(server.maxInFlight()).toBe(1);
  });

  it("refuses an inactive token without presenting it to the server as a login, and remembers it", async () => {
    const server = fakeServer({ active: false });
    const verify = verifierFor(server);
    await expect(verify(bearer())).rejects.toMatchObject({ name: "AuthError", status: 401 });
    await expect(verify(bearer())).rejects.toMatchObject({ name: "AuthError", status: 401 });
    expect(server.calls.map((call) => call.path)).toEqual(["/auth/introspect"]);
  });

  it("refuses a long-lived token, such as a refresh token, without presenting it to the server", async () => {
    const server = fakeServer({ lifetime: 30 * 86400 });
    await expect(verifierFor(server)(bearer())).rejects.toMatchObject({ status: 401, message: "this is not an access token" });
    expect(server.calls.map((call) => call.path)).toEqual(["/auth/introspect"]);
  });

  it("does not guess when introspection gives no lifetime", async () => {
    await expect(verifierFor(fakeServer({ omitLifetime: true }))(bearer())).rejects.toBeInstanceOf(VerifierUnavailableError);
  });

  it("returns the account's permissions, for each route to check", async () => {
    const server = fakeServer({ permissions: ["authenticate", "liveMetrics"], username: "Jane@Example.com" });
    const operator = await verifierFor(server)(bearer());
    expect(operator).toEqual({ login: "jane@example.com", permissions: new Set(["authenticate", "liveMetrics"]) });
    expect(() => requirePermissions(operator, ["liveMetrics"])).not.toThrow();
    expect(() => requirePermissions(operator, ["liveMetrics", "impersonate"])).toThrow(
      expect.objectContaining({ status: 403, message: "jane@example.com does not have the impersonate permission" }),
    );
    expect(() => requirePermissions(LOCAL_OPERATOR, ["impersonate"])).not.toThrow();
  });

  it("applies the allow-list when one is set", async () => {
    await expect(verifierFor(fakeServer(), undefined, { allowedAccounts: ["ops@example.com"] })(bearer())).rejects.toMatchObject({
      status: 403,
      message: "admin is not allowed to use the console",
    });
    await expect(verifierFor(fakeServer(), undefined, { allowedAccounts: ["admin"] })(bearer())).resolves.toMatchObject({ login: "admin" });
  });

  it("answers from its cache for a minute", async () => {
    const server = fakeServer();
    const clock = { now: NOW };
    const verify = verifierFor(server, clock);
    await verify(bearer());
    clock.now += 59_000;
    await verify(bearer());
    expect(server.calls).toHaveLength(3);
    clock.now += 2_000;
    await verify(bearer());
    expect(server.calls).toHaveLength(6);
  });

  it("never caches a token past its expiry", async () => {
    const server = fakeServer({ lifetime: 70 });
    const clock = { now: NOW };
    const verify = verifierFor(server, clock);
    await verify(bearer());
    clock.now += 11_000;
    await verify(bearer());
    expect(server.calls.filter((call) => call.path === "/auth/introspect")).toHaveLength(2);
  });

  it("limits introspections per minute, but not cached tokens", async () => {
    const server = fakeServer();
    const clock = { now: NOW };
    const verify = verifierFor(server, clock, { perMinute: 2 });
    await verify(bearer("sw1.token-one-xxxxxxxx"));
    await verify(bearer("sw1.token-two-xxxxxxxx"));
    await expect(verify(bearer("sw1.token-three-xxxxxx"))).rejects.toBeInstanceOf(RateLimitError);
    await expect(verify(bearer("sw1.token-one-xxxxxxxx"))).resolves.toMatchObject({ login: "admin" });
    clock.now += 60_000;
    await expect(verify(bearer("sw1.token-three-xxxxxx"))).resolves.toMatchObject({ login: "admin" });
  });

  it("limits each client separately, so one client cannot use up the budget", async () => {
    const server = fakeServer({ active: false });
    const verify = verifierFor(server, undefined, { perClientPerMinute: 2 });
    await expect(verify(bearer("sw1.garbage-one-xxxxxx", "203.0.113.9"))).rejects.toBeInstanceOf(AuthError);
    await expect(verify(bearer("sw1.garbage-two-xxxxxx", "203.0.113.9"))).rejects.toBeInstanceOf(AuthError);
    await expect(verify(bearer("sw1.garbage-three-xxxx", "203.0.113.9"))).rejects.toBeInstanceOf(RateLimitError);
    await expect(verify(bearer("sw1.another-client-xxx", "198.51.100.7"))).rejects.toBeInstanceOf(AuthError);
  });

  it("retries once when the operator's account is at its limit of concurrent requests", async () => {
    const server = fakeServer({ accountStatuses: ["limit", 200] });
    await expect(verifierFor(server)(bearer())).resolves.toMatchObject({ login: "admin" });
    expect(server.calls.filter((call) => call.path === "/api/account")).toHaveLength(2);
  });

  it("retries an introspection once when the principal is at its limit of concurrent requests", async () => {
    const server = fakeServer({ introspectAtLimit: 1 });
    await expect(verifierFor(server)(bearer())).resolves.toMatchObject({ login: "admin" });
    expect(server.calls.filter((call) => call.path === "/auth/introspect")).toHaveLength(2);
  });

  it("lets a session that already passed be checked again without using the budget", async () => {
    const server = fakeServer();
    const clock = { now: NOW };
    const verify = verifierFor(server, clock, { perMinute: 1, perClientPerMinute: 1 });
    await verify(bearer(TOKEN, "203.0.113.9"));
    clock.now += 61_000;
    await expect(verify(bearer(TOKEN, "203.0.113.9"))).resolves.toMatchObject({ login: "admin" });
    clock.now += 61_000;
    await expect(verify(bearer(TOKEN, "203.0.113.9"))).resolves.toMatchObject({ login: "admin" });
    await expect(verify(bearer("sw1.a-new-session-xxxx", "203.0.113.9"))).resolves.toMatchObject({ login: "admin" });
  });

  it("reports a server it cannot ask, or cannot understand, as unavailable", async () => {
    for (const options of [
      { failWith: new TypeError("fetch failed") },
      { introspectStatus: 401 },
      { introspectStatus: 413 },
      { introspectBody: "<html>proxy error</html>" },
      { accountStatuses: [500] },
      { accountStatuses: [429] },
      { accountStatuses: ["limit", "limit"] },
      { introspectAtLimit: 2 },
    ] satisfies FakeServer[]) {
      await expect(verifierFor(fakeServer(options))(bearer())).rejects.toBeInstanceOf(VerifierUnavailableError);
    }
  });

  it("treats a token refused by the account read as an ended session", async () => {
    await expect(verifierFor(fakeServer({ accountStatuses: [401] }))(bearer())).rejects.toMatchObject({ name: "AuthError", status: 401 });
  });
});
