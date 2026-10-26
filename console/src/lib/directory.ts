import { JMAP_CORE, STALWART_REGISTRY, responseOf, type Credentials, type JmapClient } from "./jmap";

export interface Mailbox {
  address: string;
  /** The account's description, usually the name of whoever uses the mailbox. */
  name: string | null;
  /** The account's numeric id, as the server's message-ingest events carry it. */
  accountId: number | null;
}

/** The mailboxes the console lists, and the domains they are in. */
export interface MailboxDirectory {
  mailboxes: Mailbox[];
  domains: string[];
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
  /** Empty lists every domain on the server. */
  mailboxDomains: readonly string[];
  mailboxLocalpartPattern: RegExp | null;
  /** The console's own login, which is never listed. */
  principal: string;
}

export function isListedAddress(address: string, settings: DirectorySettings): boolean {
  const normalized = address.toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || normalized === settings.principal) return false;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const listedDomain = settings.mailboxDomains.length === 0 || settings.mailboxDomains.includes(domain);
  return listedDomain && (settings.mailboxLocalpartPattern?.test(local) ?? true);
}

type DirectoryClient = Pick<JmapClient, "call" | "session">;
type RegistryObject = "x:Domain" | "x:Account";

const USING = [JMAP_CORE, STALWART_REGISTRY];
/** The server's default for `maxObjectsInGet`, for a session that does not say. */
const DEFAULT_IDS_PER_GET = 500;

/** How many ids one get may carry: the server refuses a larger get outright. */
async function idsPerGet(client: DirectoryClient, credentials: Credentials): Promise<number> {
  const limit = (await client.session(credentials)).capabilities?.[JMAP_CORE]?.maxObjectsInGet;
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_IDS_PER_GET;
}

/** Every object a registry query finds, read in gets of at most `perGet` ids. */
async function queryAll<T>(
  client: DirectoryClient,
  credentials: Credentials,
  object: RegistryObject,
  query: Record<string, unknown>,
  properties: string[],
  perGet: number,
): Promise<T[]> {
  const ids = responseOf(await client.call(credentials, USING, [[`${object}/query`, query, "q"]]), "q").ids as string[];
  const objects: T[] = [];
  for (let start = 0; start < ids.length; start += perGet) {
    const responses = await client.call(credentials, USING, [[`${object}/get`, { ids: ids.slice(start, start + perGet), properties }, "g"]]);
    objects.push(...(responseOf(responses, "g").list as T[]));
  }
  return objects;
}

/** Every user account in the listed domains, which is every mailbox people sign in to. */
export async function fetchMailboxes(client: DirectoryClient, credentials: Credentials, settings: DirectorySettings): Promise<MailboxDirectory> {
  const perGet = await idsPerGet(client, credentials);
  const domains = (await queryAll<{ id: string; name: string }>(client, credentials, "x:Domain", {}, ["name"], perGet)).filter(
    (domain) => settings.mailboxDomains.length === 0 || settings.mailboxDomains.includes(domain.name.toLowerCase()),
  );

  const mailboxes: Mailbox[] = [];
  for (const domain of domains) {
    const accounts = await queryAll<{ id: string; name: string; description?: string | null; "@type"?: string }>(
      client,
      credentials,
      "x:Account",
      { filter: { domainId: domain.id } },
      ["name", "description", "@type"],
      perGet,
    );
    for (const account of accounts) {
      if (account["@type"] !== undefined && account["@type"] !== "User") continue;
      const address = `${account.name}@${domain.name}`.toLowerCase();
      if (isListedAddress(address, settings)) {
        mailboxes.push({ address, name: account.description?.trim() || null, accountId: decodeServerId(account.id) });
      }
    }
  }
  return {
    mailboxes: mailboxes.sort((a, b) => (a.name ?? a.address).localeCompare(b.name ?? b.address) || a.address.localeCompare(b.address)),
    domains: domains.map((domain) => domain.name.toLowerCase()).sort(),
  };
}
