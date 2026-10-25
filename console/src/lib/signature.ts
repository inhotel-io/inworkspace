import { createHmac, timingSafeEqual } from "node:crypto";

/** The server's X-Signature: base64 HMAC-SHA256 of the body, keyed with the key's UTF-8 bytes. */
export function signBody(body: Uint8Array | string, key: string): string {
  return createHmac("sha256", key).update(body).digest("base64");
}

export function verifySignature(body: Uint8Array, header: string | null, key: string): boolean {
  if (!header || !key) return false;
  const given = Buffer.from(header.trim(), "base64");
  const expected = createHmac("sha256", key).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}
