import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Credentials, Invocation, JmapSession } from "./jmap";
import { getThread, listThreads } from "./mailbox";

const fixture = JSON.parse(readFileSync(new URL("./__fixtures__/jmap-mailbox.json", import.meta.url), "utf8"));
const AGENT = "a21i3v9v@agents.example.test";
const PRINCIPAL: Credentials = { username: "console@agents.example.test", password: "secret" };

function fakeClient(answer: (calls: readonly Invocation[]) => Invocation[]) {
  return {
    session: vi.fn(async (_credentials: Credentials): Promise<JmapSession> => ({
      username: AGENT,
      apiUrl: "https://mail.example.com/jmap/",
      primaryAccounts: { "urn:ietf:params:jmap:mail": "b" },
    })),
    call: vi.fn(async (_credentials: Credentials, _using: readonly string[], calls: readonly Invocation[]) => answer(calls)),
  };
}

describe("listThreads", () => {
  it("logs in as the agent, hides Trash and Drafts, and keeps the query order", async () => {
    const client = fakeClient((calls) => {
      if (calls[0]![0] === "Mailbox/get") return [["Mailbox/get", { list: fixture.mailboxes }, "m"]];
      return [
        ["Email/query", { ids: ["maaaaah", "baaaaaai", "yaaaaag", "eaaaaaf"], total: 4 }, "q"],
        ["Email/get", { list: [...fixture.latest].reverse() }, "g"],
        ["Thread/get", { list: fixture.threads }, "t"],
      ];
    });
    const page = await listThreads(client, PRINCIPAL, AGENT, 0);
    expect(client.session).toHaveBeenCalledWith({ username: `${AGENT}%console@agents.example.test`, password: "secret" });
    const query = client.call.mock.calls[1]![2][0]!;
    expect(query[1]).toMatchObject({ accountId: "b", filter: { inMailboxOtherThan: ["b", "d"] }, collapseThreads: true, position: 0, limit: 50 });
    expect(page.total).toBe(4);
    expect(page.threads.map((thread) => thread.threadId)).toEqual(["d", "i", "g", "b"]);
  });
});

describe("getThread", () => {
  it("returns the thread's messages, or null for an unknown thread", async () => {
    const found = fakeClient((calls) =>
      calls[0]![0] === "Mailbox/get"
        ? [["Mailbox/get", { list: fixture.mailboxes }, "m"]]
        : [
            ["Thread/get", { list: [{ id: "b", emailIds: ["eaaaaab", "eaaaaac", "eaaaaaf"] }], notFound: [] }, "t"],
            ["Email/get", { list: fixture.thread }, "e"],
          ],
    );
    const messages = await getThread(found, PRINCIPAL, AGENT, "b");
    expect(messages?.map((message) => message.direction)).toEqual(["inbound", "outbound", "inbound"]);

    const missing = fakeClient((calls) =>
      calls[0]![0] === "Mailbox/get"
        ? [["Mailbox/get", { list: fixture.mailboxes }, "m"]]
        : [
            ["Thread/get", { list: [], notFound: ["zz"] }, "t"],
            ["Email/get", { list: [] }, "e"],
          ],
    );
    expect(await getThread(missing, PRINCIPAL, AGENT, "zz")).toBeNull();
  });
});
