import { Link } from "react-router";
import type { StoredEvent } from "@/lib/apiTypes";
import { describeEvent, formatDateTime } from "@/lib/format";
import { SeverityBadge } from "./SeverityBadge";

export function EventRow({ event, timeZone }: { event: StoredEvent; timeZone: string }) {
  return (
    <tr className="border-t border-border align-top">
      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-text-muted">
        <time dateTime={event.eventAt}>{formatDateTime(event.eventAt, timeZone)}</time>
      </td>
      <td className="px-4 py-2">
        <SeverityBadge severity={event.severity} />
      </td>
      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">
        <Link to={`/events?type=${encodeURIComponent(event.type)}`} className="hover:text-brand hover:underline">
          {event.type}
        </Link>
      </td>
      <td className="px-4 py-2 text-sm">
        <p className="break-words">{describeEvent(event) || "—"}</p>
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-text-muted hover:text-text">Raw event</summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded bg-surface-sunken p-3 font-mono text-xs">{JSON.stringify(event.data, null, 2)}</pre>
        </details>
      </td>
    </tr>
  );
}
