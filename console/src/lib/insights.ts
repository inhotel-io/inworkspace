import { ApiError } from "./apiRoute";
import { AuthError, requirePermissions, type Operator } from "./auth";
import type { DashboardMetric } from "./metricStore";
import { TRACE_KINDS } from "./traceEvents";
import { AnchorNotFoundError, type StoredTrace, type TraceQuery } from "./traceStore";
import type { TraceEvent } from "./traceValues";

// What the web admin's Dashboard, Live Tracing and History read, in the shapes of the server's own
// (Enterprise-only) endpoints, so its pages need only to be pointed here.

/**
 * Metrics the community edition does not export and the console cannot derive: store latencies
 * come from debug-level events on every read and write, too many to send. The dashboards show
 * these as not collected rather than as zero.
 */
export const UNAVAILABLE_METRICS: ReadonlySet<string> = new Set([
  "store.data-read-time",
  "store.data-write-time",
  "store.blob-read-time",
  "store.blob-write-time",
]);

export const METRIC_PERMISSIONS = ["sysMetricQuery", "sysMetricGet"] as const;
export const LIVE_METRIC_PERMISSIONS = ["liveMetrics"] as const;
export const LIVE_TRACING_PERMISSIONS = ["liveTracing"] as const;
export const TRACE_PERMISSIONS = ["sysTraceQuery", "sysTraceGet"] as const;
/** Every permission some insights route accepts. */
export const INSIGHTS_PERMISSIONS: readonly string[] = [
  ...METRIC_PERMISSIONS,
  ...LIVE_METRIC_PERMISSIONS,
  ...LIVE_TRACING_PERMISSIONS,
  ...TRACE_PERMISSIONS,
];

const METRIC_ID = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const MAX_METRICS = 64;
const MAX_WINDOW_MS = 400 * 86_400_000;

export interface MetricsResponse {
  metrics: DashboardMetric[];
  /** Requested metrics this server cannot provide. */
  unavailable: string[];
  /** When the server last pushed its metrics; null if it never did. */
  lastPushAt: string | null;
}

export interface TracingResponse {
  cursor: string;
  events: TraceEvent[];
}

export function parseMetricIds(params: URLSearchParams): string[] {
  const ids = [...new Set(params.getAll("metric").flatMap((value) => value.split(",")).map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) throw new ApiError(400, "bad_request", "name at least one metric");
  if (ids.length > MAX_METRICS) throw new ApiError(400, "bad_request", `at most ${MAX_METRICS} metrics at once`);
  const bad = ids.find((id) => !METRIC_ID.test(id));
  if (bad) throw new ApiError(400, "bad_request", `${bad.slice(0, 80)} is not a metric name`);
  return ids;
}

export function parseWindow(params: URLSearchParams, now: Date): { from: Date; to: Date } {
  const read = (name: string, fallback: Date) => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    const value = new Date(raw);
    if (Number.isNaN(value.getTime())) throw new ApiError(400, "bad_request", `${name} must be a date and time`);
    return value;
  };
  const to = read("to", now);
  const from = read("from", new Date(to.getTime() - 86_400_000));
  if (from >= to) throw new ApiError(400, "bad_request", "from must be before to");
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) throw new ApiError(400, "bad_request", "the window is at most 400 days");
  return { from, to };
}

export function unavailableOf(ids: readonly string[]): string[] {
  return ids.filter((id) => UNAVAILABLE_METRICS.has(id));
}

const KEY_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
const MAX_FILTERS = 16;
const MAX_KEYWORDS = 8;

/** `?after=<cursor>&filter=<keywords>&<key>=<value>…`, as the server's live tracing takes them. */
export function parseLiveTracing(params: URLSearchParams): { after?: string; keywords: string[]; filters: [string, string][] } {
  const after = params.get("after") ?? undefined;
  if (after !== undefined && !/^\d{1,19}$/.test(after)) throw new ApiError(400, "bad_request", "after must be a cursor from an earlier answer");
  const keywords = (params.get("filter") ?? "").split(/\s+/).filter(Boolean);
  if (keywords.length > MAX_KEYWORDS) throw new ApiError(400, "bad_request", `at most ${MAX_KEYWORDS} keywords`);
  const filters: [string, string][] = [];
  for (const [key, value] of params) {
    if (key === "after" || key === "filter") continue;
    if (!KEY_NAME.test(key)) throw new ApiError(400, "bad_request", `${key.slice(0, 64)} is not an event key`);
    if (value.length === 0 || value.length > 256) throw new ApiError(400, "bad_request", `the value for ${key} must be 1 to 256 characters`);
    filters.push([key, value]);
  }
  if (filters.length > MAX_FILTERS) throw new ApiError(400, "bad_request", `at most ${MAX_FILTERS} key filters`);
  if (keywords.some((keyword) => keyword.length > 256)) throw new ApiError(400, "bad_request", "a keyword is at most 256 characters");
  return { after, keywords, filters };
}

// --- x:Trace over JMAP -------------------------------------------------------------------------

export interface TraceStore {
  query: (query: TraceQuery) => Promise<{ ids: string[]; position: number; total: number | null }>;
  get: (ids: readonly string[], withEvents: boolean) => Promise<StoredTrace[]>;
}

type Invocation = [string, Record<string, unknown>, string];

const MAX_CALLS = 16;
const MAX_GET = 500;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const PROPERTIES = new Set(["id", "timestamp", "from", "to", "size", "events"]);
const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

class MethodError extends Error {
  constructor(
    readonly type: string,
    description?: string,
  ) {
    super(description ?? type);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dateOf(value: unknown, name: string): Date {
  if (typeof value !== "string") throw new MethodError("invalidArguments", `${name} must be a date`);
  const date = new Date(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) throw new MethodError("invalidArguments", `${name} must be a date`);
  return date;
}

/** The filters the History lists send: the trace kind, text, a date and a queue id. */
function traceFilter(filter: unknown): Pick<TraceQuery, "kinds" | "text" | "from" | "until" | "queueId"> {
  const result: Pick<TraceQuery, "kinds" | "text" | "from" | "until" | "queueId"> = { kinds: TRACE_KINDS };
  if (filter === undefined || filter === null) return result;
  if (!isRecord(filter)) throw new MethodError("unsupportedFilter", "the filter must be an object");
  const later = (date: Date) => (!result.from || date > result.from ? (result.from = date) : undefined);
  const earlier = (date: Date) => (!result.until || date < result.until ? (result.until = date) : undefined);
  for (const [key, value] of Object.entries(filter)) {
    switch (key) {
      case "event":
        if (typeof value !== "string") throw new MethodError("unsupportedFilter", "event must be an event type");
        result.kinds = TRACE_KINDS.includes(value) ? [value] : [];
        break;
      case "text":
        if (typeof value !== "string" || value.length > 256) throw new MethodError("unsupportedFilter", "text must be a short string");
        result.text = value;
        break;
      case "queueId":
        if (typeof value !== "string" && typeof value !== "number") throw new MethodError("unsupportedFilter", "queueId must be an id");
        result.queueId = String(value).trim();
        break;
      case "timestamp": {
        const date = dateOf(value, key);
        later(date);
        earlier(new Date(date.getTime() + (DATE_ONLY.test(String(value)) ? DAY_MS : 1)));
        break;
      }
      case "timestampIsGreaterThan":
      case "timestampIsGreaterThanOrEqual": {
        // "After" a day starts the next day; after an instant, the next millisecond.
        const date = dateOf(value, key);
        const after = key === "timestampIsGreaterThan" ? (DATE_ONLY.test(String(value)) ? DAY_MS : 1) : 0;
        later(new Date(date.getTime() + after));
        break;
      }
      case "timestampIsLessThan":
      case "timestampIsLessThanOrEqual": {
        const date = dateOf(value, key);
        earlier(key === "timestampIsLessThanOrEqual" ? new Date(date.getTime() + (DATE_ONLY.test(String(value)) ? DAY_MS : 1)) : date);
        break;
      }
      default:
        throw new MethodError("unsupportedFilter", `${key} is not a trace filter`);
    }
  }
  return result;
}

function wholeNumber(value: unknown, name: string, fallback: number, min: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) throw new MethodError("invalidArguments", `${name} must be a whole number`);
  return value;
}

async function traceQuery(args: Record<string, unknown>, store: TraceStore): Promise<Record<string, unknown>> {
  let ascending = false;
  if (args.sort !== undefined && args.sort !== null) {
    if (!Array.isArray(args.sort)) throw new MethodError("unsupportedSort");
    for (const comparator of args.sort) {
      if (!isRecord(comparator) || comparator.property !== "timestamp") throw new MethodError("unsupportedSort", "traces sort by timestamp only");
      ascending = comparator.isAscending !== false;
    }
  }
  const requested = wholeNumber(args.limit, "limit", DEFAULT_LIMIT, 0);
  const limit = Math.min(requested, MAX_LIMIT);
  const anchor = args.anchor === undefined || args.anchor === null ? undefined : String(args.anchor);
  const query: TraceQuery = {
    ...traceFilter(args.filter),
    ascending,
    // A negative position counts from the end, as RFC 8620 allows.
    position: wholeNumber(args.position, "position", 0, Number.MIN_SAFE_INTEGER),
    anchor,
    anchorOffset: wholeNumber(args.anchorOffset, "anchorOffset", 0, Number.MIN_SAFE_INTEGER),
    limit,
    calculateTotal: args.calculateTotal === true,
  };
  try {
    const result = await store.query(query);
    return {
      accountId: args.accountId ?? null,
      queryState: "0",
      canCalculateChanges: false,
      position: result.position,
      ids: result.ids,
      ...(result.total !== null ? { total: result.total } : {}),
      ...(limit < requested ? { limit } : {}),
    };
  } catch (error) {
    if (error instanceof AnchorNotFoundError) throw new MethodError("anchorNotFound");
    throw error;
  }
}

async function traceGet(args: Record<string, unknown>, store: TraceStore): Promise<Record<string, unknown>> {
  if (!Array.isArray(args.ids)) throw new MethodError("requestTooLarge", "name the traces to get");
  const ids = args.ids.map(String);
  if (ids.length > MAX_GET) throw new MethodError("requestTooLarge", `at most ${MAX_GET} traces at once`);
  let properties: string[] | null = null;
  if (args.properties !== undefined && args.properties !== null) {
    if (!Array.isArray(args.properties)) throw new MethodError("invalidArguments", "properties must be a list");
    properties = args.properties.map(String);
    const unknown = properties.find((property) => !PROPERTIES.has(property));
    if (unknown) throw new MethodError("invalidArguments", `${unknown} is not a trace property`);
  }
  const wants = (property: string) => properties === null || properties.includes(property);
  const traces = await store.get(ids, wants("events"));
  const found = new Set(traces.map((trace) => trace.spanId));
  return {
    accountId: args.accountId ?? null,
    state: "0",
    list: traces.map((trace) => {
      const object: Record<string, unknown> = { id: trace.spanId };
      if (wants("timestamp")) object.timestamp = trace.startedAt.toISOString();
      if (wants("from")) object.from = trace.sender ?? "";
      if (wants("to")) object.to = trace.recipients.join(", ");
      if (wants("size")) object.size = trace.size ?? 0;
      if (wants("events")) object.events = trace.events ?? [];
      return object;
    }),
    notFound: ids.filter((id) => !found.has(id)),
  };
}

/** Follows a `#name` result reference to an earlier call's ids. */
function resolveReferences(args: Record<string, unknown>, done: ReadonlyMap<string, [string, Record<string, unknown>]>) {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("#")) {
      resolved[key] = value;
      continue;
    }
    const name = key.slice(1);
    if (name in args) throw new MethodError("invalidArguments", `${name} is given both directly and by reference`);
    if (!isRecord(value) || typeof value.resultOf !== "string" || typeof value.name !== "string" || typeof value.path !== "string") {
      throw new MethodError("invalidResultReference");
    }
    const earlier = done.get(value.resultOf);
    if (!earlier || earlier[0] !== value.name) throw new MethodError("invalidResultReference", `no ${value.name} result named ${value.resultOf}`);
    const [, result] = earlier;
    if (value.path === "/ids" && Array.isArray(result.ids)) resolved[name] = result.ids;
    else if (value.path === "/list/*/id" && Array.isArray(result.list)) resolved[name] = result.list.map((item) => (item as { id: unknown }).id);
    else throw new MethodError("invalidResultReference", `${value.path} is not supported`);
  }
  return resolved;
}

const METHODS = new Map<string, { permission: string; run: (args: Record<string, unknown>, store: TraceStore) => Promise<Record<string, unknown>> }>([
  ["x:Trace/query", { permission: "sysTraceQuery", run: traceQuery }],
  ["x:Trace/get", { permission: "sysTraceGet", run: traceGet }],
]);

/** A JMAP request with `x:Trace/query` and `x:Trace/get` calls, answered as the server would. */
export async function handleTraceJmap(body: unknown, operator: Operator, store: TraceStore): Promise<{ methodResponses: Invocation[]; sessionState: string }> {
  if (!isRecord(body) || !Array.isArray(body.methodCalls)) throw new ApiError(400, "bad_request", "the body is not a JMAP request");
  if (body.methodCalls.length > MAX_CALLS) throw new ApiError(400, "bad_request", `at most ${MAX_CALLS} method calls at once`);
  const responses: Invocation[] = [];
  const done = new Map<string, [string, Record<string, unknown>]>();
  for (const call of body.methodCalls) {
    if (!Array.isArray(call) || call.length !== 3 || typeof call[0] !== "string" || !isRecord(call[1]) || typeof call[2] !== "string") {
      throw new ApiError(400, "bad_request", "a method call is malformed");
    }
    const [name, args, callId] = call as Invocation;
    const method = METHODS.get(name);
    try {
      if (!method) throw new MethodError("unknownMethod", `${name} is not served here`);
      try {
        requirePermissions(operator, [method.permission]);
      } catch (error) {
        if (error instanceof AuthError) throw new MethodError("forbidden", error.message);
        throw error;
      }
      const result = await method.run(resolveReferences(args, done), store);
      done.set(callId, [name, result]);
      responses.push([name, result, callId]);
    } catch (error) {
      if (!(error instanceof MethodError)) throw error;
      responses.push(["error", { type: error.type, ...(error.message !== error.type ? { description: error.message } : {}) }, callId]);
    }
  }
  return { methodResponses: responses, sessionState: "0" };
}
