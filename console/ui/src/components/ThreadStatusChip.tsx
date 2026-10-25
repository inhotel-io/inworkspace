import type { ThreadStatus } from "@/lib/conversations";

const STATUS: Record<ThreadStatus, { label: string; className: string }> = {
  "awaiting-reply": { label: "Awaiting reply", className: "bg-warning-soft text-warning" },
  junk: { label: "Junk", className: "bg-error-soft text-error" },
  automated: { label: "Automated", className: "bg-surface-sunken text-text-muted" },
  answered: { label: "Answered", className: "bg-brand-soft text-brand" },
};

export function ThreadStatusChip({ status }: { status: ThreadStatus }) {
  const { label, className } = STATUS[status];
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>;
}
