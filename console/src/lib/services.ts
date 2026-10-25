import "server-only";
import path from "node:path";
import { createTokenVerifier, forwardedClient, LOCAL_OPERATOR, type TokenVerifier } from "./auth";
import { getConfig } from "./config";
import { fetchAgents, type Agent, type DirectorySettings } from "./directory";
import { JmapClient, type Credentials } from "./jmap";
import { buildUiShell, loadUiApp, uiSettingsFrom, type UiApp, type UiShell } from "./uiBundle";

const AGENT_CACHE_MS = 5 * 60 * 1000;

let client: JmapClient | undefined;
let agentCache: { loadedAt: number; agents: Agent[] } | undefined;
let verifier: TokenVerifier | undefined;
let shell: Promise<UiShell> | undefined;
let app: Promise<UiApp> | undefined;

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
            allowedAccounts: config.allowedAccounts,
            clientOf: forwardedClient(config.trustedProxyHops),
            maxTokenLifetimeMs: config.maxAccessTokenLifetimeSeconds * 1000,
          });
  }
  return verifier;
}

/** The page the server hosts, built once per process from this deployment's settings. */
export function uiShell(): Promise<UiShell> {
  const config = getConfig();
  shell ??= buildUiShell(path.resolve(config.uiDistDir), uiSettingsFrom(config));
  return shell;
}

/** The web app's code from `npm run build:ui`, loaded once per process. */
export function uiApp(): Promise<UiApp> {
  app ??= loadUiApp(path.resolve(getConfig().uiDistDir));
  return app;
}
