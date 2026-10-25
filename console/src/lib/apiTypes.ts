// The JSON the console API answers: the route handlers produce it, and the web app reads it.
import type { ThreadMessage, ThreadSummary } from "./conversations";
import type { StoredEvent } from "./eventStore";

export type { StoredEvent, ThreadMessage, ThreadSummary };

export interface AgentRef {
  address: string;
  name: string | null;
}

export interface MeResponse {
  login: string;
}

/** The 24-hour counts; null when the count needs the agent list and it could not be read. */
export interface OverviewTotals {
  received: number | null;
  junk: number | null;
  refused: number;
  repliesSent: number | null;
  repliesDelivered: number | null;
  deliveryProblems: number | null;
  accessProblems: number;
}

export interface AgentOverview extends AgentRef {
  received: number;
  junk: number;
  repliesSent: number;
  errors: number;
  lastActivity: string | null;
}

export interface OverviewResponse {
  totals: OverviewTotals;
  /** Null when the agent directory could not be read; directoryError says why. */
  agents: AgentOverview[] | null;
  directoryError: string | null;
  agentDomains: string[];
  recentErrors: StoredEvent[];
}

export interface AgentsResponse {
  agents: AgentRef[];
}

export interface ThreadsResponse {
  agent: AgentRef;
  threads: ThreadSummary[];
  total: number;
  position: number;
  pageSize: number;
}

export interface ThreadResponse {
  agent: AgentRef;
  messages: ThreadMessage[];
}

export interface EventsResponse {
  events: StoredEvent[];
  pageSize: number;
}

export interface BundleManifest {
  version: string;
  file: string;
}

export type ApiErrorCode =
  | "bad_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "upstream_failed"
  | "unavailable"
  | "internal";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}
