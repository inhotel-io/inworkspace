import { useState } from "react";
import { Link } from "react-router";
import type { MailboxOverview, OverviewResponse } from "@/lib/apiTypes";
import { formatRelative } from "@/lib/format";
import { ErrorPanel } from "../components/ErrorPanel";
import { EventRow } from "../components/EventRow";
import { Loading } from "../components/Loading";
import { RefreshNote } from "../components/RefreshNote";
import { StatCard } from "../components/StatCard";
import { useConsole } from "../console";
import { useApi } from "../useApi";
import { useDocumentTitle } from "../useDocumentTitle";

/** How often the overview counts again. */
const REFRESH_MS = 60_000;

/** Above this many mailboxes the list gets a search field. */
const SEARCH_FROM = 8;

export function OverviewPage() {
  useDocumentTitle("Overview");
  const { settings } = useConsole();
  const overview = useApi<OverviewResponse>("overview", { refreshMs: REFRESH_MS });
  return (
    <main className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-text-muted">Mail over the last 24 hours.</p>
        {overview.status === "ready" ? (
          <div className="mt-1">
            <RefreshNote every="minute" loadedAt={overview.loadedAt} refreshError={overview.refreshError} timeZone={settings.timeZone} />
          </div>
        ) : null}
      </header>
      {overview.status === "loading" ? (
        <Loading label="Counting the last 24 hours…" />
      ) : overview.status === "error" ? (
        <ErrorPanel title="The overview could not be loaded" detail={overview.error.message} />
      ) : (
        <OverviewContent data={overview.data} loadedAt={overview.loadedAt} />
      )}
    </main>
  );
}

/** Most recently active first; mailboxes without activity follow in address order. */
function byActivity(a: MailboxOverview, b: MailboxOverview): number {
  const at = a.lastActivity === null ? -Infinity : Date.parse(a.lastActivity);
  const bt = b.lastActivity === null ? -Infinity : Date.parse(b.lastActivity);
  return at === bt ? a.address.localeCompare(b.address) : bt - at;
}

function OverviewContent({ data, loadedAt }: { data: OverviewResponse; loadedAt: Date }) {
  const { settings } = useConsole();
  const { totals, mailboxes } = data;
  const [search, setSearch] = useState("");
  // Each mailbox's last activity when the page opened: anything later is new to whoever is watching.
  const [seen] = useState(() => (mailboxes === null ? null : new Map(mailboxes.map((mailbox) => [mailbox.address, mailbox.lastActivity]))));
  const isNew = (mailbox: MailboxOverview) => {
    if (seen === null || mailbox.lastActivity === null) return false;
    const before = seen.get(mailbox.address);
    return before === undefined || before === null || Date.parse(mailbox.lastActivity) > Date.parse(before);
  };
  const query = search.trim().toLowerCase();
  const shown = (mailboxes ?? [])
    .filter((mailbox) => !query || mailbox.address.includes(query) || (mailbox.name?.toLowerCase().includes(query) ?? false))
    .sort(byActivity);

  return (
    <>
      {data.directoryError !== null ? (
        <ErrorPanel title="The mailbox list is unavailable" detail={`${data.directoryError}. Counts that need it are shown as —.`} />
      ) : null}

      <section aria-label="Counts" className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
        <StatCard label="Received" value={totals.received} />
        <StatCard label="Filed as junk" value={totals.junk} tone="warning" />
        <StatCard label="Refused at SMTP" value={totals.refused} tone="warning" />
        <StatCard label="Sent" value={totals.sent} />
        <StatCard label="Delivered" value={totals.delivered} />
        <StatCard label="Delivery problems" value={totals.deliveryProblems} tone="error" />
        <StatCard label="Access problems" value={totals.accessProblems} tone="warning" />
      </section>

      <section aria-labelledby="mailboxes-heading" className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <h2 id="mailboxes-heading" className="text-sm font-semibold">
            Mailboxes <span className="font-normal text-text-muted">({mailboxes ? mailboxes.length : "—"})</span>
          </h2>
          {mailboxes && mailboxes.length > SEARCH_FROM ? (
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find a mailbox"
              aria-label="Find a mailbox"
              className="ml-auto w-56 rounded-md border border-border bg-surface px-2 py-1 text-sm"
            />
          ) : null}
        </div>
        {mailboxes === null ? (
          <p className="p-4 text-sm text-text-muted">The mailbox list could not be loaded from the mail server.</p>
        ) : mailboxes.length === 0 ? (
          <p className="p-4 text-sm text-text-muted">
            {data.domains.length > 0 ? `No mailboxes in ${data.domains.join(", ")}.` : "The mail server has no mailboxes."}
          </p>
        ) : shown.length === 0 ? (
          <p className="p-4 text-sm text-text-muted">No mailbox matches “{search.trim()}”.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Mailbox</th>
                  <th className="px-4 py-2 text-right font-medium">Received</th>
                  <th className="px-4 py-2 text-right font-medium">Junk</th>
                  <th className="px-4 py-2 text-right font-medium">Sent</th>
                  <th className="px-4 py-2 text-right font-medium">Errors</th>
                  <th className="px-4 py-2 text-right font-medium">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((mailbox) => (
                  <tr key={mailbox.address} className="border-t border-border hover:bg-surface-muted">
                    <td className="px-4 py-2">
                      {isNew(mailbox) ? (
                        <span title="Activity since you opened this page" className="mr-2 rounded-full bg-brand px-2 py-0.5 text-xs font-medium text-surface">
                          New
                        </span>
                      ) : null}
                      <Link to={`/mailboxes/${encodeURIComponent(mailbox.address)}`} className="font-medium text-brand hover:underline">
                        {mailbox.name ?? mailbox.address}
                      </Link>
                      {mailbox.name ? <div className="font-mono text-xs text-text-muted">{mailbox.address}</div> : null}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{mailbox.received}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{mailbox.junk}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{mailbox.sent}</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${mailbox.errors ? "font-semibold text-error" : ""}`}>{mailbox.errors}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right text-text-muted">
                      {mailbox.lastActivity ? formatRelative(mailbox.lastActivity, loadedAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="errors-heading" className="overflow-hidden rounded-lg border border-border bg-surface">
        <h2 id="errors-heading" className="flex items-center border-b border-border px-4 py-3 text-sm font-semibold">
          Recent errors
          <Link to="/events?severity=error" className="ml-auto text-xs font-medium text-brand hover:underline">
            All errors
          </Link>
        </h2>
        {data.recentErrors.length === 0 ? (
          <p className="p-4 text-sm text-text-muted">No errors in the event store.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <tbody>
                {data.recentErrors.map((event) => (
                  <EventRow key={event.id} event={event} timeZone={settings.timeZone} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
