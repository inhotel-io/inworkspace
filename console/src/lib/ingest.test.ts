import { describe, expect, it, vi } from "vitest";
import { createIngestHandler, MAX_INGEST_BYTES, type IngestDeps } from "./ingest";
import type { EventRow } from "./normalize";
import { signBody } from "./signature";

const KEY = "test-signing-key-0123456789abcdef0123456789";
const BODY = '{"events":[{"type":"message-ingest.ham","createdAt":"2026-10-25T11:20:29Z","data":{"to":["a@agents.example.test"]}}]}';

function deps(overrides: Partial<IngestDeps> = {}): IngestDeps {
  return {
    signingKey: KEY,
    insert: vi.fn(async (rows: EventRow[]) => rows.length),
    prune: vi.fn(async () => 0),
    now: () => 0,
    log: vi.fn(),
    ...overrides,
  };
}

function post(body: string, signature: string | null = signBody(body, KEY)): Request {
  return new Request("http://console.test/api/ingest/events", {
    method: "POST",
    body,
    headers: signature === null ? {} : { "X-Signature": signature },
  });
}

describe("ingest handler", () => {
  it("stores a signed batch and answers 204", async () => {
    const d = deps();
    const response = await createIngestHandler(d)(post(BODY));
    expect(response.status).toBe(204);
    expect(d.insert).toHaveBeenCalledOnce();
    const [rows] = vi.mocked(d.insert).mock.calls[0]!;
    expect(rows.map((row) => row.recipients)).toEqual([["a@agents.example.test"]]);
  });

  it("answers 401 without a valid signature and stores nothing", async () => {
    const d = deps();
    expect((await createIngestHandler(d)(post(BODY, null))).status).toBe(401);
    expect((await createIngestHandler(d)(post(BODY, signBody(BODY, "another-key-0123456789abcdef0123456789")))).status).toBe(401);
    expect(d.insert).not.toHaveBeenCalled();
  });

  it("answers 400 for a malformed batch", async () => {
    expect((await createIngestHandler(deps())(post('{"nope":true}'))).status).toBe(400);
  });

  it("answers 413 for an oversized body, declared or streamed", async () => {
    // Request strips a hand-set content-length, so the declared case uses a minimal stand-in.
    const declared = { headers: new Headers({ "content-length": String(MAX_INGEST_BYTES + 1) }), body: null } as unknown as Request;
    expect((await createIngestHandler(deps())(declared)).status).toBe(413);
    const big = "x".repeat(MAX_INGEST_BYTES + 1);
    expect((await createIngestHandler(deps())(post(big, signBody(big, KEY)))).status).toBe(413);
  });

  it("answers 503 when the store fails, so the server retries", async () => {
    const d = deps({ insert: vi.fn(async () => Promise.reject(new Error("connection refused"))) });
    expect((await createIngestHandler(d)(post(BODY))).status).toBe(503);
    expect(d.log).toHaveBeenCalledWith(expect.objectContaining({ message: "console.ingest.store-failed" }));
  });

  it("prunes at most once an hour", async () => {
    let now = 0;
    const d = deps({ now: () => now });
    const handle = createIngestHandler(d);
    await handle(post(BODY));
    now = 30 * 60 * 1000;
    await handle(post(BODY));
    now = 61 * 60 * 1000;
    await handle(post(BODY));
    expect(d.prune).toHaveBeenCalledTimes(2);
  });
});
