/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useDaemonWorkspaceActions } from '../DaemonWorkspaceProvider.js';

export function useDaemonGlob() {
  const workspaceActions = useDaemonWorkspaceActions();
  return {
    globWorkspace: workspaceActions.globWorkspace,
  };
}
