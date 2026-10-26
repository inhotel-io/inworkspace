import eventTypes from "./event-types.json";

export type Severity = "info" | "warning" | "error";

export const SUBSCRIBED_EVENT_TYPES: readonly string[] = eventTypes.subscribed;
export const REFUSAL_EVENT_TYPES: readonly string[] = eventTypes.refusal;
export const DELIVERY_PROBLEM_EVENT_TYPES: readonly string[] = eventTypes.deliveryProblem;
/**
 * Failed sign-ins and new bans. `security.ip-blocked`, a connection from an address that is already
 * banned, is left out: it is the ban working, and it would drown out the rest.
 */
export const ACCESS_EVENT_TYPES: readonly string[] = eventTypes.access;

/** Sets of types the events view can be filtered by, named after the overview's counts. */
export const EVENT_GROUPS = { access: ACCESS_EVENT_TYPES } as const satisfies Record<string, readonly string[]>;
export type EventGroup = keyof typeof EVENT_GROUPS;

const ERROR_TYPES = new Set(eventTypes.error);
const WARNING_TYPES = new Set(eventTypes.warning);

/** The webhook sends no level, so severity follows the type; unknown types are informational. */
export function severityOf(type: string): Severity {
  if (ERROR_TYPES.has(type)) return "error";
  if (WARNING_TYPES.has(type)) return "warning";
  return "info";
}
