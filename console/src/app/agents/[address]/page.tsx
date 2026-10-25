import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Loading } from "@/components/Loading";
import { ThreadStatusChip } from "@/components/ThreadStatusChip";
import { audit } from "@/lib/audit";
import { getConfig } from "@/lib/config";
import { formatAddress, formatDateTime, formatRelative } from "@/lib/format";
import { listThreads, THREAD_PAGE_SIZE } from "@/lib/mailbox";
import { requireOperator } from "@/lib/operator";
import { decodeAddressParam, parsePosition } from "@/lib/params";
import { findAgent, jmapClient, principalCredentials } from "@/lib/services";
import { settle } from "@/lib/settle";

export const metadata: Metadata = { title: "Conversations" };

type Props = PageProps<"/agents/[address]">;

export default function AgentPage({ params, searchParams }: Props) {
  return (
    <main className="space-y-6">
      <Suspense fallback={<Loading label="Opening the mailbox…" />}>
        <AgentThreads params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function AgentThreads({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const operator = await requireOperator();
  const agent = await findAgent(decodeAddressParam((await params).address));
  if (!agent) notFound();
  const position = parsePosition((await searchParams).position);
  audit({ operator: operator.email, agent: agent.address });

  const config = getConfig();
  const now = new Date();
  const result = await settle(listThreads(jmapClient(), principalCredentials(), agent.address, position));
  const agentPath = `/agents/${encodeURIComponent(agent.address)}`;

  return (
    <>
      <header>
        <Link href="/" className="text-xs font-medium text-brand hover:underline">
          ← Overview
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{agent.name ?? agent.address}</h1>
        <p className="font-mono text-sm text-text-muted">{agent.address}</p>
      </header>

      {!result.ok ? (
        <ErrorPanel title="The mailbox could not be read" detail={result.error} />
      ) : result.value.threads.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface p-6 text-sm text-text-muted">This mailbox has no conversations yet.</p>
      ) : (
        <section aria-label="Conversations" className="overflow-hidden rounded-lg border border-border bg-surface">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Conversation</th>
                  <th className="px-4 py-2 font-medium">With</th>
                  <th className="px-4 py-2 text-right font-medium">Messages</th>
                  <th className="px-4 py-2 text-right font-medium">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {result.value.threads.map((thread) => (
                  <tr key={thread.threadId} className="border-t border-border align-top hover:bg-surface-muted">
                    <td className="px-4 py-3">
                      <ThreadStatusChip status={thread.status} />
                    </td>
                    <td className="max-w-xl px-4 py-3">
                      <Link href={`${agentPath}/threads/${thread.threadId}`} className="font-medium text-text hover:text-brand hover:underline">
                        {thread.subject}
                      </Link>
                      <p className="mt-0.5 line-clamp-1 text-xs text-text-muted">
                        {thread.lastDirection === "outbound" ? "Agent: " : ""}
                        {thread.preview}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-text-muted">{formatAddress(thread.counterpart)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{thread.messageCount}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-text-muted" title={formatDateTime(thread.lastActivity, config.displayTimeZone)}>
                      {formatRelative(thread.lastActivity, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav aria-label="Pages" className="flex items-center gap-4 border-t border-border px-4 py-3 text-xs text-text-muted">
            <span>
              {position + 1}–{position + result.value.threads.length} of {result.value.total}
            </span>
            {position > 0 ? (
              <Link href={`${agentPath}?position=${Math.max(0, position - THREAD_PAGE_SIZE)}`} className="ml-auto font-medium text-brand hover:underline">
                Newer
              </Link>
            ) : null}
            {position + THREAD_PAGE_SIZE < result.value.total ? (
              <Link href={`${agentPath}?position=${position + THREAD_PAGE_SIZE}`} className={`${position > 0 ? "" : "ml-auto "}font-medium text-brand hover:underline`}>
                Older
              </Link>
            ) : null}
          </nav>
        </section>
      )}
    </>
  );
}
