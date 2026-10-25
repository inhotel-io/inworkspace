import { isIP } from "node:net";

// Events as the web admin's tracing views read them: the shapes of the server's `x:TraceEvent`,
// built from the plain JSON its webhook sends.

export type TraceValue =
  | { "@type": "String"; value: string }
  | { "@type": "UnsignedInt"; value: number | string }
  | { "@type": "Integer"; value: number }
  | { "@type": "Boolean"; value: boolean }
  | { "@type": "Float"; value: number }
  | { "@type": "UTCDateTime"; value: string }
  | { "@type": "Duration"; value: number }
  | { "@type": "IpAddr"; value: string }
  | { "@type": "List"; value: TraceValue[] }
  | { "@type": "Event"; event: string; value: TraceKeyValue[] }
  | { "@type": "Null" };

export interface TraceKeyValue {
  key: string;
  value: TraceValue;
}

export interface TraceEvent {
  event: string;
  timestamp: string;
  keyValues: TraceKeyValue[];
}

/** Keys whose numbers are durations in milliseconds. */
const DURATION_KEYS = new Set(["elapsed", "duration", "interval", "timeout"]);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Ids too large for a double arrive as their exact digits (see json.ts). */
const LARGE_INTEGER = /^\d{16,20}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueOf(key: string, value: unknown): TraceValue {
  if (value === null || value === undefined) return { "@type": "Null" };
  if (typeof value === "boolean") return { "@type": "Boolean", value };
  if (typeof value === "number") {
    if (DURATION_KEYS.has(key) && value >= 0) return { "@type": "Duration", value };
    if (!Number.isInteger(value)) return { "@type": "Float", value };
    return value < 0 ? { "@type": "Integer", value } : { "@type": "UnsignedInt", value };
  }
  if (typeof value === "string") {
    if (LARGE_INTEGER.test(value) && /Id$/.test(key)) return { "@type": "UnsignedInt", value };
    if (DATE_TIME.test(value)) return { "@type": "UTCDateTime", value };
    if (/ip$/i.test(key) && isIP(value) !== 0) return { "@type": "IpAddr", value };
    return { "@type": "String", value };
  }
  if (Array.isArray(value)) return { "@type": "List", value: value.map((item) => valueOf(key, item)) };
  if (isRecord(value) && typeof value.type === "string") {
    return { "@type": "Event", event: value.type, value: keyValuesOf(isRecord(value.data) ? value.data : {}) };
  }
  return { "@type": "String", value: JSON.stringify(value) };
}

export function keyValuesOf(data: Record<string, unknown>): TraceKeyValue[] {
  return Object.entries(data).map(([key, value]) => ({ key, value: valueOf(key, value) }));
}

export function toTraceEvent(type: string, at: Date, data: Record<string, unknown>): TraceEvent {
  return { event: type, timestamp: at.toISOString(), keyValues: keyValuesOf(data) };
}
