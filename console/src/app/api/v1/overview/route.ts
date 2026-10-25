import { apiPreflight, apiRoute } from "@/lib/api";
import type { OverviewResponse } from "@/lib/apiTypes";
import { getConfig } from "@/lib/config";
import { getPool } from "@/lib/db";
import { agentActivity, overviewCounts, queryEvents } from "@/lib/eventStore";
import { getAgents } from "@/lib/services";
import { settle } from "@/lib/settle";

const DAY_MS = 24 * 60 * 60 * 1000;

export const GET = apiRoute(async (): Promise<OverviewResponse> => {
  const config = getConfig();
  const pool = getPool();
  const since = new Date(Date.now() - DAY_MS);
  const directory = await settle(getAgents());
  const agents = directory.ok ? directory.value : [];
  const [counts, activity, recentErrors] = await Promise.all([
    overviewCounts(pool, {
      since,
      agentAddresses: agents.map((agent) => agent.address),
      agentAccountIds: agents.flatMap((agent) => (agent.accountId === null ? [] : [agent.accountId])),
      agentDomains: config.agentDomains,
    }),
    agentActivity(pool, { since, agents }),
    queryEvents(pool, { severity: "error", limit: 20 }),
  ]);
  const byAddress = new Map(activity.map((row) => [row.address, row]));
  // Without the agent list, counts that need it would read as zero; report them as unknown instead.
  const perAgent = (value: number) => (directory.ok ? value : null);
  return {
    totals: {
      received: perAgent(counts.received),
      junk: perAgent(counts.junk),
      refused: counts.refused,
      repliesSent: perAgent(counts.repliesSent),
      repliesDelivered: perAgent(counts.repliesDelivered),
      deliveryProblems: perAgent(counts.deliveryProblems),
      accessProblems: counts.accessProblems,
    },
    agents: directory.ok
      ? agents.map((agent) => {
          const row = byAddress.get(agent.address);
          return {
            address: agent.address,
            name: agent.name,
            received: row?.received ?? 0,
            junk: row?.junk ?? 0,
            repliesSent: row?.repliesSent ?? 0,
            errors: row?.errors ?? 0,
            lastActivity: row?.lastActivity ?? null,
          };
        })
      : null,
    directoryError: directory.ok ? null : directory.error,
    agentDomains: config.agentDomains,
    recentErrors,
  };
});
export const OPTIONS = apiPreflight;
