import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "./config";

const WEB = {
  CONSOLE_ROLE: "web",
  DATABASE_URL: "postgres://console:secret@localhost/console",
  JMAP_URL: "https://mail.example.com/",
  JMAP_PRINCIPAL: "Console@Example.com",
  JMAP_PRINCIPAL_SECRET: "secret",
  AGENT_DOMAINS: "Agents.Example.com, other.example.com",
  AUTH_MODE: "iap",
  IAP_AUDIENCE: "/projects/1/locations/region/services/console",
  ALLOWED_DOMAINS: "example.com",
};

const INGEST = {
  CONSOLE_ROLE: "ingest",
  DATABASE_URL: "postgres://console:secret@localhost/console",
  WEBHOOK_SIGNING_KEY: "k".repeat(32),
};

function problemsOf(env: Record<string, string>): string[] {
  try {
    parseConfig(env);
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
}

describe("parseConfig", () => {
  it("parses a web configuration and normalizes it", () => {
    const config = parseConfig(WEB);
    expect(config.role).toBe("web");
    expect(config.jmapUrl).toBe("https://mail.example.com");
    expect(config.jmapPrincipal).toBe("console@example.com");
    expect(config.agentDomains).toEqual(["agents.example.com", "other.example.com"]);
    expect(config.allowedDomains).toEqual(["example.com"]);
    expect(config.iapJwksUrl).toBe("https://www.gstatic.com/iap/verify/public_key-jwk");
    expect(config.displayTimeZone).toBe("UTC");
  });

  it("parses an ingest configuration with the default retention", () => {
    const config = parseConfig(INGEST);
    expect(config.retentionDays).toBe(30);
    expect(config.webhookSigningKey).toBe("k".repeat(32));
  });

  it("does not require web settings for the ingest role", () => {
    expect(problemsOf(INGEST)).toEqual([]);
  });

  it("serves both roles with all", () => {
    const config = parseConfig({ ...WEB, ...INGEST, CONSOLE_ROLE: "all" });
    expect(config.webhookSigningKey).toHaveLength(32);
    expect(config.jmapPrincipal).toBe("console@example.com");
  });

  it("requires a known role", () => {
    expect(problemsOf({ ...INGEST, CONSOLE_ROLE: "both" })).toContain("CONSOLE_ROLE must be web, ingest or all");
  });

  it("requires a long signing key", () => {
    expect(problemsOf({ ...INGEST, WEBHOOK_SIGNING_KEY: "short" })).toContain(
      "WEBHOOK_SIGNING_KEY must be at least 32 characters",
    );
  });

  it("rejects a retention that is not a positive integer", () => {
    expect(problemsOf({ ...INGEST, EVENT_RETENTION_DAYS: "0" })).toContain(
      "EVENT_RETENTION_DAYS must be a positive integer",
    );
  });

  it("requires the JMAP settings for the web role", () => {
    expect(problemsOf({ CONSOLE_ROLE: "web", DATABASE_URL: "postgres://x", AUTH_MODE: "none" })).toEqual(
      expect.arrayContaining([
        "JMAP_URL is required",
        "JMAP_PRINCIPAL is required",
        "JMAP_PRINCIPAL_SECRET is required",
        "AGENT_DOMAINS is required",
      ]),
    );
  });

  it("requires an allow-list with IAP", () => {
    expect(problemsOf({ ...WEB, ALLOWED_DOMAINS: "" })).toContain(
      "ALLOWED_EMAILS or ALLOWED_DOMAINS is required when AUTH_MODE=iap",
    );
  });

  it("refuses AUTH_MODE=none in production", () => {
    expect(problemsOf({ ...WEB, AUTH_MODE: "none", NODE_ENV: "production" })).toContain(
      "AUTH_MODE=none is refused in production unless ALLOW_INSECURE_AUTH_NONE=1",
    );
  });

  it("allows AUTH_MODE=none in production with the explicit override", () => {
    expect(problemsOf({ ...WEB, AUTH_MODE: "none", NODE_ENV: "production", ALLOW_INSECURE_AUTH_NONE: "1" })).toEqual([]);
  });

  it("anchors the local-part pattern", () => {
    const config = parseConfig({ ...WEB, AGENT_LOCALPART_PATTERN: "a[0-9a-z]{7}" });
    expect(config.agentLocalpartPattern?.test("a21i3v9v")).toBe(true);
    expect(config.agentLocalpartPattern?.test("xa21i3v9v")).toBe(false);
  });

  it("rejects an invalid local-part pattern and time zone", () => {
    expect(problemsOf({ ...WEB, AGENT_LOCALPART_PATTERN: "(", DISPLAY_TIME_ZONE: "Mars/Olympus" })).toEqual(
      expect.arrayContaining([
        "AGENT_LOCALPART_PATTERN is not a valid regular expression",
        "DISPLAY_TIME_ZONE is not a valid IANA time zone",
      ]),
    );
  });
});
