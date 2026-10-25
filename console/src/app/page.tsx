import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ErrorPanel } from "@/components/ErrorPanel";
import { EventRow } from "@/components/EventRow";
import { Loading } from "@/components/Loading";
import { StatCard } from "@/components/StatCard";
import { getConfig } from "@/lib/config";
import { getPool } from "@/lib/db";
import { agentActivity, overviewCounts, queryEvents } from "@/lib/eventStore";
import { formatRelative } from "@/lib/format";
import { requireOperator } from "@/lib/operator";
import { getAgents } from "@/lib/services";
import { settle } from "@/lib/settle";

export const metadata: Metadata = { title: "Overview" };

const DAY_MS = 24 * 60 * 60 * 1000;

export default function OverviewPage() {
  return (
    <main className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-text-muted">Agent mail over the last 24 hours.</p>
      </header>
      <Suspense fallback={<Loading label="Counting the last 24 hours…" />}>
        <OverviewContent />
      </Suspense>
    </main>
  );
}

async function OverviewContent() {
  await requireOperator();
  const config = getConfig();
  const pool = getPool();
  const now = new Date();
  const since = new Date(now.getTime() - DAY_MS);
  const directory = await settle(getAgents());
  const agents = directory.ok ? directory.value : [];
  const addresses = agents.map((agent) => agent.address);
  const [counts, activity, errors] = await Promise.all([
    overviewCounts(pool, { since, agentAddresses: addresses, agentDomains: config.agentDomains }),
    agentActivity(pool, { since, agentAddresses: addresses }),
    queryEvents(pool, { severity: "error", limit: 20 }),
  ]);
  const activityByAddress = new Map(activity.map((row) => [row.address, row]));

  return (
    <>
      {directory.ok ? null : (
        <ErrorPanel title="The agent list is unavailable" detail={`${directory.error}. Per-agent counts are missing.`} />
      )}

      <section aria-label="Counts" className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
        <StatCard label="Received" value={counts.received} />
        <StatCard label="Filed as junk" value={counts.junk} tone="warning" />
        <StatCard label="Refused at SMTP" value={counts.refused} tone="warning" />
        <StatCard label="Replies sent" value={counts.repliesSent} />
        <StatCard label="Replies delivered" value={counts.repliesDelivered} />
        <StatCard label="Delivery problems" value={counts.deliveryProblems} tone="error" />
        <StatCard label="Access problems" value={counts.accessProblems} tone="warning" />
      </section>

      <section aria-labelledby="agents-heading" className="overflow-hidden rounded-lg border border-border bg-surface">
        <h2 id="agents-heading" className="border-b border-border px-4 py-3 text-sm font-semibold">
          Agents <span className="font-normal text-text-muted">({agents.length})</span>
        </h2>
        {agents.length === 0 ? (
          <p className="p-4 text-sm text-text-muted">No agent mailboxes in {config.agentDomains.join(", ")}.</p>
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
                {agents.map((agent) => {
                  const row = activityByAddress.get(agent.address);
                  return (
                    <tr key={agent.address} className="border-t border-border hover:bg-surface-muted">
                      <td className="px-4 py-2">
                        <Link href={`/agents/${encodeURIComponent(agent.address)}`} className="font-medium text-brand hover:underline">
                          {agent.name ?? agent.address}
                        </Link>
                        {agent.name ? <div className="font-mono text-xs text-text-muted">{agent.address}</div> : null}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{row?.received ?? 0}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{row?.junk ?? 0}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{row?.repliesSent ?? 0}</td>
                      <td className={`px-4 py-2 text-right tabular-nums ${row?.errors ? "font-semibold text-error" : ""}`}>{row?.errors ?? 0}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right text-text-muted">
                        {row?.lastActivity ? formatRelative(row.lastActivity, now) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="errors-heading" className="overflow-hidden rounded-lg border border-border bg-surface">
        <h2 id="errors-heading" className="flex items-center border-b border-border px-4 py-3 text-sm font-semibold">
          Recent errors
          <Link href="/events?severity=error" className="ml-auto text-xs font-medium text-brand hover:underline">
            All errors
          </Link>
        </h2>
        {errors.length === 0 ? (
          <p className="p-4 text-sm text-text-muted">No errors in the event store.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <tbody>
                {errors.map((event) => (
                  <EventRow key={event.id} event={event} timeZone={config.displayTimeZone} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
