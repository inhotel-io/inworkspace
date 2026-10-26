import type { EmailAddress } from "./conversations";

const formatters = new Map<string, Intl.DateTimeFormat>();

export function formatDateTime(value: string | Date, timeZone: string): string {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter.format(typeof value === "string" ? new Date(value) : value);
}

export function formatRelative(value: string | Date, now: Date): string {
  const seconds = Math.round((now.getTime() - new Date(value).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatAddress(address: EmailAddress | null | undefined): string {
  if (!address) return "unknown";
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

/** One line for an event: who to whom, then whatever the server said about it. */
export function describeEvent(event: { sender: string | null; recipients: string[]; data: Record<string, unknown> }): string {
  const parts: string[] = [];
  if (event.sender || event.recipients.length > 0) {
    parts.push(`${event.sender ?? "—"} → ${event.recipients.join(", ") || "—"}`);
  }
  // A failed sign-in names the login that was tried; a scan ban, the page that was probed.
  if (typeof event.data.accountName === "string" && event.data.accountName) parts.push(`as ${event.data.accountName}`);
  if (typeof event.data.path === "string" && event.data.path) parts.push(`asked for ${event.data.path}`);
  const detail = event.data.details ?? event.data.reason;
  if (typeof detail === "string" && detail) parts.push(detail);
  if (typeof event.data.code === "number") parts.push(`code ${event.data.code}`);
  if (typeof event.data.remoteIp === "string" && !event.sender && event.recipients.length === 0) {
    parts.push(`from ${event.data.remoteIp}`);
  }
  return parts.join(" · ");
}
