import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { authenticate, AuthError, IAP_ISSUER, isAllowed } from "./auth";

const AUDIENCE = "/projects/123/locations/europe-west1/services/console";
const SETTINGS = {
  authMode: "iap" as const,
  iapAudience: AUDIENCE,
  iapJwksUrl: "https://keys.invalid",
  allowedEmails: ["ops@partner.example"],
  allowedDomains: ["example.com"],
};

let keys: JWTVerifyGetKey;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" }] });
});

function assertion(claims: { email?: string; issuer?: string; audience?: string; expires?: string } = {}): Promise<string> {
  return new SignJWT(claims.email === undefined ? {} : { email: claims.email })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(claims.issuer ?? IAP_ISSUER)
    .setAudience(claims.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(claims.expires ?? "5m")
    .sign(privateKey);
}

function headersWith(token?: string): Headers {
  return new Headers(token ? { "x-goog-iap-jwt-assertion": token } : {});
}

describe("authenticate", () => {
  it("accepts an allowed operator by domain or by email", async () => {
    await expect(authenticate(headersWith(await assertion({ email: "Alex@Example.com" })), SETTINGS, keys)).resolves.toEqual({ email: "alex@example.com" });
    await expect(authenticate(headersWith(await assertion({ email: "ops@partner.example" })), SETTINGS, keys)).resolves.toEqual({ email: "ops@partner.example" });
  });

  it("rejects operators outside the allow-list", async () => {
    await expect(authenticate(headersWith(await assertion({ email: "eve@elsewhere.example" })), SETTINGS, keys)).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a missing, foreign or expired assertion", async () => {
    await expect(authenticate(headersWith(), SETTINGS, keys)).rejects.toBeInstanceOf(AuthError);
    await expect(authenticate(headersWith(await assertion({ email: "alex@example.com", audience: "/projects/9/x" })), SETTINGS, keys)).rejects.toBeInstanceOf(AuthError);
    await expect(authenticate(headersWith(await assertion({ email: "alex@example.com", issuer: "https://evil.example" })), SETTINGS, keys)).rejects.toBeInstanceOf(AuthError);
    await expect(authenticate(headersWith(await assertion({ email: "alex@example.com", expires: "-1m" })), SETTINGS, keys)).rejects.toBeInstanceOf(AuthError);
    await expect(authenticate(headersWith(await assertion({})), SETTINGS, keys)).rejects.toBeInstanceOf(AuthError);
  });

  it("returns the local operator when authentication is off", async () => {
    await expect(authenticate(headersWith(), { ...SETTINGS, authMode: "none" })).resolves.toEqual({ email: "local-operator" });
  });
});

describe("isAllowed", () => {
  it("compares case-insensitively and does not match subdomains", () => {
    expect(isAllowed("ALEX@EXAMPLE.COM", [], ["example.com"])).toBe(true);
    expect(isAllowed("alex@mail.example.com", [], ["example.com"])).toBe(false);
  });
});
