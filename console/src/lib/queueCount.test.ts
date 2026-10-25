import { describe, expect, it, vi } from "vitest";
import { countQueuedMessages, QueueCountError } from "./queueCount";

const READER = { serverUrl: "https://mail.example.test", login: "console@example.test", secret: "app-password" };

function answering(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(body, { status }));
}

describe("countQueuedMessages", () => {
  it("asks for the queue's total with the app password", async () => {
    const fetchImpl = answering(200, { methodResponses: [["x:QueuedMessage/query", { ids: ["a"], total: 7 }, "0"]] });
    expect(await countQueuedMessages(READER, fetchImpl)).toBe(7);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://mail.example.test/jmap/");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${Buffer.from("console@example.test:app-password").toString("base64")}`);
    expect(JSON.parse(String(init?.body)).methodCalls).toEqual([["x:QueuedMessage/query", { calculateTotal: true, limit: 1 }, "0"]]);
  });

  it("reports a refused credential, a method error and a failed request", async () => {
    await expect(countQueuedMessages(READER, answering(401, {}))).rejects.toThrow("HTTP 401");
    await expect(countQueuedMessages(READER, answering(200, { methodResponses: [["error", { type: "forbidden" }, "0"]] }))).rejects.toThrow(
      "forbidden",
    );
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(countQueuedMessages(READER, failing)).rejects.toBeInstanceOf(QueueCountError);
  });
});
