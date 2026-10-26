import { describe, expect, it, vi } from "vitest";
import { decodeServerId, fetchMailboxes, isListedAddress, type DirectorySettings } from "./directory";
import { JMAP_CORE, JmapError, type Invocation, type JmapSession } from "./jmap";

describe("decodeServerId", () => {
  it("decodes the server's base32 ids into the numbers its events carry", () => {
    expect(decodeServerId("a")).toBe(0);
    expect(decodeServerId("b")).toBe(1);
    expect(decodeServerId("ba")).toBe(32);
    expect(decodeServerId("3")).toBe(31);
    expect(decodeServerId("")).toBeNull();
    expect(decodeServerId("B")).toBeNull();
    expect(decodeServerId("zzzzzzzzzzzz")).toBeNull();
  });
});

const SETTINGS: DirectorySettings = {
  mailboxDomains: [],
  mailboxLocalpartPattern: null,
  principal: "console@example.test",
};

describe("isListedAddress", () => {
  it("lists every address but the principal's, in every domain unless domains are named", () => {
    expect(isListedAddress("Alex@Example.test", SETTINGS)).toBe(true);
    expect(isListedAddress("a21i3v9v@agents.example.test", SETTINGS)).toBe(true);
    expect(isListedAddress("console@example.test", SETTINGS)).toBe(false);
    expect(isListedAddress("not-an-address", SETTINGS)).toBe(false);
    const named = { ...SETTINGS, mailboxDomains: ["example.test"] };
    expect(isListedAddress("alex@example.test", named)).toBe(true);
    expect(isListedAddress("alex@other.example.test", named)).toBe(false);
    const patterned = { ...SETTINGS, mailboxLocalpartPattern: /^(?:a[0-9a-z]{7})$/ };
    expect(isListedAddress("a21i3v9v@example.test", patterned)).toBe(true);
    expect(isListedAddress("alex@example.test", patterned)).toBe(false);
  });
});

interface FakeAccount {
  id: string;
  name: string;
  description: string | null;
  "@type": string;
}

/** A registry that answers one call per request, as the directory sends them, and refuses gets over its limit. */
function fakeRegistry(domains: { id: string; name: string }[], accounts: Record<string, FakeAccount[]>, maxObjectsInGet?: number) {
  const gets: string[][] = [];
  const queriedDomains: string[] = [];
  const call = vi.fn(async (_credentials: unknown, _using: unknown, calls: readonly Invocation[]): Promise<Invocation[]> => {
    expect(calls).toHaveLength(1);
    const [method, args, id] = calls[0]!;
    if (method === "x:Domain/query") return [[method, { ids: domains.map((domain) => domain.id) }, id]];
    if (method === "x:Account/query") {
      const domainId = (args as { filter: { domainId: string } }).filter.domainId;
      queriedDomains.push(domainId);
      return [[method, { ids: (accounts[domainId] ?? []).map((account) => account.id) }, id]];
    }
    const ids = (args as { ids: string[] }).ids;
    if (ids.length > (maxObjectsInGet ?? 500)) throw new JmapError("requestTooLarge", "requestTooLarge");
    gets.push(ids);
    const objects: { id: string }[] = method === "x:Domain/get" ? domains : Object.values(accounts).flat();
    return [[method, { list: objects.filter((object) => ids.includes(object.id)) }, id]];
  });
  const session = vi.fn(async (): Promise<JmapSession> => ({
    username: "console@example.test",
    apiUrl: "https://mail.example.test/jmap/",
    primaryAccounts: {},
    capabilities: maxObjectsInGet === undefined ? {} : { [JMAP_CORE]: { maxObjectsInGet } },
  }));
  return { client: { call, session }, gets, queriedDomains };
}

const CREDENTIALS = { username: "console@example.test", password: "x" };

describe("fetchMailboxes", () => {
  it("lists the user accounts of every domain, with their descriptions as names", async () => {
    const { client } = fakeRegistry(
      [
        { id: "a", name: "example.test" },
        { id: "b", name: "Agents.Example.test" },
      ],
      {
        a: [
          { id: "d", name: "console", description: "Oversight console", "@type": "User" },
          { id: "e", name: "alex", description: " Alex Example ", "@type": "User" },
          { id: "f", name: "team", description: "Team", "@type": "Group" },
        ],
        b: [{ id: "b", name: "a21i3v9v", description: null, "@type": "User" }],
      },
    );
    expect(await fetchMailboxes(client, CREDENTIALS, SETTINGS)).toEqual({
      mailboxes: [
        { address: "a21i3v9v@agents.example.test", name: null, accountId: 1 },
        { address: "alex@example.test", name: "Alex Example", accountId: 4 },
      ],
      domains: ["agents.example.test", "example.test"],
    });
  });

  it("reads a domain larger than one get allows in several gets", async () => {
    const people = ["ann", "bob", "cat", "dan", "eve"].map((name, index) => ({ id: `b${"abcde"[index]}`, name, description: null, "@type": "User" }));
    const { client, gets } = fakeRegistry([{ id: "a", name: "example.test" }], { a: people }, 2);
    const directory = await fetchMailboxes(client, CREDENTIALS, SETTINGS);
    expect(directory.mailboxes.map((mailbox) => mailbox.address)).toEqual(people.map((person) => `${person.name}@example.test`));
    expect(gets.map((ids) => ids.length)).toEqual([1, 2, 2, 1]);
  });

  it("asks only for the named domains", async () => {
    const { client, queriedDomains } = fakeRegistry(
      [
        { id: "a", name: "example.test" },
        { id: "b", name: "other.example.test" },
      ],
      {},
    );
    const directory = await fetchMailboxes(client, CREDENTIALS, { ...SETTINGS, mailboxDomains: ["other.example.test"] });
    expect(directory).toEqual({ mailboxes: [], domains: ["other.example.test"] });
    expect(queriedDomains).toEqual(["b"]);
  });
});
