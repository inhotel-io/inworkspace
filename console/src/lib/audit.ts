export interface AuditEntry {
  operator: string;
  agent: string;
  threadId?: string;
}

export function auditLine(entry: AuditEntry, now: Date): string {
  return JSON.stringify({
    severity: "NOTICE",
    message: "console.view",
    operator: entry.operator,
    agent: entry.agent,
    threadId: entry.threadId ?? null,
    at: now.toISOString(),
  });
}

/** One structured line per conversation view; log collectors index the JSON fields. */
export function audit(entry: AuditEntry): void {
  console.log(auditLine(entry, new Date()));
}
