import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { ThreadsResponse } from "@/lib/apiTypes";
import { formatAddress, formatDateTime, formatRelative } from "@/lib/format";
import { parsePosition } from "@/lib/params";
import { ErrorPanel } from "../components/ErrorPanel";
import { Loading } from "../components/Loading";
import { ThreadStatusChip } from "../components/ThreadStatusChip";
import { useConsole } from "../console";
import { useApi } from "../useApi";
import { useDocumentTitle } from "../useDocumentTitle";

export function AgentPage() {
  useDocumentTitle("Conversations");
  const { address = "" } = useParams();
  const [search] = useSearchParams();
  const position = parsePosition(search.get("position") ?? undefined);
  const agentPath = `/agents/${encodeURIComponent(address)}`;
  const result = useApi<ThreadsResponse>(`agents/${encodeURIComponent(address)}/threads?position=${position}`);

  return (
    <main className="space-y-6">
      <header>
        <Link to="/" className="text-xs font-medium text-brand hover:underline">
          ← Overview
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{result.status === "ready" ? (result.data.agent.name ?? address) : address}</h1>
        {result.status === "ready" && result.data.agent.name ? <p className="font-mono text-sm text-text-muted">{address}</p> : null}
      </header>
      {result.status === "loading" ? (
        <Loading label="Opening the mailbox…" />
      ) : result.status === "error" ? (
        <ErrorPanel title={result.error.status === 404 ? "No such agent" : "The mailbox could not be read"} detail={result.error.message} />
      ) : (
        <Threads page={result.data} agentPath={agentPath} />
      )}
    </main>
  );
}

function Threads({ page, agentPath }: { page: ThreadsResponse; agentPath: string }) {
  const { settings } = useConsole();
  const [now] = useState(() => new Date());
  if (page.threads.length === 0) {
    return <p className="rounded-lg border border-border bg-surface p-6 text-sm text-text-muted">This mailbox has no conversations yet.</p>;
  }
  const { position, pageSize, total } = page;
  return (
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
            {page.threads.map((thread) => (
              <tr key={thread.threadId} className="border-t border-border align-top hover:bg-surface-muted">
                <td className="px-4 py-3">
                  <ThreadStatusChip status={thread.status} />
                </td>
                <td className="max-w-xl px-4 py-3">
                  <Link to={`${agentPath}/threads/${encodeURIComponent(thread.threadId)}`} className="font-medium text-text hover:text-brand hover:underline">
                    {thread.subject}
                  </Link>
                  <p className="mt-0.5 line-clamp-1 text-xs text-text-muted">
                    {thread.lastDirection === "outbound" ? "Agent: " : ""}
                    {thread.preview}
                  </p>
                </td>
                <td className="px-4 py-3 text-text-muted">{formatAddress(thread.counterpart)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{thread.messageCount}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-text-muted" title={formatDateTime(thread.lastActivity, settings.timeZone)}>
                  {formatRelative(thread.lastActivity, now)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav aria-label="Pages" className="flex items-center gap-4 border-t border-border px-4 py-3 text-xs text-text-muted">
        <span>
          {position + 1}–{position + page.threads.length} of {total}
        </span>
        {position > 0 ? (
          <Link to={`${agentPath}?position=${Math.max(0, position - pageSize)}`} className="ml-auto font-medium text-brand hover:underline">
            Newer
          </Link>
        ) : null}
        {position + pageSize < total ? (
          <Link to={`${agentPath}?position=${position + pageSize}`} className={`${position > 0 ? "" : "ml-auto "}font-medium text-brand hover:underline`}>
            Older
          </Link>
        ) : null}
      </nav>
    </section>
  );
}
