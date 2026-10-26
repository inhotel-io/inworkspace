export interface AuditEntry {
  operator: string;
  mailbox: string;
  threadId?: string;
  /** A read the web app makes by itself to show new mail, not one the operator asked for. */
  automatic?: boolean;
}

export function auditLine(entry: AuditEntry, now: Date): string {
  return JSON.stringify({
    severity: "NOTICE",
    message: "console.view",
    operator: entry.operator,
    mailbox: entry.mailbox,
    threadId: entry.threadId ?? null,
    ...(entry.automatic ? { automatic: true } : {}),
    at: now.toISOString(),
  });
}

/** One structured line per mailbox or conversation view; log collectors index the JSON fields. */
export function audit(entry: AuditEntry): void {
  console.log(auditLine(entry, new Date()));
}
