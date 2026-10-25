import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { EventRow } from "@/components/EventRow";
import { LiveEvents } from "@/components/LiveEvents";
import { Loading } from "@/components/Loading";
import { getConfig } from "@/lib/config";
import { getPool } from "@/lib/db";
import { EVENT_TYPE_PREFIXES, EVENT_WINDOWS, eventFiltersQuery, parseEventFilters } from "@/lib/eventFilters";
import { queryEvents } from "@/lib/eventStore";
import { requireOperator } from "@/lib/operator";
import { firstValue, parseEventId } from "@/lib/params";
import { getAgents } from "@/lib/services";
import { settle } from "@/lib/settle";

export const metadata: Metadata = { title: "Events" };

const PAGE_SIZE = 100;

type Props = PageProps<"/events">;

export default function EventsPage({ searchParams }: Props) {
  return (
    <main className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
        <p className="mt-1 text-sm text-text-muted">What the mail server did with agent mail, newest first.</p>
      </header>
      <Suspense fallback={<Loading label="Loading events…" />}>
        <EventsContent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function EventsContent({ searchParams }: Pick<Props, "searchParams">) {
  await requireOperator();
  const query = await searchParams;
  const reader = { get: (name: string) => firstValue(query[name]) };
  const filters = parseEventFilters(reader, new Date());
  const before = parseEventId(query.before) ?? 0;
  const config = getConfig();
  const [events, directory] = await Promise.all([
    queryEvents(getPool(), { ...filters, beforeId: before > 0 ? before : undefined, limit: PAGE_SIZE }),
    settle(getAgents()),
  ]);
  const filterQuery = eventFiltersQuery(filters);
  const newestId = before > 0 ? 0 : (events[0]?.id ?? 0);

  return (
    <>
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4 text-sm">
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
          {directory.ok ? (
            <select name="agent" defaultValue={filters.address ?? ""} className="rounded-md border border-border bg-surface px-2 py-1.5">
              <option value="">All agents</option>
              {directory.value.map((agent) => (
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
        <Link href="/events" className="px-1 py-1.5 text-xs text-text-muted hover:text-text">
          Reset
        </Link>
      </form>

      {/* Keyed by the filters: navigating to other filters keeps client state otherwise. */}
      {before === 0 ? <LiveEvents key={filterQuery} initialAfter={newestId} query={filterQuery} timeZone={config.displayTimeZone} /> : null}

      <section aria-label="Events" className="overflow-hidden rounded-lg border border-border bg-surface">
        {events.length === 0 ? (
          <p className="p-6 text-sm text-text-muted">No events match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="text-left text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Time ({config.displayTimeZone})</th>
                  <th className="px-4 py-2 font-medium">Severity</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <EventRow key={event.id} event={event} timeZone={config.displayTimeZone} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <nav aria-label="Pages" className="flex gap-4 border-t border-border px-4 py-3 text-xs">
          {before > 0 ? (
            <Link href={`/events${filterQuery ? `?${filterQuery}` : ""}`} className="font-medium text-brand hover:underline">
              Newest
            </Link>
          ) : null}
          {events.length === PAGE_SIZE ? (
            <Link
              href={`/events?${filterQuery ? `${filterQuery}&` : ""}before=${events[events.length - 1]!.id}`}
              className="ml-auto font-medium text-brand hover:underline"
            >
              Older
            </Link>
          ) : null}
        </nav>
      </section>
    </>
  );
}
