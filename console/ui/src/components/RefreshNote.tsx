import { formatDateTime } from "@/lib/format";
import type { ApiFailure } from "../api";

/** When a page that reloads by itself last did, or why its last reload failed. */
export function RefreshNote({
  every,
  loadedAt,
  refreshError,
  timeZone,
}: {
  every: string;
  loadedAt: Date;
  refreshError: ApiFailure | null;
  timeZone: string;
}) {
  const updated = formatDateTime(loadedAt, timeZone);
  if (refreshError) {
    const reason = /[.!?]$/.test(refreshError.message) ? refreshError.message : `${refreshError.message}.`;
    return (
      <p role="status" className="text-xs text-warning">
        Not updated since {updated}. {reason} Trying again every {every}.
      </p>
    );
  }
  return (
    <p role="status" className="text-xs text-text-muted">
      Updated {updated}; checks again every {every} while this page is open.
    </p>
  );
}
