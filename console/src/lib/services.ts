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
