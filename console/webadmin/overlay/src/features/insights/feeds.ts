/*
 * SPDX-FileCopyrightText: 2026 inWorkspace contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Polled in place of the Enterprise server's event streams: a request every few seconds needs no
// long-lived connection, and carries the administrator's token like any other request.

import type { Metric, MetricId } from '@/features/dashboard/types/metrics';
import type { TraceEvent } from '@/features/tracing/types';
import { ConsoleApiError, fetchLiveMetrics, fetchLiveTracing } from './consoleApi';

export interface Feed {
  close(): void;
}

interface FeedHandlers<T> {
  onData: (batch: T[]) => void;
  /** After the first answer. */
  onOpen: () => void;
  /** The feed has stopped; the caller decides whether to start another. */
  onError: (error: unknown) => void;
}

/** Where a trace feed has got to; a feed started with the same object continues from there. */
export interface FeedPosition {
  cursor: string | null;
}

/** The live tracing interval: the server's own stream sends a batch about this often. */
export const TRACE_POLL_MS = 2000;
/** The live metrics interval: the dashboards ask the server's stream for one every 30 seconds. */
export const METRICS_POLL_MS = 30_000;
/** Failed polls in a row that a feed rides out, waiting longer each time, before it stops. */
export const MAX_FAILURES = 5;
const MAX_BACKOFF_MS = 30_000;
const FULL_PAGE = 500;

/** A network failure, a rate limit or a server error may pass; a refusal will not. */
function isTransient(error: unknown): boolean {
  if (!(error instanceof ConsoleApiError)) return true;
  return error.status === 0 || error.status === 429 || error.status >= 500;
}

/** Why a feed stopped, when starting it again cannot help (a missing permission, no console); otherwise null. */
export function lastingFeedError(error: unknown): string | null {
  return isTransient(error) ? null : (error as ConsoleApiError).message;
}

/** Polls `fetch` until closed: `next` says when to poll again, failures back off, then stop it. */
function follow<A>(intervalMs: number, fetch: () => Promise<A>, next: (answer: A) => number, handlers: Pick<FeedHandlers<never>, 'onOpen' | 'onError'>): Feed {
  let closed = false;
  let opened = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (ms: number) => {
    if (!closed) timer = setTimeout(poll, ms);
  };
  async function poll() {
    if (closed) return;
    try {
      const answer = await fetch();
      if (closed) return;
      failures = 0;
      if (!opened) {
        opened = true;
        handlers.onOpen();
      }
      schedule(next(answer));
    } catch (error) {
      if (closed) return;
      failures += 1;
      if (!isTransient(error) || failures >= MAX_FAILURES) handlers.onError(error);
      else schedule(Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS));
    }
  }
  void poll();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}

export function followTraceFeed(
  keywords: string,
  filters: readonly (readonly [string, string])[],
  handlers: FeedHandlers<TraceEvent>,
  position: FeedPosition = { cursor: null },
): Feed {
  return follow(
    TRACE_POLL_MS,
    () => fetchLiveTracing(position.cursor, keywords, filters),
    (answer) => {
      position.cursor = answer.cursor;
      if (answer.events.length > 0) handlers.onData(answer.events);
      // A full page means more are waiting.
      return answer.events.length >= FULL_PAGE ? 0 : TRACE_POLL_MS;
    },
    handlers,
  );
}

export function followLiveMetrics(ids: ReadonlySet<MetricId>, handlers: FeedHandlers<Metric>): Feed {
  return follow(
    METRICS_POLL_MS,
    () => fetchLiveMetrics([...ids]),
    (answer) => {
      handlers.onData(answer.metrics);
      return METRICS_POLL_MS;
    },
    handlers,
  );
}
