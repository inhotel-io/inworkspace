import { useState } from "react";
import { Link } from "react-router";
import type { OverviewResponse } from "@/lib/apiTypes";
import { formatRelative } from "@/lib/format";
import { ErrorPanel } from "../components/ErrorPanel";
import { EventRow } from "../components/EventRow";
import { Loading } from "../components/Loading";
import { StatCard } from "../components/StatCard";
import { useConsole } from "../console";
import { useApi } from "../useApi";
import { useDocumentTitle } from "../useDocumentTitle";

export function OverviewPage() {
  useDocumentTitle("Overview");
  const overview = useApi<OverviewResponse>("overview");
  return (
    <main className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-text-muted">Agent mail over the last 24 hours.</p>
      </header>
      {overview.status === "loading" ? (
        <Loading label="Counting the last 24 hours…" />
      ) : overview.status === "error" ? (
        <ErrorPanel title="The overview could not be loaded" detail={overview.error.message} />
      ) : (
        <OverviewContent data={overview.data} />
      )}
    </main>
  );
}

function OverviewContent({ data }: { data: OverviewResponse }) {
  const { settings } = useConsole();
  const [now] = useState(() => new Date());
  const { totals, agents } = data;
  return (
    <>
      {data.directoryError !== null ? (
        <ErrorPanel title="The agent list is unavailable" detail={`${data.directoryError}. Counts that need it are shown as —.`} />
      ) : null}

      <section aria-label="Counts" className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
        <StatCard label="Received" value={totals.received} />
        <StatCard label="Filed as junk" value={totals.junk} tone="warning" />
        <StatCard label="Refused at SMTP" value={totals.refused} tone="warning" />
        <StatCard label="Replies sent" value={totals.repliesSent} />
        <StatCard label="Replies delivered" value={totals.repliesDelivered} />
        <StatCard label="Delivery problems" value={totals.deliveryProblems} tone="error" />
        <StatCard label="Access problems" value={totals.accessProblems} tone="warning" />
      </section>

      <section aria-labelledby="agents-heading" className="overflow-hidden rounded-lg border border-border bg-surface">
        <h2 id="agents-heading" className="border-b border-border px-4 py-3 text-sm font-semibold">
          Agents <span className="font-normal text-text-muted">({agents ? agents.length : "—"})</span>
        </h2>
        {agents === null ? (
          <p className="p-4 text-sm text-text-muted">The agent list could not be loaded from the mail server.</p>
        ) : agents.length === 0 ? (
          <p className="p-4 text-sm text-text-muted">No agent mailboxes in {data.agentDomains.join(", ")}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Agent</th>
                  <th className="px-4 py-2 text-right font-medium">Received</th>
                  <th className="px-4 py-2 text-right font-medium">Junk</th>
                  <th className="px-4 py-2 text-right font-medium">Replies sent</th>
                  <th className="px-4 py-2 text-right font-medium">Errors</th>
                  <th className="px-4 py-2 text-right font-medium">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.address} className="border-t border-border hover:bg-surface-muted">
                    <td className="px-4 py-2">
                      <Link to={`/agents/${encodeURIComponent(agent.address)}`} className="font-medium text-brand hover:underline">
                        {agent.name ?? agent.address}
                      </Link>
                      {agent.name ? <div className="font-mono text-xs text-text-muted">{agent.address}</div> : null}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{agent.received}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{agent.junk}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{agent.repliesSent}</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${agent.errors ? "font-semibold text-error" : ""}`}>{agent.errors}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right text-text-muted">
                      {agent.lastActivity ? formatRelative(agent.lastActivity, now) : "—"}
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
