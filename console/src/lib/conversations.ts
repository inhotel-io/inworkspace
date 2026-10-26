export interface EmailAddress {
  name: string | null;
  email: string;
}

export interface BodyPart {
  partId: string | null;
  size: number;
  name: string | null;
  type: string;
}

export interface JmapEmail {
  id: string;
  threadId: string;
  subject: string | null;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc?: EmailAddress[] | null;
  receivedAt: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  preview?: string;
  "header:Auto-Submitted:asText"?: string | null;
  textBody?: BodyPart[];
  htmlBody?: BodyPart[];
  bodyValues?: Record<string, { value: string; isTruncated?: boolean }>;
  attachments?: BodyPart[];
}

export interface MailboxRoles {
  inbox: string | null;
  junk: string | null;
  sent: string | null;
  trash: string | null;
  drafts: string | null;
}

export type Direction = "inbound" | "outbound";
export type ThreadStatus = "awaiting-reply" | "junk" | "automated" | "answered" | "draft" | "deleted";

export interface ThreadSummary {
  threadId: string;
  subject: string;
  counterpart: EmailAddress | null;
  messageCount: number;
  lastActivity: string;
  lastDirection: Direction;
  /** The newest message was never sent: a draft, wherever it is now. */
  lastDraft: boolean;
  preview: string;
  status: ThreadStatus;
}

export interface ThreadMessage {
  id: string;
  direction: Direction;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  receivedAt: string;
  text: string;
  /** Sanitized HTML, or null when the message has no HTML part. */
  html: string | null;
  truncated: boolean;
  junk: boolean;
  automated: boolean;
  /** Written but never sent: in Drafts, or still marked as a draft wherever it was moved. */
  draft: boolean;
  /** In Trash. */
  deleted: boolean;
  attachments: { name: string; size: number; type: string }[];
}

export interface BodyRenderers {
  sanitizeHtml: (html: string) => string;
  htmlToText: (html: string) => string;
}

export function rolesFromMailboxes(mailboxes: readonly { id: string; role: string | null }[]): MailboxRoles {
  const idOf = (role: string) => mailboxes.find((mailbox) => mailbox.role === role)?.id ?? null;
  return { inbox: idOf("inbox"), junk: idOf("junk"), sent: idOf("sent"), trash: idOf("trash"), drafts: idOf("drafts") };
}

function lowercase(address: EmailAddress): EmailAddress {
  return { name: address.name, email: address.email.toLowerCase() };
}

function isIn(email: JmapEmail, mailboxId: string | null): boolean {
  return mailboxId !== null && Boolean(email.mailboxIds[mailboxId]);
}

/** Written but never sent: in Drafts, or still marked as a draft, as one moved to Trash is. */
export function isDraft(email: JmapEmail, roles: MailboxRoles): boolean {
  return isIn(email, roles.drafts) || Boolean(email.keywords?.$draft);
}

/**
 * Sent mail and drafts are the mailbox's own. Inbox and Junk hold what it received, even mail that
 * claims its own address as the sender. Anywhere else, the sender decides.
 */
export function directionOf(email: JmapEmail, address: string, roles: MailboxRoles): Direction {
  if (isIn(email, roles.sent) || isDraft(email, roles)) return "outbound";
  if (isIn(email, roles.inbox) || isIn(email, roles.junk)) return "inbound";
  return email.from?.[0]?.email.toLowerCase() === address ? "outbound" : "inbound";
}

export function isJunk(email: JmapEmail, roles: MailboxRoles): boolean {
  return isIn(email, roles.junk) || Boolean(email.keywords?.$junk);
}

/** Machine-generated mail (RFC 3834), including delivery reports, never awaits a reply. */
export function isAutomated(email: JmapEmail): boolean {
  const autoSubmitted = email["header:Auto-Submitted:asText"]?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  const local = email.from?.[0]?.email.split("@")[0]?.toLowerCase();
  return local === "mailer-daemon" || local === "postmaster";
}

/** `latest` holds the newest email of each thread, in display order. */
export function summarizeThreads(
  latest: readonly JmapEmail[],
  threads: readonly { id: string; emailIds: string[] }[],
  address: string,
  roles: MailboxRoles,
): ThreadSummary[] {
  const counts = new Map(threads.map((thread) => [thread.id, thread.emailIds.length]));
  return latest.map((email) => {
    const direction = directionOf(email, address, roles);
    const draft = isDraft(email, roles);
    const counterpart = direction === "inbound" ? email.from?.[0] : email.to?.[0];
    let status: ThreadStatus = "answered";
    // The newest message's folder comes first: a deleted or draft one says more than its direction.
    if (isIn(email, roles.trash)) status = "deleted";
    else if (draft) status = "draft";
    else if (direction === "inbound") {
      if (isJunk(email, roles)) status = "junk";
      else if (isAutomated(email)) status = "automated";
      else status = "awaiting-reply";
    }
    return {
      threadId: email.threadId,
      subject: email.subject?.trim() || "(no subject)",
      counterpart: counterpart ? lowercase(counterpart) : null,
      messageCount: counts.get(email.threadId) ?? 1,
      lastActivity: email.receivedAt,
      lastDirection: direction,
      lastDraft: draft,
      preview: email.preview ?? "",
      status,
    };
  });
}

function partValues(email: JmapEmail, parts: readonly BodyPart[]): string[] {
  return parts
    .map((part) => (part.partId === null ? undefined : email.bodyValues?.[part.partId]?.value))
    .filter((value): value is string => typeof value === "string");
}

export function buildThread(
  emails: readonly JmapEmail[],
  address: string,
  roles: MailboxRoles,
  renderers: BodyRenderers,
): ThreadMessage[] {
  return [...emails]
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    .map((email) => {
      const htmlParts = (email.htmlBody ?? []).filter((part) => part.type === "text/html");
      const html = htmlParts.length > 0 ? renderers.sanitizeHtml(partValues(email, htmlParts).join("\n")) : null;
      let text = partValues(email, email.textBody ?? []).join("\n\n").trim();
      if (!text && html) text = renderers.htmlToText(html);
      const direction = directionOf(email, address, roles);
      return {
        id: email.id,
        direction,
        subject: email.subject?.trim() || "(no subject)",
        from: (email.from ?? []).map(lowercase),
        to: (email.to ?? []).map(lowercase),
        cc: (email.cc ?? []).map(lowercase),
        receivedAt: email.receivedAt,
        text,
        html,
        truncated: Object.values(email.bodyValues ?? {}).some((value) => value.isTruncated === true),
        junk: direction === "inbound" && isJunk(email, roles),
        automated: direction === "inbound" && isAutomated(email),
        draft: isDraft(email, roles),
        deleted: isIn(email, roles.trash),
        attachments: (email.attachments ?? []).map((part) => ({ name: part.name ?? "(unnamed)", size: part.size, type: part.type })),
      };
    });
}
