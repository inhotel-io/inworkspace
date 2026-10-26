// The JSON the console API answers: the route handlers produce it, and the web app reads it.
import type { ThreadMessage, ThreadSummary } from "./conversations";
import type { StoredEvent } from "./eventStore";

export type { StoredEvent, ThreadMessage, ThreadSummary };

export interface MailboxRef {
  address: string;
  name: string | null;
}

export interface MeResponse {
  login: string;
}

/** The 24-hour counts; null when the count needs the mailbox list and it could not be read. */
export interface OverviewTotals {
  received: number | null;
  junk: number | null;
  refused: number | null;
  sent: number | null;
  delivered: number | null;
  deliveryProblems: number | null;
  accessProblems: number;
}

export interface MailboxOverview extends MailboxRef {
  received: number;
  junk: number;
  sent: number;
  errors: number;
  lastActivity: string | null;
}

export interface OverviewResponse {
  totals: OverviewTotals;
  /** Null when the mailbox list could not be read; directoryError says why. */
  mailboxes: MailboxOverview[] | null;
  directoryError: string | null;
  /** The domains whose mailboxes are listed. */
  domains: string[];
  recentErrors: StoredEvent[];
}

export interface MailboxesResponse {
  mailboxes: MailboxRef[];
}

export interface ThreadsResponse {
  mailbox: MailboxRef;
  threads: ThreadSummary[];
  total: number;
  position: number;
  pageSize: number;
}

export interface ThreadResponse {
  mailbox: MailboxRef;
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
