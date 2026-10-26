import "server-only";
import path from "node:path";
import { createTokenVerifier, forwardedClient, LOCAL_OPERATOR, type TokenVerifier } from "./auth";
import { getConfig } from "./config";
import { fetchMailboxes, type DirectorySettings, type Mailbox, type MailboxDirectory } from "./directory";
import { INSIGHTS_PERMISSIONS } from "./insights";
import { JmapClient, type Credentials } from "./jmap";
import { buildUiShell, loadUiApp, uiSettingsFrom, type UiApp, type UiShell } from "./uiBundle";

const DIRECTORY_CACHE_MS = 5 * 60 * 1000;

let client: JmapClient | undefined;
let directoryCache: { loadedAt: number; directory: MailboxDirectory } | undefined;
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
  return { mailboxDomains: config.mailboxDomains, mailboxLocalpartPattern: config.mailboxLocalpartPattern, principal: config.jmapPrincipal };
}

/** The mailbox directory, cached for five minutes. */
export async function getMailboxes(): Promise<MailboxDirectory> {
  const now = Date.now();
  if (directoryCache && now - directoryCache.loadedAt < DIRECTORY_CACHE_MS) return directoryCache.directory;
  const directory = await fetchMailboxes(jmapClient(), principalCredentials(), directorySettings());
  directoryCache = { loadedAt: now, directory };
  return directory;
}

/** Only listed mailboxes can be opened, so a URL cannot point the console at any other account. */
export async function findMailbox(address: string): Promise<Mailbox | undefined> {
  const normalized = address.toLowerCase();
  return (await getMailboxes()).mailboxes.find((mailbox) => mailbox.address === normalized);
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
            acceptedPermissions: [config.operatorPermission, ...INSIGHTS_PERMISSIONS],
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
