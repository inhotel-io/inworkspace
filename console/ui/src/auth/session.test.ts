import { describe, expect, it } from "vitest";
import { s256Challenge } from "./pkce";
import {
  SCOPE,
  beginSignIn,
  callbackPath,
  clearTokens,
  completeSignIn,
  readTokens,
  refreshTokens,
  safeReturnTo,
  type SessionEnvironment,
  type Store,
} from "./session";

const ORIGIN = "https://mail.example.com";
const NOW = Date.parse("2026-10-26T10:00:00Z");

function memoryStore(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

interface TokenCall {
  url: string;
  form: URLSearchParams;
}

function tokenServer(answer: { status?: number; body: unknown }) {
  const calls: TokenCall[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), form: new URLSearchParams(String(init?.body ?? "")) });
    return Response.json(answer.body, { status: answer.status ?? 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function environment(store: Store, fetch: typeof globalThis.fetch = tokenServer({ body: {} }).fetch): SessionEnvironment {
  return { origin: ORIGIN, basePath: "/console", clientId: "inworkspace-console", store, fetch, now: () => NOW };
}

async function startedSignIn(store: Store, returnTo = "/events?severity=error") {
  const url = new URL(await beginSignIn(environment(store), returnTo));
  return { url, state: url.searchParams.get("state")! };
}

describe("safeReturnTo", () => {
  it("keeps paths inside the app and nothing else", () => {
    expect(safeReturnTo("/agents/a1%40example.com")).toBe("/agents/a1%40example.com");
    expect(safeReturnTo("//attacker.example/")).toBe("/");
    expect(safeReturnTo("https://attacker.example/")).toBe("/");
    expect(safeReturnTo(null)).toBe("/");
  });
});

describe("beginSignIn", () => {
  it("sends the operator to the server's sign-in page with PKCE", async () => {
    const store = memoryStore();
    const { url } = await startedSignIn(store);
    expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}/login`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("inworkspace-console");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}${callbackPath("/console")}`);
    expect(url.searchParams.get("scope")).toBe(SCOPE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const pending = JSON.parse(store.data.get("inworkspace-console:sign-in")!) as { verifier: string; state: string; returnTo: string };
    expect(url.searchParams.get("state")).toBe(pending.state);
    expect(url.searchParams.get("code_challenge")).toBe(await s256Challenge(pending.verifier));
    expect(pending.returnTo).toBe("/events?severity=error");
  });
});

describe("completeSignIn", () => {
  it("exchanges the code with the verifier and keeps the tokens", async () => {
    const store = memoryStore();
    const { state } = await startedSignIn(store);
    const verifier = (JSON.parse(store.data.get("inworkspace-console:sign-in")!) as { verifier: string }).verifier;
    const server = tokenServer({ body: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, token_type: "bearer" } });
    const returnTo = await completeSignIn(environment(store, server.fetch), new URL(`${ORIGIN}/console/oauth/callback?code=c0de&state=${state}`));
    expect(returnTo).toBe("/events?severity=error");
    expect(server.calls[0]?.url).toBe(`${ORIGIN}/auth/token`);
    expect(Object.fromEntries(server.calls[0]!.form)).toEqual({
      grant_type: "authorization_code",
      code: "c0de",
      redirect_uri: `${ORIGIN}/console/oauth/callback`,
      client_id: "inworkspace-console",
      code_verifier: verifier,
    });
    expect(readTokens(store)).toEqual({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000 });
    expect(store.data.has("inworkspace-console:sign-in")).toBe(false);
  });

  it("refuses a callback this tab did not start, without calling the server", async () => {
    const store = memoryStore();
    await startedSignIn(store);
    const server = tokenServer({ body: {} });
    await expect(
      completeSignIn(environment(store, server.fetch), new URL(`${ORIGIN}/console/oauth/callback?code=c0de&state=forged`)),
    ).rejects.toMatchObject({ name: "SignInError" });
    expect(server.calls).toHaveLength(0);
  });

  it("can be used only once", async () => {
    const store = memoryStore();
    const { state } = await startedSignIn(store);
    const server = tokenServer({ body: { access_token: "access-1" } });
    const callback = new URL(`${ORIGIN}/console/oauth/callback?code=c0de&state=${state}`);
    await completeSignIn(environment(store, server.fetch), callback);
    await expect(completeSignIn(environment(store, server.fetch), callback)).rejects.toMatchObject({ name: "SignInError" });
  });

  it("reports what the server said when it refuses", async () => {
    const store = memoryStore();
    const { state } = await startedSignIn(store);
    await expect(
      completeSignIn(
        environment(store, tokenServer({ status: 400, body: { error: "invalid_grant", error_description: "Code expired" } }).fetch),
        new URL(`${ORIGIN}/console/oauth/callback?code=c0de&state=${state}`),
      ),
    ).rejects.toThrow("Code expired");
    const declined = memoryStore();
    await startedSignIn(declined);
    await expect(
      completeSignIn(environment(declined), new URL(`${ORIGIN}/console/oauth/callback?error=access_denied`)),
    ).rejects.toThrow("access_denied");
  });
});

describe("refreshTokens", () => {
  function signedIn(refreshToken: string | null): Store & { data: Map<string, string> } {
    const store = memoryStore();
    store.setItem("inworkspace-console:tokens", JSON.stringify({ accessToken: "access-1", refreshToken, expiresAt: NOW }));
    return store;
  }

  it("replaces the access token and keeps the refresh token when none is returned", async () => {
    const store = signedIn("refresh-1");
    const server = tokenServer({ body: { access_token: "access-2", expires_in: 600 } });
    await expect(refreshTokens(environment(store, server.fetch))).resolves.toBe(true);
    expect(Object.fromEntries(server.calls[0]!.form)).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "inworkspace-console" });
    expect(readTokens(store)).toEqual({ accessToken: "access-2", refreshToken: "refresh-1", expiresAt: NOW + 600_000 });
  });

  it("ends the session when the server refuses the refresh", async () => {
    const store = signedIn("refresh-1");
    await expect(refreshTokens(environment(store, tokenServer({ status: 400, body: { error: "invalid_grant" } }).fetch))).resolves.toBe(false);
    expect(readTokens(store)).toBeNull();
  });

  it("does nothing without a refresh token", async () => {
    const server = tokenServer({ body: {} });
    await expect(refreshTokens(environment(signedIn(null), server.fetch))).resolves.toBe(false);
    expect(server.calls).toHaveLength(0);
  });
});

describe("readTokens", () => {
  it("ignores anything it did not write", () => {
    const store = memoryStore();
    store.setItem("inworkspace-console:tokens", "{not json");
    expect(readTokens(store)).toBeNull();
    store.setItem("inworkspace-console:tokens", JSON.stringify({ accessToken: 1 }));
    expect(readTokens(store)).toBeNull();
    clearTokens(store);
    expect(store.data.size).toBe(0);
  });
});
