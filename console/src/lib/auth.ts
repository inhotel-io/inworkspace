import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { ConsoleConfig } from "./config";

export const IAP_ISSUER = "https://cloud.google.com/iap";
export const IAP_ASSERTION_HEADER = "x-goog-iap-jwt-assertion";

export interface Operator {
  email: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

type AuthSettings = Pick<ConsoleConfig, "authMode" | "iapAudience" | "iapJwksUrl" | "allowedEmails" | "allowedDomains">;

let remoteKeys: { url: string; keys: JWTVerifyGetKey } | undefined;

function keysFor(url: string): JWTVerifyGetKey {
  if (remoteKeys?.url !== url) remoteKeys = { url, keys: createRemoteJWKSet(new URL(url)) };
  return remoteKeys.keys;
}

export function isAllowed(email: string, allowedEmails: readonly string[], allowedDomains: readonly string[]): boolean {
  const normalized = email.toLowerCase();
  const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
  return allowedEmails.includes(normalized) || allowedDomains.includes(domain);
}

/** What Cloud Run puts in place of the signature of a token it has verified, before forwarding it. */
export const CLOUD_RUN_SIGNATURE_MARKER = "SIGNATURE_REMOVED_BY_GOOGLE";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/**
 * AUTH_MODE=cloud-run: Cloud Run's IAM check has already verified the caller's Google ID token,
 * and forwards it with the signature replaced, so the signature cannot be checked again here. The
 * claims are trusted only because the service is private: `cloudRunGuard` stops the process if the
 * service ever becomes publicly invokable.
 */
function cloudRunCaller(headers: Headers, now: number): string {
  // Cloud Run authenticates with X-Serverless-Authorization when present (as `gcloud run services
  // proxy` sends it) and then passes Authorization through unchecked, so it must win.
  const value = headers.get("x-serverless-authorization") ?? headers.get("authorization") ?? "";
  const match = /^Bearer\s+([\w-]+)\.([\w-]+)\.(\S+)$/i.exec(value.trim());
  if (!match) throw new AuthError("no identity token");
  if (match[3] !== CLOUD_RUN_SIGNATURE_MARKER) throw new AuthError("the identity token did not pass Cloud Run's IAM check");
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(match[2]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new AuthError("the identity token is unreadable");
  }
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) throw new AuthError("the identity token is not from Google");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) throw new AuthError("the identity token has expired");
  if (claims.email_verified !== true || typeof claims.email !== "string" || !claims.email) {
    throw new AuthError("the identity token has no verified email");
  }
  return claims.email.toLowerCase();
}

/** Resolves the operator from the platform's identity assertion and checks the allow-list; throws AuthError otherwise. */
export async function authenticate(headers: Headers, settings: AuthSettings, keys?: JWTVerifyGetKey): Promise<Operator> {
  if (settings.authMode === "none") return { email: "local-operator" };
  if (settings.authMode === "cloud-run") {
    const email = cloudRunCaller(headers, Date.now());
    if (!isAllowed(email, settings.allowedEmails, settings.allowedDomains)) throw new AuthError(`${email} is not allowed`);
    return { email };
  }
  const token = headers.get(IAP_ASSERTION_HEADER);
  if (!token) throw new AuthError("no identity assertion");

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys ?? keysFor(settings.iapJwksUrl), {
      issuer: IAP_ISSUER,
      audience: settings.iapAudience,
      algorithms: ["ES256"],
    }));
  } catch (error) {
    throw new AuthError(`invalid identity assertion: ${error instanceof Error ? error.message : String(error)}`);
  }

  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!email) throw new AuthError("the identity assertion has no email");
  if (!isAllowed(email, settings.allowedEmails, settings.allowedDomains)) throw new AuthError(`${email} is not allowed`);
  return { email };
}
