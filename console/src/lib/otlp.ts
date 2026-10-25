// Decodes the OpenTelemetry metrics the server pushes (OTLP over HTTP, protobuf): only what the
// console stores, from the messages of opentelemetry-proto's metrics/v1/metrics.proto.

export class OtlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtlpError";
  }
}

export type Temporality = "unspecified" | "delta" | "cumulative";

export interface NumberPoint {
  /** Nanoseconds since the epoch; the start is when the series began counting. */
  startTimeNs: bigint;
  timeNs: bigint;
  value: number;
}

export interface HistogramPoint {
  startTimeNs: bigint;
  timeNs: bigint;
  count: number;
  sum: number;
}

export type OtlpMetric =
  | { name: string; kind: "gauge"; points: NumberPoint[] }
  | { name: string; kind: "sum"; monotonic: boolean; temporality: Temporality; points: NumberPoint[] }
  | { name: string; kind: "histogram"; temporality: Temporality; points: HistogramPoint[] };

const VARINT = 0;
const FIXED64 = 1;
const BYTES = 2;
const FIXED32 = 5;

class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  varint(): bigint {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (this.offset >= this.bytes.length) throw new OtlpError("truncated varint");
      const byte = this.bytes[this.offset++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
    }
    throw new OtlpError("varint too long");
  }

  private take(length: number): number {
    if (length < 0 || this.offset + length > this.bytes.length) throw new OtlpError("truncated field");
    const start = this.offset;
    this.offset += length;
    return start;
  }

  fixed64(): bigint {
    return this.view.getBigUint64(this.take(8), true);
  }

  double(): number {
    return this.view.getFloat64(this.take(8), true);
  }

  bytesField(): Uint8Array {
    const length = Number(this.varint());
    const start = this.take(length);
    return this.bytes.subarray(start, start + length);
  }

  /** The next field's number and wire type; null at the end. */
  tag(): { field: number; wire: number } | null {
    if (this.done) return null;
    const tag = Number(this.varint());
    return { field: tag >>> 3, wire: tag & 7 };
  }

  skip(wire: number): void {
    switch (wire) {
      case VARINT:
        this.varint();
        return;
      case FIXED64:
        this.take(8);
        return;
      case BYTES:
        this.bytesField();
        return;
      case FIXED32:
        this.take(4);
        return;
      default:
        throw new OtlpError(`unsupported wire type ${wire}`);
    }
  }
}

/** Calls `onField` for every field of a message; fields it does not read are skipped. */
function eachField(bytes: Uint8Array, onField: (field: number, wire: number, reader: Reader) => boolean): void {
  const reader = new Reader(bytes);
  for (let tag = reader.tag(); tag; tag = reader.tag()) {
    if (!onField(tag.field, tag.wire, reader)) reader.skip(tag.wire);
  }
}

function expectWire(actual: number, expected: number, what: string): void {
  if (actual !== expected) throw new OtlpError(`${what} has wire type ${actual}, expected ${expected}`);
}

const TEMPORALITIES: readonly Temporality[] = ["unspecified", "delta", "cumulative"];

function temporalityOf(value: bigint): Temporality {
  return TEMPORALITIES[Number(value)] ?? "unspecified";
}

function numberPoint(bytes: Uint8Array): NumberPoint {
  const point: NumberPoint = { startTimeNs: 0n, timeNs: 0n, value: 0 };
  eachField(bytes, (field, wire, reader) => {
    switch (field) {
      case 2:
        expectWire(wire, FIXED64, "start_time_unix_nano");
        point.startTimeNs = reader.fixed64();
        return true;
      case 3:
        expectWire(wire, FIXED64, "time_unix_nano");
        point.timeNs = reader.fixed64();
        return true;
      case 4:
        expectWire(wire, FIXED64, "as_double");
        point.value = reader.double();
        return true;
      case 6:
        expectWire(wire, FIXED64, "as_int");
        point.value = Number(BigInt.asIntN(64, reader.fixed64()));
        return true;
      default:
        return false;
    }
  });
  return point;
}

function histogramPoint(bytes: Uint8Array): HistogramPoint {
  const point: HistogramPoint = { startTimeNs: 0n, timeNs: 0n, count: 0, sum: 0 };
  eachField(bytes, (field, wire, reader) => {
    switch (field) {
      case 2:
        expectWire(wire, FIXED64, "start_time_unix_nano");
        point.startTimeNs = reader.fixed64();
        return true;
      case 3:
        expectWire(wire, FIXED64, "time_unix_nano");
        point.timeNs = reader.fixed64();
        return true;
      case 4:
        expectWire(wire, FIXED64, "count");
        point.count = Number(reader.fixed64());
        return true;
      case 5:
        expectWire(wire, FIXED64, "sum");
        point.sum = reader.double();
        return true;
      default:
        return false;
    }
  });
  return point;
}

/** Gauge, Sum and Histogram share their layout: points in field 1, temporality in 2, monotonic in 3. */
function series<P>(bytes: Uint8Array, point: (bytes: Uint8Array) => P) {
  const points: P[] = [];
  let temporality: Temporality = "unspecified";
  let monotonic = false;
  eachField(bytes, (field, wire, reader) => {
    switch (field) {
      case 1:
        expectWire(wire, BYTES, "data_points");
        points.push(point(reader.bytesField()));
        return true;
      case 2:
        expectWire(wire, VARINT, "aggregation_temporality");
        temporality = temporalityOf(reader.varint());
        return true;
      case 3:
        expectWire(wire, VARINT, "is_monotonic");
        monotonic = reader.varint() !== 0n;
        return true;
      default:
        return false;
    }
  });
  return { points, temporality, monotonic };
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function text(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new OtlpError("a metric name is not UTF-8");
  }
}

/** A metric of a kind the console does not store (exponential histogram, summary) is null. */
function metric(bytes: Uint8Array): OtlpMetric | null {
  let name = "";
  let decoded: OtlpMetric | null = null;
  eachField(bytes, (field, wire, reader) => {
    switch (field) {
      case 1:
        expectWire(wire, BYTES, "name");
        name = text(reader.bytesField());
        return true;
      case 5: {
        expectWire(wire, BYTES, "gauge");
        decoded = { name: "", kind: "gauge", points: series(reader.bytesField(), numberPoint).points };
        return true;
      }
      case 7: {
        expectWire(wire, BYTES, "sum");
        const { points, temporality, monotonic } = series(reader.bytesField(), numberPoint);
        decoded = { name: "", kind: "sum", monotonic, temporality, points };
        return true;
      }
      case 9: {
        expectWire(wire, BYTES, "histogram");
        const { points, temporality } = series(reader.bytesField(), histogramPoint);
        decoded = { name: "", kind: "histogram", temporality, points };
        return true;
      }
      default:
        return false;
    }
  });
  if (!decoded || !name) return null;
  return { ...(decoded as OtlpMetric), name };
}

function nested(bytes: Uint8Array, field: number, what: string, onMessage: (bytes: Uint8Array) => void): void {
  eachField(bytes, (number, wire, reader) => {
    if (number !== field) return false;
    expectWire(wire, BYTES, what);
    onMessage(reader.bytesField());
    return true;
  });
}

/** Every gauge, sum and histogram in an ExportMetricsServiceRequest, in the order sent. */
export function decodeMetricsRequest(body: Uint8Array): OtlpMetric[] {
  const metrics: OtlpMetric[] = [];
  nested(body, 1, "resource_metrics", (resource) =>
    nested(resource, 2, "scope_metrics", (scope) =>
      nested(scope, 2, "metrics", (bytes) => {
        const decoded = metric(bytes);
        if (decoded) metrics.push(decoded);
      }),
    ),
  );
  return metrics;
}
