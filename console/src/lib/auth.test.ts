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

describe("authenticate with AUTH_MODE=cloud-run", () => {
  const CLOUD_RUN = { ...SETTINGS, authMode: "cloud-run" as const };
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

  // What Cloud Run forwards after its IAM check: the caller's ID token with the signature replaced.
  function forwarded(claims: Record<string, unknown>, signature = "SIGNATURE_REMOVED_BY_GOOGLE"): Headers {
    const payload = { iss: "https://accounts.google.com", email_verified: true, exp: Math.floor(Date.now() / 1000) + 300, ...claims };
    return new Headers({ authorization: `Bearer ${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.${signature}` });
  }

  it("takes the operator from a token that passed Cloud Run's IAM check", async () => {
    await expect(authenticate(forwarded({ email: "Alex@Example.com" }), CLOUD_RUN)).resolves.toEqual({ email: "alex@example.com" });
    await expect(authenticate(forwarded({ email: "ops@partner.example", iss: "accounts.google.com" }), CLOUD_RUN)).resolves.toEqual({
      email: "ops@partner.example",
    });
  });

  it("rejects tokens that did not come through Cloud Run, or say the wrong thing", async () => {
    const rejected = [
      new Headers(),
      new Headers({ authorization: "Basic dXNlcjpwYXNz" }),
      forwarded({ email: "alex@example.com" }, "a-real-looking-signature"),
      forwarded({ email: "alex@example.com", iss: "https://evil.example" }),
      forwarded({ email: "alex@example.com", email_verified: false }),
      forwarded({ email: "alex@example.com", exp: Math.floor(Date.now() / 1000) - 60 }),
      forwarded({ email: "eve@elsewhere.example" }),
      forwarded({}),
      new Headers({ authorization: "Bearer not.a-token.SIGNATURE_REMOVED_BY_GOOGLE" }),
    ];
    for (const headers of rejected) {
      await expect(authenticate(headers, CLOUD_RUN)).rejects.toBeInstanceOf(AuthError);
    }
  });
});

describe("isAllowed", () => {
  it("compares case-insensitively and does not match subdomains", () => {
    expect(isAllowed("ALEX@EXAMPLE.COM", [], ["example.com"])).toBe(true);
    expect(isAllowed("alex@mail.example.com", [], ["example.com"])).toBe(false);
  });
});
