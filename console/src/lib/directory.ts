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

/**
 * Every user account in the listed domains, which is every mailbox people sign in to. The registry
 * ignores paging, so each domain is one query.
 */
export async function fetchMailboxes(
  client: Pick<JmapClient, "call">,
  credentials: Credentials,
  settings: DirectorySettings,
): Promise<MailboxDirectory> {
  const using = [JMAP_CORE, STALWART_REGISTRY];
  const domainResponses = await client.call(credentials, using, [
    ["x:Domain/query", {}, "dq"],
    ["x:Domain/get", { "#ids": { resultOf: "dq", name: "x:Domain/query", path: "/ids" }, properties: ["name"] }, "dg"],
  ]);
  const domains = (responseOf(domainResponses, "dg").list as { id: string; name: string }[]).filter(
    (domain) => settings.mailboxDomains.length === 0 || settings.mailboxDomains.includes(domain.name.toLowerCase()),
  );

  const mailboxes: Mailbox[] = [];
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
