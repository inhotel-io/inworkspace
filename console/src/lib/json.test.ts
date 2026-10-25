import { describe, expect, it } from "vitest";
import { parseJsonExact } from "./json";

describe("parseJsonExact", () => {
  it("keeps integers above 2^53 as exact strings", () => {
    const value = parseJsonExact('{"queueId":336901507433627648,"size":1691,"ratio":1.5}') as Record<string, unknown>;
    expect(value).toEqual({ queueId: "336901507433627648", size: 1691, ratio: 1.5 });
  });

  it("keeps them exact inside arrays and nested objects", () => {
    const value = parseJsonExact('{"events":[{"data":{"spanId":336901578871013376,"to":["a@b.c"]}}]}');
    expect(value).toEqual({ events: [{ data: { spanId: "336901578871013376", to: ["a@b.c"] } }] });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseJsonExact("{")).toThrow(SyntaxError);
  });
});
