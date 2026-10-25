import "server-only";
import { getConfig } from "./config";
import { fetchAgents, type Agent, type DirectorySettings } from "./directory";
import { JmapClient, type Credentials } from "./jmap";

const AGENT_CACHE_MS = 5 * 60 * 1000;

let client: JmapClient | undefined;
let agentCache: { loadedAt: number; agents: Agent[] } | undefined;

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
