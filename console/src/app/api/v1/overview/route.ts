import { apiPreflight, apiRoute } from "@/lib/api";
import type { OverviewResponse } from "@/lib/apiTypes";
import { getConfig } from "@/lib/config";
import { getPool } from "@/lib/db";
import { mailboxActivity, overviewCounts, queryEvents } from "@/lib/eventStore";
import { getMailboxes } from "@/lib/services";
import { settle } from "@/lib/settle";

const DAY_MS = 24 * 60 * 60 * 1000;

export const GET = apiRoute(async (): Promise<OverviewResponse> => {
  const config = getConfig();
  const pool = getPool();
  const since = new Date(Date.now() - DAY_MS);
  const directory = await settle(getMailboxes());
  const mailboxes = directory.ok ? directory.value.mailboxes : [];
  // Refusals count for the listed domains: the configured ones, or every domain the server has.
  const domains = directory.ok ? directory.value.domains : config.mailboxDomains;
  const [counts, activity, recentErrors] = await Promise.all([
    overviewCounts(pool, {
      since,
      addresses: mailboxes.map((mailbox) => mailbox.address),
      accountIds: mailboxes.flatMap((mailbox) => (mailbox.accountId === null ? [] : [mailbox.accountId])),
      domains,
    }),
    mailboxActivity(pool, { since, mailboxes }),
    queryEvents(pool, { severity: "error", limit: 20 }),
  ]);
  const byAddress = new Map(activity.map((row) => [row.address, row]));
  // Without the mailbox list, counts that need it would read as zero; report them as unknown instead.
  const listed = (value: number) => (directory.ok ? value : null);
  return {
    totals: {
      received: listed(counts.received),
      junk: listed(counts.junk),
      refused: counts.refused,
      sent: listed(counts.sent),
      delivered: listed(counts.delivered),
      deliveryProblems: listed(counts.deliveryProblems),
      accessProblems: counts.accessProblems,
    },
    mailboxes: directory.ok
      ? mailboxes.map((mailbox) => {
          const row = byAddress.get(mailbox.address);
          return {
            address: mailbox.address,
            name: mailbox.name,
            received: row?.received ?? 0,
            junk: row?.junk ?? 0,
            sent: row?.sent ?? 0,
            errors: row?.errors ?? 0,
            lastActivity: row?.lastActivity ?? null,
          };
        })
      : null,
    directoryError: directory.ok ? null : directory.error,
    domains,
    recentErrors,
  };
});
export const OPTIONS = apiPreflight;
