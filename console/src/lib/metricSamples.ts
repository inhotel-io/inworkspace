import type { OtlpMetric } from "./otlp";

// The samples the console keeps, in the shapes the web admin's dashboards read:
// - counters: what each push added;
// - gauges: the value at each push;
// - histograms: running totals of count and sum. The dashboards take the difference between
//   consecutive samples themselves.

export type SampleKind = "counter" | "gauge" | "histogram";

export interface MetricSample {
  metric: string;
  kind: SampleKind;
  at: Date;
  count: number;
  /** Histograms only. */
  sum: number | null;
}

/** What the last push of a cumulative series said, and the running totals derived from it. */
export interface SeriesState {
  metric: string;
  kind: "counter" | "histogram";
  /** When the server started counting, in nanoseconds; it changes when the server restarts. */
  startNs: string;
  count: number;
  sum: number;
  totalCount: number;
  totalSum: number;
}

export interface PushResult {
  samples: MetricSample[];
  states: SeriesState[];
}

/**
 * A series the console has never seen is new when the server began counting this recently, or when
 * the console already has other series from the same server run: the server sends a counter or
 * histogram only once it is above zero, so it was zero at the last push. Otherwise its first value
 * is everything since a restart the console did not see, and only becomes the baseline.
 */
export const FRESH_SERIES_MS = 3 * 60_000;

function nsToDate(ns: bigint): Date {
  return new Date(Number(ns / 1_000_000n));
}

function latest(points: readonly { timeNs: bigint; startTimeNs: bigint }[]) {
  let time = 0n;
  let start: bigint | null = null;
  for (const point of points) {
    if (point.timeNs > time) time = point.timeNs;
    if (start === null || point.startTimeNs < start) start = point.startTimeNs;
  }
  return { at: nsToDate(time), startNs: start ?? 0n };
}

/**
 * The increase since the previous push. A different start time, or a value that went down, means
 * the server restarted, and everything it reports now came after that.
 */
function increase(current: number, previous: SeriesState | undefined, startNs: bigint, at: Date, knownRun: boolean): number | null {
  if (!previous) return knownRun || at.getTime() - nsToDate(startNs).getTime() <= FRESH_SERIES_MS ? current : null;
  if (previous.startNs !== startNs.toString() || current < previous.count) return current;
  return current - previous.count;
}

/** Turns one push into samples, given what the previous pushes said. */
export function samplesFromPush(metrics: readonly OtlpMetric[], previous: ReadonlyMap<string, SeriesState>): PushResult {
  const samples: MetricSample[] = [];
  const states: SeriesState[] = [];
  const knownRuns = new Set([...previous.values()].filter((state) => state.startNs !== "derived").map((state) => state.startNs));

  for (const metric of metrics) {
    if (metric.points.length === 0) continue;
    const { at, startNs } = latest(metric.points);
    const knownRun = knownRuns.has(startNs.toString());

    if (metric.kind === "gauge" || (metric.kind === "sum" && !metric.monotonic)) {
      const value = metric.points.reduce((total, point) => total + point.value, 0);
      samples.push({ metric: metric.name, kind: "gauge", at, count: value, sum: null });
      continue;
    }

    if (metric.kind === "sum") {
      const value = metric.points.reduce((total, point) => total + point.value, 0);
      if (metric.temporality === "delta") {
        if (value > 0) samples.push({ metric: metric.name, kind: "counter", at, count: value, sum: null });
        continue;
      }
      const before = previous.get(metric.name);
      const added = increase(value, before, startNs, at, knownRun);
      if (added !== null && added > 0) samples.push({ metric: metric.name, kind: "counter", at, count: added, sum: null });
      states.push({ metric: metric.name, kind: "counter", startNs: startNs.toString(), count: value, sum: 0, totalCount: 0, totalSum: 0 });
      continue;
    }

    const count = metric.points.reduce((total, point) => total + point.count, 0);
    const sum = metric.points.reduce((total, point) => total + point.sum, 0);
    const before = previous.get(metric.name);
    const totals = { count: before?.totalCount ?? 0, sum: before?.totalSum ?? 0 };
    let added: { count: number; sum: number } | null;
    if (metric.temporality === "delta") {
      added = { count, sum };
    } else {
      const addedCount = increase(count, before, startNs, at, knownRun);
      const restarted = !before || before.startNs !== startNs.toString() || count < before.count;
      added = addedCount === null ? null : { count: addedCount, sum: restarted ? sum : sum - before.sum };
    }
    if (!before) {
      // The first sample is the baseline the dashboards measure the next one against; what this
      // push adds is placed just after it.
      const baselineAt = added && added.count > 0 ? new Date(at.getTime() - 1) : at;
      samples.push({ metric: metric.name, kind: "histogram", at: baselineAt, count: 0, sum: 0 });
    }
    if (added && added.count > 0) {
      totals.count += added.count;
      totals.sum += Math.max(added.sum, 0);
      samples.push({ metric: metric.name, kind: "histogram", at, count: totals.count, sum: totals.sum });
    }
    states.push({
      metric: metric.name,
      kind: "histogram",
      startNs: startNs.toString(),
      count,
      sum,
      totalCount: totals.count,
      totalSum: totals.sum,
    });
  }
  return { samples, states };
}

/** Histogram samples for values the console derives itself, such as ingest times from events. */
export function addToHistogram(
  state: SeriesState | undefined,
  metric: string,
  observations: readonly { at: Date; value: number }[],
): PushResult {
  const samples: MetricSample[] = [];
  let totalCount = state?.totalCount ?? 0;
  let totalSum = state?.totalSum ?? 0;
  const sorted = [...observations].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (!state && sorted.length > 0) {
    samples.push({ metric, kind: "histogram", at: new Date(sorted[0]!.at.getTime() - 1), count: 0, sum: 0 });
  }
  // Event times have whole seconds, so observations at the same time become one sample.
  for (const [index, { at, value }] of sorted.entries()) {
    totalCount += 1;
    totalSum += Math.max(value, 0);
    if (sorted[index + 1]?.at.getTime() === at.getTime()) continue;
    samples.push({ metric, kind: "histogram", at, count: totalCount, sum: totalSum });
  }
  return {
    samples,
    states: [{ metric, kind: "histogram", startNs: "derived", count: totalCount, sum: totalSum, totalCount, totalSum }],
  };
}
