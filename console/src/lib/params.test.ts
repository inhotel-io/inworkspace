import { describe, expect, it } from "vitest";
import { decodeAddressParam, firstValue, isThreadId, parsePosition } from "./params";

describe("route params", () => {
  it("decodes an address segment", () => {
    expect(decodeAddressParam("A21I3V9V%40agents.example.test")).toBe("a21i3v9v@agents.example.test");
    expect(decodeAddressParam("a21i3v9v@agents.example.test")).toBe("a21i3v9v@agents.example.test");
    expect(decodeAddressParam("%E0%A4%A")).toBe("%e0%a4%a");
  });

  it("parses a page position", () => {
    expect(parsePosition(undefined)).toBe(0);
    expect(parsePosition("100")).toBe(100);
    expect(parsePosition(["50", "100"])).toBe(50);
    expect(parsePosition("-5")).toBe(0);
    expect(parsePosition("abc")).toBe(0);
    expect(parsePosition("99999999")).toBe(100000);
  });

  it("accepts only plausible thread ids", () => {
    expect(isThreadId("b")).toBe(true);
    expect(isThreadId("abc_DEF-123")).toBe(true);
    expect(isThreadId("../x")).toBe(false);
    expect(isThreadId("")).toBe(false);
  });

  it("takes the first value of a repeated search param", () => {
    expect(firstValue(["a", "b"])).toBe("a");
    expect(firstValue("a")).toBe("a");
    expect(firstValue(undefined)).toBeNull();
  });
});
