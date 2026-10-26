import type { Severity } from "./eventTypes";

export const EVENT_WINDOWS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 } as const;
export type EventWindow = keyof typeof EVENT_WINDOWS;
export const EVENT_TYPE_PREFIXES = ["message-ingest.", "queue.", "delivery.", "smtp.", "auth.", "security."] as const;

export interface EventFilters {
  typePrefix?: string;
  severity?: Severity;
  address?: string;
  window: EventWindow;
  since: Date;
}

interface ParamReader {
  get(name: string): string | null;
}

export function parseEventFilters(params: ParamReader, now: Date): EventFilters {
  const filters: EventFilters = { window: "24h", since: new Date(0) };
  const type = params.get("type")?.trim() ?? "";
  if (/^[a-z0-9.-]{1,80}$/.test(type)) filters.typePrefix = type;
  const severity = params.get("severity");
  if (severity === "info" || severity === "warning" || severity === "error") filters.severity = severity;
  // "agent" is the name links used before 0.4.
  const mailbox = (params.get("mailbox") ?? params.get("agent"))?.trim().toLowerCase() ?? "";
  if (/^[^\s@]+@[^\s@]+$/.test(mailbox)) filters.address = mailbox;
  const window = params.get("window") ?? "";
  if (Object.hasOwn(EVENT_WINDOWS, window)) filters.window = window as EventWindow;
  filters.since = new Date(now.getTime() - EVENT_WINDOWS[filters.window]);
  return filters;
}

/** The filters as a query string, leaving out defaults. */
export function eventFiltersQuery(filters: Omit<EventFilters, "since">): string {
  const params = new URLSearchParams();
  if (filters.typePrefix) params.set("type", filters.typePrefix);
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.address) params.set("mailbox", filters.address);
  if (filters.window !== "24h") params.set("window", filters.window);
  return params.toString();
}
