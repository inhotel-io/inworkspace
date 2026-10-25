type Tone = "neutral" | "warning" | "error";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "text-text",
  warning: "text-warning",
  error: "text-error",
};

/** A count; warning and error tones only colour non-zero values. */
export function StatCard({ label, value, tone = "neutral" }: { label: string; value: number; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</p>
      <p className={`mt-2 text-3xl font-semibold tabular-nums ${TONE_CLASSES[value === 0 ? "neutral" : tone]}`}>
        {value.toLocaleString("en-US")}
      </p>
    </div>
  );
}
