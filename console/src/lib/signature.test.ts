import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "./signature";

// Vectors computed independently with Python's hmac module.
const KEY = "test-signing-key-0123456789abcdef0123456789";
const encode = (text: string) => new TextEncoder().encode(text);

describe("signature", () => {
  it("matches an independently computed signature", () => {
    expect(signBody('{"events":[]}', KEY)).toBe("CjEV7KUCtGqW7dqAmPdenMDY1Cj6ByDWew09Vr4u86s=");
  });

  it("accepts the server's signature over the exact body", () => {
    const body = '{"events":[{"type":"x","createdAt":"2026-10-25T11:19:17Z","data":{}}]}';
    expect(verifySignature(encode(body), "RHDzWACuS/CKh8sRb9q7RrWfS8Z6WLeOIdEWP3tn/GU=", KEY)).toBe(true);
  });

  it("rejects a changed body", () => {
    expect(verifySignature(encode('{"events":[ ]}'), "CjEV7KUCtGqW7dqAmPdenMDY1Cj6ByDWew09Vr4u86s=", KEY)).toBe(false);
  });

  it("rejects another key", () => {
    expect(verifySignature(encode('{"events":[]}'), "CjEV7KUCtGqW7dqAmPdenMDY1Cj6ByDWew09Vr4u86s=", `${KEY}x`)).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(verifySignature(encode("{}"), null, KEY)).toBe(false);
    expect(verifySignature(encode("{}"), "not base64!", KEY)).toBe(false);
  });
});
