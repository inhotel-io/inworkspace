import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, servesApi, servesIngest } from "./config";

const API = {
  CONSOLE_ROLE: "api",
  DATABASE_URL: "postgres://console:secret@localhost/console",
  JMAP_URL: "https://mail.example.com/",
  JMAP_PRINCIPAL: "Console@Example.com",
  JMAP_PRINCIPAL_SECRET: "secret",
  AGENT_DOMAINS: "Agents.Example.com, other.example.com",
  PUBLIC_URL: "https://console-api.example.com/",
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
  it("parses an api configuration with its defaults", () => {
    const config = parseConfig(API);
    expect(config.role).toBe("api");
    expect(config.jmapUrl).toBe("https://mail.example.com");
    expect(config.publicUrl).toBe("https://console-api.example.com");
    expect(config.jmapPrincipal).toBe("console@example.com");
    expect(config.agentDomains).toEqual(["agents.example.com", "other.example.com"]);
    expect(config.authMode).toBe("server");
    expect(config.operatorPermission).toBe("impersonate");
    expect(config.allowedAccounts).toEqual([]);
    expect(config.oauthClientId).toBe("inworkspace-console");
    expect(config.displayTimeZone).toBeNull();
    expect(config.uiDistDir).toBe("ui-dist");
  });

  it("reads the optional api settings", () => {
    const config = parseConfig({
      ...API,
      OPERATOR_PERMISSION: "sysAccountGet",
      ALLOWED_ACCOUNTS: "Admin, ops@example.com",
      OAUTH_CLIENT_ID: "console-staging",
      DISPLAY_TIME_ZONE: "Europe/Zurich",
      UI_DIST_DIR: "/srv/ui",
    });
    expect(config.operatorPermission).toBe("sysAccountGet");
    expect(config.allowedAccounts).toEqual(["admin", "ops@example.com"]);
    expect(config.oauthClientId).toBe("console-staging");
    expect(config.displayTimeZone).toBe("Europe/Zurich");
    expect(config.uiDistDir).toBe("/srv/ui");
  });

  it("parses an ingest configuration with the default retention", () => {
    const config = parseConfig(INGEST);
    expect(config.retentionDays).toBe(30);
    expect(config.webhookSigningKey).toBe("k".repeat(32));
  });

  it("does not require api settings for the ingest role", () => {
    expect(problemsOf(INGEST)).toEqual([]);
  });

  it("serves both roles with all", () => {
    const config = parseConfig({ ...API, ...INGEST, CONSOLE_ROLE: "all" });
    expect(servesApi(config)).toBe(true);
    expect(servesIngest(config)).toBe(true);
    expect(config.webhookSigningKey).toHaveLength(32);
    expect(config.jmapPrincipal).toBe("console@example.com");
  });

  it("requires a known role", () => {
    expect(problemsOf({ ...INGEST, CONSOLE_ROLE: "web" })).toContain("CONSOLE_ROLE must be api, ingest or all");
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

  it("requires the server and API settings for the api role", () => {
    expect(problemsOf({ CONSOLE_ROLE: "api", DATABASE_URL: "postgres://x" })).toEqual(
      expect.arrayContaining([
        "JMAP_URL is required",
        "JMAP_PRINCIPAL is required",
        "JMAP_PRINCIPAL_SECRET is required",
        "AGENT_DOMAINS is required",
        "PUBLIC_URL is required",
      ]),
    );
  });

  it("requires origins, not paths", () => {
    expect(problemsOf({ ...API, JMAP_URL: "https://mail.example.com/jmap", PUBLIC_URL: "console-api" })).toEqual(
      expect.arrayContaining([
        "JMAP_URL must be an http(s) origin such as https://mail.example.com",
        "PUBLIC_URL must be an http(s) origin such as https://console-api.example.com",
      ]),
    );
  });

  it("refuses an origin with a path, query, credentials or another scheme", () => {
    for (const value of ["https://mail.example.com?x", "https://user:pw@mail.example.com", "ftp://mail.example.com", "mail.example.com"]) {
      expect(problemsOf({ ...API, JMAP_URL: value })).toContain("JMAP_URL must be an http(s) origin such as https://mail.example.com");
    }
    expect(parseConfig({ ...API, JMAP_URL: "https://Mail.Example.com/" }).jmapUrl).toBe("https://mail.example.com");
  });

  it("reads the proxy hops and the longest access-token lifetime", () => {
    const defaults = parseConfig(API);
    expect(defaults.trustedProxyHops).toBe(0);
    expect(defaults.maxAccessTokenLifetimeSeconds).toBe(86400);
    const set = parseConfig({ ...API, TRUSTED_PROXY_HOPS: "1", MAX_ACCESS_TOKEN_LIFETIME: "7200" });
    expect(set.trustedProxyHops).toBe(1);
    expect(set.maxAccessTokenLifetimeSeconds).toBe(7200);
    expect(problemsOf({ ...API, TRUSTED_PROXY_HOPS: "-1", MAX_ACCESS_TOKEN_LIFETIME: "0" })).toEqual(
      expect.arrayContaining([
        "TRUSTED_PROXY_HOPS must be a whole number from 0 to 10",
        "MAX_ACCESS_TOKEN_LIFETIME must be a whole number of seconds from 60 to 2592000",
      ]),
    );
  });

  it("accepts only the server and none sign-in modes", () => {
    expect(problemsOf({ ...API, AUTH_MODE: "iap" })).toContain("AUTH_MODE must be server or none");
  });

  it("refuses AUTH_MODE=none in production", () => {
    expect(problemsOf({ ...API, AUTH_MODE: "none", NODE_ENV: "production" })).toContain(
      "AUTH_MODE=none is refused in production unless ALLOW_INSECURE_AUTH_NONE=1",
    );
  });

  it("allows AUTH_MODE=none in production with the explicit override", () => {
    expect(problemsOf({ ...API, AUTH_MODE: "none", NODE_ENV: "production", ALLOW_INSECURE_AUTH_NONE: "1" })).toEqual([]);
  });

  it("rejects an invalid permission name and client id", () => {
    expect(problemsOf({ ...API, OPERATOR_PERMISSION: "impersonate everyone", OAUTH_CLIENT_ID: "a b" })).toEqual(
      expect.arrayContaining([
        "OPERATOR_PERMISSION must be a permission name such as impersonate",
        "OAUTH_CLIENT_ID may only contain letters, digits and . _ ~ -",
      ]),
    );
  });

  it("anchors the local-part pattern", () => {
    const config = parseConfig({ ...API, AGENT_LOCALPART_PATTERN: "a[0-9a-z]{7}" });
    expect(config.agentLocalpartPattern?.test("a21i3v9v")).toBe(true);
    expect(config.agentLocalpartPattern?.test("xa21i3v9v")).toBe(false);
  });

  it("rejects an invalid local-part pattern and time zone", () => {
    expect(problemsOf({ ...API, AGENT_LOCALPART_PATTERN: "(", DISPLAY_TIME_ZONE: "Mars/Olympus" })).toEqual(
      expect.arrayContaining([
        "AGENT_LOCALPART_PATTERN is not a valid regular expression",
        "DISPLAY_TIME_ZONE is not a valid IANA time zone",
      ]),
    );
  });
});
