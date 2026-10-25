/*
 * SPDX-FileCopyrightText: 2026 inWorkspace contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Schema } from '@/types/schema';
import { isLinkEnterprise, isLinkVisible } from '@/lib/layout';
import { apiUrlFromPage } from './consoleApi';
import { followTraceFeed, TRACE_POLL_MS } from './feeds';
import { allUnavailable } from './insightsStore';
import { isReplicatedView, isTraceRequest } from './replicated';

vi.mock('./consoleApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./consoleApi')>();
  return { ...actual, fetchLiveTracing: vi.fn(), fetchLiveMetrics: vi.fn() };
});
const { fetchLiveTracing } = await import('./consoleApi');

const schema = {
  objects: {
    'x:Trace': { type: 'object', description: 'Trace', permissionPrefix: 'sysTrace', enterprise: true },
    'x:Trace/InboundDelivery': { type: 'view', objectName: 'x:Trace' },
    'x:MetricsStore': { type: 'singleton', description: 'Store', permissionPrefix: 'sysMetricsStore', enterprise: true },
  },
  schemas: {},
  fields: {},
  forms: {},
  lists: {},
  enums: {},
  dashboards: [],
  layouts: [],
} as unknown as Schema;

describe('replicated views', () => {
  it('names the views this build serves from the console', () => {
    expect(isReplicatedView('CustomComponent/Dashboard')).toBe(true);
    expect(isReplicatedView('Dashboard/network')).toBe(true);
    expect(isReplicatedView('CustomComponent/LiveTracing')).toBe(true);
    expect(isReplicatedView('x:Trace/OutboundDelivery')).toBe(true);
    expect(isReplicatedView('x:MetricsStore')).toBe(false);
    expect(isReplicatedView('x:TracingStore')).toBe(false);
  });

  it('sends only all-trace requests to the console', () => {
    expect(isTraceRequest(['x:Trace/query', 'x:Trace/get'])).toBe(true);
    expect(isTraceRequest(['x:Trace/query', 'x:Account/get'])).toBe(false);
    expect(isTraceRequest([])).toBe(false);
  });

  it('unlocks them for the community edition, still behind permissions', () => {
    const all = () => true;
    for (const edition of ['community', 'oss']) {
      expect(isLinkEnterprise(schema, 'CustomComponent/Dashboard', edition)).toBe(false);
      expect(isLinkEnterprise(schema, 'x:Trace/InboundDelivery', edition)).toBe(false);
      expect(isLinkVisible(schema, 'CustomComponent/LiveTracing', edition, all, all)).toBe(true);
      expect(isLinkVisible(schema, 'x:Trace/InboundDelivery', edition, all, all)).toBe(true);
    }
    expect(isLinkEnterprise(schema, 'x:MetricsStore', 'community')).toBe(true);
    expect(isLinkVisible(schema, 'x:MetricsStore', 'oss', all, all)).toBe(false);
    expect(isLinkVisible(schema, 'CustomComponent/LiveTracing', 'community', all, (perm) => perm !== 'liveTracing')).toBe(false);
    expect(isLinkVisible(schema, 'CustomComponent/Dashboard', 'community', () => false, all)).toBe(false);
  });
});

describe('apiUrlFromPage', () => {
  const page = (content: string) => `<!doctype html><head><meta name="inworkspace-console-api" content="${content}" /></head>`;

  it("reads the API from the console's page", () => {
    expect(apiUrlFromPage(page('https://console-api.example.com'))).toBe('https://console-api.example.com');
    expect(apiUrlFromPage(page('https://example.com/console-api/'))).toBe('https://example.com/console-api');
    expect(apiUrlFromPage(page('http://localhost:3100'))).toBe('http://localhost:3100');
  });

  it('refuses a page without it, or an API that is not https', () => {
    expect(apiUrlFromPage('<!doctype html><title>Not found</title>')).toBeNull();
    expect(apiUrlFromPage(page('http://console-api.example.com'))).toBeNull();
    expect(apiUrlFromPage(page('javascript:alert(1)'))).toBeNull();
    expect(apiUrlFromPage(page('https://user:pass@console-api.example.com'))).toBeNull();
  });
});

describe('allUnavailable', () => {
  it('is true only when every metric is unavailable', () => {
    const unavailable = new Set(['store.data-read-time', 'store.data-write-time']);
    expect(allUnavailable(unavailable, ['store.data-read-time', 'store.data-write-time'])).toBe(true);
    expect(allUnavailable(unavailable, ['store.data-read-time', 'server.memory'])).toBe(false);
    expect(allUnavailable(unavailable, [])).toBe(false);
  });
});

describe('followTraceFeed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(fetchLiveTracing).mockReset();
  });

  it('polls from its cursor, opening once, until closed', async () => {
    const event = { event: 'smtp.ehlo', timestamp: '2026-10-26T09:00:00Z', keyValues: [] };
    vi.mocked(fetchLiveTracing)
      .mockResolvedValueOnce({ cursor: '5', events: [event] })
      .mockResolvedValueOnce({ cursor: '5', events: [] })
      .mockResolvedValue({ cursor: '6', events: [event] });
    const onData = vi.fn();
    const onOpen = vi.fn();
    const feed = followTraceFeed('jane', [['queueId', '7']], { onData, onOpen, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchLiveTracing).toHaveBeenLastCalledWith(null, 'jane', [['queueId', '7']]);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onData).toHaveBeenCalledWith([event]);
    await vi.advanceTimersByTimeAsync(TRACE_POLL_MS);
    expect(fetchLiveTracing).toHaveBeenLastCalledWith('5', 'jane', [['queueId', '7']]);
    expect(onData).toHaveBeenCalledOnce();
    feed.close();
    await vi.advanceTimersByTimeAsync(TRACE_POLL_MS * 3);
    expect(fetchLiveTracing).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('stops and reports when a poll fails', async () => {
    vi.mocked(fetchLiveTracing).mockRejectedValue(new Error('HTTP 503'));
    const onError = vi.fn();
    followTraceFeed('', [], { onData: vi.fn(), onOpen: vi.fn(), onError });
    await vi.advanceTimersByTimeAsync(TRACE_POLL_MS * 3);
    expect(onError).toHaveBeenCalledOnce();
    expect(fetchLiveTracing).toHaveBeenCalledOnce();
  });
});
