import { describe, expect, it } from "vitest";
import { AuthError, RateLimitError, VerifierUnavailableError, bearerToken, createTokenVerifier } from "./auth";

const NOW = Date.parse("2026-10-26T10:00:00Z");
const SERVER = "https://mail.example.com";
const PRINCIPAL = { username: "console@example.com", password: "principal-secret" };
const TOKEN = "dG9rZW4tZm9yLWFkbWlu";

interface FakeServer {
  active?: boolean;
  exp?: number;
  permissions?: string[];
  username?: string;
  introspectStatus?: number;
  accountStatus?: number;
  failWith?: Error;
}

interface Call {
  path: string;
  authorization: string | null;
  body: string | null;
}

function fakeServer(options: FakeServer = {}) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (options.failWith) throw options.failWith;
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (url.pathname === "/auth/introspect") {
      if (options.introspectStatus) return new Response("", { status: options.introspectStatus });
      return Response.json({ active: options.active ?? true, exp: options.exp ?? NOW / 1000 + 3600 });
    }
    if (url.pathname === "/api/account") {
      if (options.accountStatus) return new Response("", { status: options.accountStatus });
      return Response.json({ permissions: options.permissions ?? ["authenticate", "impersonate"], edition: "community", locale: "en" });
    }
    if (url.pathname === "/jmap/session") return Response.json({ username: options.username ?? "admin", accounts: {} });
    return new Response("", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function bearer(token = TOKEN): Headers {
  return new Headers({ Authorization: `Bearer ${token}` });
}

function verifierFor(server: ReturnType<typeof fakeServer>, clock = { now: NOW }, extra: { allowedAccounts?: string[]; introspectionsPerMinute?: number } = {}) {
  return createTokenVerifier({
    serverUrl: SERVER,
    principal: PRINCIPAL,
    permission: "impersonate",
    allowedAccounts: extra.allowedAccounts ?? [],
    introspectionsPerMinute: extra.introspectionsPerMinute,
    fetch: server.fetch,
    now: () => clock.now,
  });
}

describe("bearerToken", () => {
  it("reads a bearer token", () => {
    expect(bearerToken(bearer())).toBe(TOKEN);
    expect(bearerToken(new Headers({ Authorization: `bearer  ${TOKEN} ` }))).toBe(TOKEN);
  });

  it("refuses a missing, malformed or oversized token", () => {
    for (const value of [null, "Basic YWRtaW46c2VjcmV0", "Bearer", "Bearer a b", "Bearer <script>", `Bearer ${"a".repeat(1001)}`]) {
      const headers = new Headers(value === null ? {} : { Authorization: value });
      expect(() => bearerToken(headers)).toThrow(AuthError);
    }
  });
});

describe("createTokenVerifier", () => {
  it("accepts an active token from an account with the permission", async () => {
    const server = fakeServer();
    await expect(verifierFor(server)(bearer())).resolves.toEqual({ login: "admin" });
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

  it("refuses an inactive token without presenting it to the server as a login", async () => {
    const server = fakeServer({ active: false });
    await expect(verifierFor(server)(bearer())).rejects.toMatchObject({ name: "AuthError", status: 401 });
    expect(server.calls.map((call) => call.path)).toEqual(["/auth/introspect"]);
  });

  it("refuses an account without the permission with 403", async () => {
    const server = fakeServer({ permissions: ["authenticate"], username: "Jane@Example.com" });
    await expect(verifierFor(server)(bearer())).rejects.toMatchObject({
      status: 403,
      message: "jane@example.com does not have the impersonate permission",
    });
  });

  it("applies the allow-list when one is set", async () => {
    await expect(verifierFor(fakeServer(), undefined, { allowedAccounts: ["ops@example.com"] })(bearer())).rejects.toMatchObject({
      status: 403,
      message: "admin is not allowed to use the console",
    });
    await expect(verifierFor(fakeServer(), undefined, { allowedAccounts: ["admin"] })(bearer())).resolves.toEqual({ login: "admin" });
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
    const server = fakeServer({ exp: NOW / 1000 + 10 });
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
    const verify = verifierFor(server, clock, { introspectionsPerMinute: 2 });
    await verify(bearer("token-one"));
    await verify(bearer("token-two"));
    await expect(verify(bearer("token-three"))).rejects.toBeInstanceOf(RateLimitError);
    await expect(verify(bearer("token-one"))).resolves.toEqual({ login: "admin" });
    clock.now += 60_000;
    await expect(verify(bearer("token-three"))).resolves.toEqual({ login: "admin" });
  });

  it("reports a server it cannot ask as unavailable", async () => {
    await expect(verifierFor(fakeServer({ failWith: new TypeError("fetch failed") }))(bearer())).rejects.toBeInstanceOf(
      VerifierUnavailableError,
    );
    await expect(verifierFor(fakeServer({ introspectStatus: 401 }))(bearer())).rejects.toBeInstanceOf(VerifierUnavailableError);
    await expect(verifierFor(fakeServer({ accountStatus: 500 }))(bearer())).rejects.toBeInstanceOf(VerifierUnavailableError);
  });

  it("treats a token refused by the account read as an ended session", async () => {
    await expect(verifierFor(fakeServer({ accountStatus: 401 }))(bearer())).rejects.toMatchObject({ name: "AuthError", status: 401 });
  });
});
