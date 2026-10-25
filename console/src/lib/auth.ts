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

/** Resolves the operator from the identity-aware proxy's signed assertion; throws AuthError otherwise. */
export async function authenticate(headers: Headers, settings: AuthSettings, keys?: JWTVerifyGetKey): Promise<Operator> {
  if (settings.authMode === "none") return { email: "local-operator" };
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
