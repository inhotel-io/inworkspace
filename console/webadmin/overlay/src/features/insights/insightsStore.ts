/*
 * SPDX-FileCopyrightText: 2026 inWorkspace contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { create } from 'zustand';

interface InsightsState {
  /** Metrics this server cannot provide, as the console reported them. */
  unavailable: ReadonlySet<string>;
  /** When the server last pushed its metrics to the console; null if it never did. */
  lastPushAt: string | null;
  /** Whether the console has answered a metrics request yet. */
  answered: boolean;
  consoleError: string | null;
  setMetricsAnswer: (unavailable: readonly string[], lastPushAt: string | null) => void;
  setConsoleError: (error: string | null) => void;
}

export const useInsightsStore = create<InsightsState>()((set) => ({
  unavailable: new Set(),
  lastPushAt: null,
  answered: false,
  consoleError: null,
  setMetricsAnswer: (unavailable, lastPushAt) =>
    set((state) => ({
      unavailable: new Set([...state.unavailable, ...unavailable]),
      lastPushAt,
      answered: true,
    })),
  setConsoleError: (consoleError) => set((state) => (state.consoleError === consoleError ? state : { consoleError })),
}));

/** Whether every one of these metrics is one the server cannot provide. */
export function allUnavailable(unavailable: ReadonlySet<string>, metrics: readonly string[]): boolean {
  return metrics.length > 0 && metrics.every((id) => unavailable.has(id));
}
