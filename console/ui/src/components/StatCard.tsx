import { Link } from "react-router";

type Tone = "neutral" | "warning" | "error";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "text-text",
  warning: "text-warning",
  error: "text-error",
};

const CARD_CLASSES = "rounded-lg border border-border bg-surface p-4";

/**
 * A count; warning and error tones only colour non-zero values, and null means it could not be computed.
 * With `to`, the card opens the events it counts.
 */
export function StatCard({ label, value, tone = "neutral", to }: { label: string; value: number | null; tone?: Tone; to?: string }) {
  const content = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
        {label}
        {/* Kept with the last word, so a long label wraps as the others do. */}
        {to ? <span aria-hidden="true">{"\u00a0→"}</span> : null}
      </p>
      {value === null ? (
        <p className="mt-2 text-3xl font-semibold text-text-muted" title="Unavailable without the mailbox list">
          —
        </p>
      ) : (
        <p className={`mt-2 text-3xl font-semibold tabular-nums ${TONE_CLASSES[value === 0 ? "neutral" : tone]}`}>
          {value.toLocaleString("en-US")}
        </p>
      )}
    </>
  );
  return to ? (
    <Link to={to} className={`block ${CARD_CLASSES} hover:border-brand/40 hover:bg-surface-muted`}>
      {content}
    </Link>
  ) : (
    <div className={CARD_CLASSES}>{content}</div>
  );
}
