import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./apiRoute";
import type { Operator } from "./auth";
import { handleTraceJmap, parseLiveTracing, parseMetricIds, parseWindow, unavailableOf, type TraceStore } from "./insights";
import type { StoredTrace, TraceQuery } from "./traceStore";

const ADMIN: Operator = { login: "admin", permissions: new Set(["sysTraceQuery", "sysTraceGet"]) };
const NOW = new Date("2026-10-26T12:00:00Z");

const TRACE: StoredTrace = {
  spanId: "336901507366519296",
  kind: "smtp.connection-start",
  startedAt: new Date("2026-10-26T09:00:00Z"),
  sender: "jane@example.com",
  recipients: ["a@agents.example.test", "b@agents.example.test"],
  size: 1691,
  queueIds: ["7"],
  remoteIp: "192.0.2.7",
  events: [{ event: "smtp.connection-start", timestamp: "2026-10-26T09:00:00.000Z", keyValues: [] }],
};

function storeWith(ids: string[] = [TRACE.spanId], total: number | null = 1) {
  const queries: TraceQuery[] = [];
  const store: TraceStore = {
    query: vi.fn(async (query: TraceQuery) => {
      queries.push(query);
      return { ids, position: query.position, total: query.calculateTotal ? total : null };
    }),
    get: vi.fn(async (wanted: readonly string[], withEvents: boolean) =>
      wanted.includes(TRACE.spanId) ? [withEvents ? TRACE : { ...TRACE, events: undefined }] : [],
    ),
  };
  return { store, queries };
}

function request(...methodCalls: unknown[]) {
  return { using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], methodCalls };
}

describe("metric parameters", () => {
  it("reads metric names, repeated or comma-separated", () => {
    expect(parseMetricIds(new URLSearchParams("metric=queue.count,server.memory&metric=queue.count"))).toEqual(["queue.count", "server.memory"]);
  });

  it("refuses missing, malformed or too many names", () => {
    expect(() => parseMetricIds(new URLSearchParams())).toThrow(ApiError);
    expect(() => parseMetricIds(new URLSearchParams("metric=DROP TABLE"))).toThrow("is not a metric name");
    const many = Array.from({ length: 65 }, (_, i) => `metric=a.m${i}`).join("&");
    expect(() => parseMetricIds(new URLSearchParams(many))).toThrow("at most 64");
  });

  it("reads the window, a day by default", () => {
    expect(parseWindow(new URLSearchParams(), NOW)).toEqual({ from: new Date("2026-10-25T12:00:00Z"), to: NOW });
    expect(parseWindow(new URLSearchParams("from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z"), NOW).from).toEqual(new Date("2026-10-01T00:00:00Z"));
    expect(() => parseWindow(new URLSearchParams("from=nonsense"), NOW)).toThrow("from must be a date");
    expect(() => parseWindow(new URLSearchParams("from=2026-10-27T00:00:00Z"), NOW)).toThrow("before to");
    expect(() => parseWindow(new URLSearchParams("from=2024-01-01T00:00:00Z"), NOW)).toThrow("400 days");
  });

  it("names the metrics the community edition cannot provide", () => {
    expect(unavailableOf(["store.data-read-time", "server.memory", "message-ingest.time"])).toEqual(["store.data-read-time"]);
  });
});

describe("parseLiveTracing", () => {
  it("reads the cursor, keywords and key filters", () => {
    expect(parseLiveTracing(new URLSearchParams("after=42&filter=jane%20bounce&queueId=7&remoteIp=192.0.2.7"))).toEqual({
      after: "42",
      keywords: ["jane", "bounce"],
      filters: [
        ["queueId", "7"],
        ["remoteIp", "192.0.2.7"],
      ],
    });
    expect(parseLiveTracing(new URLSearchParams())).toEqual({ after: undefined, keywords: [], filters: [] });
  });

  it("refuses a bad cursor, key or value", () => {
    expect(() => parseLiveTracing(new URLSearchParams("after=-1"))).toThrow("after must be a cursor");
    expect(() => parseLiveTracing(new URLSearchParams("data%3E%3E1=x"))).toThrow("is not an event key");
    expect(() => parseLiveTracing(new URLSearchParams("queueId="))).toThrow("1 to 256 characters");
  });
});

describe("handleTraceJmap", () => {
  it("answers the History list's query and get, with the result reference", async () => {
    const { store, queries } = storeWith();
    const response = await handleTraceJmap(
      request(
        [
          "x:Trace/query",
          { accountId: "a", filter: { event: "smtp.connection-start", text: "jane", timestampIsGreaterThan: "2026-10-25" }, limit: 25, position: 0, calculateTotal: true },
          "0",
        ],
        ["x:Trace/get", { accountId: "a", "#ids": { resultOf: "0", name: "x:Trace/query", path: "/ids" }, properties: ["id", "timestamp", "from", "to", "size"] }, "1"],
      ),
      ADMIN,
      store,
    );
    expect(queries[0]).toEqual({
      kinds: ["smtp.connection-start"],
      text: "jane",
      from: new Date("2026-10-26T00:00:00Z"),
      ascending: false,
      position: 0,
      anchor: undefined,
      anchorOffset: 0,
      limit: 25,
      calculateTotal: true,
    });
    expect(response.methodResponses).toEqual([
      ["x:Trace/query", { accountId: "a", queryState: "0", canCalculateChanges: false, position: 0, ids: [TRACE.spanId], total: 1 }, "0"],
      [
        "x:Trace/get",
        {
          accountId: "a",
          state: "0",
          list: [{ id: TRACE.spanId, timestamp: "2026-10-26T09:00:00.000Z", from: "jane@example.com", to: "a@agents.example.test, b@agents.example.test", size: 1691 }],
          notFound: [],
        },
        "1",
      ],
    ]);
    expect(store.get).toHaveBeenCalledWith([TRACE.spanId], false);
  });

  it("gets a trace with its events for the trace view", async () => {
    const { store } = storeWith();
    const { methodResponses } = await handleTraceJmap(request(["x:Trace/get", { ids: [TRACE.spanId, "9"] }, "0"]), ADMIN, store);
    expect(methodResponses[0]![1]).toMatchObject({ list: [{ id: TRACE.spanId, events: TRACE.events }], notFound: ["9"] });
  });

  it("reads dates, sorting and anchors the way the list sends them", async () => {
    const { store, queries } = storeWith();
    await handleTraceJmap(
      request([
        "x:Trace/query",
        { filter: { timestamp: "2026-10-20", queueId: 7 }, sort: [{ property: "timestamp", isAscending: true }], anchor: "5", anchorOffset: 1, limit: 2000 },
        "0",
      ]),
      ADMIN,
      store,
    );
    expect(queries[0]).toMatchObject({
      kinds: ["smtp.connection-start", "delivery.attempt-start"],
      from: new Date("2026-10-20T00:00:00Z"),
      until: new Date("2026-10-21T00:00:00Z"),
      queueId: "7",
      ascending: true,
      anchor: "5",
      anchorOffset: 1,
      limit: 500,
    });
    const { methodResponses } = await handleTraceJmap(request(["x:Trace/query", { limit: 2000 }, "0"]), ADMIN, store);
    expect(methodResponses[0]![1]).toMatchObject({ limit: 500 });
  });

  it("answers method errors the way JMAP does", async () => {
    const { store } = storeWith();
    const { methodResponses } = await handleTraceJmap(
      request(
        ["x:Account/get", {}, "a"],
        ["x:Trace/query", { filter: { subject: "x" } }, "b"],
        ["x:Trace/query", { sort: [{ property: "size" }] }, "c"],
        ["x:Trace/get", { ids: null }, "d"],
        ["x:Trace/get", { "#ids": { resultOf: "zz", name: "x:Trace/query", path: "/ids" } }, "e"],
        ["x:Trace/get", { ids: ["1"], properties: ["subject"] }, "f"],
      ),
      ADMIN,
      store,
    );
    expect(methodResponses.map(([name, result, id]) => [name, result.type, id])).toEqual([
      ["error", "unknownMethod", "a"],
      ["error", "unsupportedFilter", "b"],
      ["error", "unsupportedSort", "c"],
      ["error", "requestTooLarge", "d"],
      ["error", "invalidResultReference", "e"],
      ["error", "invalidArguments", "f"],
    ]);
  });

  it("refuses each method its permission does not allow", async () => {
    const { store } = storeWith();
    const lister: Operator = { login: "ops", permissions: new Set(["sysTraceQuery"]) };
    const { methodResponses } = await handleTraceJmap(request(["x:Trace/query", {}, "0"], ["x:Trace/get", { ids: ["1"] }, "1"]), lister, store);
    expect(methodResponses.map(([name, result]) => [name, result.type ?? "ok"])).toEqual([
      ["x:Trace/query", "ok"],
      ["error", "forbidden"],
    ]);
    expect(store.get).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a JMAP request", async () => {
    const { store } = storeWith();
    await expect(handleTraceJmap({ methodCalls: "x" }, ADMIN, store)).rejects.toBeInstanceOf(ApiError);
    await expect(handleTraceJmap(request(["x:Trace/get"]), ADMIN, store)).rejects.toThrow("malformed");
    const many = Array.from({ length: 17 }, (_, i) => ["x:Trace/query", {}, String(i)]);
    await expect(handleTraceJmap(request(...many), ADMIN, store)).rejects.toThrow("at most 16");
  });
});
