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

/**
 * The events that describe the delivery itself. A span also carries messages the server makes
 * along the way, such as the bounce queued for a failed attempt, whose addresses and sizes are not
 * this delivery's: an attempt is described by its first event, an SMTP session by its envelope and
 * the messages it queued.
 */
function describes(root: SpanEvent, event: SpanEvent): boolean {
  if (root.type === OUTBOUND_TRACE) return event === root;
  return event.type === "smtp.mail-from" || event.type === "smtp.rcpt-to" || event.type === "queue.message-queued";
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
  for (const event of ordered) {
    const { data } = event;
    if (describes(root, event)) {
      const from = strings(data.from)[0]?.toLowerCase();
      if (from && sender === null) sender = from;
      for (const to of strings(data.to)) recipients.add(to.toLowerCase());
      const queueId = idOf(data.queueId);
      if (queueId) queueIds.add(queueId);
      if (typeof data.size === "number" && Number.isFinite(data.size)) size = Math.max(size ?? 0, data.size);
    }
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

/**
 * Latencies the community edition does not export, measured from the same events the server's own
 * histograms observe (`Collector::record_metric`): the `elapsed` of each.
 */
const DERIVED_TIMES: readonly { metric: string; observes: (type: string) => boolean; positiveOnly: boolean }[] = [
  {
    metric: "message-ingest.time",
    observes: (type) => ["message-ingest.ham", "message-ingest.spam", "message-ingest.imap-append", "message-ingest.jmap-append"].includes(type),
    positiveOnly: false,
  },
  { metric: "message-ingest.index-time", observes: (type) => type === "message-ingest.search-index", positiveOnly: false },
  {
    metric: "dns.lookup-time",
    observes: (type) => ["delivery.mx-lookup", "delivery.ip-lookup", "delivery.null-mx"].includes(type) || /^(?:tls-rpt|mta-sts|dane)\./.test(type),
    positiveOnly: true,
  },
];

export const DERIVED_METRICS: readonly string[] = DERIVED_TIMES.map((derived) => derived.metric);

/** Each derived latency's observations in these rows, by metric. */
export function derivedTimes(rows: readonly TraceRow[]): Map<string, { at: Date; value: number }[]> {
  const observations = new Map<string, { at: Date; value: number }[]>();
  for (const row of rows) {
    const elapsed = row.data.elapsed;
    if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < 0) continue;
    for (const derived of DERIVED_TIMES) {
      if (!derived.observes(row.type) || (derived.positiveOnly && elapsed === 0)) continue;
      const list = observations.get(derived.metric) ?? [];
      list.push({ at: row.eventAt, value: elapsed });
      observations.set(derived.metric, list);
    }
  }
  return observations;
}
