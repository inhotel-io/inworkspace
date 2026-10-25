import { randomToken, s256Challenge } from "./pkce";

export type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface SessionEnvironment {
  /** The page's origin: the mail server, which serves the app and signs operators in. */
  origin: string;
  basePath: string;
  clientId: string;
  store: Store;
  fetch: typeof fetch;
  now: () => number;
}

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

interface PendingSignIn {
  verifier: string;
  state: string;
  returnTo: string;
}

interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

const TOKENS_KEY = "inworkspace-console:tokens";
const PENDING_KEY = "inworkspace-console:sign-in";
/** offline_access asks for a refresh token, so a session outlives the one-hour access token. */
export const SCOPE = "openid offline_access";
const DEFAULT_LIFETIME_S = 3600;

export function callbackPath(basePath: string): string {
  return `${basePath}/oauth/callback`;
}

function redirectUri(env: Pick<SessionEnvironment, "origin" | "basePath">): string {
  return `${env.origin}${callbackPath(env.basePath)}`;
}

/** Only routes inside the app: never another origin. */
export function safeReturnTo(value: string | null | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function readTokens(store: Store): Tokens | null {
  try {
    const value = JSON.parse(store.getItem(TOKENS_KEY) ?? "null") as Partial<Tokens> | null;
    if (!value || typeof value.accessToken !== "string" || typeof value.expiresAt !== "number") return null;
    return {
      accessToken: value.accessToken,
      refreshToken: typeof value.refreshToken === "string" ? value.refreshToken : null,
      expiresAt: value.expiresAt,
    };
  } catch {
    return null;
  }
}

export function clearTokens(store: Store): void {
  store.removeItem(TOKENS_KEY);
}

function tokensFrom(answer: TokenAnswer, now: number, previousRefresh: string | null): Tokens | null {
  if (typeof answer.access_token !== "string" || answer.access_token.length === 0) return null;
  const lifetime = typeof answer.expires_in === "number" && answer.expires_in > 0 ? answer.expires_in : DEFAULT_LIFETIME_S;
  return {
    accessToken: answer.access_token,
    refreshToken: typeof answer.refresh_token === "string" && answer.refresh_token ? answer.refresh_token : previousRefresh,
    expiresAt: now + lifetime * 1000,
  };
}

function describeRefusal(answer: TokenAnswer, status: number): string {
  if (typeof answer.error_description === "string" && answer.error_description) return answer.error_description;
  if (typeof answer.error === "string" && answer.error) return answer.error;
  return `HTTP ${status}`;
}

async function tokenRequest(env: SessionEnvironment, form: Record<string, string>) {
  const response = await env.fetch(`${env.origin}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const answer = (await response.json().catch(() => ({}))) as TokenAnswer;
  return { ok: response.ok, status: response.status, answer };
}

/** The server's sign-in page, for this tab; the caller navigates to it. */
export async function beginSignIn(env: Pick<SessionEnvironment, "origin" | "basePath" | "clientId" | "store">, returnTo: string): Promise<string> {
  const verifier = randomToken();
  const state = randomToken(16);
  const pending: PendingSignIn = { verifier, state, returnTo: safeReturnTo(returnTo) };
  env.store.setItem(PENDING_KEY, JSON.stringify(pending));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.clientId,
    redirect_uri: redirectUri(env),
    scope: SCOPE,
    state,
    code_challenge: await s256Challenge(verifier),
    code_challenge_method: "S256",
  });
  return `${env.origin}/login?${params.toString()}`;
}

/** Finishes sign-in on the callback page; returns the route to open. */
export async function completeSignIn(env: SessionEnvironment, callback: URL): Promise<string> {
  const raw = env.store.getItem(PENDING_KEY);
  env.store.removeItem(PENDING_KEY);
  let pending: PendingSignIn | null = null;
  try {
    pending = JSON.parse(raw ?? "null") as PendingSignIn | null;
  } catch {
    pending = null;
  }
  const error = callback.searchParams.get("error");
  if (error) {
    throw new SignInError(`The mail server did not sign you in: ${callback.searchParams.get("error_description") ?? error}`);
  }
  const code = callback.searchParams.get("code");
  if (!pending || !code || callback.searchParams.get("state") !== pending.state) {
    throw new SignInError("This sign-in was not started in this tab, or it was already used. Sign in again.");
  }
  const { ok, status, answer } = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(env),
    client_id: env.clientId,
    code_verifier: pending.verifier,
  });
  const tokens = ok ? tokensFrom(answer, env.now(), null) : null;
  if (!tokens) throw new SignInError(`The mail server refused the sign-in: ${describeRefusal(answer, status)}`);
  env.store.setItem(TOKENS_KEY, JSON.stringify(tokens));
  return pending.returnTo;
}

/** A new access token from the refresh token; false when the session cannot be renewed. */
export async function refreshTokens(env: SessionEnvironment): Promise<boolean> {
  const current = readTokens(env.store);
  if (!current?.refreshToken) return false;
  try {
    const { ok, answer } = await tokenRequest(env, {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: env.clientId,
    });
    const tokens = ok ? tokensFrom(answer, env.now(), current.refreshToken) : null;
    if (!tokens) {
      clearTokens(env.store);
      return false;
    }
    env.store.setItem(TOKENS_KEY, JSON.stringify(tokens));
    return true;
  } catch {
    // The server could not be reached; keep the tokens for the next try.
    return false;
  }
}
