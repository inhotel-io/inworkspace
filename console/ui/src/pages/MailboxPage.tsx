import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { ThreadSummary, ThreadsResponse } from "@/lib/apiTypes";
import { formatAddress, formatDateTime, formatRelative } from "@/lib/format";
import { parsePosition } from "@/lib/params";
import type { ApiFailure } from "../api";
import { ErrorPanel } from "../components/ErrorPanel";
import { Loading } from "../components/Loading";
import { RefreshNote } from "../components/RefreshNote";
import { ThreadStatusChip } from "../components/ThreadStatusChip";
import { useConsole } from "../console";
import { useApi } from "../useApi";
import { useDocumentTitle } from "../useDocumentTitle";

/** How often an open mailbox checks for new mail. */
const REFRESH_MS = 30_000;

export function MailboxPage() {
  const { address = "" } = useParams();
  useDocumentTitle(address || "Mailbox");
  const [search] = useSearchParams();
  const position = parsePosition(search.get("position") ?? undefined);
  const mailboxPath = `/mailboxes/${encodeURIComponent(address)}`;
  const apiPath = `mailboxes/${encodeURIComponent(address)}/threads?position=${position}`;
  const result = useApi<ThreadsResponse>(apiPath, { refreshMs: REFRESH_MS });

  return (
    <main className="space-y-6">
      <header>
        <Link to="/" className="text-xs font-medium text-brand hover:underline">
          ← Overview
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{result.status === "ready" ? (result.data.mailbox.name ?? address) : address}</h1>
        {result.status === "ready" && result.data.mailbox.name ? <p className="font-mono text-sm text-text-muted">{address}</p> : null}
      </header>
      {result.status === "loading" ? (
        <Loading label="Opening the mailbox…" />
      ) : result.status === "error" ? (
        <ErrorPanel title={result.error.status === 404 ? "No such mailbox" : "The mailbox could not be read"} detail={result.error.message} />
      ) : (
        <Threads key={apiPath} page={result.data} loadedAt={result.loadedAt} refreshError={result.refreshError} mailboxPath={mailboxPath} />
      )}
    </main>
  );
}

/** The time of the newest activity among the threads, or null when there are none. */
function newestActivity(threads: ThreadSummary[]): number | null {
  return threads.length === 0 ? null : Math.max(...threads.map((thread) => Date.parse(thread.lastActivity)));
}

function Threads({
  page,
  loadedAt,
  refreshError,
  mailboxPath,
}: {
  page: ThreadsResponse;
  loadedAt: Date;
  refreshError: ApiFailure | null;
  mailboxPath: string;
}) {
  const { settings } = useConsole();
  // New mail always lands on the first page; activity after what it showed when it opened is new.
  const [seenUntil] = useState(() => newestActivity(page.threads));
  const { position, pageSize, total } = page;
  const isNew = (thread: ThreadSummary) => position === 0 && (seenUntil === null || Date.parse(thread.lastActivity) > seenUntil);
  const newCount = page.threads.filter(isNew).length;
  const note = <RefreshNote every="30 seconds" loadedAt={loadedAt} refreshError={refreshError} timeZone={settings.timeZone} />;

  if (page.threads.length === 0) {
    return (
      <div className="space-y-2">
        {note}
        <p className="rounded-lg border border-border bg-surface p-6 text-sm text-text-muted">This mailbox has no mail yet.</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-text-muted">
        All mail, newest first, from every folder; drafts and mail in Trash are marked.
        {newCount > 0 ? <span className="ml-2 font-medium text-brand">{newCount} new since you opened this page.</span> : null}
      </p>
      {note}
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
                    {isNew(thread) ? (
                      <span title="Since you opened this page" className="mr-2 rounded-full bg-brand px-2 py-0.5 text-xs font-medium text-surface">
                        New
                      </span>
                    ) : null}
                    <Link to={`${mailboxPath}/threads/${encodeURIComponent(thread.threadId)}`} className="font-medium text-text hover:text-brand hover:underline">
                      {thread.subject}
                    </Link>
                    <p className="mt-0.5 line-clamp-1 text-xs text-text-muted">
                      {thread.lastDirection === "outbound" && !thread.lastDraft ? "Sent: " : ""}
                      {thread.preview}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-text-muted">{formatAddress(thread.counterpart)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{thread.messageCount}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-text-muted" title={formatDateTime(thread.lastActivity, settings.timeZone)}>
                    {formatRelative(thread.lastActivity, loadedAt)}
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
            <Link to={`${mailboxPath}?position=${Math.max(0, position - pageSize)}`} className="ml-auto font-medium text-brand hover:underline">
              Newer
            </Link>
          ) : null}
          {position + pageSize < total ? (
            <Link to={`${mailboxPath}?position=${position + pageSize}`} className={`${position > 0 ? "" : "ml-auto "}font-medium text-brand hover:underline`}>
              Older
            </Link>
          ) : null}
        </nav>
      </section>
    </div>
  );
}
