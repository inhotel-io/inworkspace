/*
 * SPDX-FileCopyrightText: 2026 inWorkspace contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Polled in place of the Enterprise server's event streams: a request every few seconds needs no
// long-lived connection, and carries the administrator's token like any other request.

import type { Metric, MetricId } from '@/features/dashboard/types/metrics';
import type { TraceEvent } from '@/features/tracing/types';
import { fetchLiveMetrics, fetchLiveTracing } from './consoleApi';

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

/** The live tracing interval: the server's own stream sends a batch about this often. */
export const TRACE_POLL_MS = 2000;
/** The live metrics interval: the dashboards ask the server's stream for one every 30 seconds. */
export const METRICS_POLL_MS = 30_000;
const FULL_PAGE = 500;

export function followTraceFeed(
  keywords: string,
  filters: readonly (readonly [string, string])[],
  handlers: FeedHandlers<TraceEvent>,
): Feed {
  let cursor: string | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const answer = await fetchLiveTracing(cursor, keywords, filters);
      if (closed) return;
      if (cursor === null) handlers.onOpen();
      cursor = answer.cursor;
      if (answer.events.length > 0) handlers.onData(answer.events);
      // A full page means more are waiting.
      timer = setTimeout(poll, answer.events.length >= FULL_PAGE ? 0 : TRACE_POLL_MS);
    } catch (error) {
      if (!closed) handlers.onError(error);
    }
  };
  void poll();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}

export function followLiveMetrics(ids: ReadonlySet<MetricId>, handlers: FeedHandlers<Metric>): Feed {
  let opened = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const answer = await fetchLiveMetrics([...ids]);
      if (closed) return;
      if (!opened) {
        opened = true;
        handlers.onOpen();
      }
      handlers.onData(answer.metrics);
      timer = setTimeout(poll, METRICS_POLL_MS);
    } catch (error) {
      if (!closed) handlers.onError(error);
    }
  };
  void poll();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}
