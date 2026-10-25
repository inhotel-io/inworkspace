type Tone = "neutral" | "warning" | "error";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "text-text",
  warning: "text-warning",
  error: "text-error",
};

/** A count; warning and error tones only colour non-zero values, and null means it could not be computed. */
export function StatCard({ label, value, tone = "neutral" }: { label: string; value: number | null; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</p>
      {value === null ? (
        <p className="mt-2 text-3xl font-semibold text-text-muted" title="Unavailable without the agent list">
          —
        </p>
      ) : (
        <p className={`mt-2 text-3xl font-semibold tabular-nums ${TONE_CLASSES[value === 0 ? "neutral" : tone]}`}>
          {value.toLocaleString("en-US")}
        </p>
      )}
    </div>
  );
}
