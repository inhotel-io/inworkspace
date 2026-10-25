import { servesIngest, servesWeb, type ConsoleConfig } from "./config";

export const INGEST_PATH = "/api/ingest/events";

export type GateDecision = "pass" | "not-found" | "authenticate";

/** What the request gate does with a path for this process's role. */
export function gateFor(path: string, config: Pick<ConsoleConfig, "role">): GateDecision {
  if (path === "/healthz") return "pass";
  if (path === INGEST_PATH) return servesIngest(config) ? "pass" : "not-found";
  return servesWeb(config) ? "authenticate" : "not-found";
}
