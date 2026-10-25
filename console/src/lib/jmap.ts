export const JMAP_CORE = "urn:ietf:params:jmap:core";
export const JMAP_MAIL = "urn:ietf:params:jmap:mail";
export const STALWART_REGISTRY = "urn:stalwart:jmap";

/** The only methods the console sends. Anything else is refused before a request is made. */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "Mailbox/get",
  "Email/query",
  "Email/get",
  "Thread/get",
  "x:Domain/query",
  "x:Domain/get",
  "x:Account/query",
  "x:Account/get",
]);

export type Invocation = [name: string, args: Record<string, unknown>, callId: string];

export interface Credentials {
  username: string;
  password: string;
}

export interface JmapSession {
  username: string;
  apiUrl: string;
  primaryAccounts: Record<string, string>;
}

export class JmapError extends Error {
  constructor(
    message: string,
    readonly type: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JmapError";
  }
}

/** The server's master-user login: act as `mailbox` with the password of `principal`. */
export function masterUserLogin(mailbox: string, principal: string): string {
  return `${mailbox}%${principal}`;
}

export function responseOf(responses: readonly Invocation[], callId: string): Record<string, unknown> {
  const response = responses.find(([, , id]) => id === callId);
  if (!response) throw new JmapError(`the server sent no response for call ${callId}`, "missingResponse");
  return response[1];
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const SESSION_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export class JmapClient {
  private readonly sessions = new Map<string, { session: JmapSession; expiresAt: number }>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async session(credentials: Credentials): Promise<JmapSession> {
    const cached = this.sessions.get(credentials.username);
    if (cached && cached.expiresAt > this.now()) return cached.session;
    const session = (await this.request(credentials, new URL("/jmap/session", this.baseUrl), { method: "GET" })) as JmapSession;
    if (typeof session?.apiUrl !== "string" || typeof session.primaryAccounts !== "object") {
      throw new JmapError("the mail server returned an invalid session", "invalidSession");
    }
    this.sessions.set(credentials.username, { session, expiresAt: this.now() + SESSION_TTL_MS });
    return session;
  }

  async call(credentials: Credentials, using: readonly string[], calls: readonly Invocation[]): Promise<Invocation[]> {
    for (const [name] of calls) {
      if (!READ_ONLY_METHODS.has(name)) {
        throw new JmapError(`refusing to send ${name}: the console is read-only`, "forbiddenMethod");
      }
    }
    const session = await this.session(credentials);
    // The session advertises the server's public URL; keep its path but use the configured origin.
    const apiUrl = new URL(new URL(session.apiUrl).pathname, this.baseUrl);
    const body = (await this.request(credentials, apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ using, methodCalls: calls }),
    })) as { methodResponses?: Invocation[] };
    if (!Array.isArray(body?.methodResponses)) {
      throw new JmapError("the mail server returned no method responses", "invalidResponse");
    }
    for (const [name, args] of body.methodResponses) {
      if (name === "error") {
        const description = typeof args.description === "string" && args.description ? `: ${args.description}` : "";
        throw new JmapError(`${String(args.type)}${description}`, String(args.type));
      }
    }
    return body.methodResponses;
  }

  private async request(credentials: Credentials, url: URL, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: basicAuth(credentials) },
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new JmapError(`cannot reach the mail server: ${error instanceof Error ? error.message : String(error)}`, "network");
    }
    if (!response.ok) {
      if (response.status === 401) this.sessions.delete(credentials.username);
      throw new JmapError(
        `the mail server answered HTTP ${response.status}`,
        response.status === 401 ? "unauthorized" : "http",
        response.status,
      );
    }
    return response.json();
  }
}

function basicAuth(credentials: Credentials): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
}
