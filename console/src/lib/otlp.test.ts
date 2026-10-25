import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeMetricsRequest, OtlpError } from "./otlp";

// A push captured from a v0.16.13 server: counters since its start, gauges, one histogram.
const CAPTURED = new Uint8Array(readFileSync(new URL("./__fixtures__/otlp-metrics.bin", import.meta.url)));

// A minimal protobuf writer, so each case states the exact bytes it sends.
function varint(value: bigint | number): number[] {
  let rest = BigInt(value);
  const out: number[] = [];
  do {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    out.push(rest > 0n ? byte | 0x80 : byte);
  } while (rest > 0n);
  return out;
}
const key = (field: number, wire: number) => varint((field << 3) | wire);
const message = (field: number, bytes: number[]) => [...key(field, 2), ...varint(bytes.length), ...bytes];
const fixed64 = (field: number, value: bigint) => {
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setBigUint64(0, BigInt.asUintN(64, value), true);
  return [...key(field, 1), ...new Uint8Array(buffer.buffer)];
};
const double = (field: number, value: number) => {
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, value, true);
  return [...key(field, 1), ...new Uint8Array(buffer.buffer)];
};
const string = (field: number, value: string) => message(field, [...new TextEncoder().encode(value)]);
const request = (...metrics: number[][]) =>
  new Uint8Array(message(1, message(2, metrics.flatMap((metric) => message(2, metric)))));

describe("decodeMetricsRequest", () => {
  it("decodes a push from the server", () => {
    const metrics = decodeMetricsRequest(CAPTURED);
    expect(metrics).toHaveLength(23);
    expect(metrics.find((metric) => metric.name === "smtp.connection-start")).toEqual({
      name: "smtp.connection-start",
      kind: "sum",
      monotonic: true,
      temporality: "cumulative",
      points: [{ startTimeNs: 1792963258960452630n, timeNs: 1792963283970820294n, value: 1 }],
    });
    expect(metrics.find((metric) => metric.name === "server.memory")).toMatchObject({
      kind: "gauge",
      points: [{ value: 107634688 }],
    });
    expect(metrics.find((metric) => metric.name === "http.request-time")).toMatchObject({
      kind: "histogram",
      temporality: "cumulative",
      points: [{ count: 2, sum: 4010 }],
    });
  });

  it("reads integer values, delta temporality, and skips fields it does not use", () => {
    const point = [...fixed64(2, 10n), ...fixed64(3, 20n), ...fixed64(6, -3n), ...message(7, string(1, "attr"))];
    const sum = [...message(1, point), ...key(2, 0), ...varint(1), ...key(3, 0), ...varint(0)];
    const metrics = decodeMetricsRequest(request([...string(1, "x.y"), ...string(2, "about"), ...string(3, "1"), ...message(7, sum)]));
    expect(metrics).toEqual([
      { name: "x.y", kind: "sum", monotonic: false, temporality: "delta", points: [{ startTimeNs: 10n, timeNs: 20n, value: -3 }] },
    ]);
  });

  it("reads histogram counts and sums", () => {
    const point = [...fixed64(3, 5n), ...fixed64(4, 4n), ...double(5, 12.5), ...fixed64(6, 1n), ...double(7, 0.5)];
    const [metric] = decodeMetricsRequest(request([...string(1, "h"), ...message(9, [...message(1, point), ...key(2, 0), ...varint(2)])]));
    expect(metric).toEqual({ name: "h", kind: "histogram", temporality: "cumulative", points: [{ startTimeNs: 0n, timeNs: 5n, count: 4, sum: 12.5 }] });
  });

  it("leaves out kinds it does not store and metrics without a name", () => {
    const summary = [...string(1, "s"), ...message(11, [])];
    const nameless = message(5, message(1, double(4, 1)));
    expect(decodeMetricsRequest(request(summary, nameless))).toEqual([]);
  });

  it("accepts an empty request", () => {
    expect(decodeMetricsRequest(new Uint8Array())).toEqual([]);
  });

  it("refuses truncated or malformed bodies", () => {
    expect(() => decodeMetricsRequest(CAPTURED.subarray(0, CAPTURED.length - 3))).toThrow(OtlpError);
    expect(() => decodeMetricsRequest(new Uint8Array([0x0b]))).toThrow(OtlpError);
    expect(() => decodeMetricsRequest(new Uint8Array([0x0a, 0x05, 0x12]))).toThrow(OtlpError);
    expect(() => decodeMetricsRequest(request(string(1, "￿").map((byte, index) => (index === 2 ? 0xff : byte))))).toThrow(OtlpError);
  });
});
