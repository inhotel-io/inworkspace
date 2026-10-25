import { describe, expect, it } from "vitest";
import { base64Url, randomToken, s256Challenge } from "./pkce";

describe("base64Url", () => {
  it("uses the URL alphabet without padding", () => {
    expect(base64Url(new Uint8Array([]))).toBe("");
    expect(base64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(base64Url(new TextEncoder().encode("hi"))).toBe("aGk");
  });
});

describe("randomToken", () => {
  it("gives a 43-character verifier for 32 bytes", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("encodes the bytes of its random source", () => {
    expect(randomToken(3, (bytes) => bytes.set([1, 2, 3]))).toBe("AQID");
  });
});

describe("s256Challenge", () => {
  it("matches the example in RFC 7636, appendix B", async () => {
    expect(await s256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});
