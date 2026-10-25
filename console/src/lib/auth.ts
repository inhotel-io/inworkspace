import { createHash } from "node:crypto";

export interface Operator {
  /** The account's login at the server, lowercased. */
  login: string;
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** The server could not be asked about the token; the token itself may be fine. */
export class VerifierUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifierUnavailableError";
  }
}

export type TokenVerifier = (headers: Headers) => Promise<Operator>;

export interface VerifierOptions {
  /** Origin of the inWorkspace server that issued the token. */
  serverUrl: string;
  /** The console principal, which introspects tokens. */
  principal: { username: string; password: string };
  permission: string;
  allowedAccounts: readonly string[];
  /** The client a request comes from, for its own introspection budget; null when unknown. */
  clientOf?: (headers: Headers) => string | null;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long a verified or refused token is remembered, at most. */
  cacheMs?: number;
  maxCacheEntries?: number;
  introspectionsPerMinute?: number;
  introspectionsPerClientPerMinute?: number;
  /** Longer-lived tokens cannot be access tokens: refresh tokens, links. */
  maxTokenLifetimeMs?: number;
  timeoutMs?: number;
}

/** For AUTH_MODE=none: every request is this operator. */
export const LOCAL_OPERATOR: Operator = { login: "local-operator" };

// The server's tokens are "sw1." and base64url, so dots, digits, letters, "-" and "_" only. None of
// those grows in the form body, so 1,000 characters always fit the server's 1,024-byte limit.
const BEARER = /^Bearer\s+([A-Za-z0-9._-]{16,1000})$/i;
const MINUTE_MS = 60_000;
const RETRY_AFTER_LIMIT_MS = 300;

export function bearerToken(headers: Headers): string {
  const token = BEARER.exec(headers.get("authorization")?.trim() ?? "")?.[1];
  if (!token) throw new AuthError(401, "sign-in required");
  return token;
}

/**
 * The client's address as the trusted proxies in front of this service recorded it: each appends
 * the address it saw to X-Forwarded-For, so the client is the entry `hops` from the end. Entries
 * further left came from the client and prove nothing.
 */
export function forwardedClient(hops: number): (headers: Headers) => string | null {
  return (headers) => {
    if (hops < 1) return null;
    const entries = (headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return entries.length >= hops ? entries[entries.length - hops]! : null;
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Outcome = { operator: Operator } | { refusal: AuthError };

/**
 * Verifies the operator's access token with the server that issued it.
 * - The token is introspected as the console principal, so an invalid one is never presented to the
 *   server as a login, and failed logins cannot get this service's address banned.
 * - The server reports every unexpired token it issued as active, refresh tokens included. So a
 *   token that lives longer than an access token can is refused here, unchecked.
 * - An access token is then used to read the account's permissions and login, one request at a time.
 * - Each token is checked once at a time, and the answer, yes or no, is remembered for a minute.
 */
export function createTokenVerifier(options: VerifierOptions): TokenVerifier {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clientOf = options.clientOf ?? (() => null);
  const cacheMs = options.cacheMs ?? MINUTE_MS;
  const maxCacheEntries = options.maxCacheEntries ?? 1000;
  const perMinute = options.introspectionsPerMinute ?? 120;
  const perClientPerMinute = options.introspectionsPerClientPerMinute ?? 20;
  const maxLifetimeMs = options.maxTokenLifetimeMs ?? 86_400_000;
  const timeoutMs = options.timeoutMs ?? 5000;
  const basic = `Basic ${Buffer.from(`${options.principal.username}:${options.principal.password}`).toString("base64")}`;
  const cache = new Map<string, { outcome: Outcome; expiresAt: number }>();
  const checking = new Map<string, Promise<Outcome>>();
  const windows = new Map<string, { startedAt: number; count: number }>();

  function windowOf(name: string, at: number) {
    let window = windows.get(name);
    if (!window || at - window.startedAt >= MINUTE_MS) {
      window = { startedAt: at, count: 0 };
      windows.set(name, window);
    }
    return window;
  }

  function countIntrospection(client: string | null, at: number): void {
    const all = windowOf("*", at);
    const own = client === null ? null : windowOf(`client ${client}`, at);
    if (all.count >= perMinute || (own && own.count >= perClientPerMinute)) {
      throw new RateLimitError("Too many sign-in checks. Try again in a minute.");
    }
    all.count += 1;
    if (own) own.count += 1;
    if (windows.size > 10_000) {
      for (const [name, window] of windows) if (at - window.startedAt >= MINUTE_MS) windows.delete(name);
    }
  }

  function remember(key: string, outcome: Outcome, expiresAt: number): Outcome {
    if (cache.size >= maxCacheEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { outcome, expiresAt });
    return outcome;
  }

  async function ask(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(`${options.serverUrl}${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new VerifierUnavailableError(`the mail server did not answer ${path}: ${messageOf(error)}`);
    }
  }

  async function jsonOf(response: Response, path: string): Promise<Record<string, unknown>> {
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object") return body as Record<string, unknown>;
    } catch {
      // handled below
    }
    throw new VerifierUnavailableError(`the mail server's answer to ${path} is not understood`);
  }

  /** A read with the operator's token; null when the server refuses the token. */
  async function readAsOperator(path: string, token: string): Promise<Record<string, unknown> | null> {
    let response = await ask(path, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 429) {
      // The server limits concurrent requests per account; the operator's browser may be busy.
      await response.body?.cancel();
      await sleep(RETRY_AFTER_LIMIT_MS);
      response = await ask(path, { headers: { Authorization: `Bearer ${token}` } });
    }
    if (response.status === 401) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new VerifierUnavailableError(`${path} answered HTTP ${response.status}`);
    }
    return jsonOf(response, path);
  }

  async function check(key: string, token: string, client: string | null): Promise<Outcome> {
    const at = now();
    countIntrospection(client, at);
    const refused = (status: 401 | 403, message: string) => remember(key, { refusal: new AuthError(status, message) }, at + cacheMs);

    const introspection = await ask("/auth/introspect", {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    if (!introspection.ok) {
      await introspection.body?.cancel();
      throw new VerifierUnavailableError(`token introspection answered HTTP ${introspection.status}`);
    }
    const state = await jsonOf(introspection, "/auth/introspect");
    if (state.active !== true) return refused(401, "the session has ended or is not valid");
    if (typeof state.iat !== "number" || typeof state.exp !== "number") {
      throw new VerifierUnavailableError("token introspection gave no lifetime, so access tokens cannot be told apart");
    }
    if ((state.exp - state.iat) * 1000 > maxLifetimeMs) return refused(401, "this is not an access token");

    const account = await readAsOperator("/api/account", token);
    const session = account && (await readAsOperator("/jmap/session", token));
    if (!account || !session) return refused(401, "the session has ended or is not valid");
    const { permissions } = account;
    const { username } = session;
    if (!Array.isArray(permissions) || typeof username !== "string" || username.length === 0) {
      throw new VerifierUnavailableError("the mail server's account answer has no permissions or login");
    }

    const login = username.toLowerCase();
    if (!permissions.includes(options.permission)) {
      return refused(403, `${login} does not have the ${options.permission} permission`);
    }
    if (options.allowedAccounts.length > 0 && !options.allowedAccounts.includes(login)) {
      return refused(403, `${login} is not allowed to use the console`);
    }
    return remember(key, { operator: { login } }, Math.min(at + cacheMs, state.exp * 1000));
  }

  return async function verify(headers: Headers): Promise<Operator> {
    const token = bearerToken(headers);
    const key = createHash("sha256").update(token).digest("base64url");
    const cached = cache.get(key);
    let outcome: Outcome;
    if (cached && cached.expiresAt > now()) {
      outcome = cached.outcome;
    } else {
      cache.delete(key);
      let pending = checking.get(key);
      if (!pending) {
        pending = check(key, token, clientOf(headers)).finally(() => checking.delete(key));
        checking.set(key, pending);
      }
      outcome = await pending;
    }
    if ("refusal" in outcome) throw outcome.refusal;
    return outcome.operator;
  };
}
