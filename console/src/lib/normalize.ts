import { createHash } from "node:crypto";
import { severityOf, type Severity } from "./eventTypes";
import { parseJsonExact } from "./json";

export interface WebhookEvent {
  createdAt: string;
  type: string;
  data: Record<string, unknown>;
}

export interface EventRow {
  dedupeHash: Buffer;
  eventAt: Date;
  type: string;
  severity: Severity;
  sender: string | null;
  recipients: string[];
  addresses: string[];
  remoteIp: string | null;
  queueId: string | null;
  messageId: string | null;
  /** The server's numeric id of the account a message was stored in (message-ingest events). */
  accountId: string | null;
  data: Record<string, unknown>;
}

export class BatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchError";
  }
}

const EMAIL_ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emailOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim().toLowerCase();
  return EMAIL_ADDRESS.test(address) ? address : null;
}

function emailsOf(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(emailOf).filter((address): address is string => address !== null))];
}

function scalarOf(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number") return String(value);
  return null;
}

function integerOf(value: unknown): string | null {
  const scalar = scalarOf(value);
  return scalar !== null && /^\d{1,19}$/.test(scalar) ? scalar : null;
}

/**
 * Postgres text and jsonb cannot hold NUL, and event values carry text from remote servers, so
 * NUL is removed from every key and string before anything is derived or stored.
 */
function withoutNul(value: unknown): unknown {
  if (typeof value === "string") return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
  if (Array.isArray(value)) return value.map(withoutNul);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key.replaceAll("\u0000", ""), withoutNul(inner)]));
  }
  return value;
}

/** JSON with object keys sorted at every level, so equal data always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function parseBatch(text: string): WebhookEvent[] {
  let parsed: unknown;
  try {
    parsed = parseJsonExact(text);
  } catch {
    throw new BatchError("the body is not valid JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.events)) {
    throw new BatchError("the body is not an event batch");
  }
  return parsed.events.map((raw: unknown, index: number) => {
    const event = withoutNul(raw);
    if (
      !isRecord(event) ||
      typeof event.type !== "string" ||
      event.type.length === 0 ||
      typeof event.createdAt !== "string" ||
      Number.isNaN(Date.parse(event.createdAt))
    ) {
      throw new BatchError(`event ${index} is malformed`);
    }
    return { createdAt: event.createdAt, type: event.type, data: isRecord(event.data) ? event.data : {} };
  });
}

export function normalizeEvent(event: WebhookEvent): EventRow {
  const { data } = event;
  const sender = emailOf(data.from);
  const recipients = emailsOf(data.to);
  const account = emailOf(data.accountName);
  const addresses = [...new Set([sender, ...recipients, account].filter((address): address is string => address !== null))];
  return {
    dedupeHash: createHash("sha256").update(`${event.createdAt}\n${event.type}\n${canonicalJson(data)}`).digest(),
    eventAt: new Date(event.createdAt),
    type: event.type,
    severity: severityOf(event.type),
    sender,
    recipients,
    addresses,
    remoteIp: scalarOf(data.remoteIp),
    queueId: scalarOf(data.queueId),
    messageId: scalarOf(data.messageId),
    accountId: event.type.startsWith("message-ingest.") ? integerOf(data.accountId) : null,
    data,
  };
}
