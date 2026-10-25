import eventTypes from "./event-types.json";

export type Severity = "info" | "warning" | "error";

export const SUBSCRIBED_EVENT_TYPES: readonly string[] = eventTypes.subscribed;
export const REFUSAL_EVENT_TYPES: readonly string[] = eventTypes.refusal;
export const DELIVERY_PROBLEM_EVENT_TYPES: readonly string[] = eventTypes.deliveryProblem;
export const ACCESS_EVENT_TYPES: readonly string[] = eventTypes.access;

const ERROR_TYPES = new Set(eventTypes.error);
const WARNING_TYPES = new Set(eventTypes.warning);

/** The webhook sends no level, so severity follows the type; unknown types are informational. */
export function severityOf(type: string): Severity {
  if (ERROR_TYPES.has(type)) return "error";
  if (WARNING_TYPES.has(type)) return "warning";
  return "info";
}
