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
  fetch?: typeof fetch;
  now?: () => number;
  cacheMs?: number;
  maxCacheEntries?: number;
  introspectionsPerMinute?: number;
  timeoutMs?: number;
}

/** For AUTH_MODE=none: every request is this operator. */
export const LOCAL_OPERATOR: Operator = { login: "local-operator" };

// RFC 6750 b64token, and short enough for the server's 1,024-byte introspection form.
const BEARER = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i;
const MAX_TOKEN_LENGTH = 1000;
const MINUTE_MS = 60_000;

export function bearerToken(headers: Headers): string {
  const match = BEARER.exec(headers.get("authorization")?.trim() ?? "");
  const token = match?.[1];
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new AuthError(401, "sign-in required");
  return token;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Verifies the operator's access token with the server that issued it.
 *
 * The token is first introspected as the console principal. An invalid token is therefore never
 * presented to the server as a login, and failed logins cannot get this service's address banned.
 * Only an active token is used, to read the account's permissions and login.
 */
export function createTokenVerifier(options: VerifierOptions): TokenVerifier {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? MINUTE_MS;
  const maxCacheEntries = options.maxCacheEntries ?? 1000;
  const limit = options.introspectionsPerMinute ?? 120;
  const timeoutMs = options.timeoutMs ?? 5000;
  const basic = `Basic ${Buffer.from(`${options.principal.username}:${options.principal.password}`).toString("base64")}`;
  const cache = new Map<string, { operator: Operator; expiresAt: number }>();
  let window = { startedAt: Number.NEGATIVE_INFINITY, count: 0 };

  async function ask(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(`${options.serverUrl}${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new VerifierUnavailableError(`the mail server did not answer ${path}: ${messageOf(error)}`);
    }
  }

  function countIntrospection(at: number): void {
    if (at - window.startedAt >= MINUTE_MS) window = { startedAt: at, count: 0 };
    if (window.count >= limit) throw new RateLimitError("Too many sign-in checks. Try again in a minute.");
    window.count += 1;
  }

  return async function verify(headers: Headers): Promise<Operator> {
    const token = bearerToken(headers);
    const key = createHash("sha256").update(token).digest("base64url");
    const at = now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > at) return cached.operator;
    cache.delete(key);

    countIntrospection(at);
    const introspection = await ask("/auth/introspect", {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    if (!introspection.ok) {
      throw new VerifierUnavailableError(`token introspection answered HTTP ${introspection.status}`);
    }
    const state = (await introspection.json()) as { active?: unknown; exp?: unknown };
    if (state.active !== true) throw new AuthError(401, "the session has ended or is not valid");

    const asOperator = { headers: { Authorization: `Bearer ${token}` } };
    const [account, session] = await Promise.all([ask("/api/account", asOperator), ask("/jmap/session", asOperator)]);
    if (account.status === 401 || session.status === 401) throw new AuthError(401, "the session has ended or is not valid");
    if (!account.ok || !session.ok) {
      throw new VerifierUnavailableError(`reading the account answered HTTP ${account.ok ? session.status : account.status}`);
    }
    const { permissions } = (await account.json()) as { permissions?: unknown };
    const { username } = (await session.json()) as { username?: unknown };
    if (!Array.isArray(permissions) || typeof username !== "string" || username.length === 0) {
      throw new VerifierUnavailableError("the mail server's account answer has no permissions or login");
    }

    const login = username.toLowerCase();
    if (!permissions.includes(options.permission)) {
      throw new AuthError(403, `${login} does not have the ${options.permission} permission`);
    }
    if (options.allowedAccounts.length > 0 && !options.allowedAccounts.includes(login)) {
      throw new AuthError(403, `${login} is not allowed to use the console`);
    }

    const operator = { login };
    const expiresAt = Math.min(at + cacheMs, typeof state.exp === "number" ? state.exp * 1000 : Number.POSITIVE_INFINITY);
    if (cache.size >= maxCacheEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { operator, expiresAt });
    return operator;
  };
}
