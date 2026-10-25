export type ConsoleRole = "api" | "ingest" | "all";
export type AuthMode = "server" | "none";

export interface ConsoleConfig {
  role: ConsoleRole;
  databaseUrl: string;
  /** Ingest role only; empty otherwise. */
  webhookSigningKey: string;
  retentionDays: number;
  /** API role only; empty otherwise. */
  jmapUrl: string;
  jmapPrincipal: string;
  jmapPrincipalSecret: string;
  agentDomains: string[];
  agentLocalpartPattern: RegExp | null;
  /** Origin at which browsers reach the api role. */
  publicUrl: string;
  authMode: AuthMode;
  /** The server permission an operator's account needs. */
  operatorPermission: string;
  /** Logins that may use the console; empty allows every account with the permission. */
  allowedAccounts: string[];
  oauthClientId: string;
  /** Null shows times in each browser's own time zone. */
  displayTimeZone: string | null;
  uiDistDir: string;
  /** Proxies in front of this service that append the client's address to X-Forwarded-For. */
  trustedProxyHops: number;
  /** Tokens that live longer cannot be access tokens (refresh tokens, links), and are refused unchecked. */
  maxAccessTokenLifetimeSeconds: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid console configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** The origin of an http(s) URL that is nothing more than an origin; null otherwise. */
function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.href === `${url.origin}/` ? url.origin : null;
  } catch {
    return null;
  }
}

export function servesIngest(config: Pick<ConsoleConfig, "role">): boolean {
  return config.role === "ingest" || config.role === "all";
}

export function servesApi(config: Pick<ConsoleConfig, "role">): boolean {
  return config.role === "api" || config.role === "all";
}

function text(env: Env, name: string): string {
  return env[name]?.trim() ?? "";
}

function list(env: Env, name: string): string[] {
  return text(env, name)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

export function parseConfig(env: Env): ConsoleConfig {
  const problems: string[] = [];
  const need = (name: string): string => {
    const value = text(env, name);
    if (!value) problems.push(`${name} is required`);
    return value;
  };
  const origin = (name: string, example: string): string => {
    const value = need(name);
    if (!value) return "";
    const parsed = originOf(value);
    if (!parsed) problems.push(`${name} must be an http(s) origin such as ${example}`);
    return parsed ?? value;
  };
  const whole = (name: string, fallback: number, min: number, max: number, problem: string): number => {
    const raw = text(env, name);
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) problems.push(problem);
    return value;
  };

  const role = text(env, "CONSOLE_ROLE") as ConsoleRole;
  if (role !== "api" && role !== "ingest" && role !== "all") {
    problems.push("CONSOLE_ROLE must be api, ingest or all");
  }
  const databaseUrl = need("DATABASE_URL");

  let webhookSigningKey = "";
  let retentionDays = 30;
  if (servesIngest({ role })) {
    webhookSigningKey = need("WEBHOOK_SIGNING_KEY");
    if (webhookSigningKey && webhookSigningKey.length < 32) {
      problems.push("WEBHOOK_SIGNING_KEY must be at least 32 characters");
    }
    const days = text(env, "EVENT_RETENTION_DAYS");
    if (days) {
      retentionDays = Number(days);
      if (!Number.isInteger(retentionDays) || retentionDays < 1) {
        problems.push("EVENT_RETENTION_DAYS must be a positive integer");
      }
    }
  }

  let jmapUrl = "";
  let jmapPrincipal = "";
  let jmapPrincipalSecret = "";
  let agentDomains: string[] = [];
  let agentLocalpartPattern: RegExp | null = null;
  let publicUrl = "";
  let authMode: AuthMode = "server";
  let operatorPermission = "impersonate";
  let allowedAccounts: string[] = [];
  let oauthClientId = "inworkspace-console";
  let displayTimeZone: string | null = null;
  let uiDistDir = "ui-dist";
  let trustedProxyHops = 0;
  let maxAccessTokenLifetimeSeconds = 86400;
  if (servesApi({ role })) {
    jmapUrl = origin("JMAP_URL", "https://mail.example.com");
    jmapPrincipal = need("JMAP_PRINCIPAL").toLowerCase();
    jmapPrincipalSecret = need("JMAP_PRINCIPAL_SECRET");
    agentDomains = list(env, "AGENT_DOMAINS");
    if (agentDomains.length === 0) problems.push("AGENT_DOMAINS is required");

    const pattern = text(env, "AGENT_LOCALPART_PATTERN");
    if (pattern) {
      try {
        agentLocalpartPattern = new RegExp(`^(?:${pattern})$`);
      } catch {
        problems.push("AGENT_LOCALPART_PATTERN is not a valid regular expression");
      }
    }

    publicUrl = origin("PUBLIC_URL", "https://console-api.example.com");

    const mode = text(env, "AUTH_MODE") || "server";
    if (mode !== "server" && mode !== "none") problems.push("AUTH_MODE must be server or none");
    authMode = mode === "none" ? "none" : "server";
    if (mode === "none" && env.NODE_ENV === "production" && env.ALLOW_INSECURE_AUTH_NONE !== "1") {
      problems.push("AUTH_MODE=none is refused in production unless ALLOW_INSECURE_AUTH_NONE=1");
    }

    operatorPermission = text(env, "OPERATOR_PERMISSION") || "impersonate";
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(operatorPermission)) {
      problems.push("OPERATOR_PERMISSION must be a permission name such as impersonate");
    }
    allowedAccounts = list(env, "ALLOWED_ACCOUNTS");
    oauthClientId = text(env, "OAUTH_CLIENT_ID") || "inworkspace-console";
    if (!/^[A-Za-z0-9._~-]{1,100}$/.test(oauthClientId)) {
      problems.push("OAUTH_CLIENT_ID may only contain letters, digits and . _ ~ -");
    }

    const zone = text(env, "DISPLAY_TIME_ZONE");
    if (zone) {
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: zone });
        displayTimeZone = zone;
      } catch {
        problems.push("DISPLAY_TIME_ZONE is not a valid IANA time zone");
      }
    }
    uiDistDir = text(env, "UI_DIST_DIR") || "ui-dist";
    trustedProxyHops = whole("TRUSTED_PROXY_HOPS", 0, 0, 10, "TRUSTED_PROXY_HOPS must be a whole number from 0 to 10");
    maxAccessTokenLifetimeSeconds = whole(
      "MAX_ACCESS_TOKEN_LIFETIME",
      86400,
      60,
      2_592_000,
      "MAX_ACCESS_TOKEN_LIFETIME must be a whole number of seconds from 60 to 2592000",
    );
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    role,
    databaseUrl,
    webhookSigningKey,
    retentionDays,
    jmapUrl,
    jmapPrincipal,
    jmapPrincipalSecret,
    agentDomains,
    agentLocalpartPattern,
    publicUrl,
    authMode,
    operatorPermission,
    allowedAccounts,
    oauthClientId,
    displayTimeZone,
    uiDistDir,
    trustedProxyHops,
    maxAccessTokenLifetimeSeconds,
  };
}

let cached: ConsoleConfig | undefined;

/** The configuration of this process, parsed on first use. Never call at module top level: builds run without it. */
export function getConfig(): ConsoleConfig {
  cached ??= parseConfig(process.env);
  return cached;
}
