/*
 * SPDX-FileCopyrightText: 2026 inWorkspace contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// The inWorkspace Console's API, which collects the server's metrics and events and serves the
// Dashboard, Live Tracing and History pages in place of the Enterprise-only endpoints. Requests carry
// the signed-in administrator's own token; the console checks it with the server.

import i18n from '@/i18n';
import { refreshAccessToken } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { Metric, MetricId } from '@/features/dashboard/types/metrics';
import type { TraceEvent } from '@/features/tracing/types';
import type { JmapMethodCall, JmapMethodResponse } from '@/types/jmap';
import { useInsightsStore } from './insightsStore';

/** The console's page on this server; its settings name the API. */
const CONSOLE_PAGE = (import.meta.env.VITE_INWORKSPACE_CONSOLE_PAGE as string | undefined) || '/console/';

export class ConsoleApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ConsoleApiError';
    this.status = status;
  }
}

/** The API origin and path from the console page's settings; null when it names none, or not over https. */
export function apiUrlFromPage(html: string): string | null {
  const page = new DOMParser().parseFromString(html, 'text/html');
  const content = page.querySelector('meta[name="inworkspace-console-api"]')?.getAttribute('content')?.trim();
  if (!content) return null;
  try {
    const url = new URL(content);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

let apiUrl: Promise<string> | null = null;

export function consoleApiUrl(): Promise<string> {
  const override = import.meta.env.VITE_INWORKSPACE_CONSOLE_API as string | undefined;
  if (override) return Promise.resolve(override.replace(/\/+$/, ''));
  apiUrl ??= (async () => {
    let response: Response;
    try {
      response = await fetch(CONSOLE_PAGE, { cache: 'no-store', credentials: 'omit' });
    } catch {
      throw new ConsoleApiError(0, i18n.t('insights.consoleUnreachable', 'The inWorkspace Console could not be reached.'));
    }
    const url = response.ok ? apiUrlFromPage(await response.text()) : null;
    if (!url) {
      throw new ConsoleApiError(
        404,
        i18n.t(
          'insights.consoleMissing',
          'These pages need the inWorkspace Console, which is not installed on this server at {{page}}.',
          { page: CONSOLE_PAGE },
        ),
      );
    }
    return url;
  })().catch((error: unknown) => {
    apiUrl = null;
    throw error;
  });
  return apiUrl;
}

async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') return body.error.message;
  } catch {
    // not JSON
  }
  return i18n.t('insights.consoleFailed', 'The inWorkspace Console answered HTTP {{status}}.', { status: response.status });
}

export async function consoleFetch(path: string, init: RequestInit = {}): Promise<Response> {
  let base: string;
  try {
    base = await consoleApiUrl();
  } catch (error) {
    useInsightsStore.getState().setConsoleError(error instanceof Error ? error.message : String(error));
    throw error;
  }
  const store = useAuthStore.getState();
  if (store.isTokenExpiringSoon() && store.refreshToken) await refreshAccessToken();

  const send = () => {
    const headers = new Headers(init.headers);
    const { accessToken } = useAuthStore.getState();
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(`${base}${path}`, { ...init, headers, cache: 'no-store', credentials: 'omit' });
  };

  let response: Response;
  try {
    response = await send();
    if (response.status === 401 && useAuthStore.getState().refreshToken) {
      await refreshAccessToken();
      response = await send();
    }
  } catch (error) {
    const message = i18n.t('insights.consoleUnreachable', 'The inWorkspace Console could not be reached.');
    useInsightsStore.getState().setConsoleError(message);
    throw error instanceof ConsoleApiError ? error : new ConsoleApiError(0, message);
  }
  if (!response.ok) {
    const error = new ConsoleApiError(response.status, await messageOf(response));
    if (response.status !== 400) useInsightsStore.getState().setConsoleError(error.message);
    throw error;
  }
  useInsightsStore.getState().setConsoleError(null);
  return response;
}

export interface MetricsAnswer {
  metrics: Metric[];
  /** Requested metrics this server cannot provide. */
  unavailable: MetricId[];
  lastPushAt: string | null;
}

function metricParams(ids: readonly MetricId[]): URLSearchParams {
  const params = new URLSearchParams();
  for (const id of ids) params.append('metric', id);
  return params;
}

async function metricsFrom(response: Response): Promise<MetricsAnswer> {
  const answer = (await response.json()) as MetricsAnswer;
  useInsightsStore.getState().setMetricsAnswer(answer.unavailable, answer.lastPushAt);
  return answer;
}

/** History samples, as `x:Metric/query` and `x:Metric/get` would return them. */
export async function fetchMetricHistory(ids: readonly MetricId[], from: Date, to: Date): Promise<MetricsAnswer> {
  const params = metricParams(ids);
  params.set('from', from.toISOString());
  params.set('to', to.toISOString());
  return metricsFrom(await consoleFetch(`/api/v1/insights/metrics?${params}`));
}

/** The newest value of each gauge, as the live metrics stream would send them. */
export async function fetchLiveMetrics(ids: readonly MetricId[]): Promise<MetricsAnswer> {
  return metricsFrom(await consoleFetch(`/api/v1/insights/metrics/live?${metricParams(ids)}`));
}

/** Events after the cursor (none starts the feed), filtered as the live tracing stream would. */
export async function fetchLiveTracing(
  cursor: string | null,
  keywords: string,
  filters: readonly (readonly [string, string])[],
): Promise<{ cursor: string; events: TraceEvent[] }> {
  const params = new URLSearchParams();
  if (cursor !== null) params.set('after', cursor);
  if (keywords) params.set('filter', keywords);
  for (const [key, value] of filters) params.append(key, value);
  const response = await consoleFetch(`/api/v1/insights/tracing?${params}`);
  return (await response.json()) as { cursor: string; events: TraceEvent[] };
}

/** `x:Trace` method calls, answered by the console as the server would answer them. */
export async function traceJmap(methodCalls: JmapMethodCall[], signal?: AbortSignal): Promise<JmapMethodResponse[]> {
  const response = await consoleFetch('/api/v1/insights/jmap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }),
    signal,
  });
  const body = (await response.json()) as { methodResponses: JmapMethodResponse[] };
  return body.methodResponses;
}
