# Console served by the inWorkspace server — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The inWorkspace server serves the console at `/console`, and operators sign in with
their mail-server account. To get there, the console service becomes a JSON API, and its pages
become a static web app that the server hosts.

**Architecture:**
- The Next.js service keeps the ingest role and otherwise has route handlers only:
  `/api/v1/*` and `/ui/*`.
- The web app is a Vite and React single-page app, built into `ui-dist/`. The API zips it
  together with the runtime settings, and the server downloads the zip as a web application
  (`x:Application`).
- Operators sign in at the server with OAuth 2.0 and PKCE.
- The API checks each bearer token by introspection, authenticating as the console principal,
  then checks the operator's permission.

**Tech Stack:** Next.js 16 route handlers, TypeScript, Postgres (`pg`), `fflate`, Vite 8,
React 19, React Router 8 (hash routing), Tailwind CSS 4, Vitest.

Spec: [`design.md`](design.md), as revised on 2026-10-26. Issue: inhotel-io/inworkspace#8.

Each code block below is preceded by a `**File: `path`**` line, and gives that file's complete
content; paths are relative to `console/`. Run every command from `console/`.

## File structure

| Path | Responsibility |
| --- | --- |
| `vite.config.ts` | Web app build (`ui/` → `ui-dist/`) and development server. |
| `ui/index.html` | Page template; the API fills the settings placeholders. |
| `ui/src/settings.ts` | Runtime settings from the page, and the base path. |
| `ui/src/auth/pkce.ts` | Random tokens and the S256 challenge. |
| `ui/src/auth/session.ts` | Sign-in start and finish, token storage, refresh. |
| `ui/src/api.ts` | API client with the bearer token, refresh-once, session end. |
| `ui/src/console.tsx` | React context: settings, API client, sign-in and sign-out. |
| `ui/src/main.tsx`, `App.tsx`, `Shell.tsx` | Entry, hash router, signed-in layout. |
| `ui/src/useApi.ts`, `useDocumentTitle.ts` | Data loading and page titles. |
| `ui/src/components/*`, `ui/src/pages/*` | The views, ported from the server-rendered pages. |
| `src/lib/apiTypes.ts` | The JSON contract shared by the API and the web app. |
| `src/lib/auth.ts` | Bearer token verification against the server. |
| `src/lib/cors.ts` | CORS headers and preflight answers. |
| `src/lib/apiRoute.ts` | Wrapper for every API handler, and `ApiError`. |
| `src/lib/api.ts` | The wrapper wired to the configuration and services. |
| `src/lib/uiBundle.ts` | The zip the server downloads. |
| `src/lib/emailDocument.ts` | Sandboxed document for email HTML, shared with the web app. |
| `src/app/api/v1/**/route.ts`, `src/app/ui/**/route.ts` | Endpoints. |
| `scripts/server-setup.mjs` | Also registers the OAuth client and the web application. |
| `e2e/run.mjs` | End-to-end run, including sign-in through the server. |

Deleted:
- the server-rendered pages: `src/app/page.tsx`, `layout.tsx`, `error.tsx`, `not-found.tsx`,
  `forbidden.tsx`, `agents/`, `events/` and `api/events/`;
- `src/proxy.ts`;
- `src/lib/operator.ts`, `cloudRunGuard.ts`, `gate.ts` and their tests;
- `src/components/OperatorBadge.tsx`.

---

### Task 1: Tooling

**Files:** `package.json`, `package-lock.json`, `vitest.config.mts`, `eslint.config.mjs`,
`tsconfig.json`, `.gitignore`, `.dockerignore`, `vite.config.ts`.

- [ ] **Step 1: Change dependencies and scripts**

```bash
npm uninstall jose @tailwindcss/turbopack
npm install fflate@^0.8.3 react-router@^8.5.0
npm install -D vite@^8.3.5 @vitejs/plugin-react@^6.1.2 @tailwindcss/vite@^4.3.3
npm pkg set version=0.2.0 scripts.build="next build && vite build" scripts.build:ui="vite build" scripts.dev:ui="vite"
printf '\n# the built web app (npm run build:ui)\n/ui-dist/\n' >> .gitignore
```

- [ ] **Step 2: Write the configuration files**

**File: `vitest.config.mts`**

```ts
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "ui/src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
  },
});
```

**File: `eslint.config.mjs`**

```js
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Underscore-prefixed parameters exist only to give a callback its type.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The built web app.
    "ui-dist/**",
  ]),
]);

export default eslintConfig;
```

**File: `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts",
    "**/*.mts"
  ],
  "exclude": ["node_modules", "ui-dist"]
}
```

**File: `.dockerignore`**

```text
node_modules
.next
ui-dist
e2e
docs
*.md
.env*
coverage
```

**File: `vite.config.ts`**

```ts
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const mailServer = process.env.CONSOLE_MAIL_SERVER ?? "http://localhost:18080";
const consoleApi = process.env.CONSOLE_API ?? "http://localhost:3100";

/**
 * In production the console service writes its settings into index.html (src/lib/uiBundle.ts).
 * The development server fills them itself. API calls stay on its own origin and are proxied,
 * as are the mail server's sign-in paths. The page gets no content security policy, because
 * Vite injects inline scripts.
 */
function developmentSettings(): Plugin {
  return {
    name: "inworkspace-console-development-settings",
    apply: "serve",
    transformIndexHtml(html) {
      return html
        .replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
        .replace("__CONSOLE_API_URL__", "")
        .replace("__CONSOLE_OAUTH_CLIENT_ID__", process.env.CONSOLE_OAUTH_CLIENT_ID ?? "inworkspace-console")
        .replace("__CONSOLE_TIME_ZONE__", "");
    },
  };
}

export default defineConfig({
  root: "ui",
  // Relative asset URLs: the server places the app under a prefix and rewrites <base href>.
  base: "./",
  plugins: [react(), tailwindcss(), developmentSettings()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: { outDir: path.resolve(import.meta.dirname, "ui-dist"), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api/v1": consoleApi,
      "/api/auth": mailServer,
      "/auth": mailServer,
      "/login": mailServer,
    },
  },
});
```

- [ ] **Step 3: Check the existing tests still pass**

Run: `npm test`
Expected: PASS (the existing suites; nothing changed in `src/` yet).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json vitest.config.mts eslint.config.mjs tsconfig.json .gitignore .dockerignore vite.config.ts
git commit -m "build(console): tooling for a web app built with Vite"
```

---

### Task 2: Configuration for the api role

**Files:** Modify `src/lib/config.ts`, `src/lib/config.test.ts`.

- [ ] **Step 1: Write the failing tests**

**File: `src/lib/config.test.ts`**

```ts
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/lib/config.test.ts`
Expected: FAIL. `servesApi` is not exported, and the api role is unknown.

- [ ] **Step 3: Implement**

**File: `src/lib/config.ts`**

```ts
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
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid console configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const ORIGIN = /^https?:\/\/[^/]+$/;

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
    const value = need(name).replace(/\/+$/, "");
    if (value && !ORIGIN.test(value)) problems.push(`${name} must be an http(s) origin such as ${example}`);
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
  };
}

let cached: ConsoleConfig | undefined;

/** The configuration of this process, parsed on first use. Never call at module top level: builds run without it. */
export function getConfig(): ConsoleConfig {
  cached ??= parseConfig(process.env);
  return cached;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run src/lib/config.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts src/lib/config.test.ts
git commit -m "feat(console): api role configuration with sign-in through the server"
```

The project typecheck is red from here until Task 6 removes the old consumers of `servesWeb`.

---

### Task 3: Token verifier

**Files:** Replace `src/lib/auth.ts`, `src/lib/auth.test.ts`.

- [ ] **Step 1: Write the failing tests**

**File: `src/lib/auth.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { AuthError, RateLimitError, VerifierUnavailableError, bearerToken, createTokenVerifier } from "./auth";

const NOW = Date.parse("2026-10-26T10:00:00Z");
const SERVER = "https://mail.example.com";
const PRINCIPAL = { username: "console@example.com", password: "principal-secret" };
const TOKEN = "dG9rZW4tZm9yLWFkbWlu";

interface FakeServer {
  active?: boolean;
  exp?: number;
  permissions?: string[];
  username?: string;
  introspectStatus?: number;
  accountStatus?: number;
  failWith?: Error;
}

interface Call {
  path: string;
  authorization: string | null;
  body: string | null;
}

function fakeServer(options: FakeServer = {}) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (options.failWith) throw options.failWith;
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (url.pathname === "/auth/introspect") {
      if (options.introspectStatus) return new Response("", { status: options.introspectStatus });
      return Response.json({ active: options.active ?? true, exp: options.exp ?? NOW / 1000 + 3600 });
    }
    if (url.pathname === "/api/account") {
      if (options.accountStatus) return new Response("", { status: options.accountStatus });
      return Response.json({ permissions: options.permissions ?? ["authenticate", "impersonate"], edition: "community", locale: "en" });
    }
    if (url.pathname === "/jmap/session") return Response.json({ username: options.username ?? "admin", accounts: {} });
    return new Response("", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function bearer(token = TOKEN): Headers {
  return new Headers({ Authorization: `Bearer ${token}` });
}

function verifierFor(server: ReturnType<typeof fakeServer>, clock = { now: NOW }, extra: { allowedAccounts?: string[]; introspectionsPerMinute?: number } = {}) {
  return createTokenVerifier({
    serverUrl: SERVER,
    principal: PRINCIPAL,
    permission: "impersonate",
    allowedAccounts: extra.allowedAccounts ?? [],
    introspectionsPerMinute: extra.introspectionsPerMinute,
    fetch: server.fetch,
    now: () => clock.now,
  });
}

describe("bearerToken", () => {
  it("reads a bearer token", () => {
    expect(bearerToken(bearer())).toBe(TOKEN);
    expect(bearerToken(new Headers({ Authorization: `bearer  ${TOKEN} ` }))).toBe(TOKEN);
  });

  it("refuses a missing, malformed or oversized token", () => {
    for (const value of [null, "Basic YWRtaW46c2VjcmV0", "Bearer", "Bearer a b", "Bearer <script>", `Bearer ${"a".repeat(1001)}`]) {
      const headers = new Headers(value === null ? {} : { Authorization: value });
      expect(() => bearerToken(headers)).toThrow(AuthError);
    }
  });
});

describe("createTokenVerifier", () => {
  it("accepts an active token from an account with the permission", async () => {
    const server = fakeServer();
    await expect(verifierFor(server)(bearer())).resolves.toEqual({ login: "admin" });
    expect(server.calls.map((call) => call.path)).toEqual(["/auth/introspect", "/api/account", "/jmap/session"]);
  });

  it("introspects as the console principal, and reads the account with the operator's token", async () => {
    const server = fakeServer();
    await verifierFor(server)(bearer());
    const [introspect, account, session] = server.calls;
    expect(introspect?.authorization).toBe(`Basic ${Buffer.from("console@example.com:principal-secret").toString("base64")}`);
    expect(introspect?.body).toBe(`token=${TOKEN}`);
    expect(account?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(session?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses an inactive token without presenting it to the server as a login", async () => {
    const server = fakeServer({ active: false });
    await expect(verifierFor(server)(bearer())).rejects.toMatchObject({ name: "AuthError", status: 401 });
    expect(server.calls.map((call) => call.path)).toEqual(["/auth/introspect"]);
  });

  it("refuses an account without the permission with 403", async () => {
    const server = fakeServer({ permissions: ["authenticate"], username: "Jane@Example.com" });
    await expect(verifierFor(server)(bearer())).rejects.toMatchObject({
      status: 403,
      message: "jane@example.com does not have the impersonate permission",
    });
  });

  it("applies the allow-list when one is set", async () => {
    await expect(verifierFor(fakeServer(), undefined, { allowedAccounts: ["ops@example.com"] })(bearer())).rejects.toMatchObject({
      status: 403,
      message: "admin is not allowed to use the console",
    });
    await expect(verifierFor(fakeServer(), undefined, { allowedAccounts: ["admin"] })(bearer())).resolves.toEqual({ login: "admin" });
  });

  it("answers from its cache for a minute", async () => {
    const server = fakeServer();
    const clock = { now: NOW };
    const verify = verifierFor(server, clock);
    await verify(bearer());
    clock.now += 59_000;
    await verify(bearer());
    expect(server.calls).toHaveLength(3);
    clock.now += 2_000;
    await verify(bearer());
    expect(server.calls).toHaveLength(6);
  });

  it("never caches a token past its expiry", async () => {
    const server = fakeServer({ exp: NOW / 1000 + 10 });
    const clock = { now: NOW };
    const verify = verifierFor(server, clock);
    await verify(bearer());
    clock.now += 11_000;
    await verify(bearer());
    expect(server.calls.filter((call) => call.path === "/auth/introspect")).toHaveLength(2);
  });

  it("limits introspections per minute, but not cached tokens", async () => {
    const server = fakeServer();
    const clock = { now: NOW };
    const verify = verifierFor(server, clock, { introspectionsPerMinute: 2 });
    await verify(bearer("token-one"));
    await verify(bearer("token-two"));
    await expect(verify(bearer("token-three"))).rejects.toBeInstanceOf(RateLimitError);
    await expect(verify(bearer("token-one"))).resolves.toEqual({ login: "admin" });
    clock.now += 60_000;
    await expect(verify(bearer("token-three"))).resolves.toEqual({ login: "admin" });
  });

  it("reports a server it cannot ask as unavailable", async () => {
    await expect(verifierFor(fakeServer({ failWith: new TypeError("fetch failed") }))(bearer())).rejects.toBeInstanceOf(
      VerifierUnavailableError,
    );
    await expect(verifierFor(fakeServer({ introspectStatus: 401 }))(bearer())).rejects.toBeInstanceOf(VerifierUnavailableError);
    await expect(verifierFor(fakeServer({ accountStatus: 500 }))(bearer())).rejects.toBeInstanceOf(VerifierUnavailableError);
  });

  it("treats a token refused by the account read as an ended session", async () => {
    await expect(verifierFor(fakeServer({ accountStatus: 401 }))(bearer())).rejects.toMatchObject({ name: "AuthError", status: 401 });
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/lib/auth.test.ts`
Expected: FAIL. `createTokenVerifier` and `bearerToken` are not exported.

- [ ] **Step 3: Implement**

**File: `src/lib/auth.ts`**

```ts
import { createHash } from "node:crypto";

export interface Operator {
  /** The account's login at the server, lowercased. */
  login: string;
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** The server could not be asked about the token; the token itself may be fine. */
export class VerifierUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifierUnavailableError";
  }
}

export type TokenVerifier = (headers: Headers) => Promise<Operator>;

export interface VerifierOptions {
  /** Origin of the inWorkspace server that issued the token. */
  serverUrl: string;
  /** The console principal, which introspects tokens. */
  principal: { username: string; password: string };
  permission: string;
  allowedAccounts: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
  cacheMs?: number;
  maxCacheEntries?: number;
  introspectionsPerMinute?: number;
  timeoutMs?: number;
}

/** For AUTH_MODE=none: every request is this operator. */
export const LOCAL_OPERATOR: Operator = { login: "local-operator" };

// RFC 6750 b64token, and short enough for the server's 1,024-byte introspection form.
const BEARER = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i;
const MAX_TOKEN_LENGTH = 1000;
const MINUTE_MS = 60_000;

export function bearerToken(headers: Headers): string {
  const match = BEARER.exec(headers.get("authorization")?.trim() ?? "");
  const token = match?.[1];
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new AuthError(401, "sign-in required");
  return token;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Verifies the operator's access token with the server that issued it.
 *
 * The token is first introspected as the console principal. An invalid token is therefore never
 * presented to the server as a login, and failed logins cannot get this service's address banned.
 * Only an active token is used, to read the account's permissions and login.
 */
export function createTokenVerifier(options: VerifierOptions): TokenVerifier {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? MINUTE_MS;
  const maxCacheEntries = options.maxCacheEntries ?? 1000;
  const limit = options.introspectionsPerMinute ?? 120;
  const timeoutMs = options.timeoutMs ?? 5000;
  const basic = `Basic ${Buffer.from(`${options.principal.username}:${options.principal.password}`).toString("base64")}`;
  const cache = new Map<string, { operator: Operator; expiresAt: number }>();
  let window = { startedAt: Number.NEGATIVE_INFINITY, count: 0 };

  async function ask(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(`${options.serverUrl}${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new VerifierUnavailableError(`the mail server did not answer ${path}: ${messageOf(error)}`);
    }
  }

  function countIntrospection(at: number): void {
    if (at - window.startedAt >= MINUTE_MS) window = { startedAt: at, count: 0 };
    if (window.count >= limit) throw new RateLimitError("Too many sign-in checks. Try again in a minute.");
    window.count += 1;
  }

  return async function verify(headers: Headers): Promise<Operator> {
    const token = bearerToken(headers);
    const key = createHash("sha256").update(token).digest("base64url");
    const at = now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > at) return cached.operator;
    cache.delete(key);

    countIntrospection(at);
    const introspection = await ask("/auth/introspect", {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    if (!introspection.ok) {
      throw new VerifierUnavailableError(`token introspection answered HTTP ${introspection.status}`);
    }
    const state = (await introspection.json()) as { active?: unknown; exp?: unknown };
    if (state.active !== true) throw new AuthError(401, "the session has ended or is not valid");

    const asOperator = { headers: { Authorization: `Bearer ${token}` } };
    const [account, session] = await Promise.all([ask("/api/account", asOperator), ask("/jmap/session", asOperator)]);
    if (account.status === 401 || session.status === 401) throw new AuthError(401, "the session has ended or is not valid");
    if (!account.ok || !session.ok) {
      throw new VerifierUnavailableError(`reading the account answered HTTP ${account.ok ? session.status : account.status}`);
    }
    const { permissions } = (await account.json()) as { permissions?: unknown };
    const { username } = (await session.json()) as { username?: unknown };
    if (!Array.isArray(permissions) || typeof username !== "string" || username.length === 0) {
      throw new VerifierUnavailableError("the mail server's account answer has no permissions or login");
    }

    const login = username.toLowerCase();
    if (!permissions.includes(options.permission)) {
      throw new AuthError(403, `${login} does not have the ${options.permission} permission`);
    }
    if (options.allowedAccounts.length > 0 && !options.allowedAccounts.includes(login)) {
      throw new AuthError(403, `${login} is not allowed to use the console`);
    }

    const operator = { login };
    const expiresAt = Math.min(at + cacheMs, typeof state.exp === "number" ? state.exp * 1000 : Number.POSITIVE_INFINITY);
    if (cache.size >= maxCacheEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { operator, expiresAt });
    return operator;
  };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run src/lib/auth.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth.ts src/lib/auth.test.ts
git commit -m "feat(console): verify operators' bearer tokens with the mail server"
```

---

### Task 4: API contract, CORS and the route wrapper

**Files:** Create `src/lib/apiTypes.ts`, `src/lib/cors.ts`, `src/lib/cors.test.ts`,
`src/lib/apiRoute.ts`, `src/lib/apiRoute.test.ts`.

- [ ] **Step 1: Write the contract**

**File: `src/lib/apiTypes.ts`**

```ts
// The JSON the console API answers: the route handlers produce it, and the web app reads it.
import type { ThreadMessage, ThreadSummary } from "./conversations";
import type { StoredEvent } from "./eventStore";

export type { StoredEvent, ThreadMessage, ThreadSummary };

export interface AgentRef {
  address: string;
  name: string | null;
}

export interface MeResponse {
  login: string;
}

/** The 24-hour counts; null when the count needs the agent list and it could not be read. */
export interface OverviewTotals {
  received: number | null;
  junk: number | null;
  refused: number;
  repliesSent: number | null;
  repliesDelivered: number | null;
  deliveryProblems: number | null;
  accessProblems: number;
}

export interface AgentOverview extends AgentRef {
  received: number;
  junk: number;
  repliesSent: number;
  errors: number;
  lastActivity: string | null;
}

export interface OverviewResponse {
  totals: OverviewTotals;
  /** Null when the agent directory could not be read; directoryError says why. */
  agents: AgentOverview[] | null;
  directoryError: string | null;
  agentDomains: string[];
  recentErrors: StoredEvent[];
}

export interface AgentsResponse {
  agents: AgentRef[];
}

export interface ThreadsResponse {
  agent: AgentRef;
  threads: ThreadSummary[];
  total: number;
  position: number;
  pageSize: number;
}

export interface ThreadResponse {
  agent: AgentRef;
  messages: ThreadMessage[];
}

export interface EventsResponse {
  events: StoredEvent[];
  pageSize: number;
}

export interface BundleManifest {
  version: string;
  file: string;
}

export type ApiErrorCode =
  | "bad_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "upstream_failed"
  | "unavailable"
  | "internal";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}
```

- [ ] **Step 2: Write the failing tests**

**File: `src/lib/cors.test.ts`**

```ts
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

  it("refuses any other origin", () => {
    const response = preflight("https://attacker.example", SERVER);
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
```

**File: `src/lib/apiRoute.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { ApiError, createApiRoute, createPreflight, type ApiRouteDeps } from "./apiRoute";
import { AuthError, RateLimitError, VerifierUnavailableError, type Operator } from "./auth";
import { JmapError } from "./jmap";

const SERVER = "https://mail.example.com";

function depsWith(verify: (headers: Headers) => Promise<Operator>, enabled = true) {
  const logged: Record<string, unknown>[] = [];
  const deps: ApiRouteDeps = { enabled: () => enabled, allowedOrigin: () => SERVER, verify, log: (entry) => logged.push(entry) };
  return { deps, logged };
}

const admin = async () => ({ login: "admin" });
const context = { params: Promise.resolve({ address: "a1@agents.example.com" }) };

function request(path = "/api/v1/me", origin: string | null = SERVER): Request {
  return new Request(`https://console-api.example.com${path}`, { headers: origin ? { Origin: origin } : {} });
}

describe("createApiRoute", () => {
  it("answers the handler's value as JSON, with CORS and no-store", async () => {
    const { deps } = depsWith(admin);
    const route = createApiRoute(deps)<{ address: string }>(async ({ operator, params }) => ({ who: operator.login, address: params.address }));
    const response = await route(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ who: "admin", address: "a1@agents.example.com" });
    expect(response.headers.get("access-control-allow-origin")).toBe(SERVER);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("is a 404 outside the api role, before any check", async () => {
    const { deps } = depsWith(async () => {
      throw new Error("must not verify");
    }, false);
    const response = await createApiRoute(deps)(async () => ({}))(request(), context);
    expect(response.status).toBe(404);
  });

  it("never runs the handler for an unverified request", async () => {
    let ran = false;
    const { deps } = depsWith(async () => {
      throw new AuthError(401, "sign-in required");
    });
    const response = await createApiRoute(deps)(async () => {
      ran = true;
      return {};
    })(request(), context);
    expect(ran).toBe(false);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthenticated", message: "sign-in required" } });
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="inworkspace-console"');
    expect(response.headers.get("access-control-allow-origin")).toBe(SERVER);
  });

  it("maps each failure to its status and code", async () => {
    const cases: [unknown, number, string][] = [
      [new AuthError(403, "admin does not have the impersonate permission"), 403, "forbidden"],
      [new RateLimitError("Too many sign-in checks. Try again in a minute."), 429, "rate_limited"],
      [new VerifierUnavailableError("the mail server did not answer"), 503, "unavailable"],
      [new ApiError(404, "not_found", "There is no agent at this address."), 404, "not_found"],
      [new JmapError("cannot reach the mail server: fetch failed", "network"), 502, "upstream_failed"],
      [new Error("boom"), 500, "internal"],
    ];
    for (const [error, status, code] of cases) {
      const { deps } = depsWith(admin);
      const response = await createApiRoute(deps)(async () => {
        throw error;
      })(request(), context);
      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });

  it("logs failures without sending their details to the browser", async () => {
    const { deps, logged } = depsWith(admin);
    const response = await createApiRoute(deps)(async () => {
      throw new Error("password authentication failed for user console");
    })(request(), context);
    expect(JSON.stringify(await response.json())).not.toContain("password");
    expect(logged).toEqual([expect.objectContaining({ severity: "ERROR", message: "console.api.failed" })]);
  });

  it("sends no CORS headers to another origin", async () => {
    const { deps } = depsWith(admin);
    const response = await createApiRoute(deps)(async () => ({}))(request("/api/v1/me", "https://attacker.example"), context);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("createPreflight", () => {
  it("answers preflights in the api role only", () => {
    expect(createPreflight(depsWith(admin).deps)(request()).status).toBe(204);
    expect(createPreflight(depsWith(admin, false).deps)(request()).status).toBe(404);
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run src/lib/cors.test.ts src/lib/apiRoute.test.ts`
Expected: FAIL. `./cors` and `./apiRoute` do not exist.

- [ ] **Step 4: Implement**

**File: `src/lib/cors.ts`**

```ts
/** The web app runs on the server's origin and calls the API from there; no other origin may read it. */
export function corsHeaders(origin: string | null, allowedOrigin: string): Record<string, string> {
  return origin === allowedOrigin
    ? { Vary: "Origin", "Access-Control-Allow-Origin": allowedOrigin }
    : { Vary: "Origin" };
}

export function preflight(origin: string | null, allowedOrigin: string): Response {
  if (origin !== allowedOrigin) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin, allowedOrigin),
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "Authorization",
      "Access-Control-Max-Age": "600",
    },
  });
}
```

**File: `src/lib/apiRoute.ts`**

```ts
import type { ApiErrorBody, ApiErrorCode } from "./apiTypes";
import { AuthError, RateLimitError, VerifierUnavailableError, type Operator } from "./auth";
import { corsHeaders, preflight } from "./cors";
import { JmapError } from "./jmap";

/** A failure a handler reports on purpose: bad parameters, or an unknown agent or thread. */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiRouteDeps {
  /** Whether this process serves the api role. */
  enabled: () => boolean;
  allowedOrigin: () => string;
  verify: (headers: Headers) => Promise<Operator>;
  log: (entry: Record<string, unknown>) => void;
}

export interface ApiContext<P> {
  request: Request;
  operator: Operator;
  params: P;
}

type HeaderMap = Record<string, string>;

function errorResponse(error: unknown, cors: HeaderMap, log: ApiRouteDeps["log"]): Response {
  const send = (status: number, code: ApiErrorCode, message: string, extra: HeaderMap = {}) =>
    Response.json({ error: { code, message } } satisfies ApiErrorBody, {
      status,
      headers: { ...cors, "Cache-Control": "no-store", ...extra },
    });
  if (error instanceof AuthError) {
    return error.status === 401
      ? send(401, "unauthenticated", error.message, { "WWW-Authenticate": 'Bearer realm="inworkspace-console"' })
      : send(403, "forbidden", error.message);
  }
  if (error instanceof RateLimitError) return send(429, "rate_limited", error.message, { "Retry-After": "60" });
  if (error instanceof ApiError) return send(error.status, error.code, error.message);
  if (error instanceof VerifierUnavailableError) {
    log({ severity: "ERROR", message: "console.auth.unavailable", error: error.message });
    return send(503, "unavailable", "The mail server could not check the session. Try again shortly.");
  }
  if (error instanceof JmapError) {
    log({ severity: "ERROR", message: "console.jmap.failed", type: error.type, error: error.message });
    return send(502, "upstream_failed", `The mail server could not be read: ${error.message}`);
  }
  log({ severity: "ERROR", message: "console.api.failed", error: error instanceof Error ? error.message : String(error) });
  return send(500, "internal", "The console failed to answer.");
}

/** Every API handler runs behind this: role, CORS, the operator's token, then JSON either way. */
export function createApiRoute(deps: ApiRouteDeps) {
  return function apiRoute<P = unknown>(handler: (context: ApiContext<P>) => Promise<unknown>) {
    return async (request: Request, context: { params: Promise<P> }): Promise<Response> => {
      if (!deps.enabled()) return new Response(null, { status: 404 });
      const cors = corsHeaders(request.headers.get("origin"), deps.allowedOrigin());
      try {
        const operator = await deps.verify(request.headers);
        const body = await handler({ request, operator, params: await context.params });
        return Response.json(body, { headers: { ...cors, "Cache-Control": "no-store" } });
      } catch (error) {
        return errorResponse(error, cors, deps.log);
      }
    };
  };
}

export function createPreflight(deps: Pick<ApiRouteDeps, "enabled" | "allowedOrigin">) {
  return (request: Request): Response => {
    if (!deps.enabled()) return new Response(null, { status: 404 });
    return preflight(request.headers.get("origin"), deps.allowedOrigin());
  };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run src/lib/cors.test.ts src/lib/apiRoute.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/apiTypes.ts src/lib/cors.ts src/lib/cors.test.ts src/lib/apiRoute.ts src/lib/apiRoute.test.ts
git commit -m "feat(console): API contract, CORS for the server's origin, and the route wrapper"
```

---

### Task 5: Email document and the web app bundle

**Files:** Create `src/lib/emailDocument.ts`, `src/lib/emailDocument.test.ts`,
`src/lib/uiBundle.ts`, `src/lib/uiBundle.test.ts`. Modify `src/lib/sanitize.ts` and
`src/lib/sanitize.test.ts`: move `emailHtmlDocument` out.

- [ ] **Step 1: Write the failing tests**

**File: `src/lib/emailDocument.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { emailHtmlDocument } from "./emailDocument";

describe("emailHtmlDocument", () => {
  it("wraps the body in a document that blocks every remote resource", () => {
    const document = emailHtmlDocument("<p>Hi</p>");
    expect(document).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"`);
    expect(document).toContain("<body><p>Hi</p></body>");
  });
});
```

**File: `src/lib/uiBundle.test.ts`**

```ts
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLE_FILE, buildUiBundle, contentSecurityPolicy, renderIndex } from "./uiBundle";

const TEMPLATE = [
  "<!doctype html><html><head>",
  '<meta http-equiv="Content-Security-Policy" content="__CONSOLE_CSP__" />',
  '<base href="/" />',
  '<meta name="inworkspace-console-api" content="__CONSOLE_API_URL__" />',
  '<meta name="inworkspace-console-client-id" content="__CONSOLE_OAUTH_CLIENT_ID__" />',
  '<meta name="inworkspace-console-time-zone" content="__CONSOLE_TIME_ZONE__" />',
  '<script type="module" src="./assets/index-abc.js"></script>',
  "</head><body></body></html>",
].join("");

const SETTINGS = { apiUrl: "https://console-api.example.com", clientId: "inworkspace-console", timeZone: "Europe/Zurich" };

describe("renderIndex", () => {
  it("writes the settings into the page", () => {
    const html = renderIndex(TEMPLATE, SETTINGS);
    expect(html).toContain('<meta name="inworkspace-console-api" content="https://console-api.example.com" />');
    expect(html).toContain('<meta name="inworkspace-console-client-id" content="inworkspace-console" />');
    expect(html).toContain('<meta name="inworkspace-console-time-zone" content="Europe/Zurich" />');
    expect(html).not.toContain("__CONSOLE_");
  });

  it("escapes the values it writes into attributes", () => {
    const html = renderIndex(TEMPLATE, { ...SETTINGS, clientId: 'x"><script>' });
    expect(html).toContain('content="x&quot;&gt;&lt;script&gt;"');
  });

  it("allows API calls only to the console API", () => {
    expect(contentSecurityPolicy("https://console-api.example.com/ignored")).toContain("connect-src 'self' https://console-api.example.com;");
    expect(renderIndex(TEMPLATE, SETTINGS)).toContain("script-src 'self';");
  });

  it("refuses a page the server could not place under its prefix", () => {
    expect(() => renderIndex(TEMPLATE.replace('<base href="/" />', ""), SETTINGS)).toThrow(/base href/);
  });

  it("refuses a page without a placeholder", () => {
    expect(() => renderIndex(TEMPLATE.replace("__CONSOLE_TIME_ZONE__", ""), SETTINGS)).toThrow(/__CONSOLE_TIME_ZONE__/);
  });
});

describe("buildUiBundle", () => {
  let dist: string;

  beforeEach(async () => {
    dist = await mkdtemp(path.join(tmpdir(), "console-ui-"));
    await mkdir(path.join(dist, "assets"));
    await writeFile(path.join(dist, "index.html"), TEMPLATE);
    await writeFile(path.join(dist, "assets", "index-abc.js"), "console.log('app')");
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  it("zips every file, with the settings in index.html", async () => {
    const bundle = await buildUiBundle(dist, SETTINGS);
    expect(bundle.fileName).toMatch(BUNDLE_FILE);
    expect(bundle.fileName).toBe(`console-${bundle.version}.zip`);
    const files = unzipSync(bundle.zip);
    expect(Object.keys(files).sort()).toEqual(["assets/index-abc.js", "index.html"]);
    expect(strFromU8(files["index.html"]!)).toContain('content="https://console-api.example.com"');
    expect(strFromU8(files["assets/index-abc.js"]!)).toBe("console.log('app')");
  });

  it("gives the same bundle the same version and bytes, and new settings a new version", async () => {
    const first = await buildUiBundle(dist, SETTINGS);
    const second = await buildUiBundle(dist, SETTINGS);
    expect(second.version).toBe(first.version);
    expect(Buffer.from(second.zip).equals(Buffer.from(first.zip))).toBe(true);
    const moved = await buildUiBundle(dist, { ...SETTINGS, apiUrl: "https://console-api-2.example.com" });
    expect(moved.version).not.toBe(first.version);
  });

  it("explains a missing build", async () => {
    await rm(path.join(dist, "index.html"));
    await expect(buildUiBundle(dist, SETTINGS)).rejects.toThrow(/npm run build:ui/);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/lib/emailDocument.test.ts src/lib/uiBundle.test.ts`
Expected: FAIL. The modules do not exist.

- [ ] **Step 3: Implement, and move `emailHtmlDocument` out of `sanitize.ts`**

**File: `src/lib/emailDocument.ts`**

```ts
/** A document for `<iframe sandbox srcdoc>`: its own policy blocks every remote resource. */
export function emailHtmlDocument(sanitizedHtml: string): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:\">",
    "<style>body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#292929;margin:12px;overflow-wrap:anywhere}</style>",
    `</head><body>${sanitizedHtml}</body></html>`,
  ].join("");
}
```

**File: `src/lib/uiBundle.ts`**

```ts
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { zipSync, type Zippable } from "fflate";
import type { ConsoleConfig } from "./config";

export interface UiSettings {
  apiUrl: string;
  clientId: string;
  timeZone: string | null;
}

export interface UiBundle {
  version: string;
  fileName: string;
  zip: Uint8Array<ArrayBuffer>;
}

export const BUNDLE_FILE = /^console-[A-Za-z0-9_-]{1,64}\.zip$/;

/** The server rewrites exactly this tag to the app's prefix; without it the app cannot find its assets. */
const BASE_TAG = '<base href="/"';
/** A fixed time for every entry, so the same files always give the same zip. */
const ENTRY_TIME = new Date("2000-01-01T00:00:00Z");

export function uiSettingsFrom(config: Pick<ConsoleConfig, "publicUrl" | "oauthClientId" | "displayTimeZone">): UiSettings {
  return { apiUrl: config.publicUrl, clientId: config.oauthClientId, timeZone: config.displayTimeZone };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The web app's own policy: its scripts and styles, calls to the console API only, inline images only. */
export function contentSecurityPolicy(apiUrl: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${new URL(apiUrl).origin}`,
    "frame-src 'self'",
    "base-uri 'self'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

export function renderIndex(template: string, settings: UiSettings): string {
  if (!template.includes(BASE_TAG)) {
    throw new Error(`the built index.html has no ${BASE_TAG}> tag, so the server could not place the app under its prefix`);
  }
  const values: Record<string, string> = {
    __CONSOLE_CSP__: contentSecurityPolicy(settings.apiUrl),
    __CONSOLE_API_URL__: settings.apiUrl,
    __CONSOLE_OAUTH_CLIENT_ID__: settings.clientId,
    __CONSOLE_TIME_ZONE__: settings.timeZone ?? "",
  };
  let html = template;
  for (const [placeholder, value] of Object.entries(values)) {
    if (!html.includes(placeholder)) throw new Error(`the built index.html has no ${placeholder} placeholder`);
    html = html.split(placeholder).join(escapeAttribute(value));
  }
  return html;
}

async function listFiles(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/** The built web app as the zip the server downloads, with this deployment's settings in index.html. */
export async function buildUiBundle(distDir: string, settings: UiSettings): Promise<UiBundle> {
  let files: string[];
  try {
    files = (await listFiles(distDir)).sort();
  } catch {
    files = [];
  }
  if (!files.includes("index.html")) {
    throw new Error(`${distDir} has no index.html; build the web app with \`npm run build:ui\``);
  }
  const entries: Zippable = {};
  const hash = createHash("sha256");
  for (const file of files) {
    let content: Uint8Array = await readFile(path.join(distDir, file));
    if (file === "index.html") content = new TextEncoder().encode(renderIndex(Buffer.from(content).toString("utf8"), settings));
    entries[file] = content;
    hash.update(file).update("\0").update(content).update("\0");
  }
  const version = hash.digest("hex").slice(0, 16);
  return {
    version,
    fileName: `console-${version}.zip`,
    zip: new Uint8Array(zipSync(entries, { level: 9, mtime: ENTRY_TIME })),
  };
}
```

In `src/lib/sanitize.ts`, delete the `emailHtmlDocument` function and its doc comment. In
`src/lib/sanitize.test.ts`, delete the `describe("emailHtmlDocument", …)` block and remove
`emailHtmlDocument` from the import.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run src/lib/emailDocument.test.ts src/lib/uiBundle.test.ts src/lib/sanitize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/emailDocument.ts src/lib/emailDocument.test.ts src/lib/uiBundle.ts src/lib/uiBundle.test.ts src/lib/sanitize.ts src/lib/sanitize.test.ts
git commit -m "feat(console): the web app bundle the server downloads"
```

---

### Task 6: API endpoints, and removal of the server-rendered console

**Files:** Create `src/lib/api.ts` and the route handlers. Modify `src/lib/services.ts`,
`src/lib/startup.ts`, `next.config.ts`. Delete the files listed under *File structure*.

- [ ] **Step 1: Move what the web app reuses, delete the rest**

```bash
mkdir -p ui/src/components ui/public
git mv src/components/ErrorPanel.tsx src/components/EventRow.tsx src/components/LiveEvents.tsx src/components/Loading.tsx src/components/SeverityBadge.tsx src/components/StatCard.tsx src/components/ThreadStatusChip.tsx ui/src/components/
git mv src/app/globals.css ui/src/styles.css
git mv src/app/favicon.ico ui/public/favicon.ico
git rm -q -r src/app/page.tsx src/app/layout.tsx src/app/error.tsx src/app/not-found.tsx src/app/forbidden.tsx src/app/agents src/app/events src/app/api/events src/components/OperatorBadge.tsx src/lib/operator.ts src/lib/cloudRunGuard.ts src/lib/cloudRunGuard.test.ts src/lib/gate.ts src/lib/gate.test.ts src/proxy.ts
```

- [ ] **Step 2: Wire services, routes and startup**

**File: `src/lib/services.ts`**

```ts
import "server-only";
import path from "node:path";
import { createTokenVerifier, LOCAL_OPERATOR, type TokenVerifier } from "./auth";
import { getConfig } from "./config";
import { fetchAgents, type Agent, type DirectorySettings } from "./directory";
import { JmapClient, type Credentials } from "./jmap";
import { buildUiBundle, uiSettingsFrom, type UiBundle } from "./uiBundle";

const AGENT_CACHE_MS = 5 * 60 * 1000;

let client: JmapClient | undefined;
let agentCache: { loadedAt: number; agents: Agent[] } | undefined;
let verifier: TokenVerifier | undefined;
let bundle: Promise<UiBundle> | undefined;

export function jmapClient(): JmapClient {
  client ??= new JmapClient(getConfig().jmapUrl);
  return client;
}

export function principalCredentials(): Credentials {
  const config = getConfig();
  return { username: config.jmapPrincipal, password: config.jmapPrincipalSecret };
}

function directorySettings(): DirectorySettings {
  const config = getConfig();
  return { agentDomains: config.agentDomains, agentLocalpartPattern: config.agentLocalpartPattern, principal: config.jmapPrincipal };
}

/** The agent directory, cached for five minutes. */
export async function getAgents(): Promise<Agent[]> {
  const now = Date.now();
  if (agentCache && now - agentCache.loadedAt < AGENT_CACHE_MS) return agentCache.agents;
  const agents = await fetchAgents(jmapClient(), principalCredentials(), directorySettings());
  agentCache = { loadedAt: now, agents };
  return agents;
}

/** Only directory agents can be opened, so a URL cannot point the console at any other mailbox. */
export async function findAgent(address: string): Promise<Agent | undefined> {
  const normalized = address.toLowerCase();
  return (await getAgents()).find((agent) => agent.address === normalized);
}

/** Verifies the operator behind each API request; one per process, so its cache is shared. */
export function operatorVerifier(): TokenVerifier {
  if (!verifier) {
    const config = getConfig();
    verifier =
      config.authMode === "none"
        ? async () => LOCAL_OPERATOR
        : createTokenVerifier({
            serverUrl: config.jmapUrl,
            principal: principalCredentials(),
            permission: config.operatorPermission,
            allowedAccounts: config.allowedAccounts,
          });
  }
  return verifier;
}

/** The web app's bundle, built once per process from the files of `npm run build:ui`. */
export function uiBundle(): Promise<UiBundle> {
  const config = getConfig();
  bundle ??= buildUiBundle(path.resolve(config.uiDistDir), uiSettingsFrom(config));
  return bundle;
}
```

**File: `src/lib/api.ts`**

```ts
import "server-only";
import { createApiRoute, createPreflight, type ApiRouteDeps } from "./apiRoute";
import { getConfig, servesApi } from "./config";
import { operatorVerifier } from "./services";

const deps: ApiRouteDeps = {
  enabled: () => servesApi(getConfig()),
  allowedOrigin: () => new URL(getConfig().jmapUrl).origin,
  verify: (headers) => operatorVerifier()(headers),
  log: (entry) => console.log(JSON.stringify(entry)),
};

export const apiRoute = createApiRoute(deps);
export const apiPreflight = createPreflight(deps);
```

**File: `src/app/api/v1/me/route.ts`**

```ts
import { apiPreflight, apiRoute } from "@/lib/api";
import type { MeResponse } from "@/lib/apiTypes";

export const GET = apiRoute(async ({ operator }): Promise<MeResponse> => ({ login: operator.login }));
export const OPTIONS = apiPreflight;
```

**File: `src/app/api/v1/overview/route.ts`**

```ts
import { apiPreflight, apiRoute } from "@/lib/api";
import type { OverviewResponse } from "@/lib/apiTypes";
import { getConfig } from "@/lib/config";
import { getPool } from "@/lib/db";
import { agentActivity, overviewCounts, queryEvents } from "@/lib/eventStore";
import { getAgents } from "@/lib/services";
import { settle } from "@/lib/settle";

const DAY_MS = 24 * 60 * 60 * 1000;

export const GET = apiRoute(async (): Promise<OverviewResponse> => {
  const config = getConfig();
  const pool = getPool();
  const since = new Date(Date.now() - DAY_MS);
  const directory = await settle(getAgents());
  const agents = directory.ok ? directory.value : [];
  const [counts, activity, recentErrors] = await Promise.all([
    overviewCounts(pool, {
      since,
      agentAddresses: agents.map((agent) => agent.address),
      agentAccountIds: agents.flatMap((agent) => (agent.accountId === null ? [] : [agent.accountId])),
      agentDomains: config.agentDomains,
    }),
    agentActivity(pool, { since, agents }),
    queryEvents(pool, { severity: "error", limit: 20 }),
  ]);
  const byAddress = new Map(activity.map((row) => [row.address, row]));
  // Without the agent list, counts that need it would read as zero; report them as unknown instead.
  const perAgent = (value: number) => (directory.ok ? value : null);
  return {
    totals: {
      received: perAgent(counts.received),
      junk: perAgent(counts.junk),
      refused: counts.refused,
      repliesSent: perAgent(counts.repliesSent),
      repliesDelivered: perAgent(counts.repliesDelivered),
      deliveryProblems: perAgent(counts.deliveryProblems),
      accessProblems: counts.accessProblems,
    },
    agents: directory.ok
      ? agents.map((agent) => {
          const row = byAddress.get(agent.address);
          return {
            address: agent.address,
            name: agent.name,
            received: row?.received ?? 0,
            junk: row?.junk ?? 0,
            repliesSent: row?.repliesSent ?? 0,
            errors: row?.errors ?? 0,
            lastActivity: row?.lastActivity ?? null,
          };
        })
      : null,
    directoryError: directory.ok ? null : directory.error,
    agentDomains: config.agentDomains,
    recentErrors,
  };
});
export const OPTIONS = apiPreflight;
```

**File: `src/app/api/v1/agents/route.ts`**

```ts
import { apiPreflight, apiRoute } from "@/lib/api";
import type { AgentsResponse } from "@/lib/apiTypes";
import { getAgents } from "@/lib/services";

export const GET = apiRoute(
  async (): Promise<AgentsResponse> => ({ agents: (await getAgents()).map(({ address, name }) => ({ address, name })) }),
);
export const OPTIONS = apiPreflight;
```

**File: `src/app/api/v1/agents/[address]/threads/route.ts`**

```ts
import { apiPreflight, apiRoute } from "@/lib/api";
import { ApiError } from "@/lib/apiRoute";
import type { ThreadsResponse } from "@/lib/apiTypes";
import { audit } from "@/lib/audit";
import { listThreads, THREAD_PAGE_SIZE } from "@/lib/mailbox";
import { decodeAddressParam, parsePosition } from "@/lib/params";
import { findAgent, jmapClient, principalCredentials } from "@/lib/services";

export const GET = apiRoute<{ address: string }>(async ({ request, operator, params }): Promise<ThreadsResponse> => {
  const agent = await findAgent(decodeAddressParam(params.address));
  if (!agent) throw new ApiError(404, "not_found", "There is no agent at this address.");
  const position = parsePosition(new URL(request.url).searchParams.get("position") ?? undefined);
  audit({ operator: operator.login, agent: agent.address });
  const page = await listThreads(jmapClient(), principalCredentials(), agent.address, position);
  return {
    agent: { address: agent.address, name: agent.name },
    threads: page.threads,
    total: page.total,
    position: page.position,
    pageSize: THREAD_PAGE_SIZE,
  };
});
export const OPTIONS = apiPreflight;
```

**File: `src/app/api/v1/agents/[address]/threads/[threadId]/route.ts`**

```ts
import { apiPreflight, apiRoute } from "@/lib/api";
import { ApiError } from "@/lib/apiRoute";
import type { ThreadResponse } from "@/lib/apiTypes";
import { audit } from "@/lib/audit";
import { getThread } from "@/lib/mailbox";
import { decodeAddressParam, isThreadId } from "@/lib/params";
import { findAgent, jmapClient, principalCredentials } from "@/lib/services";

export const GET = apiRoute<{ address: string; threadId: string }>(async ({ operator, params }): Promise<ThreadResponse> => {
  if (!isThreadId(params.threadId)) throw new ApiError(404, "not_found", "There is no such conversation.");
  const agent = await findAgent(decodeAddressParam(params.address));
  if (!agent) throw new ApiError(404, "not_found", "There is no agent at this address.");
  audit({ operator: operator.login, agent: agent.address, threadId: params.threadId });
  const messages = await getThread(jmapClient(), principalCredentials(), agent.address, params.threadId);
  if (messages === null) throw new ApiError(404, "not_found", "This mailbox has no such conversation.");
  return { agent: { address: agent.address, name: agent.name }, messages };
});
export const OPTIONS = apiPreflight;
```

**File: `src/app/api/v1/events/route.ts`**

```ts
import { apiPreflight, apiRoute } from "@/lib/api";
import { ApiError } from "@/lib/apiRoute";
import type { EventsResponse } from "@/lib/apiTypes";
import { getPool } from "@/lib/db";
import { parseEventFilters } from "@/lib/eventFilters";
import { queryEvents } from "@/lib/eventStore";
import { parseEventId } from "@/lib/params";

const PAGE_SIZE = 100;
const LIVE_LIMIT = 200;

function idParam(params: URLSearchParams, name: string, allowZero: boolean): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  if (allowZero && raw === "0") return 0;
  const id = parseEventId(raw);
  if (id === null) throw new ApiError(400, "bad_request", `${name} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  return id;
}

export const GET = apiRoute(async ({ request }): Promise<EventsResponse> => {
  const params = new URL(request.url).searchParams;
  const filters = parseEventFilters(params, new Date());
  const beforeId = idParam(params, "before", false);
  const afterId = idParam(params, "after", true);
  if (beforeId !== undefined && afterId !== undefined) {
    throw new ApiError(400, "bad_request", "use before or after, not both");
  }
  const limit = afterId === undefined ? PAGE_SIZE : LIVE_LIMIT;
  const events = await queryEvents(getPool(), { ...filters, beforeId, afterId, limit });
  return { events, pageSize: limit };
});
export const OPTIONS = apiPreflight;
```

**File: `src/app/ui/manifest/route.ts`**

```ts
import type { BundleManifest } from "@/lib/apiTypes";
import { getConfig, servesApi } from "@/lib/config";
import { uiBundle } from "@/lib/services";

/** Which bundle the server should download; the setup script reads it. */
export async function GET(): Promise<Response> {
  if (!servesApi(getConfig())) return new Response(null, { status: 404 });
  const bundle = await uiBundle();
  const manifest: BundleManifest = { version: bundle.version, file: bundle.fileName };
  return Response.json(manifest, { headers: { "Cache-Control": "no-store" } });
}
```

**File: `src/app/ui/[file]/route.ts`**

```ts
import { getConfig, servesApi } from "@/lib/config";
import { uiBundle } from "@/lib/services";
import { BUNDLE_FILE } from "@/lib/uiBundle";

/**
 * The bundle the server downloads. Every version name returns the current bundle, so the server
 * never gets a 404 when it fetches again after its copy expires.
 */
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }): Promise<Response> {
  if (!servesApi(getConfig())) return new Response(null, { status: 404 });
  const { file } = await context.params;
  if (!BUNDLE_FILE.test(file)) return new Response(null, { status: 404 });
  const bundle = await uiBundle();
  return new Response(bundle.zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(bundle.zip.byteLength),
      "Cache-Control": "no-cache",
    },
  });
}
```

**File: `src/lib/startup.ts`**

```ts
import path from "node:path";
import { getConfig, servesApi } from "./config";
import { getPool } from "./db";
import { migrate } from "./migrations";
import { buildUiBundle, uiSettingsFrom } from "./uiBundle";

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/** Validates the configuration, applies migrations and, in the api role, builds the web app's bundle; throws when any fails. */
export async function startup(): Promise<void> {
  const config = getConfig();
  const applied = await migrate(getPool());
  const bundle = servesApi(config) ? await buildUiBundle(path.resolve(config.uiDistDir), uiSettingsFrom(config)) : null;
  log({
    severity: "INFO",
    message: "console.started",
    role: config.role,
    authMode: servesApi(config) ? config.authMode : null,
    migrationsApplied: applied,
    uiVersion: bundle?.version ?? null,
  });
}

/** Next.js logs a failing instrumentation hook and keeps serving, so a broken start exits the process instead. */
export async function startupOrExit(): Promise<void> {
  try {
    await startup();
  } catch (error) {
    console.error(
      JSON.stringify({
        severity: "CRITICAL",
        message: "console.startup-failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(1);
  }
}
```

**File: `next.config.ts`**

```ts
import type { NextConfig } from "next";

// The service answers JSON and zips only; nothing it returns is meant to render or be framed.
const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  poweredByHeader: false,
  turbopack: { root: process.cwd() },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
```

- [ ] **Step 3: Check the service**

Run: `npm test && npx next typegen && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "^ui/" ; npx next build`
Expected: unit tests PASS. Type errors remain only under `ui/`, because the moved components
still import `next/link` and the old fetch. `next build` lists `/api/v1/*`, `/ui/manifest`,
`/ui/[file]`, `/api/ingest/events` and `/healthz`.

- [ ] **Step 4: Commit**

```bash
git add -A src next.config.ts ui
git commit -m "feat(console)!: JSON API for the web app; remove the server-rendered pages and Google sign-in"
```

---

### Task 7: Web app foundation

**Files:** Create `ui/index.html`, `ui/src/settings.ts`, `ui/src/settings.test.ts`,
`ui/src/auth/pkce.ts`, `ui/src/auth/pkce.test.ts`, `ui/src/auth/session.ts`,
`ui/src/auth/session.test.ts`, `ui/src/api.ts`, `ui/src/api.test.ts`.

- [ ] **Step 1: Write the page template**

**File: `ui/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="__CONSOLE_CSP__" />
    <base href="/" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="referrer" content="no-referrer" />
    <meta name="inworkspace-console-api" content="__CONSOLE_API_URL__" />
    <meta name="inworkspace-console-client-id" content="__CONSOLE_OAUTH_CLIENT_ID__" />
    <meta name="inworkspace-console-time-zone" content="__CONSOLE_TIME_ZONE__" />
    <link rel="icon" href="/favicon.ico" />
    <title>inWorkspace Console</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write the failing tests**

**File: `ui/src/settings.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { basePathFrom, readSettings } from "./settings";

function pageWith(meta: Record<string, string>, baseURI: string): Document {
  return {
    baseURI,
    querySelector: (selector: string) => {
      const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1];
      return name && name in meta ? { getAttribute: () => meta[name] } : null;
    },
  } as unknown as Document;
}

describe("basePathFrom", () => {
  it("takes the prefix the server wrote into <base href>", () => {
    expect(basePathFrom("https://mail.example.com/console/")).toBe("/console");
    expect(basePathFrom("http://localhost:5173/")).toBe("");
  });
});

describe("readSettings", () => {
  it("reads the settings the console service wrote into the page", () => {
    const settings = readSettings(
      pageWith(
        {
          "inworkspace-console-api": "https://console-api.example.com/",
          "inworkspace-console-client-id": "inworkspace-console",
          "inworkspace-console-time-zone": "Europe/Zurich",
        },
        "https://mail.example.com/console/",
      ),
    );
    expect(settings).toEqual({
      apiUrl: "https://console-api.example.com",
      clientId: "inworkspace-console",
      timeZone: "Europe/Zurich",
      basePath: "/console",
    });
  });

  it("falls back to the browser's time zone", () => {
    const settings = readSettings(pageWith({ "inworkspace-console-time-zone": "" }, "https://mail.example.com/console/"));
    expect(settings.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
```

**File: `ui/src/auth/pkce.test.ts`**

```ts
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
```

**File: `ui/src/auth/session.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { s256Challenge } from "./pkce";
import {
  SCOPE,
  beginSignIn,
  callbackPath,
  clearTokens,
  completeSignIn,
  readTokens,
  refreshTokens,
  safeReturnTo,
  type SessionEnvironment,
  type Store,
} from "./session";

const ORIGIN = "https://mail.example.com";
const NOW = Date.parse("2026-10-26T10:00:00Z");

function memoryStore(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

interface TokenCall {
  url: string;
  form: URLSearchParams;
}

function tokenServer(answer: { status?: number; body: unknown }) {
  const calls: TokenCall[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), form: new URLSearchParams(String(init?.body ?? "")) });
    return Response.json(answer.body, { status: answer.status ?? 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function environment(store: Store, fetch: typeof globalThis.fetch = tokenServer({ body: {} }).fetch): SessionEnvironment {
  return { origin: ORIGIN, basePath: "/console", clientId: "inworkspace-console", store, fetch, now: () => NOW };
}

async function startedSignIn(store: Store, returnTo = "/events?severity=error") {
  const url = new URL(await beginSignIn(environment(store), returnTo));
  return { url, state: url.searchParams.get("state")! };
}

describe("safeReturnTo", () => {
  it("keeps paths inside the app and nothing else", () => {
    expect(safeReturnTo("/agents/a1%40example.com")).toBe("/agents/a1%40example.com");
    expect(safeReturnTo("//attacker.example/")).toBe("/");
    expect(safeReturnTo("https://attacker.example/")).toBe("/");
    expect(safeReturnTo(null)).toBe("/");
  });
});

describe("beginSignIn", () => {
  it("sends the operator to the server's sign-in page with PKCE", async () => {
    const store = memoryStore();
    const { url } = await startedSignIn(store);
    expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}/login`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("inworkspace-console");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}${callbackPath("/console")}`);
    expect(url.searchParams.get("scope")).toBe(SCOPE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const pending = JSON.parse(store.data.get("inworkspace-console:sign-in")!) as { verifier: string; state: string; returnTo: string };
    expect(url.searchParams.get("state")).toBe(pending.state);
    expect(url.searchParams.get("code_challenge")).toBe(await s256Challenge(pending.verifier));
    expect(pending.returnTo).toBe("/events?severity=error");
  });
});

describe("completeSignIn", () => {
  it("exchanges the code with the verifier and keeps the tokens", async () => {
    const store = memoryStore();
    const { state } = await startedSignIn(store);
    const verifier = (JSON.parse(store.data.get("inworkspace-console:sign-in")!) as { verifier: string }).verifier;
    const server = tokenServer({ body: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, token_type: "bearer" } });
    const returnTo = await completeSignIn(environment(store, server.fetch), new URL(`${ORIGIN}/console/oauth/callback?code=c0de&state=${state}`));
    expect(returnTo).toBe("/events?severity=error");
    expect(server.calls[0]?.url).toBe(`${ORIGIN}/auth/token`);
    expect(Object.fromEntries(server.calls[0]!.form)).toEqual({
      grant_type: "authorization_code",
      code: "c0de",
      redirect_uri: `${ORIGIN}/console/oauth/callback`,
      client_id: "inworkspace-console",
      code_verifier: verifier,
    });
    expect(readTokens(store)).toEqual({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000 });
    expect(store.data.has("inworkspace-console:sign-in")).toBe(false);
  });

  it("refuses a callback this tab did not start, without calling the server", async () => {
    const store = memoryStore();
    await startedSignIn(store);
    const server = tokenServer({ body: {} });
    await expect(
      completeSignIn(environment(store, server.fetch), new URL(`${ORIGIN}/console/oauth/callback?code=c0de&state=forged`)),
    ).rejects.toMatchObject({ name: "SignInError" });
    expect(server.calls).toHaveLength(0);
  });

  it("can be used only once", async () => {
    const store = memoryStore();
    const { state } = await startedSignIn(store);
    const server = tokenServer({ body: { access_token: "access-1" } });
    const callback = new URL(`${ORIGIN}/console/oauth/callback?code=c0de&state=${state}`);
    await completeSignIn(environment(store, server.fetch), callback);
    await expect(completeSignIn(environment(store, server.fetch), callback)).rejects.toMatchObject({ name: "SignInError" });
  });

  it("reports what the server said when it refuses", async () => {
    const store = memoryStore();
    const { state } = await startedSignIn(store);
    await expect(
      completeSignIn(
        environment(store, tokenServer({ status: 400, body: { error: "invalid_grant", error_description: "Code expired" } }).fetch),
        new URL(`${ORIGIN}/console/oauth/callback?code=c0de&state=${state}`),
      ),
    ).rejects.toThrow("Code expired");
    const declined = memoryStore();
    await startedSignIn(declined);
    await expect(
      completeSignIn(environment(declined), new URL(`${ORIGIN}/console/oauth/callback?error=access_denied`)),
    ).rejects.toThrow("access_denied");
  });
});

describe("refreshTokens", () => {
  function signedIn(refreshToken: string | null): Store & { data: Map<string, string> } {
    const store = memoryStore();
    store.setItem("inworkspace-console:tokens", JSON.stringify({ accessToken: "access-1", refreshToken, expiresAt: NOW }));
    return store;
  }

  it("replaces the access token and keeps the refresh token when none is returned", async () => {
    const store = signedIn("refresh-1");
    const server = tokenServer({ body: { access_token: "access-2", expires_in: 600 } });
    await expect(refreshTokens(environment(store, server.fetch))).resolves.toBe(true);
    expect(Object.fromEntries(server.calls[0]!.form)).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "inworkspace-console" });
    expect(readTokens(store)).toEqual({ accessToken: "access-2", refreshToken: "refresh-1", expiresAt: NOW + 600_000 });
  });

  it("ends the session when the server refuses the refresh", async () => {
    const store = signedIn("refresh-1");
    await expect(refreshTokens(environment(store, tokenServer({ status: 400, body: { error: "invalid_grant" } }).fetch))).resolves.toBe(false);
    expect(readTokens(store)).toBeNull();
  });

  it("does nothing without a refresh token", async () => {
    const server = tokenServer({ body: {} });
    await expect(refreshTokens(environment(signedIn(null), server.fetch))).resolves.toBe(false);
    expect(server.calls).toHaveLength(0);
  });
});

describe("readTokens", () => {
  it("ignores anything it did not write", () => {
    const store = memoryStore();
    store.setItem("inworkspace-console:tokens", "{not json");
    expect(readTokens(store)).toBeNull();
    store.setItem("inworkspace-console:tokens", JSON.stringify({ accessToken: 1 }));
    expect(readTokens(store)).toBeNull();
    clearTokens(store);
    expect(store.data.size).toBe(0);
  });
});
```

**File: `ui/src/api.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { ApiFailure, createApiClient } from "./api";
import type { SessionEnvironment, Store } from "./auth/session";

const API = "https://console-api.example.com";
const ORIGIN = "https://mail.example.com";
const NOW = Date.parse("2026-10-26T10:00:00Z");
const TOKENS = "inworkspace-console:tokens";

function memoryStore(tokens?: { accessToken: string; refreshToken: string | null; expiresAt: number }): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (tokens) data.set(TOKENS, JSON.stringify(tokens));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

interface Seen {
  url: string;
  authorization: string | null;
}

/** The API answers 401 to every token in `expired`; the token endpoint hands out access-2, access-3, … */
function servers(options: { expired?: string[]; refuseRefresh?: boolean; apiStatus?: number; apiBody?: unknown } = {}) {
  const seen: Seen[] = [];
  let issued = 1;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url === `${ORIGIN}/auth/token`) {
      if (options.refuseRefresh) return Response.json({ error: "invalid_grant" }, { status: 400 });
      issued += 1;
      return Response.json({ access_token: `access-${issued}`, expires_in: 3600 });
    }
    const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    if (options.expired?.includes(token)) return Response.json({ error: { code: "unauthenticated", message: "ended" } }, { status: 401 });
    return Response.json(options.apiBody ?? { ok: token }, { status: options.apiStatus ?? 200 });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

function clientFor(store: Store, server: ReturnType<typeof servers>) {
  let ended = 0;
  const session: SessionEnvironment = { origin: ORIGIN, basePath: "/console", clientId: "inworkspace-console", store, fetch: server.fetch, now: () => NOW };
  const get = createApiClient({ apiUrl: API, session, onSessionEnded: () => (ended += 1) });
  return { get, ended: () => ended };
}

describe("createApiClient", () => {
  it("calls the API with the access token", async () => {
    const server = servers();
    const { get } = clientFor(memoryStore({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000 }), server);
    await expect(get<{ ok: string }>("overview")).resolves.toEqual({ ok: "access-1" });
    expect(server.seen).toEqual([{ url: `${API}/api/v1/overview`, authorization: "Bearer access-1" }]);
  });

  it("refreshes first when the access token is about to expire", async () => {
    const server = servers();
    const { get } = clientFor(memoryStore({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 10_000 }), server);
    await expect(get("me")).resolves.toEqual({ ok: "access-2" });
  });

  it("refreshes once on a 401 and retries", async () => {
    const server = servers({ expired: ["access-1"] });
    const { get, ended } = clientFor(memoryStore({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000 }), server);
    await expect(get("me")).resolves.toEqual({ ok: "access-2" });
    expect(ended()).toBe(0);
  });

  it("ends the session when the token is refused and cannot be refreshed", async () => {
    const store = memoryStore({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000 });
    const { get, ended } = clientFor(store, servers({ expired: ["access-1"], refuseRefresh: true }));
    await expect(get("me")).rejects.toMatchObject({ name: "ApiFailure", status: 401 });
    expect(ended()).toBe(1);
    expect(store.data.has(TOKENS)).toBe(false);
  });

  it("ends the session without a request when there are no tokens", async () => {
    const server = servers();
    const { get, ended } = clientFor(memoryStore(), server);
    await expect(get("me")).rejects.toBeInstanceOf(ApiFailure);
    expect(ended()).toBe(1);
    expect(server.seen).toHaveLength(0);
  });

  it("turns an error answer into a failure with its code and message", async () => {
    const server = servers({ apiStatus: 403, apiBody: { error: { code: "forbidden", message: "admin does not have the impersonate permission" } } });
    const { get } = clientFor(memoryStore({ accessToken: "access-1", refreshToken: null, expiresAt: NOW + 3_600_000 }), server);
    await expect(get("me")).rejects.toMatchObject({ status: 403, code: "forbidden", message: "admin does not have the impersonate permission" });
  });

  it("refreshes once for requests that fail together", async () => {
    const server = servers({ expired: ["access-1"] });
    const { get } = clientFor(memoryStore({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000 }), server);
    await Promise.all([get("me"), get("overview"), get("agents")]);
    expect(server.seen.filter((call) => call.url === `${ORIGIN}/auth/token`)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run ui/src`
Expected: FAIL. The modules do not exist.

- [ ] **Step 4: Implement**

**File: `ui/src/settings.ts`**

```ts
export interface UiSettings {
  /** Origin of the console API, or "" for the page's own origin (the development server proxies it). */
  apiUrl: string;
  clientId: string;
  /** The configured time zone, else the browser's own. */
  timeZone: string;
  /** The path the server serves the app under, such as "/console"; "" at the root. */
  basePath: string;
}

function meta(document: Document, name: string): string {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content")?.trim() ?? "";
}

/** The server rewrites the page's <base href> to the app's prefix: ".../console/" → "/console". */
export function basePathFrom(baseUri: string): string {
  return new URL(baseUri).pathname.replace(/\/+$/, "");
}

export function readSettings(document: Document): UiSettings {
  return {
    apiUrl: meta(document, "inworkspace-console-api").replace(/\/+$/, ""),
    clientId: meta(document, "inworkspace-console-client-id"),
    timeZone: meta(document, "inworkspace-console-time-zone") || Intl.DateTimeFormat().resolvedOptions().timeZone,
    basePath: basePathFrom(document.baseURI),
  };
}
```

**File: `ui/src/auth/pkce.ts`**

```ts
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
```

**File: `ui/src/auth/session.ts`**

```ts
import { randomToken, s256Challenge } from "./pkce";

export type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface SessionEnvironment {
  /** The page's origin: the mail server, which serves the app and signs operators in. */
  origin: string;
  basePath: string;
  clientId: string;
  store: Store;
  fetch: typeof fetch;
  now: () => number;
}

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

interface PendingSignIn {
  verifier: string;
  state: string;
  returnTo: string;
}

interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

const TOKENS_KEY = "inworkspace-console:tokens";
const PENDING_KEY = "inworkspace-console:sign-in";
/** offline_access asks for a refresh token, so a session outlives the one-hour access token. */
export const SCOPE = "openid offline_access";
const DEFAULT_LIFETIME_S = 3600;

export function callbackPath(basePath: string): string {
  return `${basePath}/oauth/callback`;
}

function redirectUri(env: Pick<SessionEnvironment, "origin" | "basePath">): string {
  return `${env.origin}${callbackPath(env.basePath)}`;
}

/** Only routes inside the app: never another origin. */
export function safeReturnTo(value: string | null | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function readTokens(store: Store): Tokens | null {
  try {
    const value = JSON.parse(store.getItem(TOKENS_KEY) ?? "null") as Partial<Tokens> | null;
    if (!value || typeof value.accessToken !== "string" || typeof value.expiresAt !== "number") return null;
    return {
      accessToken: value.accessToken,
      refreshToken: typeof value.refreshToken === "string" ? value.refreshToken : null,
      expiresAt: value.expiresAt,
    };
  } catch {
    return null;
  }
}

export function clearTokens(store: Store): void {
  store.removeItem(TOKENS_KEY);
}

function tokensFrom(answer: TokenAnswer, now: number, previousRefresh: string | null): Tokens | null {
  if (typeof answer.access_token !== "string" || answer.access_token.length === 0) return null;
  const lifetime = typeof answer.expires_in === "number" && answer.expires_in > 0 ? answer.expires_in : DEFAULT_LIFETIME_S;
  return {
    accessToken: answer.access_token,
    refreshToken: typeof answer.refresh_token === "string" && answer.refresh_token ? answer.refresh_token : previousRefresh,
    expiresAt: now + lifetime * 1000,
  };
}

function describeRefusal(answer: TokenAnswer, status: number): string {
  if (typeof answer.error_description === "string" && answer.error_description) return answer.error_description;
  if (typeof answer.error === "string" && answer.error) return answer.error;
  return `HTTP ${status}`;
}

async function tokenRequest(env: SessionEnvironment, form: Record<string, string>) {
  const response = await env.fetch(`${env.origin}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const answer = (await response.json().catch(() => ({}))) as TokenAnswer;
  return { ok: response.ok, status: response.status, answer };
}

/** The server's sign-in page, for this tab; the caller navigates to it. */
export async function beginSignIn(env: Pick<SessionEnvironment, "origin" | "basePath" | "clientId" | "store">, returnTo: string): Promise<string> {
  const verifier = randomToken();
  const state = randomToken(16);
  const pending: PendingSignIn = { verifier, state, returnTo: safeReturnTo(returnTo) };
  env.store.setItem(PENDING_KEY, JSON.stringify(pending));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.clientId,
    redirect_uri: redirectUri(env),
    scope: SCOPE,
    state,
    code_challenge: await s256Challenge(verifier),
    code_challenge_method: "S256",
  });
  return `${env.origin}/login?${params.toString()}`;
}

/** Finishes sign-in on the callback page; returns the route to open. */
export async function completeSignIn(env: SessionEnvironment, callback: URL): Promise<string> {
  const raw = env.store.getItem(PENDING_KEY);
  env.store.removeItem(PENDING_KEY);
  let pending: PendingSignIn | null = null;
  try {
    pending = JSON.parse(raw ?? "null") as PendingSignIn | null;
  } catch {
    pending = null;
  }
  const error = callback.searchParams.get("error");
  if (error) {
    throw new SignInError(`The mail server did not sign you in: ${callback.searchParams.get("error_description") ?? error}`);
  }
  const code = callback.searchParams.get("code");
  if (!pending || !code || callback.searchParams.get("state") !== pending.state) {
    throw new SignInError("This sign-in was not started in this tab, or it was already used. Sign in again.");
  }
  const { ok, status, answer } = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(env),
    client_id: env.clientId,
    code_verifier: pending.verifier,
  });
  const tokens = ok ? tokensFrom(answer, env.now(), null) : null;
  if (!tokens) throw new SignInError(`The mail server refused the sign-in: ${describeRefusal(answer, status)}`);
  env.store.setItem(TOKENS_KEY, JSON.stringify(tokens));
  return pending.returnTo;
}

/** A new access token from the refresh token; false when the session cannot be renewed. */
export async function refreshTokens(env: SessionEnvironment): Promise<boolean> {
  const current = readTokens(env.store);
  if (!current?.refreshToken) return false;
  try {
    const { ok, answer } = await tokenRequest(env, {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: env.clientId,
    });
    const tokens = ok ? tokensFrom(answer, env.now(), current.refreshToken) : null;
    if (!tokens) {
      clearTokens(env.store);
      return false;
    }
    env.store.setItem(TOKENS_KEY, JSON.stringify(tokens));
    return true;
  } catch {
    // The server could not be reached; keep the tokens for the next try.
    return false;
  }
}
```

**File: `ui/src/api.ts`**

```ts
import type { ApiErrorBody } from "@/lib/apiTypes";
import { clearTokens, readTokens, refreshTokens, type SessionEnvironment } from "./auth/session";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

export interface ApiClientOptions {
  /** Origin of the console API; "" for the page's own origin. */
  apiUrl: string;
  session: SessionEnvironment;
  /** Called when the operator must sign in again. */
  onSessionEnded: () => void;
}

export type ApiGet = <T>(path: string, signal?: AbortSignal) => Promise<T>;

/** Refresh this long before the access token expires, so a request never races its expiry. */
const EARLY_REFRESH_MS = 30_000;

export function createApiClient(options: ApiClientOptions): ApiGet {
  const { session } = options;
  let refreshing: Promise<boolean> | null = null;
  const refresh = (): Promise<boolean> =>
    (refreshing ??= refreshTokens(session).finally(() => {
      refreshing = null;
    }));

  const send = (path: string, accessToken: string, signal?: AbortSignal) =>
    session.fetch(`${options.apiUrl}/api/v1/${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal,
    });

  const ended = (message: string): ApiFailure => {
    clearTokens(session.store);
    options.onSessionEnded();
    return new ApiFailure(401, "unauthenticated", message);
  };

  return async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    let tokens = readTokens(session.store);
    if (tokens?.refreshToken && tokens.expiresAt - EARLY_REFRESH_MS <= session.now()) {
      await refresh();
      tokens = readTokens(session.store);
    }
    if (!tokens) throw ended("Sign-in needed.");

    let response = await send(path, tokens.accessToken, signal);
    if (response.status === 401) {
      // Another request may already have renewed the token this one was sent with.
      const latest = readTokens(session.store);
      const renewedElsewhere = latest !== null && latest.accessToken !== tokens.accessToken;
      const renewed = renewedElsewhere || (await refresh()) ? readTokens(session.store) : null;
      if (renewed) response = await send(path, renewed.accessToken, signal);
    }
    if (response.status === 401) throw ended("The session ended. Sign in again.");
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
      throw new ApiFailure(
        response.status,
        body?.error?.code ?? "http_error",
        body?.error?.message ?? `The console API answered HTTP ${response.status}.`,
      );
    }
    return (await response.json()) as T;
  };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run ui/src`
Expected: PASS, 24 tests.

- [ ] **Step 6: Commit**

```bash
git add ui/index.html ui/src/settings.ts ui/src/settings.test.ts ui/src/auth ui/src/api.ts ui/src/api.test.ts
git commit -m "feat(console): web app sign-in with the mail server, and its API client"
```

---

### Task 8: Web app shell and pages

**Files:** Create `ui/src/main.tsx`, `App.tsx`, `Shell.tsx`, `console.tsx`, `useApi.ts`,
`useDocumentTitle.ts`, `components/Forbidden.tsx` and the pages. Modify the moved components
`EventRow.tsx` and `LiveEvents.tsx`.

- [ ] **Step 1: Write the app**

**File: `ui/src/console.tsx`**

```tsx
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createApiClient, type ApiGet } from "./api";
import { beginSignIn, clearTokens, completeSignIn, readTokens, type SessionEnvironment } from "./auth/session";
import type { UiSettings } from "./settings";

interface ConsoleValue {
  settings: UiSettings;
  get: ApiGet;
  hasSession: () => boolean;
  signIn: (returnTo: string) => Promise<void>;
  completeSignIn: (callback: URL) => Promise<string>;
  signOut: () => void;
}

const ConsoleContext = createContext<ConsoleValue | null>(null);

/** The app's route, from the hash: "#/events?severity=error" → "/events?severity=error". */
export function routeFromHash(hash: string): string {
  return hash.startsWith("#/") ? hash.slice(1) : "/";
}

function sessionEnvironment(settings: UiSettings): SessionEnvironment {
  return {
    origin: window.location.origin,
    basePath: settings.basePath,
    clientId: settings.clientId,
    store: window.sessionStorage,
    fetch: (input, init) => window.fetch(input, init),
    now: () => Date.now(),
  };
}

export function ConsoleProvider({ settings, children }: { settings: UiSettings; children: ReactNode }) {
  const value = useMemo<ConsoleValue>(() => {
    const session = sessionEnvironment(settings);
    const signIn = async (returnTo: string) => {
      window.location.assign(await beginSignIn(session, returnTo));
    };
    return {
      settings,
      get: createApiClient({
        apiUrl: settings.apiUrl,
        session,
        onSessionEnded: () => void signIn(routeFromHash(window.location.hash)),
      }),
      hasSession: () => readTokens(session.store) !== null,
      signIn,
      completeSignIn: (callback) => completeSignIn(session, callback),
      signOut: () => {
        clearTokens(session.store);
        window.location.assign(`${settings.basePath}/#/signed-out`);
      },
    };
  }, [settings]);
  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

export function useConsole(): ConsoleValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error("useConsole needs a ConsoleProvider");
  return value;
}
```

**File: `ui/src/useApi.ts`**

```ts
import { useEffect, useState } from "react";
import { ApiFailure } from "./api";
import { useConsole } from "./console";

export type Loaded<T> = { status: "loading" } | { status: "error"; error: ApiFailure } | { status: "ready"; data: T };

function asFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  return new ApiFailure(0, "network", `The console API could not be reached: ${error instanceof Error ? error.message : String(error)}`);
}

/** Loads one API path; a new path starts loading again. Null loads nothing. */
export function useApi<T>(path: string | null): Loaded<T> {
  const { get } = useConsole();
  const [loaded, setLoaded] = useState<{ path: string | null; value: Loaded<T> }>({ path: null, value: { status: "loading" } });

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    get<T>(path, controller.signal).then(
      (data) => setLoaded({ path, value: { status: "ready", data } }),
      (error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ path, value: { status: "error", error: asFailure(error) } });
      },
    );
    return () => controller.abort();
  }, [get, path]);

  return loaded.path === path ? loaded.value : { status: "loading" };
}
```

**File: `ui/src/useDocumentTitle.ts`**

```ts
import { useEffect } from "react";

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · inWorkspace Console`;
  }, [title]);
}
```

**File: `ui/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { callbackPath } from "./auth/session";
import { ConsoleProvider } from "./console";
import { SignInCallback } from "./pages/SignInCallback";
import { readSettings } from "./settings";
import "./styles.css";

const settings = readSettings(document);
// The OAuth callback is the app's only real path: everything else lives in the hash, which the
// server never sees, so no route can trip its path checks.
const onCallback = window.location.pathname === callbackPath(settings.basePath);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConsoleProvider settings={settings}>{onCallback ? <SignInCallback /> : <App />}</ConsoleProvider>
  </StrictMode>,
);
```

**File: `ui/src/App.tsx`**

```tsx
import { createHashRouter, RouterProvider } from "react-router";
import { Shell } from "./Shell";
import { AgentPage } from "./pages/AgentPage";
import { EventsPage } from "./pages/EventsPage";
import { NotFound } from "./pages/NotFound";
import { OverviewPage } from "./pages/OverviewPage";
import { SignedOut } from "./pages/SignedOut";
import { ThreadPage } from "./pages/ThreadPage";

const router = createHashRouter([
  { path: "/signed-out", element: <SignedOut /> },
  {
    element: <Shell />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: "agents/:address", element: <AgentPage /> },
      { path: "agents/:address/threads/:threadId", element: <ThreadPage /> },
      { path: "events", element: <EventsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
```

**File: `ui/src/Shell.tsx`**

```tsx
import { useEffect } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import type { MeResponse } from "@/lib/apiTypes";
import { Forbidden } from "./components/Forbidden";
import { Loading } from "./components/Loading";
import { useConsole } from "./console";
import { useApi } from "./useApi";

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? "text-text" : "text-text-muted hover:text-text");

/** Every signed-in page: sends the operator to sign in first, then shows the header. */
export function Shell() {
  const { hasSession, signIn, signOut } = useConsole();
  const location = useLocation();
  const signedIn = hasSession();
  const returnTo = location.pathname + location.search;

  useEffect(() => {
    if (!signedIn) void signIn(returnTo);
  }, [signedIn, signIn, returnTo]);

  const me = useApi<MeResponse>(signedIn ? "me" : null);

  if (!signedIn) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-8">
        <Loading label="Opening the mail server's sign-in page…" />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-7xl items-center gap-8 px-6 py-3">
          <Link to="/" className="text-sm font-semibold tracking-tight text-text">
            inWorkspace <span className="text-brand">Console</span>
          </Link>
          <nav aria-label="Main" className="flex gap-5 text-sm">
            <NavLink to="/" end className={navClass}>
              Overview
            </NavLink>
            <NavLink to="/events" className={navClass}>
              Events
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-4 text-xs text-text-muted">
            <a href="/admin/" className="hover:text-text">
              Mail server admin
            </a>
            {me.status === "ready" ? <span title="Signed in at the mail server">{me.data.login}</span> : null}
            <button type="button" onClick={signOut} className="rounded-md border border-border px-2 py-1 hover:bg-surface-muted">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-6 py-8">
        {me.status === "error" && me.error.status === 403 ? <Forbidden message={me.error.message} onSignOut={signOut} /> : <Outlet />}
      </div>
    </div>
  );
}
```

**File: `ui/src/components/Forbidden.tsx`**

```tsx
export function Forbidden({ message, onSignOut }: { message: string; onSignOut: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-error/30 bg-error-soft p-6 text-sm">
      <p className="font-medium text-error">This account cannot use the console</p>
      <p className="mt-1 text-text-muted">
        {message}. Ask an administrator for that permission, or sign in with another account.
      </p>
      <button type="button" onClick={onSignOut} className="mt-4 rounded-md bg-brand px-3 py-1.5 font-medium text-surface hover:bg-brand-strong">
        Sign out
      </button>
    </div>
  );
}
```

**File: `ui/src/components/EventRow.tsx`**

```tsx
import { Link } from "react-router";
import type { StoredEvent } from "@/lib/apiTypes";
import { describeEvent, formatDateTime } from "@/lib/format";
import { SeverityBadge } from "./SeverityBadge";

export function EventRow({ event, timeZone }: { event: StoredEvent; timeZone: string }) {
  return (
    <tr className="border-t border-border align-top">
      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-text-muted">
        <time dateTime={event.eventAt}>{formatDateTime(event.eventAt, timeZone)}</time>
      </td>
      <td className="px-4 py-2">
        <SeverityBadge severity={event.severity} />
      </td>
      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">
        <Link to={`/events?type=${encodeURIComponent(event.type)}`} className="hover:text-brand hover:underline">
          {event.type}
        </Link>
      </td>
      <td className="px-4 py-2 text-sm">
        <p className="break-words">{describeEvent(event) || "—"}</p>
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-text-muted hover:text-text">Raw event</summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded bg-surface-sunken p-3 font-mono text-xs">{JSON.stringify(event.data, null, 2)}</pre>
        </details>
      </td>
    </tr>
  );
}
```

**File: `ui/src/components/LiveEvents.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import type { EventsResponse, StoredEvent } from "@/lib/apiTypes";
import { useConsole } from "../console";
import { EventRow } from "./EventRow";

const POLL_MS = 3000;
const KEEP = 500;

export function LiveEvents({ initialAfter, query, timeZone }: { initialAfter: number; query: string; timeZone: string }) {
  const { get } = useConsole();
  const [live, setLive] = useState(false);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const after = useRef(initialAfter);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const body = await get<EventsResponse>(`events?${query ? `${query}&` : ""}after=${after.current}`);
        if (cancelled) return;
        setError(null);
        if (body.events.length > 0) {
          after.current = Math.max(after.current, ...body.events.map((event) => event.id));
          setEvents((current) => [...body.events, ...current].slice(0, KEEP));
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [live, query, get]);

  return (
    <section aria-label="Live events" className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <button
          type="button"
          onClick={() => setLive((value) => !value)}
          aria-pressed={live}
          className={`rounded-md px-3 py-1.5 text-xs font-medium ${live ? "bg-brand text-surface hover:bg-brand-strong" : "border border-border hover:bg-surface-muted"}`}
        >
          {live ? "Stop live updates" : "Start live updates"}
        </button>
        <span className="text-xs text-text-muted">
          {live ? (error ? `Paused: ${error}. Retrying…` : `Checking every ${POLL_MS / 1000} seconds.`) : "New events appear here while live updates are on."}
        </span>
        {events.length > 0 ? <span className="ml-auto text-xs font-medium">{events.length} new</span> : null}
      </div>
      {events.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full">
            <tbody>
              {events.map((event) => (
                <EventRow key={event.id} event={event} timeZone={timeZone} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
```

**File: `ui/src/pages/OverviewPage.tsx`**

```tsx
import { useState } from "react";
import { Link } from "react-router";
import type { OverviewResponse } from "@/lib/apiTypes";
import { formatRelative } from "@/lib/format";
import { ErrorPanel } from "../components/ErrorPanel";
import { EventRow } from "../components/EventRow";
import { Loading } from "../components/Loading";
import { StatCard } from "../components/StatCard";
import { useConsole } from "../console";
import { useApi } from "../useApi";
import { useDocumentTitle } from "../useDocumentTitle";

export function OverviewPage() {
  useDocumentTitle("Overview");
  const overview = useApi<OverviewResponse>("overview");
  return (
    <main className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-text-muted">Agent mail over the last 24 hours.</p>
      </header>
      {overview.status === "loading" ? (
        <Loading label="Counting the last 24 hours…" />
      ) : overview.status === "error" ? (
        <ErrorPanel title="The overview could not be loaded" detail={overview.error.message} />
      ) : (
        <OverviewContent data={overview.data} />
      )}
    </main>
  );
}

function OverviewContent({ data }: { data: OverviewResponse }) {
  const { settings } = useConsole();
  const [now] = useState(() => new Date());
  const { totals, agents } = data;
  return (
    <>
      {data.directoryError !== null ? (
        <ErrorPanel title="The agent list is unavailable" detail={`${data.directoryError}. Counts that need it are shown as —.`} />
      ) : null}

      <section aria-label="Counts" className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
        <StatCard label="Received" value={totals.received} />
        <StatCard label="Filed as junk" value={totals.junk} tone="warning" />
        <StatCard label="Refused at SMTP" value={totals.refused} tone="warning" />
        <StatCard label="Replies sent" value={totals.repliesSent} />
        <StatCard label="Replies delivered" value={totals.repliesDelivered} />
        <StatCard label="Delivery problems" value={totals.deliveryProblems} tone="error" />
        <StatCard label="Access problems" value={totals.accessProblems} tone="warning" />
      </section>

      <section aria-labelledby="agents-heading" className="overflow-hidden rounded-lg border border-border bg-surface">
        <h2 id="agents-heading" className="border-b border-border px-4 py-3 text-sm font-semibold">
          Agents <span className="font-normal text-text-muted">({agents ? agents.length : "—"})</span>
        </h2>
        {agents === null ? (
          <p className="p-4 text-sm text-text-muted">The agent list could not be loaded from the mail server.</p>
        ) : agents.length === 0 ? (
          <p className="p-4 text-sm text-text-muted">No agent mailboxes in {data.agentDomains.join(", ")}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Agent</th>
                  <th className="px-4 py-2 text-right font-medium">Received</th>
                  <th className="px-4 py-2 text-right font-medium">Junk</th>
                  <th className="px-4 py-2 text-right font-medium">Replies sent</th>
                  <th className="px-4 py-2 text-right font-medium">Errors</th>
                  <th className="px-4 py-2 text-right font-medium">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.address} className="border-t border-border hover:bg-surface-muted">
                    <td className="px-4 py-2">
                      <Link to={`/agents/${encodeURIComponent(agent.address)}`} className="font-medium text-brand hover:underline">
                        {agent.name ?? agent.address}
                      </Link>
                      {agent.name ? <div className="font-mono text-xs text-text-muted">{agent.address}</div> : null}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{agent.received}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{agent.junk}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{agent.repliesSent}</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${agent.errors ? "font-semibold text-error" : ""}`}>{agent.errors}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right text-text-muted">
                      {agent.lastActivity ? formatRelative(agent.lastActivity, now) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="errors-heading" className="overflow-hidden rounded-lg border border-border bg-surface">
        <h2 id="errors-heading" className="flex items-center border-b border-border px-4 py-3 text-sm font-semibold">
          Recent errors
          <Link to="/events?severity=error" className="ml-auto text-xs font-medium text-brand hover:underline">
            All errors
          </Link>
        </h2>
        {data.recentErrors.length === 0 ? (
          <p className="p-4 text-sm text-text-muted">No errors in the event store.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <tbody>
                {data.recentErrors.map((event) => (
                  <EventRow key={event.id} event={event} timeZone={settings.timeZone} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
```

**File: `ui/src/pages/AgentPage.tsx`**

```tsx
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { ThreadsResponse } from "@/lib/apiTypes";
import { formatAddress, formatDateTime, formatRelative } from "@/lib/format";
import { parsePosition } from "@/lib/params";
import { ErrorPanel } from "../components/ErrorPanel";
import { Loading } from "../components/Loading";
import { ThreadStatusChip } from "../components/ThreadStatusChip";
import { useConsole } from "../console";
import { useApi } from "../useApi";
import { useDocumentTitle } from "../useDocumentTitle";

export function AgentPage() {
  useDocumentTitle("Conversations");
  const { address = "" } = useParams();
  const [search] = useSearchParams();
  const position = parsePosition(search.get("position") ?? undefined);
  const agentPath = `/agents/${encodeURIComponent(address)}`;
  const result = useApi<ThreadsResponse>(`agents/${encodeURIComponent(address)}/threads?position=${position}`);

  return (
    <main className="space-y-6">
      <header>
        <Link to="/" className="text-xs font-medium text-brand hover:underline">
          ← Overview
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{result.status === "ready" ? (result.data.agent.name ?? address) : address}</h1>
        {result.status === "ready" && result.data.agent.name ? <p className="font-mono text-sm text-text-muted">{address}</p> : null}
      </header>
      {result.status === "loading" ? (
        <Loading label="Opening the mailbox…" />
      ) : result.status === "error" ? (
        <ErrorPanel title={result.error.status === 404 ? "No such agent" : "The mailbox could not be read"} detail={result.error.message} />
      ) : (
        <Threads page={result.data} agentPath={agentPath} />
      )}
    </main>
  );
}

function Threads({ page, agentPath }: { page: ThreadsResponse; agentPath: string }) {
  const { settings } = useConsole();
  const [now] = useState(() => new Date());
  if (page.threads.length === 0) {
    return <p className="rounded-lg border border-border bg-surface p-6 text-sm text-text-muted">This mailbox has no conversations yet.</p>;
  }
  const { position, pageSize, total } = page;
  return (
    <section aria-label="Conversations" className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Conversation</th>
              <th className="px-4 py-2 font-medium">With</th>
              <th className="px-4 py-2 text-right font-medium">Messages</th>
              <th className="px-4 py-2 text-right font-medium">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {page.threads.map((thread) => (
              <tr key={thread.threadId} className="border-t border-border align-top hover:bg-surface-muted">
                <td className="px-4 py-3">
                  <ThreadStatusChip status={thread.status} />
                </td>
                <td className="max-w-xl px-4 py-3">
                  <Link to={`${agentPath}/threads/${encodeURIComponent(thread.threadId)}`} className="font-medium text-text hover:text-brand hover:underline">
                    {thread.subject}
                  </Link>
                  <p className="mt-0.5 line-clamp-1 text-xs text-text-muted">
                    {thread.lastDirection === "outbound" ? "Agent: " : ""}
                    {thread.preview}
                  </p>
                </td>
                <td className="px-4 py-3 text-text-muted">{formatAddress(thread.counterpart)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{thread.messageCount}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-text-muted" title={formatDateTime(thread.lastActivity, settings.timeZone)}>
                  {formatRelative(thread.lastActivity, now)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav aria-label="Pages" className="flex items-center gap-4 border-t border-border px-4 py-3 text-xs text-text-muted">
        <span>
          {position + 1}–{position + page.threads.length} of {total}
        </span>
        {position > 0 ? (
          <Link to={`${agentPath}?position=${Math.max(0, position - pageSize)}`} className="ml-auto font-medium text-brand hover:underline">
            Newer
          </Link>
        ) : null}
        {position + pageSize < total ? (
          <Link to={`${agentPath}?position=${position + pageSize}`} className={`${position > 0 ? "" : "ml-auto "}font-medium text-brand hover:underline`}>
            Older
          </Link>
        ) : null}
      </nav>
    </section>
  );
}
```

**File: `ui/src/pages/ThreadPage.tsx`**

```tsx
import { Link, useParams } from "react-router";
import type { ThreadMessage, ThreadResponse } from "@/lib/apiTypes";
import { emailHtmlDocument } from "@/lib/emailDocument";
import { formatAddress, formatBytes, formatDateTime } from "@/lib/format";
import { ErrorPanel } from "../components/ErrorPanel";
import { Loading } from "../components/Loading";
import { ThreadStatusChip } from "../components/ThreadStatusChip";
import { useConsole } from "../console";
import { useApi } from "../useApi";
import { useDocumentTitle } from "../useDocumentTitle";

export function ThreadPage() {
  useDocumentTitle("Conversation");
  const { address = "", threadId = "" } = useParams();
  const { settings } = useConsole();
  const result = useApi<ThreadResponse>(`agents/${encodeURIComponent(address)}/threads/${encodeURIComponent(threadId)}`);

  return (
    <main className="space-y-6">
      <header>
        <Link to={`/agents/${encodeURIComponent(address)}`} className="text-xs font-medium text-brand hover:underline">
          ← {result.status === "ready" ? (result.data.agent.name ?? address) : address}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {result.status === "ready" ? (result.data.messages[0]?.subject ?? "Conversation") : "Conversation"}
        </h1>
      </header>
      {result.status === "loading" ? (
        <Loading label="Reading the conversation…" />
      ) : result.status === "error" ? (
        <ErrorPanel title={result.error.status === 404 ? "No such conversation" : "The conversation could not be read"} detail={result.error.message} />
      ) : (
        <ol className="space-y-4">
          {result.data.messages.map((message) => (
            <li key={message.id}>
              <Message message={message} timeZone={settings.timeZone} />
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}

function labelOf(message: ThreadMessage): string {
  if (message.draft) return "Draft, not sent";
  return message.direction === "outbound" ? "Agent reply" : "Inbound";
}

function Message({ message, timeZone }: { message: ThreadMessage; timeZone: string }) {
  const outbound = message.direction === "outbound" && !message.draft;
  return (
    <article
      className={`rounded-lg border p-4 ${outbound ? "border-brand/30 bg-brand-soft md:ml-16" : "border-border bg-surface md:mr-16"} ${message.draft || message.deleted ? "border-dashed opacity-75" : ""}`}
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{labelOf(message)}</span>
        {message.deleted ? <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-medium text-text-muted">In Trash</span> : null}
        <span className="font-medium">{formatAddress(message.from[0])}</span>
        <span className="text-text-muted">to {message.to.map(formatAddress).join(", ") || "—"}</span>
        {message.cc.length > 0 ? <span className="text-text-muted">cc {message.cc.map(formatAddress).join(", ")}</span> : null}
        {message.junk ? <ThreadStatusChip status="junk" /> : null}
        {message.automated ? <ThreadStatusChip status="automated" /> : null}
        <time className="ml-auto text-xs text-text-muted" dateTime={message.receivedAt}>
          {formatDateTime(message.receivedAt, timeZone)}
        </time>
      </header>
      <p className="mt-1 text-sm font-medium">{message.subject}</p>
      <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{message.text || "(no text body)"}</pre>
      {message.truncated ? <p className="mt-2 text-xs text-text-muted">The body is longer than 256 KB and was cut.</p> : null}
      {message.html ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-brand">Show the formatted version</summary>
          <iframe
            title={`Formatted version of “${message.subject}”`}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={emailHtmlDocument(message.html)}
            className="mt-2 h-[480px] w-full rounded border border-border bg-white"
          />
        </details>
      ) : null}
      {message.attachments.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2 text-xs text-text-muted">
          {message.attachments.map((attachment, index) => (
            <li key={`${attachment.name}-${index}`} className="rounded border border-border bg-surface px-2 py-1">
              {attachment.name} · {formatBytes(attachment.size)}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
```

**File: `ui/src/pages/EventsPage.tsx`**

```tsx
import { Link, useSearchParams } from "react-router";
import type { AgentsResponse, EventsResponse } from "@/lib/apiTypes";
import { EVENT_TYPE_PREFIXES, EVENT_WINDOWS, eventFiltersQuery, parseEventFilters } from "@/lib/eventFilters";
import { parseEventId } from "@/lib/params";
import { EventRow } from "../components/EventRow";
import { ErrorPanel } from "../components/ErrorPanel";
import { LiveEvents } from "../components/LiveEvents";
import { Loading } from "../components/Loading";
import { useConsole } from "../console";
import { useApi } from "../useApi";
import { useDocumentTitle } from "../useDocumentTitle";

/** The API computes the window's start itself; this only parses the filters. */
const UNUSED_NOW = new Date(0);
const FILTER_NAMES = ["type", "severity", "agent", "window"] as const;

export function EventsPage() {
  useDocumentTitle("Events");
  const { settings } = useConsole();
  const [search, setSearch] = useSearchParams();
  const filters = parseEventFilters(search, UNUSED_NOW);
  const filterQuery = eventFiltersQuery(filters);
  const before = parseEventId(search.get("before") ?? undefined) ?? 0;
  const events = useApi<EventsResponse>(`events?${[filterQuery, before > 0 ? `before=${before}` : ""].filter(Boolean).join("&")}`);
  const directory = useApi<AgentsResponse>("agents");

  const apply = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const next = new URLSearchParams();
    for (const name of FILTER_NAMES) {
      const value = String(data.get(name) ?? "").trim();
      if (value) next.set(name, value);
    }
    setSearch(next);
  };

  return (
    <main className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
        <p className="mt-1 text-sm text-text-muted">What the mail server did with agent mail, newest first.</p>
      </header>

      <form
        key={filterQuery}
        onSubmit={(event) => {
          event.preventDefault();
          apply(event.currentTarget);
        }}
        className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4 text-sm"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-muted">Type</span>
          <select name="type" defaultValue={filters.typePrefix ?? ""} className="rounded-md border border-border bg-surface px-2 py-1.5">
            <option value="">All types</option>
            {EVENT_TYPE_PREFIXES.map((prefix) => (
              <option key={prefix} value={prefix}>
                {prefix}*
              </option>
            ))}
            {filters.typePrefix && !(EVENT_TYPE_PREFIXES as readonly string[]).includes(filters.typePrefix) ? (
              <option value={filters.typePrefix}>{filters.typePrefix}</option>
            ) : null}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-muted">Severity</span>
          <select name="severity" defaultValue={filters.severity ?? ""} className="rounded-md border border-border bg-surface px-2 py-1.5">
            <option value="">Any</option>
            <option value="error">Error</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-muted">Agent</span>
          {directory.status === "ready" ? (
            <select name="agent" defaultValue={filters.address ?? ""} className="rounded-md border border-border bg-surface px-2 py-1.5">
              <option value="">All agents</option>
              {directory.data.agents.map((agent) => (
                <option key={agent.address} value={agent.address}>
                  {agent.name ? `${agent.name} (${agent.address})` : agent.address}
                </option>
              ))}
            </select>
          ) : (
            <input name="agent" defaultValue={filters.address ?? ""} placeholder="address" className="rounded-md border border-border bg-surface px-2 py-1.5" />
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-muted">Window</span>
          <select name="window" defaultValue={filters.window} className="rounded-md border border-border bg-surface px-2 py-1.5">
            {Object.keys(EVENT_WINDOWS).map((window) => (
              <option key={window} value={window}>
                Last {window}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-md bg-brand px-3 py-1.5 font-medium text-surface hover:bg-brand-strong">
          Apply
        </button>
        <Link to="/events" className="px-1 py-1.5 text-xs text-text-muted hover:text-text">
          Reset
        </Link>
      </form>

      {/* Keyed by the filters: other filters start a fresh live view. */}
      {before === 0 && events.status === "ready" ? (
        <LiveEvents key={filterQuery} initialAfter={events.data.events[0]?.id ?? 0} query={filterQuery} timeZone={settings.timeZone} />
      ) : null}

      {events.status === "loading" ? (
        <Loading label="Loading events…" />
      ) : events.status === "error" ? (
        <ErrorPanel title="The events could not be loaded" detail={events.error.message} />
      ) : (
        <section aria-label="Events" className="overflow-hidden rounded-lg border border-border bg-surface">
          {events.data.events.length === 0 ? (
            <p className="p-6 text-sm text-text-muted">No events match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="text-left text-xs uppercase tracking-wide text-text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Time ({settings.timeZone})</th>
                    <th className="px-4 py-2 font-medium">Severity</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {events.data.events.map((event) => (
                    <EventRow key={event.id} event={event} timeZone={settings.timeZone} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav aria-label="Pages" className="flex gap-4 border-t border-border px-4 py-3 text-xs">
            {before > 0 ? (
              <Link to={`/events${filterQuery ? `?${filterQuery}` : ""}`} className="font-medium text-brand hover:underline">
                Newest
              </Link>
            ) : null}
            {events.data.events.length === events.data.pageSize ? (
              <Link
                to={`/events?${filterQuery ? `${filterQuery}&` : ""}before=${events.data.events[events.data.events.length - 1]!.id}`}
                className="ml-auto font-medium text-brand hover:underline"
              >
                Older
              </Link>
            ) : null}
          </nav>
        </section>
      )}
    </main>
  );
}
```

**File: `ui/src/pages/NotFound.tsx`**

```tsx
import { Link } from "react-router";
import { useDocumentTitle } from "../useDocumentTitle";

export function NotFound() {
  useDocumentTitle("Not found");
  return (
    <main className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="text-sm text-text-muted">There is no page at this address.</p>
      <Link to="/" className="text-sm font-medium text-brand hover:underline">
        Go to the overview
      </Link>
    </main>
  );
}
```

**File: `ui/src/pages/SignedOut.tsx`**

```tsx
import { useConsole } from "../console";
import { useDocumentTitle } from "../useDocumentTitle";

export function SignedOut() {
  useDocumentTitle("Signed out");
  const { signIn } = useConsole();
  return (
    <main className="mx-auto max-w-md space-y-4 px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">You have signed out</h1>
      <p className="text-sm text-text-muted">This tab no longer holds a session for the console.</p>
      <button
        type="button"
        onClick={() => void signIn("/")}
        className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-surface hover:bg-brand-strong"
      >
        Sign in again
      </button>
    </main>
  );
}
```

**File: `ui/src/pages/SignInCallback.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { ErrorPanel } from "../components/ErrorPanel";
import { Loading } from "../components/Loading";
import { useConsole } from "../console";

/** The page the server returns to after sign-in. It is outside the hash router, on its own path. */
export function SignInCallback() {
  const { settings, completeSignIn } = useConsole();
  const [error, setError] = useState<string | null>(null);
  // The code can be exchanged once; StrictMode runs effects twice in development.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    completeSignIn(new URL(window.location.href)).then(
      (returnTo) => window.location.replace(`${settings.basePath}/#${returnTo}`),
      (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, [completeSignIn, settings.basePath]);

  return (
    <main className="mx-auto max-w-md space-y-4 px-6 py-16">
      {error ? (
        <>
          <ErrorPanel title="Sign-in did not finish" detail={error} />
          <a href={`${settings.basePath}/`} className="text-sm font-medium text-brand hover:underline">
            Start again
          </a>
        </>
      ) : (
        <Loading label="Finishing sign-in…" />
      )}
    </main>
  );
}
```

- [ ] **Step 2: Check the app**

Run: `npx next typegen && npx tsc --noEmit && npm run lint && npx vite build`
Expected: no type errors and no lint errors. Vite writes `ui-dist/index.html` with
`<base href="/" />`, the four placeholders, and relative `./assets/…` script and style URLs.

- [ ] **Step 3: Commit**

```bash
git add ui
git commit -m "feat(console): the web app: overview, conversations, threads and events"
```

---

### Task 9: Setup script registers the OAuth client and the web application

**Files:** Modify `scripts/server-setup.mjs`.

- [ ] **Step 1: Add the functions and the steps**

Add after `ensureWebhook` in `scripts/server-setup.mjs`; nothing else above `reloadSettings`
changes:

```js
/** Paths the server or its web admin already use. */
const RESERVED_PREFIXES = new Set([
  ".well-known", "account", "admin", "api", "auth", "authorize", "calendar", "card", "dav",
  "device", "healthz", "jmap", "login", "metrics", "mta-sts.txt", "oauth", "robots.txt",
]);

/** "/console/" → "console"; refuses a prefix the server or its web admin use. */
export function appPrefix(value) {
  const prefix = value.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(prefix) || RESERVED_PREFIXES.has(prefix)) {
    throw new Error(`${value} cannot be the console's path`);
  }
  return prefix;
}

/** A public client (no secret) whose only redirect URI is the console's callback. */
export async function ensureOAuthClient(client, { clientId, redirectUri, description }) {
  const responses = await client.call([
    ["x:OAuthClient/query", {}, "q"],
    ["x:OAuthClient/get", { "#ids": { resultOf: "q", name: "x:OAuthClient/query", path: "/ids" }, properties: ["clientId"] }, "g"],
  ]);
  const existing = responses[1][1].list.find((candidate) => candidate.clientId === clientId);
  const fields = { clientId, description, redirectUris: { [redirectUri]: true } };
  if (existing) {
    assertUpdated(await client.one("x:OAuthClient/set", { update: { [existing.id]: fields } }), existing.id, "the OAuth client");
    return { id: existing.id, created: false };
  }
  const result = await client.one("x:OAuthClient/set", { create: { c: fields } });
  return { id: createdId(result, "c", "the OAuth client"), created: true };
}

/** The bundle the console's api role serves now. */
export async function consoleBundle(consoleUrl) {
  const response = await fetch(`${consoleUrl.replace(/\/+$/, "")}/ui/manifest`);
  if (!response.ok) throw new Error(`the console's /ui/manifest answered HTTP ${response.status}`);
  const manifest = await response.json();
  if (typeof manifest.file !== "string" || !/^console-[A-Za-z0-9_-]{1,64}\.zip$/.test(manifest.file)) {
    throw new Error("the console's /ui/manifest names no bundle");
  }
  return manifest;
}

function prefixesOf(app) {
  return Object.keys(app.urlPrefix ?? {}).map((value) => value.trim().replace(/^\/+|\/+$/g, "").toLowerCase());
}

/**
 * Serves the bundle at /<prefix>. The server keeps one downloaded bundle per application record, so
 * a new bundle gets a new record: created first, then the old one is deleted. Only records that
 * serve nothing but this prefix are ever touched.
 */
export async function ensureApplication(client, { prefix, resourceUrl, description = "inWorkspace Console" }) {
  const path = appPrefix(prefix);
  const responses = await client.call([
    ["x:Application/query", {}, "q"],
    [
      "x:Application/get",
      { "#ids": { resultOf: "q", name: "x:Application/query", path: "/ids" }, properties: ["urlPrefix", "resourceUrl", "enabled"] },
      "g",
    ],
  ]);
  const mine = responses[1][1].list.filter((app) => prefixesOf(app).includes(path));
  if (mine.some((app) => prefixesOf(app).some((other) => other !== path))) {
    throw new Error(`another web application also serves /${path}; remove /${path} from it first`);
  }
  if (mine.length === 1 && mine[0].resourceUrl === resourceUrl && mine[0].enabled) {
    return { id: mine[0].id, created: false, removed: 0 };
  }
  const result = await client.one("x:Application/set", {
    create: { a: { description, urlPrefix: { [`/${path}`]: true }, resourceUrl, enabled: true } },
  });
  const id = createdId(result, "a", "the web application");
  if (mine.length > 0) {
    const destroyed = await client.one("x:Application/set", { destroy: mine.map((app) => app.id) });
    if (destroyed.notDestroyed && Object.keys(destroyed.notDestroyed).length > 0) {
      throw new Error(`could not remove the previous web application: ${JSON.stringify(destroyed.notDestroyed)}`);
    }
  }
  return { id, created: true, removed: mine.length };
}
```

Replace `main()` with:

```js
async function main() {
  const serverUrl = required("SERVER_URL").replace(/\/+$/, "");
  const client = new RegistryClient(serverUrl, required("SERVER_ADMIN_USER"), required("SERVER_ADMIN_SECRET"));
  const principal = await ensurePrincipal(client, {
    address: required("CONSOLE_PRINCIPAL"),
    secret: required("CONSOLE_PRINCIPAL_SECRET"),
  });
  console.log(`console principal ${principal.created ? "created" : "updated"} (id ${principal.id})`);
  const webhook = await ensureWebhook(client, { url: required("WEBHOOK_URL"), signingKey: required("WEBHOOK_SIGNING_KEY") });
  console.log(`webhook ${webhook.created ? "created" : "updated"} (id ${webhook.id}, ${eventTypes.subscribed.length} event types)`);

  const path = appPrefix(process.env.CONSOLE_PATH ?? "console");
  const clientId = process.env.OAUTH_CLIENT_ID?.trim() || "inworkspace-console";
  const redirectUri = `${serverUrl}/${path}/oauth/callback`;
  const oauthClient = await ensureOAuthClient(client, { clientId, redirectUri, description: "inWorkspace Console" });
  console.log(`OAuth client ${clientId} ${oauthClient.created ? "created" : "updated"} (redirect ${redirectUri})`);

  const consoleUrl = required("CONSOLE_URL");
  const manifest = await consoleBundle(consoleUrl);
  const fetchBase = (process.env.CONSOLE_FETCH_URL?.trim() || consoleUrl).replace(/\/+$/, "");
  const app = await ensureApplication(client, { prefix: path, resourceUrl: `${fetchBase}/ui/${manifest.file}` });
  console.log(
    app.created
      ? `web application /${path} now serves bundle ${manifest.version}${app.removed ? ` (${app.removed} previous record removed)` : ""}`
      : `web application /${path} already serves bundle ${manifest.version}`,
  );

  const reload = await reloadSettings(client);
  console.log(reload.reloaded ? "settings reloaded" : `settings not reloaded (${reload.reason}); restart the server to activate the webhook`);
}
```

- [ ] **Step 2: Check the syntax**

Run: `node --check scripts/server-setup.mjs`
Expected: no output. The behaviour is exercised end to end in Task 10.

- [ ] **Step 3: Commit**

```bash
git add scripts/server-setup.mjs
git commit -m "feat(console): setup registers the OAuth client and the web application"
```

---

### Task 10: Image and end-to-end run

**Files:** Modify `Dockerfile`, `e2e/run.mjs`.

- [ ] **Step 1: Ship the built web app in the image**

**File: `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=8080
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/ui-dist ./ui-dist
USER node
EXPOSE 8080
CMD ["node", "server.js"]
```

- [ ] **Step 2: Rewrite the end-to-end run**

**File: `e2e/run.mjs`**

```js
#!/usr/bin/env node
// End-to-end run: a real inWorkspace server and Postgres in Docker, the console built from this
// directory, real mail over SMTP, an agent reply over JMAP, and sign-in through the server's own
// OAuth endpoints. Run `npm run build` first. `node e2e/run.mjs --keep` leaves everything running.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import {
  RegistryClient,
  consoleBundle,
  ensureAccount,
  ensureApplication,
  ensureOAuthClient,
  ensurePrincipal,
  ensureWebhook,
  reloadSettings,
} from "../scripts/server-setup.mjs";
import { sendMail } from "./smtp.mjs";

const keep = process.argv.includes("--keep");
const root = new URL("..", import.meta.url).pathname;
const compose = ["compose", "-f", new URL("./compose.yaml", import.meta.url).pathname];
const SERVER = "http://localhost:18080";
const PORT = 3100;
const CONSOLE = `http://localhost:${PORT}`;
/** How the mail server, inside Docker, reaches the console on this machine. */
const CONSOLE_FROM_SERVER = `http://host.docker.internal:${PORT}`;
const DATABASE_URL = "postgres://console:console@localhost:15432/console";
const DOMAIN = "agents.example.test";
const AGENT = `a21i3v9v@${DOMAIN}`;
const GUEST = "jane@example.com";
const CLIENT_ID = "inworkspace-console";
const REDIRECT_URI = `${SERVER}/console/oauth/callback`;
const secret = () => randomBytes(24).toString("hex");
const adminSecret = secret();
const principalSecret = secret();
const runtimeSecret = secret();
const viewerSecret = secret();
const signingKey = secret();

function docker(args, env = {}) {
  execFileSync("docker", [...compose, ...args], { stdio: "inherit", env: { ...process.env, E2E_ADMIN_SECRET: adminSecret, ...env } });
}

async function waitFor(what, check, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

function expect(condition, what) {
  if (!condition) throw new Error(`expected: ${what}`);
  console.log(`  ✓ ${what}`);
}

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function jmapAs(username, password, using, methodCalls) {
  const response = await fetch(`${SERVER}/jmap/`, {
    method: "POST",
    headers: { Authorization: basic(username, password), "Content-Type": "application/json" },
    body: JSON.stringify({ using, methodCalls }),
  });
  if (!response.ok) throw new Error(`JMAP HTTP ${response.status}`);
  return (await response.json()).methodResponses;
}

/** What the web app does, without the browser: the server's sign-in API, then its token endpoint. */
async function signIn(accountName, accountSecret) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const login = await fetch(`${SERVER}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "authCode",
      accountName,
      accountSecret,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "openid offline_access",
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256",
      state,
    }),
  });
  const answer = await login.json().catch(() => ({}));
  if (!login.ok || answer.type !== "authenticated") throw new Error(`signing in as ${accountName} failed: ${JSON.stringify(answer)}`);
  const exchange = await fetch(`${SERVER}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: answer.clientCode, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: verifier }),
  });
  const tokens = await exchange.json().catch(() => ({}));
  if (!exchange.ok || typeof tokens.access_token !== "string") throw new Error(`the token exchange for ${accountName} failed: ${JSON.stringify(tokens)}`);
  return tokens;
}

function api(path, { token, origin = SERVER, method = "GET", headers = {} } = {}) {
  return fetch(`${CONSOLE}/api/v1/${path}`, {
    method,
    headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  });
}

async function apiJson(path, token) {
  const response = await api(path, { token });
  const body = await response.json();
  if (!response.ok) throw new Error(`GET /api/v1/${path} answered ${response.status}: ${JSON.stringify(body)}`);
  return { response, body };
}

let consoleProcess;
try {
  step("Starting a fresh inWorkspace server and Postgres");
  docker(["down", "-v", "--remove-orphans"]);
  docker(["up", "-d"]);
  await waitFor("the mail server", async () => (await fetch(`${SERVER}/healthz/live`)).ok);
  const admin = new RegistryClient(SERVER, "admin", adminSecret);

  step("Creating the agent domain, two agents, an agent runtime, a plain user, the console principal and the webhook");
  await admin.one("x:Domain/set", { create: { d: { name: DOMAIN } } });
  await ensureAccount(admin, { address: AGENT, description: "Front desk agent" });
  await ensureAccount(admin, { address: `a000001e@${DOMAIN}`, description: "Concierge agent" });
  await ensureAccount(admin, {
    address: `runtime@${DOMAIN}`,
    description: "Agent runtime",
    secret: runtimeSecret,
    permissions: { "@type": "Merge", enabledPermissions: { impersonate: true }, disabledPermissions: {} },
  });
  await ensureAccount(admin, { address: `viewer@${DOMAIN}`, description: "Plain user", secret: viewerSecret });
  await ensurePrincipal(admin, { address: `console@${DOMAIN}`, secret: principalSecret });
  await ensureWebhook(admin, { url: `${CONSOLE_FROM_SERVER}/api/ingest/events`, signingKey });
  const reload = await reloadSettings(admin);
  if (!reload.reloaded) {
    console.log(`  settings reload refused (${reload.reason.slice(0, 120)}…); restarting the server`);
    docker(["restart", "stalwart"]);
    await waitFor("the mail server after restart", async () => (await fetch(`${SERVER}/healthz/live`)).ok);
  }

  step("Starting the console (api and ingest roles in one process)");
  if (!existsSync(`${root}.next/standalone/server.js`) || !existsSync(`${root}ui-dist/index.html`)) throw new Error("run `npm run build` first");
  cpSync(`${root}.next/static`, `${root}.next/standalone/.next/static`, { recursive: true });
  rmSync(`${root}.next/standalone/ui-dist`, { recursive: true, force: true });
  cpSync(`${root}ui-dist`, `${root}.next/standalone/ui-dist`, { recursive: true });
  consoleProcess = spawn("node", [`${root}.next/standalone/server.js`], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      PORT: String(PORT),
      HOSTNAME: "0.0.0.0",
      CONSOLE_ROLE: "all",
      DATABASE_URL,
      WEBHOOK_SIGNING_KEY: signingKey,
      JMAP_URL: SERVER,
      JMAP_PRINCIPAL: `console@${DOMAIN}`,
      JMAP_PRINCIPAL_SECRET: principalSecret,
      AGENT_DOMAINS: DOMAIN,
      AGENT_LOCALPART_PATTERN: "a[0-9a-z]{7}",
      PUBLIC_URL: CONSOLE,
    },
  });
  await waitFor("the console", async () => (await fetch(`${CONSOLE}/healthz`)).ok);

  step("Registering the OAuth client and the web application at the server");
  await ensureOAuthClient(admin, { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, description: "inWorkspace Console" });
  const manifest = await consoleBundle(CONSOLE);
  const resourceUrl = `${CONSOLE_FROM_SERVER}/ui/${manifest.file}`;
  const app = await ensureApplication(admin, { prefix: "/console/", resourceUrl });
  expect(app.created, `a web application record for bundle ${manifest.version} was created`);
  const page = await waitFor("the server to serve the web app", async () => {
    const response = await fetch(`${SERVER}/console/`);
    const html = await response.text();
    return response.ok && html.includes('name="inworkspace-console-api"') ? html : null;
  });
  expect(page.includes('<base href="/console/"'), "the server serves the web app at /console, with its base path");
  expect(page.includes(`content="${CONSOLE}"`), "the page names the console API");
  const script = /src="([^"]+\.js)"/.exec(page)?.[1];
  const asset = script ? await fetch(new URL(script, `${SERVER}/console/`)) : null;
  expect(asset?.ok && asset.headers.get("content-type")?.includes("javascript"), "the server serves the app's script");
  const deepLink = await fetch(`${SERVER}/console/oauth/callback?code=x&state=y`);
  expect(deepLink.ok && (await deepLink.text()).includes('name="inworkspace-console-api"'), "the server serves the app on its callback path");
  const again = await ensureApplication(admin, { prefix: "console", resourceUrl });
  expect(!again.created, "registering the same bundle again changes nothing");

  step("Sending a guest message, a message to a mailbox that does not exist, and an agent reply");
  const inbound = await sendMail({
    host: "localhost",
    port: 12525,
    from: GUEST,
    to: AGENT,
    data: [
      `From: Jane Guest <${GUEST}>`,
      `To: ${AGENT}`,
      "Subject: Late check-in on Friday?",
      "Message-ID: <e2e-1@example.com>",
      `Date: ${new Date().toUTCString()}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hi, can I check in at 11pm on Friday? Thanks, Jane",
    ].join("\n"),
  });
  if (!inbound.accepted) throw new Error(`the guest message was refused: ${inbound.reply}`);
  const refused = await sendMail({ host: "localhost", port: 12525, from: GUEST, to: `ghost@${DOMAIN}`, data: "Subject: hello\n\nanyone?" });
  if (refused.accepted) throw new Error("mail to a missing mailbox was accepted");

  const runtimeLogin = `${AGENT}%runtime@${DOMAIN}`;
  const mailUsing = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
  const session = await (await fetch(`${SERVER}/jmap/session`, { headers: { Authorization: basic(runtimeLogin, runtimeSecret) } })).json();
  const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
  const inboundEmail = await waitFor("the guest message in the mailbox", async () => {
    const [[, mailboxes], , [, emails], [, identities]] = await jmapAs(runtimeLogin, runtimeSecret, mailUsing, [
      ["Mailbox/get", { accountId, ids: null, properties: ["role"] }, "m"],
      ["Email/query", { accountId, sort: [{ property: "receivedAt", isAscending: false }], limit: 20 }, "q"],
      ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["threadId", "messageId"] }, "g"],
      ["Identity/get", { accountId }, "i"],
    ]);
    const email = emails.list.find((candidate) => candidate.messageId?.includes("e2e-1@example.com"));
    return email && { ...email, sent: mailboxes.list.find((mailbox) => mailbox.role === "sent").id, identity: identities.list[0]?.id };
  });
  const [[, created], [, submitted]] = await jmapAs(runtimeLogin, runtimeSecret, mailUsing, [
    [
      "Email/set",
      {
        accountId,
        create: {
          r: {
            mailboxIds: { [inboundEmail.sent]: true },
            keywords: { $seen: true },
            from: [{ name: "Front desk agent", email: AGENT }],
            to: [{ name: "Jane Guest", email: GUEST }],
            subject: "Re: Late check-in on Friday?",
            inReplyTo: ["e2e-1@example.com"],
            references: ["e2e-1@example.com"],
            bodyValues: { t: { value: "Hi Jane, yes - late check-in at 11pm is fine. The night desk will have your key." } },
            textBody: [{ partId: "t", type: "text/plain" }],
          },
        },
      },
      "e",
    ],
    [
      "EmailSubmission/set",
      {
        accountId,
        create: { s: { emailId: "#r", identityId: inboundEmail.identity, envelope: { mailFrom: { email: AGENT }, rcptTo: [{ email: GUEST }] } } },
      },
      "x",
    ],
  ]);
  if (!created.created?.r || !submitted.created?.s) throw new Error(`the agent reply failed: ${JSON.stringify([created, submitted])}`);

  step("Waiting for the server's events in Postgres");
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const expected = ["queue.authenticated-message-queued", "delivery.dsn-perm-fail", "smtp.mailbox-does-not-exist"];
  const types = await waitFor("the expected events", async () => {
    const { rows } = await db.query("select distinct type from events");
    const seen = rows.map((row) => row.type);
    const ingested = seen.some((type) => type.startsWith("message-ingest."));
    return ingested && expected.every((type) => seen.includes(type)) ? seen : null;
  });
  await db.end();
  console.log(`  ✓ ${types.length} event types stored: ${types.sort().join(", ")}`);

  step("Signing in as the server's administrator and reading through the API");
  const adminTokens = await signIn("admin", adminSecret);
  const token = adminTokens.access_token;
  const me = await apiJson("me", token);
  expect(me.body.login === "admin", "the API knows the operator as admin");
  expect(me.response.headers.get("access-control-allow-origin") === SERVER, "the API allows the server's origin");
  const overview = (await apiJson("overview", token)).body;
  expect(
    ["Front desk agent", "Concierge agent"].every((name) => overview.agents?.some((agent) => agent.name === name)),
    "the overview lists both agents",
  );
  expect(overview.totals.repliesSent >= 1, "the overview counts the agent's reply");
  const agentPath = `agents/${encodeURIComponent(AGENT)}/threads`;
  const thread = (await apiJson(agentPath, token)).body.threads.find((candidate) => candidate.subject === "Late check-in on Friday?");
  expect(thread?.status === "answered", "the conversation is listed as answered");
  const messages = (await apiJson(`${agentPath}/${thread.threadId}`, token)).body.messages;
  expect(
    messages.some((message) => message.direction === "inbound" && message.text.includes("Hi, can I check in at 11pm on Friday?")) &&
      messages.some((message) => message.direction === "outbound" && message.text.includes("The night desk will have your key.")),
    "the thread has the guest's message and the agent's reply",
  );
  const events = (await apiJson("events?type=delivery.", token)).body.events;
  expect(events.some((event) => event.type === "delivery.dsn-perm-fail" && JSON.stringify(event.data).includes("null MX")), "the events include the bounce");
  const live = (await apiJson("events?after=0", token)).body;
  expect(live.events.length > 0 && live.pageSize === 200, "live mode returns events after an id");
  const outside = await api(`agents/${encodeURIComponent(`runtime@${DOMAIN}`)}/threads`, { token });
  expect(outside.status === 404, "a mailbox outside the agent directory is not opened");

  step("Checking what the API refuses");
  expect((await api("me")).status === 401, "a request without a token gets 401");
  expect((await api("me", { token: "bm90LWEtcmVhbC10b2tlbg" })).status === 401, "an invalid token gets 401");
  const viewer = await signIn(`viewer@${DOMAIN}`, viewerSecret);
  const forbidden = await api("me", { token: viewer.access_token });
  expect(forbidden.status === 403 && (await forbidden.json()).error.message.includes("impersonate"), "an account without the impersonate permission gets 403");
  const preflightHeaders = { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" };
  const preflight = await api("me", { method: "OPTIONS", headers: preflightHeaders });
  expect(preflight.status === 204 && preflight.headers.get("access-control-allow-origin") === SERVER, "a preflight from the server's origin is allowed");
  const foreign = await api("me", { method: "OPTIONS", origin: "https://attacker.example", headers: preflightHeaders });
  expect(foreign.status === 403 && !foreign.headers.get("access-control-allow-origin"), "a preflight from another origin is refused");
  const refreshed = await fetch(`${SERVER}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: adminTokens.refresh_token, client_id: CLIENT_ID }),
  });
  const renewed = await refreshed.json();
  expect(refreshed.ok && (await api("me", { token: renewed.access_token })).status === 200, "a refreshed access token works");
  const unsigned = await fetch(`${CONSOLE}/api/ingest/events`, { method: "POST", body: '{"events":[]}' });
  expect(unsigned.status === 401, "an unsigned webhook post is refused with 401");

  console.log("\nEnd-to-end run passed.");
  if (keep) {
    console.log(`Console: ${SERVER}/console/ — sign in as admin with the throwaway password ${adminSecret}`);
    console.log("Ctrl-C stops the console; the containers keep running until `docker compose -f e2e/compose.yaml down -v`.");
    await new Promise(() => {});
  }
} finally {
  if (!keep) {
    consoleProcess?.kill();
    docker(["down", "-v", "--remove-orphans"]);
  }
}
```

- [ ] **Step 3: Run it**

Run: `npm run build && npm run e2e`
Expected: every step passes; ends with `End-to-end run passed.`

- [ ] **Step 4: Commit**

```bash
git add Dockerfile e2e/run.mjs
git commit -m "test(console): end-to-end run signs in through the server and reads through the API"
```

---

### Task 11: Documentation

**Files:** Modify `README.md`.

- [ ] **Step 1: Update the README**

Rewrite these sections to match the revised design:
- **How it works:** the new diagram and roles (`api`, `ingest`, `all`), and the web app served
  by the server.
- **Configuration:** the table from the design.
- **Server setup:** the new variables `CONSOLE_URL`, `CONSOLE_FETCH_URL`, `CONSOLE_PATH` and
  `OAUTH_CLIENT_ID`, and steps 3 and 4.
- **Development:** `npm run dev` plus `npm run dev:ui`, and `node e2e/run.mjs --keep` with the
  printed admin password.
- **Tests:** the table.
- **Deployment:** a public api service, then run the setup script after each deploy.
- **Access:** sign-in at the server.
- **Security notes:** token verification, the permission, CORS, sessionStorage and the 60-second
  cache.

Remove every mention of IAP, `cloud-run` mode and `gcloud run services proxy`.

- [ ] **Step 2: Commit**

```bash
git add README.md docs/design.md docs/plan-server-hosted.md
git commit -m "docs(console): the console served by the mail server, with its sign-in"
```

---

### Task 12: Verification and review

- [ ] **Step 1: Run everything CI runs**

Run: `npm ci && npm run lint && npm run typecheck && npm test && TEST_DATABASE_URL=… npm run test:integration && npm run build && npm run e2e`
Expected: all pass.

- [ ] **Step 2: Request a code review** (superpowers:requesting-code-review) of the branch
  against `origin/main`, then fix what it finds and re-run Step 1.

- [ ] **Step 3: Open the PR**, linked to issue #8, and get CI green.

## Self-review

- **Spec coverage:**

  | Spec section | Task |
  | --- | --- |
  | Architecture, roles | 6 |
  | Web app | 7, 8 |
  | API endpoints and errors | 4, 6 |
  | Sign-in and access control: the token rules | 3 |
  | Sign-in and access control: CORS | 4 |
  | Sign-in and access control: the page's CSP | 5 |
  | Sign-in and access control: sessionStorage | 7 |
  | Configuration | 2 |
  | Server setup, steps 3 and 4 | 9 |
  | Error handling | 4, 7, 8 |
  | Testing | 2–5, 7, 10 |
  | Deployment | 10, 11 |

- **Types:**
  - `OverviewResponse.totals` is used the same way in the route (Task 6), the page (Task 8)
    and the e2e run (Task 10).
  - `ApiGet`, `SessionEnvironment` and `Store` have the same signatures in `api.ts`,
    `session.ts` and `console.tsx`.
  - `BUNDLE_FILE` and the manifest's `file` match the setup script's pattern.
- **Placeholders:** none. Task 11 describes the README changes rather than giving them in full,
  because they repeat the design text.
