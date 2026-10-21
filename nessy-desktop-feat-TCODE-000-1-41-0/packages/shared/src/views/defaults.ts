/**
 * Default Views
 *
 * Built-in views provided to new workspaces (or when views.json is missing).
 * Users can modify or remove these — they're just the starting point.
 */

import type { ViewConfig } from './types.ts';

/**
 * Default views seeded into views.json.
 * Each represents a common session state that users want to see at a glance.
 */
export function getDefaultViews(): ViewConfig[] {
  return [
    {
      id: 'view-new',
      name: 'New',
      description: 'Sessions with unread messages',
      color: 'accent',
      expression: 'hasUnread == true',
    },
    {
      id: 'view-plan',
      name: 'Plan',
      description: 'Sessions with a pending plan awaiting approval',
      color: 'info',
      expression: 'hasPendingPlan == true',
    },
    {
      // F1.1172: the seeded Explore view, now Plan mode (F1.1050 retired explore). The id is kept so a
      // stored copy is recognisable; storage.ts rewrites one that still compares with explore or safe.
      id: 'view-explore',
      name: 'Plan mode',
      description: 'Sessions in Plan (read-only) mode',
      color: 'foreground/50',
      expression: 'permissionMode == "plan"',
    },
    {
      id: 'view-processing',
      name: 'Processing',
      description: 'Sessions where the agent is currently running',
      color: 'success',
      expression: 'isProcessing == true',
    },
  ];
}
