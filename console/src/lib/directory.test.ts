import { describe, expect, it, vi } from "vitest";
import { decodeServerId, fetchMailboxes, isListedAddress, type DirectorySettings } from "./directory";
import type { Invocation } from "./jmap";

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

describe("fetchMailboxes", () => {
  it("lists the user accounts of every domain, with their descriptions as names", async () => {
    const call = vi.fn(async (_credentials: unknown, _using: unknown, calls: readonly Invocation[]): Promise<Invocation[]> => {
      if (calls[0]![0] === "x:Domain/query") {
        return [
          ["x:Domain/query", { ids: ["a", "b"] }, "dq"],
          ["x:Domain/get", { list: [{ id: "a", name: "example.test" }, { id: "b", name: "Agents.Example.test" }] }, "dg"],
        ];
      }
      const domainId = (calls[0]![1] as { filter: { domainId: string } }).filter.domainId;
      const list =
        domainId === "a"
          ? [
              { id: "d", name: "console", description: "Oversight console", "@type": "User" },
              { id: "e", name: "alex", description: " Alex Example ", "@type": "User" },
              { id: "f", name: "team", description: "Team", "@type": "Group" },
            ]
          : [{ id: "b", name: "a21i3v9v", description: null, "@type": "User" }];
      return [
        ["x:Account/query", { ids: list.map((account) => account.id) }, "aq"],
        ["x:Account/get", { list }, "ag"],
      ];
    });
    const directory = await fetchMailboxes({ call }, { username: "console@example.test", password: "x" }, SETTINGS);
    expect(directory).toEqual({
      mailboxes: [
        { address: "a21i3v9v@agents.example.test", name: null, accountId: 1 },
        { address: "alex@example.test", name: "Alex Example", accountId: 4 },
      ],
      domains: ["agents.example.test", "example.test"],
    });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("asks only for the named domains", async () => {
    const call = vi.fn(async (_credentials: unknown, _using: unknown, calls: readonly Invocation[]): Promise<Invocation[]> => {
      if (calls[0]![0] === "x:Domain/query") {
        return [
          ["x:Domain/query", { ids: ["a", "b"] }, "dq"],
          ["x:Domain/get", { list: [{ id: "a", name: "example.test" }, { id: "b", name: "other.example.test" }] }, "dg"],
        ];
      }
      expect(calls[0]![1]).toEqual({ filter: { domainId: "b" } });
      return [
        ["x:Account/query", { ids: [] }, "aq"],
        ["x:Account/get", { list: [] }, "ag"],
      ];
    });
    const directory = await fetchMailboxes({ call }, { username: "console@example.test", password: "x" }, { ...SETTINGS, mailboxDomains: ["other.example.test"] });
    expect(directory).toEqual({ mailboxes: [], domains: ["other.example.test"] });
  });
});
