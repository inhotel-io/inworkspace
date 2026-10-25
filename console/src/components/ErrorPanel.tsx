export function ErrorPanel({ title, detail }: { title: string; detail: string }) {
  return (
    <div role="alert" className="rounded-lg border border-error/30 bg-error-soft p-4 text-sm">
      <p className="font-medium text-error">{title}</p>
      <p className="mt-1 text-text-muted">{detail}</p>
    </div>
  );
}
