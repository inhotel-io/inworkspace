export type ConsoleRole = "web" | "ingest" | "all";
export type AuthMode = "iap" | "cloud-run" | "none";

export interface ConsoleConfig {
  role: ConsoleRole;
  databaseUrl: string;
  /** Ingest role only; empty otherwise. */
  webhookSigningKey: string;
  retentionDays: number;
  /** Web role only; empty otherwise. */
  jmapUrl: string;
  jmapPrincipal: string;
  jmapPrincipalSecret: string;
  agentDomains: string[];
  agentLocalpartPattern: RegExp | null;
  authMode: AuthMode;
  iapAudience: string;
  iapJwksUrl: string;
  allowedEmails: string[];
  allowedDomains: string[];
  displayTimeZone: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid console configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const GOOGLE_IAP_JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk";

export function servesIngest(config: Pick<ConsoleConfig, "role">): boolean {
  return config.role === "ingest" || config.role === "all";
}

export function servesWeb(config: Pick<ConsoleConfig, "role">): boolean {
  return config.role === "web" || config.role === "all";
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

  const role = text(env, "CONSOLE_ROLE") as ConsoleRole;
  if (role !== "web" && role !== "ingest" && role !== "all") {
    problems.push("CONSOLE_ROLE must be web, ingest or all");
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
  let authMode: AuthMode = "iap";
  let iapAudience = "";
  let iapJwksUrl = GOOGLE_IAP_JWKS_URL;
  let allowedEmails: string[] = [];
  let allowedDomains: string[] = [];
  let displayTimeZone = "UTC";
  if (servesWeb({ role })) {
    jmapUrl = need("JMAP_URL").replace(/\/+$/, "");
    if (jmapUrl && !/^https?:\/\/[^/]+$/.test(jmapUrl)) {
      problems.push("JMAP_URL must be an http(s) origin such as https://mail.example.com");
    }
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

    const mode = text(env, "AUTH_MODE") || "iap";
    if (mode !== "iap" && mode !== "cloud-run" && mode !== "none") problems.push("AUTH_MODE must be iap, cloud-run or none");
    authMode = mode === "none" || mode === "cloud-run" ? mode : "iap";
    if (mode === "iap") {
      iapAudience = need("IAP_AUDIENCE");
      iapJwksUrl = text(env, "IAP_JWKS_URL") || GOOGLE_IAP_JWKS_URL;
    }
    if (mode === "iap" || mode === "cloud-run") {
      allowedEmails = list(env, "ALLOWED_EMAILS");
      allowedDomains = list(env, "ALLOWED_DOMAINS");
      if (allowedEmails.length === 0 && allowedDomains.length === 0) {
        problems.push(`ALLOWED_EMAILS or ALLOWED_DOMAINS is required when AUTH_MODE=${mode}`);
      }
    } else if (mode === "none" && env.NODE_ENV === "production" && env.ALLOW_INSECURE_AUTH_NONE !== "1") {
      problems.push("AUTH_MODE=none is refused in production unless ALLOW_INSECURE_AUTH_NONE=1");
    }

    displayTimeZone = text(env, "DISPLAY_TIME_ZONE") || "UTC";
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: displayTimeZone });
    } catch {
      problems.push("DISPLAY_TIME_ZONE is not a valid IANA time zone");
    }
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
    authMode,
    iapAudience,
    iapJwksUrl,
    allowedEmails,
    allowedDomains,
    displayTimeZone,
  };
}

let cached: ConsoleConfig | undefined;

/** The configuration of this process, parsed on first use. Never call at module top level: builds run without it. */
export function getConfig(): ConsoleConfig {
  cached ??= parseConfig(process.env);
  return cached;
}
