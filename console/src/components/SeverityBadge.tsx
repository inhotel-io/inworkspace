import type { Severity } from "@/lib/eventTypes";

const SEVERITY_CLASSES: Record<Severity, string> = {
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
  error: "bg-error-soft text-error",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${SEVERITY_CLASSES[severity]}`}>
      {severity}
    </span>
  );
}
