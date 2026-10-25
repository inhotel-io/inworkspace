/*
 * SPDX-FileCopyrightText: 2026 inWorkspace contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The views this build serves from the inWorkspace Console instead of the Enterprise-only server
 * endpoints, so they are not locked on the community edition. Who may open them is still decided by
 * the account's permissions.
 */
export function isReplicatedView(viewName: string): boolean {
  return (
    viewName === 'CustomComponent/Dashboard' ||
    viewName.startsWith('Dashboard/') ||
    viewName === 'CustomComponent/LiveTracing' ||
    viewName === 'x:Trace' ||
    viewName.startsWith('x:Trace/')
  );
}

/** Whether a JMAP request is for the traces the console serves. */
export function isTraceRequest(methodNames: readonly string[]): boolean {
  return methodNames.length > 0 && methodNames.every((name) => name.startsWith('x:Trace/'));
}
