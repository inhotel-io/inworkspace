/*
 * SPDX-FileCopyrightText: 2026 inWorkspace contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Info } from 'lucide-react';
import { useInsightsStore } from './insightsStore';

/** A push older than this means the server has stopped sending metrics. */
const STALE_MS = 10 * 60_000;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Above the dashboards: whether the console can be reached, and whether the server sends it metrics. */
export function InsightsStatus() {
  const { t } = useTranslation();
  const consoleError = useInsightsStore((s) => s.consoleError);
  const answered = useInsightsStore((s) => s.answered);
  const lastPushAt = useInsightsStore((s) => s.lastPushAt);
  const now = useNow(60_000);

  if (consoleError) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {consoleError}
      </div>
    );
  }
  if (!answered) return null;
  const pushed = lastPushAt ? new Date(lastPushAt) : null;
  if (pushed && now - pushed.getTime() < STALE_MS) return null;
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
      <Info className="h-4 w-4 shrink-0" />
      {pushed
        ? t('insights.metricsStale', 'The mail server has not sent metrics to the inWorkspace Console since {{time}}.', {
            time: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(pushed),
          })
        : t(
            'insights.metricsNever',
            'The mail server has not sent metrics to the inWorkspace Console yet. Its OpenTelemetry metrics push must point at the console.',
          )}
    </div>
  );
}

/** In place of a value the community edition does not export. */
export function NotCollected({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <p className={className ?? 'mt-1 text-xs text-muted-foreground'}>
      {t('insights.notCollected', 'Not exported by the community edition')}
    </p>
  );
}
