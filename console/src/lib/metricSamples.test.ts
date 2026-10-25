import { describe, expect, it } from "vitest";
import { addToHistogram, FRESH_SERIES_MS, samplesFromPush, type SeriesState } from "./metricSamples";
import type { OtlpMetric } from "./otlp";

const MS = 1_000_000n;
const START = 1_792_963_258_000n * MS;
const at = (secondsAfterStart: number) => START + BigInt(secondsAfterStart * 1000) * MS;
const date = (secondsAfterStart: number) => new Date(Number(at(secondsAfterStart) / MS));

function counter(name: string, value: number, seconds: number, start = START): OtlpMetric {
  return { name, kind: "sum", monotonic: true, temporality: "cumulative", points: [{ startTimeNs: start, timeNs: at(seconds), value }] };
}

function histogram(name: string, count: number, sum: number, seconds: number, start = START): OtlpMetric {
  return { name, kind: "histogram", temporality: "cumulative", points: [{ startTimeNs: start, timeNs: at(seconds), count, sum }] };
}

function stateOf(states: readonly SeriesState[]): Map<string, SeriesState> {
  return new Map(states.map((state) => [state.metric, state]));
}

describe("samplesFromPush", () => {
  it("records gauges as they are", () => {
    const { samples, states } = samplesFromPush(
      [{ name: "server.memory", kind: "gauge", points: [{ startTimeNs: START, timeNs: at(60), value: 1024 }] }],
      new Map(),
    );
    expect(samples).toEqual([{ metric: "server.memory", kind: "gauge", at: date(60), count: 1024, sum: null }]);
    expect(states).toEqual([]);
  });

  it("counts a fresh server's counters from its start", () => {
    const { samples } = samplesFromPush([counter("smtp.connection-start", 3, 30)], new Map());
    expect(samples).toEqual([{ metric: "smtp.connection-start", kind: "counter", at: date(30), count: 3, sum: null }]);
  });

  it("only takes a baseline from a counter the server has kept for long", () => {
    const seconds = FRESH_SERIES_MS / 1000 + 600;
    const first = samplesFromPush([counter("auth.failed", 500, seconds)], new Map());
    expect(first.samples).toEqual([]);
    const second = samplesFromPush([counter("auth.failed", 507, seconds + 60)], stateOf(first.states));
    expect(second.samples).toEqual([{ metric: "auth.failed", kind: "counter", at: date(seconds + 60), count: 7, sum: null }]);
  });

  it("counts all of a series that first appears on a server run the console already knows", () => {
    const seconds = FRESH_SERIES_MS / 1000 + 600;
    const first = samplesFromPush([counter("auth.failed", 500, seconds)], new Map());
    const next = samplesFromPush(
      [counter("auth.failed", 500, seconds + 60), counter("security.ip-blocked", 2, seconds + 60), histogram("dns.lookup-time", 3, 90, seconds + 60)],
      stateOf(first.states),
    );
    expect(next.samples).toEqual([
      { metric: "security.ip-blocked", kind: "counter", at: date(seconds + 60), count: 2, sum: null },
      { metric: "dns.lookup-time", kind: "histogram", at: new Date(date(seconds + 60).getTime() - 1), count: 0, sum: 0 },
      { metric: "dns.lookup-time", kind: "histogram", at: date(seconds + 60), count: 3, sum: 90 },
    ]);
  });

  it("records nothing for a counter that did not move", () => {
    const first = samplesFromPush([counter("queue.message-queued", 4, 30)], new Map());
    expect(samplesFromPush([counter("queue.message-queued", 4, 90)], stateOf(first.states)).samples).toEqual([]);
  });

  it("starts again from zero after a restart", () => {
    const first = samplesFromPush([counter("queue.message-queued", 40, 30)], new Map());
    const restarted = START + 3600n * 1000n * MS;
    const after = samplesFromPush([counter("queue.message-queued", 2, 3700, restarted)], stateOf(first.states));
    expect(after.samples.map((sample) => sample.count)).toEqual([2]);
    const dropped = samplesFromPush([counter("queue.message-queued", 1, 3800, START)], stateOf(after.states));
    expect(dropped.samples.map((sample) => sample.count)).toEqual([1]);
  });

  it("adds delta counters directly and treats up-down sums as gauges", () => {
    const { samples } = samplesFromPush(
      [
        { name: "a", kind: "sum", monotonic: true, temporality: "delta", points: [{ startTimeNs: START, timeNs: at(5), value: 2 }] },
        { name: "b", kind: "sum", monotonic: false, temporality: "cumulative", points: [{ startTimeNs: START, timeNs: at(5), value: -1 }] },
      ],
      new Map(),
    );
    expect(samples.map(({ metric, kind, count }) => ({ metric, kind, count }))).toEqual([
      { metric: "a", kind: "counter", count: 2 },
      { metric: "b", kind: "gauge", count: -1 },
    ]);
  });

  it("keeps histogram totals that only grow, with a baseline before the first sample", () => {
    const first = samplesFromPush([histogram("delivery.total-time", 2, 300, 30)], new Map());
    expect(first.samples).toEqual([
      { metric: "delivery.total-time", kind: "histogram", at: new Date(date(30).getTime() - 1), count: 0, sum: 0 },
      { metric: "delivery.total-time", kind: "histogram", at: date(30), count: 2, sum: 300 },
    ]);
    const second = samplesFromPush([histogram("delivery.total-time", 5, 900, 90)], stateOf(first.states));
    expect(second.samples).toEqual([{ metric: "delivery.total-time", kind: "histogram", at: date(90), count: 5, sum: 900 }]);
    const restarted = START + 3600n * 1000n * MS;
    const third = samplesFromPush([histogram("delivery.total-time", 1, 50, 3700, restarted)], stateOf(second.states));
    expect(third.samples).toEqual([{ metric: "delivery.total-time", kind: "histogram", at: date(3700), count: 6, sum: 950 }]);
  });

  it("gives an old histogram a baseline sample and no jump", () => {
    const seconds = FRESH_SERIES_MS / 1000 + 600;
    const first = samplesFromPush([histogram("delivery.attempt-time", 900, 90_000, seconds)], new Map());
    expect(first.samples).toEqual([{ metric: "delivery.attempt-time", kind: "histogram", at: date(seconds), count: 0, sum: 0 }]);
    const next = samplesFromPush([histogram("delivery.attempt-time", 901, 90_200, seconds + 60)], stateOf(first.states));
    expect(next.samples).toEqual([{ metric: "delivery.attempt-time", kind: "histogram", at: date(seconds + 60), count: 1, sum: 200 }]);
  });
});

describe("addToHistogram", () => {
  it("adds observations to running totals, one sample per time", () => {
    const t = (s: number) => new Date(Date.UTC(2026, 9, 26, 10, 0, s));
    const first = addToHistogram(undefined, "message-ingest.time", [
      { at: t(5), value: 30 },
      { at: t(1), value: 10 },
      { at: t(5), value: 20 },
    ]);
    expect(first.samples).toEqual([
      { metric: "message-ingest.time", kind: "histogram", at: new Date(t(1).getTime() - 1), count: 0, sum: 0 },
      { metric: "message-ingest.time", kind: "histogram", at: t(1), count: 1, sum: 10 },
      { metric: "message-ingest.time", kind: "histogram", at: t(5), count: 3, sum: 60 },
    ]);
    const second = addToHistogram(first.states[0], "message-ingest.time", [{ at: t(9), value: 40 }]);
    expect(second.samples).toEqual([{ metric: "message-ingest.time", kind: "histogram", at: t(9), count: 4, sum: 100 }]);
  });
});
