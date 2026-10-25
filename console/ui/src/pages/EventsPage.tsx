import { Link, useSearchParams } from "react-router";
import type { AgentsResponse, EventsResponse } from "@/lib/apiTypes";
import { EVENT_TYPE_PREFIXES, EVENT_WINDOWS, eventFiltersQuery, parseEventFilters } from "@/lib/eventFilters";
import { parseEventId } from "@/lib/params";
import { EventRow } from "../components/EventRow";
import { ErrorPanel } from "../components/ErrorPanel";
import { LiveEvents } from "../components/LiveEvents";
import { Loading } from "../components/Loading";
import { useConsole } from "../console";
import { useApi } from "../useApi";
import { useDocumentTitle } from "../useDocumentTitle";

/** The API computes the window's start itself; this only parses the filters. */
const UNUSED_NOW = new Date(0);
const FILTER_NAMES = ["type", "severity", "agent", "window"] as const;

export function EventsPage() {
  useDocumentTitle("Events");
  const { settings } = useConsole();
  const [search, setSearch] = useSearchParams();
  const filters = parseEventFilters(search, UNUSED_NOW);
  const filterQuery = eventFiltersQuery(filters);
  const before = parseEventId(search.get("before") ?? undefined) ?? 0;
  const events = useApi<EventsResponse>(`events?${[filterQuery, before > 0 ? `before=${before}` : ""].filter(Boolean).join("&")}`);
  const directory = useApi<AgentsResponse>("agents");

  const apply = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const chosen = new URLSearchParams();
    for (const name of FILTER_NAMES) {
      const value = String(data.get(name) ?? "").trim();
      if (value) chosen.set(name, value);
    }
    // The canonical query the API and the links use, with defaults left out.
    setSearch(new URLSearchParams(eventFiltersQuery(parseEventFilters(chosen, UNUSED_NOW))));
  };

  return (
    <main className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
        <p className="mt-1 text-sm text-text-muted">What the mail server did with agent mail, newest first.</p>
      </header>

      <form
        key={filterQuery}
        onSubmit={(event) => {
          event.preventDefault();
          apply(event.currentTarget);
        }}
        className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4 text-sm"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-muted">Type</span>
          <select name="type" defaultValue={filters.typePrefix ?? ""} className="rounded-md border border-border bg-surface px-2 py-1.5">
            <option value="">All types</option>
            {EVENT_TYPE_PREFIXES.map((prefix) => (
              <option key={prefix} value={prefix}>
                {prefix}*
              </option>
            ))}
            {filters.typePrefix && !(EVENT_TYPE_PREFIXES as readonly string[]).includes(filters.typePrefix) ? (
              <option value={filters.typePrefix}>{filters.typePrefix}</option>
            ) : null}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-muted">Severity</span>
          <select name="severity" defaultValue={filters.severity ?? ""} className="rounded-md border border-border bg-surface px-2 py-1.5">
            <option value="">Any</option>
            <option value="error">Error</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-muted">Agent</span>
          {directory.status === "ready" ? (
            <select name="agent" defaultValue={filters.address ?? ""} className="rounded-md border border-border bg-surface px-2 py-1.5">
              <option value="">All agents</option>
              {directory.data.agents.map((agent) => (
                <option key={agent.address} value={agent.address}>
                  {agent.name ? `${agent.name} (${agent.address})` : agent.address}
                </option>
              ))}
            </select>
          ) : (
            <input name="agent" defaultValue={filters.address ?? ""} placeholder="address" className="rounded-md border border-border bg-surface px-2 py-1.5" />
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-muted">Window</span>
          <select name="window" defaultValue={filters.window} className="rounded-md border border-border bg-surface px-2 py-1.5">
            {Object.keys(EVENT_WINDOWS).map((window) => (
              <option key={window} value={window}>
                Last {window}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-md bg-brand px-3 py-1.5 font-medium text-surface hover:bg-brand-strong">
          Apply
        </button>
        <Link to="/events" className="px-1 py-1.5 text-xs text-text-muted hover:text-text">
          Reset
        </Link>
      </form>

      {/* Keyed by the filters: other filters start a fresh live view. */}
      {before === 0 && events.status === "ready" ? (
        <LiveEvents key={filterQuery} initialAfter={events.data.events[0]?.id ?? 0} query={filterQuery} timeZone={settings.timeZone} />
      ) : null}

      {events.status === "loading" ? (
        <Loading label="Loading events…" />
      ) : events.status === "error" ? (
        <ErrorPanel title="The events could not be loaded" detail={events.error.message} />
      ) : (
        <section aria-label="Events" className="overflow-hidden rounded-lg border border-border bg-surface">
          {events.data.events.length === 0 ? (
            <p className="p-6 text-sm text-text-muted">No events match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="text-left text-xs uppercase tracking-wide text-text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Time ({settings.timeZone})</th>
                    <th className="px-4 py-2 font-medium">Severity</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {events.data.events.map((event) => (
                    <EventRow key={event.id} event={event} timeZone={settings.timeZone} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav aria-label="Pages" className="flex gap-4 border-t border-border px-4 py-3 text-xs">
            {before > 0 ? (
              <Link to={`/events${filterQuery ? `?${filterQuery}` : ""}`} className="font-medium text-brand hover:underline">
                Newest
              </Link>
            ) : null}
            {events.data.events.length === events.data.pageSize ? (
              <Link
                to={`/events?${filterQuery ? `${filterQuery}&` : ""}before=${events.data.events[events.data.events.length - 1]!.id}`}
                className="ml-auto font-medium text-brand hover:underline"
              >
                Older
              </Link>
            ) : null}
          </nav>
        </section>
      )}
    </main>
  );
}
