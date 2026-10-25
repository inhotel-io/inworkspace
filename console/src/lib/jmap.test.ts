import { describe, expect, it, vi } from "vitest";
import { JMAP_CORE, JMAP_MAIL, JmapClient, JmapError, masterUserLogin, responseOf } from "./jmap";

const CREDENTIALS = { username: "a21i3v9v@agents.example.test%console@agents.example.test", password: "secret" };
const SESSION = { username: "a21i3v9v@agents.example.test", apiUrl: "https://mail.internal:8443/jmap/", primaryAccounts: { [JMAP_MAIL]: "b" } };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("JmapClient", () => {
  it("authenticates with Basic auth, caches the session and posts to the API path on the configured origin", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/jmap/session")) return json(SESSION);
      return json({ methodResponses: [["Mailbox/get", { list: [] }, "m"]], sessionState: "s" });
    });
    const client = new JmapClient("https://mail.example.com", fetchImpl);
    await client.call(CREDENTIALS, [JMAP_CORE, JMAP_MAIL], [["Mailbox/get", { accountId: "b", ids: null }, "m"]]);
    await client.call(CREDENTIALS, [JMAP_CORE, JMAP_MAIL], [["Mailbox/get", { accountId: "b", ids: null }, "m"]]);
    const urls = fetchImpl.mock.calls.map(([input]) => String(input));
    expect(urls).toEqual(["https://mail.example.com/jmap/session", "https://mail.example.com/jmap/", "https://mail.example.com/jmap/"]);
    const headers = new Headers(fetchImpl.mock.calls[0]![1]!.headers);
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from(`${CREDENTIALS.username}:secret`).toString("base64")}`);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body))).toEqual({
      using: [JMAP_CORE, JMAP_MAIL],
      methodCalls: [["Mailbox/get", { accountId: "b", ids: null }, "m"]],
    });
  });

  it("refuses any method outside the read-only allow-list before making a request", async () => {
    const fetchImpl = vi.fn();
    const client = new JmapClient("https://mail.example.com", fetchImpl);
    for (const name of ["Email/set", "EmailSubmission/set", "x:Account/set", "Mailbox/set"]) {
      await expect(client.call(CREDENTIALS, [JMAP_CORE], [[name, {}, "0"]])).rejects.toMatchObject({ type: "forbiddenMethod" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns HTTP failures and method errors into JmapError", async () => {
    const unauthorized = new JmapClient("https://mail.example.com", vi.fn(async () => json({}, 401)));
    await expect(unauthorized.session(CREDENTIALS)).rejects.toMatchObject({ type: "unauthorized", status: 401 });

    const failing = new JmapClient(
      "https://mail.example.com",
      vi.fn(async (input: string | URL) =>
        String(input).endsWith("/session") ? json(SESSION) : json({ methodResponses: [["error", { type: "forbidden", description: "no access" }, "0"]] }),
      ),
    );
    const error = await failing.call(CREDENTIALS, [JMAP_CORE], [["Email/get", {}, "0"]]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JmapError);
    expect(error).toMatchObject({ type: "forbidden", message: "forbidden: no access" });
  });

  it("reports an unreachable server", async () => {
    const client = new JmapClient("https://mail.example.com", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(client.session(CREDENTIALS)).rejects.toMatchObject({ type: "network" });
  });

  it("builds master-user logins and finds responses by call id", () => {
    expect(masterUserLogin("a@agents.example.test", "console@agents.example.test")).toBe("a@agents.example.test%console@agents.example.test");
    expect(responseOf([["Email/get", { list: [1] }, "g"]], "g")).toEqual({ list: [1] });
    expect(() => responseOf([], "g")).toThrow(JmapError);
  });
});
