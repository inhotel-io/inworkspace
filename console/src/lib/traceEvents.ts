import { createHash } from "node:crypto";
import { canonicalJson, type WebhookEvent } from "./normalize";

// The tracing webhook's events, and the delivery traces grouped from them. A trace is one span: an
// SMTP session from a remote server (inbound) or one delivery attempt to one (outbound), named by
// the event that starts it, as the server's own `x:Trace` objects are.

export interface TraceRow {
  dedupeHash: Buffer;
  eventAt: Date;
  type: string;
  /** Null for events outside any span; the server sends span 0 for those. */
  spanId: string | null;
  data: Record<string, unknown>;
}

export const INBOUND_TRACE = "smtp.connection-start";
export const OUTBOUND_TRACE = "delivery.attempt-start";
export const TRACE_KINDS: readonly string[] = [INBOUND_TRACE, OUTBOUND_TRACE];

export interface SpanEvent {
  type: string;
  eventAt: Date;
  data: Record<string, unknown>;
}

export interface DeliveryTrace {
  spanId: string;
  kind: string;
  startedAt: Date;
  sender: string | null;
  recipients: string[];
  size: number | null;
  queueIds: string[];
  remoteIp: string | null;
  /** Lowercased text the History lists' search matches. */
  search: string;
}

function idOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d{1,20}$/.test(value) && !/^0+$/.test(value)) return value;
  return null;
}

export function traceRow(event: WebhookEvent): TraceRow {
  return {
    dedupeHash: createHash("sha256").update(`${event.createdAt}\n${event.type}\n${canonicalJson(event.data)}`).digest(),
    eventAt: new Date(event.createdAt),
    type: event.type,
    spanId: idOf(event.data.spanId),
    data: event.data,
  };
}

function strings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** The trace a span's events make, or null when no event in them starts a delivery trace. */
export function summarizeSpan(spanId: string, events: readonly SpanEvent[]): DeliveryTrace | null {
  const ordered = [...events].sort((a, b) => a.eventAt.getTime() - b.eventAt.getTime());
  const root = ordered.find((event) => TRACE_KINDS.includes(event.type));
  if (!root) return null;
  let sender: string | null = null;
  const recipients = new Set<string>();
  const queueIds = new Set<string>();
  const words = new Set<string>();
  let size: number | null = null;
  let remoteIp: string | null = null;
  for (const { data } of ordered) {
    const from = strings(data.from)[0]?.toLowerCase();
    if (from && sender === null) sender = from;
    for (const to of strings(data.to)) recipients.add(to.toLowerCase());
    const queueId = idOf(data.queueId);
    if (queueId) queueIds.add(queueId);
    if (typeof data.size === "number" && Number.isFinite(data.size)) size = Math.max(size ?? 0, data.size);
    if (remoteIp === null && typeof data.remoteIp === "string") remoteIp = data.remoteIp;
    for (const key of ["domain", "hostname", "messageId", "mx"]) for (const word of strings(data[key])) words.add(word.toLowerCase());
  }
  const search = [sender, ...recipients, ...queueIds, remoteIp, ...words].filter(Boolean).join(" ");
  return {
    spanId,
    kind: root.type,
    startedAt: root.eventAt,
    sender,
    recipients: [...recipients],
    size,
    queueIds: [...queueIds],
    remoteIp,
    search,
  };
}

/** Message ingest times from `message-ingest.*` events, which the community edition does not export. */
export function ingestTimes(rows: readonly TraceRow[]): { at: Date; value: number }[] {
  return rows
    .filter((row) => (row.type === "message-ingest.ham" || row.type === "message-ingest.spam") && typeof row.data.elapsed === "number")
    .map((row) => ({ at: row.eventAt, value: row.data.elapsed as number }));
}
