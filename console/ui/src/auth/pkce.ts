/** base64url without padding (RFC 4648, section 5). */
export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A random token; 32 bytes give the 43-character code verifier RFC 7636 recommends. */
export function randomToken(
  byteLength = 32,
  fill: (bytes: Uint8Array) => void = (bytes) => void crypto.getRandomValues(bytes),
): string {
  const bytes = new Uint8Array(byteLength);
  fill(bytes);
  return base64Url(bytes);
}

/** The S256 code challenge: base64url(SHA-256(verifier)). */
export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}
