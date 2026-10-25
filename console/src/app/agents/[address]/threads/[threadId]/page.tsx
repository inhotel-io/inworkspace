import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Loading } from "@/components/Loading";
import { ThreadStatusChip } from "@/components/ThreadStatusChip";
import { audit } from "@/lib/audit";
import { getConfig } from "@/lib/config";
import type { ThreadMessage } from "@/lib/conversations";
import { formatAddress, formatBytes, formatDateTime } from "@/lib/format";
import { getThread } from "@/lib/mailbox";
import { requireOperator } from "@/lib/operator";
import { decodeAddressParam, isThreadId } from "@/lib/params";
import { emailHtmlDocument } from "@/lib/sanitize";
import { findAgent, jmapClient, principalCredentials } from "@/lib/services";
import { settle } from "@/lib/settle";

export const metadata: Metadata = { title: "Conversation" };

type Props = PageProps<"/agents/[address]/threads/[threadId]">;

export default function ThreadPage({ params }: Props) {
  return (
    <main className="space-y-6">
      <Suspense fallback={<Loading label="Reading the conversation…" />}>
        <Thread params={params} />
      </Suspense>
    </main>
  );
}

async function Thread({ params }: Pick<Props, "params">) {
  const operator = await requireOperator();
  const { address, threadId } = await params;
  if (!isThreadId(threadId)) notFound();
  const agent = await findAgent(decodeAddressParam(address));
  if (!agent) notFound();
  audit({ operator: operator.email, agent: agent.address, threadId });

  const result = await settle(getThread(jmapClient(), principalCredentials(), agent.address, threadId));
  if (result.ok && result.value === null) notFound();
  const timeZone = getConfig().displayTimeZone;

  return (
    <>
      <header>
        <Link href={`/agents/${encodeURIComponent(agent.address)}`} className="text-xs font-medium text-brand hover:underline">
          ← {agent.name ?? agent.address}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {result.ok && result.value ? result.value[0]?.subject : "Conversation"}
        </h1>
      </header>
      {!result.ok ? (
        <ErrorPanel title="The conversation could not be read" detail={result.error} />
      ) : (
        <ol className="space-y-4">
          {(result.value ?? []).map((message) => (
            <li key={message.id}>
              <Message message={message} timeZone={timeZone} />
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function labelOf(message: ThreadMessage): string {
  if (message.draft) return "Draft, not sent";
  return message.direction === "outbound" ? "Agent reply" : "Inbound";
}

function Message({ message, timeZone }: { message: ThreadMessage; timeZone: string }) {
  const outbound = message.direction === "outbound" && !message.draft;
  return (
    <article
      className={`rounded-lg border p-4 ${outbound ? "border-brand/30 bg-brand-soft md:ml-16" : "border-border bg-surface md:mr-16"} ${message.draft || message.deleted ? "border-dashed opacity-75" : ""}`}
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{labelOf(message)}</span>
        {message.deleted ? (
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-medium text-text-muted">In Trash</span>
        ) : null}
        <span className="font-medium">{formatAddress(message.from[0])}</span>
        <span className="text-text-muted">to {message.to.map(formatAddress).join(", ") || "—"}</span>
        {message.cc.length > 0 ? <span className="text-text-muted">cc {message.cc.map(formatAddress).join(", ")}</span> : null}
        {message.junk ? <ThreadStatusChip status="junk" /> : null}
        {message.automated ? <ThreadStatusChip status="automated" /> : null}
        <time className="ml-auto text-xs text-text-muted" dateTime={message.receivedAt}>
          {formatDateTime(message.receivedAt, timeZone)}
        </time>
      </header>
      <p className="mt-1 text-sm font-medium">{message.subject}</p>
      <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{message.text || "(no text body)"}</pre>
      {message.truncated ? <p className="mt-2 text-xs text-text-muted">The body is longer than 256 KB and was cut.</p> : null}
      {message.html ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-brand">Show the formatted version</summary>
          <iframe
            title={`Formatted version of “${message.subject}”`}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={emailHtmlDocument(message.html)}
            className="mt-2 h-[480px] w-full rounded border border-border bg-white"
          />
        </details>
      ) : null}
      {message.attachments.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2 text-xs text-text-muted">
          {message.attachments.map((attachment, index) => (
            <li key={`${attachment.name}-${index}`} className="rounded border border-border bg-surface px-2 py-1">
              {attachment.name} · {formatBytes(attachment.size)}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
