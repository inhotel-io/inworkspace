export function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-3 rounded-lg border border-border bg-surface p-6 text-sm text-text-muted">
      <span aria-hidden className="size-2 animate-pulse rounded-full bg-brand" />
      {label}
    </div>
  );
}
