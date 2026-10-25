/**
 * How many messages wait in the server's delivery queue. The community edition does not export this
 * gauge, so the ingest asks for it with each metrics push, using an app password that may only
 * query the queue.
 */
export interface QueueReader {
  serverUrl: string;
  login: string;
  secret: string;
}

export class QueueCountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueCountError";
  }
}

export async function countQueuedMessages(reader: QueueReader, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<number> {
  let response: Response;
  try {
    response = await fetchImpl(`${reader.serverUrl}/jmap/`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${reader.login}:${reader.secret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
        methodCalls: [["x:QueuedMessage/query", { calculateTotal: true, limit: 1 }, "0"]],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new QueueCountError(`the mail server did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new QueueCountError(`the queue query answered HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as { methodResponses?: unknown } | null;
  const [first] = Array.isArray(body?.methodResponses) ? (body.methodResponses as unknown[]) : [];
  const [name, result] = Array.isArray(first) ? (first as [unknown, Record<string, unknown> | undefined]) : [];
  if (name !== "x:QueuedMessage/query" || typeof result?.total !== "number") {
    const type = name === "error" && typeof result?.type === "string" ? result.type : "an unexpected answer";
    throw new QueueCountError(`the queue query failed: ${type}`);
  }
  return result.total;
}
