import type { ApiErrorBody } from "@/lib/apiTypes";
import { clearTokens, readTokens, refreshTokens, type RefreshOutcome, type SessionEnvironment } from "./auth/session";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

export interface ApiClientOptions {
  /** Origin of the console API; "" for the page's own origin. */
  apiUrl: string;
  session: SessionEnvironment;
  /** Called when the operator must sign in again. */
  onSessionEnded: () => void;
}

export type ApiGet = <T>(path: string, signal?: AbortSignal) => Promise<T>;

/** Refresh this long before the access token expires, so a request never races its expiry. */
const EARLY_REFRESH_MS = 30_000;

export function createApiClient(options: ApiClientOptions): ApiGet {
  const { session } = options;
  let refreshing: Promise<RefreshOutcome> | null = null;
  const refresh = (): Promise<RefreshOutcome> =>
    (refreshing ??= refreshTokens(session).finally(() => {
      refreshing = null;
    }));

  const send = (path: string, accessToken: string, signal?: AbortSignal) =>
    session.fetch(`${options.apiUrl}/api/v1/${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal,
    });

  const ended = (message: string): ApiFailure => {
    clearTokens(session.store);
    options.onSessionEnded();
    return new ApiFailure(401, "unauthenticated", message);
  };

  return async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    let tokens = readTokens(session.store);
    if (tokens?.refreshToken && tokens.expiresAt - EARLY_REFRESH_MS <= session.now()) {
      await refresh();
      tokens = readTokens(session.store);
    }
    if (!tokens) throw ended("Sign-in needed.");

    let response = await send(path, tokens.accessToken, signal);
    if (response.status === 401) {
      // Another request may already have renewed the token this one was sent with.
      const latest = readTokens(session.store);
      const outcome = latest !== null && latest.accessToken !== tokens.accessToken ? "renewed" : await refresh();
      if (outcome === "unavailable") {
        throw new ApiFailure(503, "unavailable", "The mail server could not renew the session. Try again shortly.");
      }
      const renewed = outcome === "renewed" ? readTokens(session.store) : null;
      if (renewed) response = await send(path, renewed.accessToken, signal);
    }
    if (response.status === 401) throw ended("The session ended. Sign in again.");
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
      throw new ApiFailure(
        response.status,
        body?.error?.code ?? "http_error",
        body?.error?.message ?? `The console API answered HTTP ${response.status}.`,
      );
    }
    return (await response.json()) as T;
  };
}
