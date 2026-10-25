import { describe, expect, it, vi } from "vitest";
import { fetchAgents, isAgentAddress, type DirectorySettings } from "./directory";
import type { Invocation } from "./jmap";

const SETTINGS: DirectorySettings = {
  agentDomains: ["agents.example.test"],
  agentLocalpartPattern: /^(?:a[0-9a-z]{7})$/,
  principal: "console@agents.example.test",
};

describe("isAgentAddress", () => {
  it("matches the domain and local-part pattern and excludes the principal", () => {
    expect(isAgentAddress("A21I3V9V@agents.example.test", SETTINGS)).toBe(true);
    expect(isAgentAddress("runtime@agents.example.test", SETTINGS)).toBe(false);
    expect(isAgentAddress("a21i3v9v@other.example.test", SETTINGS)).toBe(false);
    expect(isAgentAddress("console@agents.example.test", { ...SETTINGS, agentLocalpartPattern: null })).toBe(false);
    expect(isAgentAddress("runtime@agents.example.test", { ...SETTINGS, agentLocalpartPattern: null })).toBe(true);
    expect(isAgentAddress("not-an-address", SETTINGS)).toBe(false);
  });
});

describe("fetchAgents", () => {
  it("lists user accounts in the agent domains with their descriptions as names", async () => {
    const call = vi.fn(async (_credentials: unknown, _using: unknown, calls: readonly Invocation[]): Promise<Invocation[]> => {
      if (calls[0]![0] === "x:Domain/query") {
        return [
          ["x:Domain/query", { ids: ["a", "b"] }, "dq"],
          ["x:Domain/get", { list: [{ id: "a", name: "example.test" }, { id: "b", name: "agents.example.test" }] }, "dg"],
        ];
      }
      expect(calls[0]![1]).toEqual({ filter: { domainId: "b" } });
      return [
        ["x:Account/query", { ids: ["d", "c", "b", "e", "f"] }, "aq"],
        [
          "x:Account/get",
          {
            list: [
              { id: "d", name: "console", description: "Oversight console", "@type": "User" },
              { id: "c", name: "a000001e", description: "Concierge agent", "@type": "User" },
              { id: "b", name: "a21i3v9v", description: " Front desk agent ", "@type": "User" },
              { id: "e", name: "a9999999", description: null, "@type": "Group" },
              { id: "f", name: "runtime", description: "Agent runtime", "@type": "User" },
            ],
          },
          "ag",
        ],
      ];
    });
    const agents = await fetchAgents({ call }, { username: "console@agents.example.test", password: "x" }, SETTINGS);
    expect(agents).toEqual([
      { address: "a000001e@agents.example.test", name: "Concierge agent" },
      { address: "a21i3v9v@agents.example.test", name: "Front desk agent" },
    ]);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
