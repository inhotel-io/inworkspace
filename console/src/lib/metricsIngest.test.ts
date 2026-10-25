import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createMetricsIngestHandler, MAX_METRICS_BYTES, QUEUE_COUNT_METRIC, type MetricsIngestDeps } from "./metricsIngest";
import type { OtlpMetric } from "./otlp";

const TOKEN = "push-token-0123456789abcdef0123456789abcdef";
const PUSH = new Uint8Array(readFileSync(new URL("./__fixtures__/otlp-metrics.bin", import.meta.url)));

function deps(overrides: Partial<MetricsIngestDeps> = {}): MetricsIngestDeps {
  return {
    token: TOKEN,
    record: vi.fn(async (metrics: OtlpMetric[]) => metrics.length),
    countQueue: null,
    prune: vi.fn(async () => 0),
    now: () => 0,
    log: vi.fn(),
    ...overrides,
  };
}

function push(body: Uint8Array<ArrayBuffer> = PUSH, headers: Record<string, string> = {}): Request {
  return new Request("http://console.test/api/ingest/metrics", {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/x-protobuf", ...headers },
  });
}

describe("metrics ingest handler", () => {
  it("stores a push and answers as an OTLP receiver", async () => {
    const d = deps();
    const response = await createMetricsIngestHandler(d)(push());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-protobuf");
    expect(vi.mocked(d.record).mock.calls[0]![0]).toHaveLength(23);
    expect(d.prune).toHaveBeenCalledOnce();
  });

  it("adds the queue's size, timed with the push", async () => {
    const d = deps({ countQueue: async () => 4 });
    await createMetricsIngestHandler(d)(push());
    const metrics = vi.mocked(d.record).mock.calls[0]![0];
    expect(metrics.at(-1)).toEqual({
      name: QUEUE_COUNT_METRIC,
      kind: "gauge",
      points: [{ startTimeNs: 0n, timeNs: 1792963283970820294n, value: 4 }],
    });
  });

  it("stores the push even when the queue cannot be counted", async () => {
    const d = deps({
      countQueue: async () => {
        throw new Error("HTTP 401");
      },
    });
    expect((await createMetricsIngestHandler(d)(push())).status).toBe(200);
    expect(vi.mocked(d.record).mock.calls[0]![0]).toHaveLength(23);
    expect(d.log).toHaveBeenCalledWith(expect.objectContaining({ message: "console.metrics.queue-count-failed" }));
  });

  it("refuses a missing or wrong token before reading the body", async () => {
    const d = deps();
    const handler = createMetricsIngestHandler(d);
    expect((await handler(push(PUSH, { Authorization: "" }))).status).toBe(401);
    expect((await handler(push(PUSH, { Authorization: `Bearer ${TOKEN}x` }))).status).toBe(401);
    expect((await handler(push(PUSH, { Authorization: `Basic ${TOKEN}` }))).status).toBe(401);
    expect(d.record).not.toHaveBeenCalled();
  });

  it("refuses other formats, oversized and malformed bodies", async () => {
    const d = deps();
    const handler = createMetricsIngestHandler(d);
    expect((await handler(push(PUSH, { "Content-Type": "application/json" }))).status).toBe(415);
    expect((await handler(push(new Uint8Array(MAX_METRICS_BYTES + 1)))).status).toBe(413);
    expect((await handler(push(new Uint8Array([0x0a, 0x05, 0x12])))).status).toBe(400);
    expect(d.record).not.toHaveBeenCalled();
  });

  it("answers 503 when the push cannot be stored, so the server reports it", async () => {
    const d = deps({
      record: async () => {
        throw new Error("connection refused");
      },
    });
    expect((await createMetricsIngestHandler(d)(push())).status).toBe(503);
  });

  it("prunes at most once an hour", async () => {
    let now = 0;
    const d = deps({ now: () => now });
    const handler = createMetricsIngestHandler(d);
    await handler(push());
    now = 30 * 60 * 1000;
    await handler(push());
    now = 61 * 60 * 1000;
    await handler(push());
    expect(d.prune).toHaveBeenCalledTimes(2);
  });
});
