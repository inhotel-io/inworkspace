import { describe, expect, it } from "vitest";
import { corsHeaders, preflight } from "./cors";

const SERVER = "https://mail.example.com";

describe("corsHeaders", () => {
  it("allows exactly the server's origin", () => {
    expect(corsHeaders(SERVER, SERVER)).toEqual({ Vary: "Origin", "Access-Control-Allow-Origin": SERVER });
  });

  it("allows no other origin, and no request without one", () => {
    expect(corsHeaders("https://attacker.example", SERVER)).toEqual({ Vary: "Origin" });
    expect(corsHeaders("https://mail.example.com.attacker.example", SERVER)).toEqual({ Vary: "Origin" });
    expect(corsHeaders(null, SERVER)).toEqual({ Vary: "Origin" });
  });
});

describe("preflight", () => {
  it("allows GET with an Authorization header from the server's origin", () => {
    const response = preflight(SERVER, SERVER);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(SERVER);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET");
    expect(response.headers.get("access-control-allow-headers")).toBe("Authorization");
    expect(response.headers.get("access-control-max-age")).toBe("600");
  });

  it("also allows POST with a JSON body where a route takes one", () => {
    const response = preflight(SERVER, SERVER, true);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST");
    expect(response.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type");
  });

  it("refuses any other origin", () => {
    const response = preflight("https://attacker.example", SERVER);
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
