import { JMAP_CORE, STALWART_REGISTRY, responseOf, type Credentials, type JmapClient } from "./jmap";

export interface Agent {
  address: string;
  /** The account's description, which the agent runtime sets to the agent's name. */
  name: string | null;
  /** The account's numeric id, as the server's message-ingest events carry it. */
  accountId: number | null;
}

const SERVER_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz792013";

/** The server writes ids as base32 over its own alphabet; events carry the same ids as numbers. */
export function decodeServerId(id: string): number | null {
  if (id.length === 0) return null;
  let value = 0;
  for (const character of id) {
    const digit = SERVER_ID_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    value = value * 32 + digit;
    if (!Number.isSafeInteger(value)) return null;
  }
  return value;
}

export interface DirectorySettings {
  agentDomains: readonly string[];
  agentLocalpartPattern: RegExp | null;
  principal: string;
}

export function isAgentAddress(address: string, settings: DirectorySettings): boolean {
  const normalized = address.toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || normalized === settings.principal) return false;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return settings.agentDomains.includes(domain) && (settings.agentLocalpartPattern?.test(local) ?? true);
}

/** Every user account whose address is an agent address. The registry ignores paging, so each domain is one query. */
export async function fetchAgents(
  client: Pick<JmapClient, "call">,
  credentials: Credentials,
  settings: DirectorySettings,
): Promise<Agent[]> {
  const using = [JMAP_CORE, STALWART_REGISTRY];
  const domainResponses = await client.call(credentials, using, [
    ["x:Domain/query", {}, "dq"],
    ["x:Domain/get", { "#ids": { resultOf: "dq", name: "x:Domain/query", path: "/ids" }, properties: ["name"] }, "dg"],
  ]);
  const domains = (responseOf(domainResponses, "dg").list as { id: string; name: string }[]).filter((domain) =>
    settings.agentDomains.includes(domain.name.toLowerCase()),
  );

  const agents: Agent[] = [];
  for (const domain of domains) {
    const responses = await client.call(credentials, using, [
      ["x:Account/query", { filter: { domainId: domain.id } }, "aq"],
      [
        "x:Account/get",
        { "#ids": { resultOf: "aq", name: "x:Account/query", path: "/ids" }, properties: ["name", "description", "@type"] },
        "ag",
      ],
    ]);
    const accounts = responseOf(responses, "ag").list as { id: string; name: string; description?: string | null; "@type"?: string }[];
    for (const account of accounts) {
      if (account["@type"] !== undefined && account["@type"] !== "User") continue;
      const address = `${account.name}@${domain.name}`.toLowerCase();
      if (isAgentAddress(address, settings)) {
        agents.push({ address, name: account.description?.trim() || null, accountId: decodeServerId(account.id) });
      }
    }
  }
  return agents.sort((a, b) => (a.name ?? a.address).localeCompare(b.name ?? b.address) || a.address.localeCompare(b.address));
}
