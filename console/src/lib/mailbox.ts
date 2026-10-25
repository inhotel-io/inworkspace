import {
  buildThread,
  rolesFromMailboxes,
  summarizeThreads,
  type JmapEmail,
  type MailboxRoles,
  type ThreadMessage,
  type ThreadSummary,
} from "./conversations";
import { JMAP_CORE, JMAP_MAIL, JmapError, masterUserLogin, responseOf, type Credentials, type JmapClient } from "./jmap";
import { htmlToText, sanitizeEmailHtml } from "./sanitize";

export const THREAD_PAGE_SIZE = 50;

const SUMMARY_PROPERTIES = ["threadId", "subject", "from", "to", "receivedAt", "mailboxIds", "keywords", "preview", "header:Auto-Submitted:asText"];
const MESSAGE_PROPERTIES = [
  "threadId", "subject", "from", "to", "cc", "receivedAt", "mailboxIds", "keywords",
  "header:Auto-Submitted:asText", "textBody", "htmlBody", "bodyValues", "attachments",
];
const MAX_BODY_BYTES = 256 * 1024;

type MailboxClient = Pick<JmapClient, "session" | "call">;

interface OpenMailbox {
  credentials: Credentials;
  accountId: string;
  roles: MailboxRoles;
}

export interface ThreadPage {
  threads: ThreadSummary[];
  total: number;
  position: number;
}

async function openMailbox(client: MailboxClient, principal: Credentials, agentAddress: string): Promise<OpenMailbox> {
  const credentials = { username: masterUserLogin(agentAddress, principal.username), password: principal.password };
  const session = await client.session(credentials);
  const accountId = session.primaryAccounts[JMAP_MAIL];
  if (!accountId) throw new JmapError("the mailbox has no mail account", "accountNotFound");
  const responses = await client.call(credentials, [JMAP_CORE, JMAP_MAIL], [
    ["Mailbox/get", { accountId, ids: null, properties: ["name", "role"] }, "m"],
  ]);
  const roles = rolesFromMailboxes(responseOf(responses, "m").list as { id: string; role: string | null }[]);
  return { credentials, accountId, roles };
}

/** One page of the agent's threads, newest first, without Trash and Drafts. */
export async function listThreads(client: MailboxClient, principal: Credentials, agentAddress: string, position: number): Promise<ThreadPage> {
  const mailbox = await openMailbox(client, principal, agentAddress);
  const hidden = [mailbox.roles.trash, mailbox.roles.drafts].filter((id): id is string => id !== null);
  const { accountId } = mailbox;
  const responses = await client.call(mailbox.credentials, [JMAP_CORE, JMAP_MAIL], [
    [
      "Email/query",
      {
        accountId,
        filter: hidden.length > 0 ? { inMailboxOtherThan: hidden } : {},
        sort: [{ property: "receivedAt", isAscending: false }],
        collapseThreads: true,
        position,
        limit: THREAD_PAGE_SIZE,
        calculateTotal: true,
      },
      "q",
    ],
    ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: SUMMARY_PROPERTIES }, "g"],
    ["Thread/get", { accountId, "#ids": { resultOf: "g", name: "Email/get", path: "/list/*/threadId" } }, "t"],
  ]);
  const query = responseOf(responses, "q");
  const order = new Map((query.ids as string[]).map((id, index) => [id, index]));
  const latest = [...(responseOf(responses, "g").list as JmapEmail[])].sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
  const threads = responseOf(responses, "t").list as { id: string; emailIds: string[] }[];
  return {
    threads: summarizeThreads(latest, threads, agentAddress, mailbox.roles),
    total: typeof query.total === "number" ? query.total : latest.length,
    position,
  };
}

/** Every message of one thread, oldest first; null when the thread is not in this mailbox. */
export async function getThread(
  client: MailboxClient,
  principal: Credentials,
  agentAddress: string,
  threadId: string,
): Promise<ThreadMessage[] | null> {
  const mailbox = await openMailbox(client, principal, agentAddress);
  const { accountId } = mailbox;
  const responses = await client.call(mailbox.credentials, [JMAP_CORE, JMAP_MAIL], [
    ["Thread/get", { accountId, ids: [threadId] }, "t"],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
        properties: MESSAGE_PROPERTIES,
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: MAX_BODY_BYTES,
      },
      "e",
    ],
  ]);
  if ((responseOf(responses, "t").list as unknown[]).length === 0) return null;
  const emails = responseOf(responses, "e").list as JmapEmail[];
  return buildThread(emails, agentAddress, mailbox.roles, { sanitizeHtml: sanitizeEmailHtml, htmlToText });
}
