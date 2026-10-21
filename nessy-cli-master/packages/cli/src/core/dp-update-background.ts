/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

// [nessy-fork] dp-binary-lifecycle

import {
  checkForDpUpdateAvailable,
  createDebugLogger,
  installDpVersion,
  tryAsyncDpUpdate,
  type DpUpdateInfo,
} from '@nestor/nessy-cli-core';
import { t } from '../i18n/index.js';
import { updateEventEmitter } from '../utils/updateEventEmitter.js';

const debugLogger = createDebugLogger('DP_UPDATE');

let checkRequest: Promise<void> | undefined;

/**
 * Check for and apply a dp update in the background.
 *
 * Fire-and-forget: never blocks startup. Uses the shared update event emitter
 * so a TUI subscriber (`setUpdateHandler`) renders a notification when a new
 * version is found and when the update finishes. Concurrent callers share a
 * single inflight run so parallel entry points cannot start two `dp update`
 * processes over the same binary.
 */
export function startBackgroundDpUpdate(): void {
  if (checkRequest) {
    return;
  }
  checkRequest = runBackgroundCheck().finally(() => {
    checkRequest = undefined;
  });
}

async function runBackgroundCheck(): Promise<void> {
  let info: DpUpdateInfo | null = null;
  try {
    info = await checkForDpUpdateAvailable();
  } catch (error) {
    debugLogger.warn('Failed to check for dp update:', error);
  }
  if (!info) {
    return;
  }

  const versionParams = { current: info.current, latest: info.latest };
  // 'update-info' renders immediately (unlike 'update-received', which is
  // suppressed by a fast subsequent success), so the user learns about the
  // newer version before the background update finishes.
  updateEventEmitter.emit('update-info', {
    message: t(
      'A new version of the dp CLI is available ({{current}} → {{latest}}). Updating in the background...',
      versionParams,
    ),
  });

  const ok =
    (await tryAsyncDpUpdate()) ||
    // [nessy-fork] dp-update-fallback-workaround
    // `dp update` may fail on some networks even though the direct download
    // URL works. Fall back to downloading the new version directly. Remove
    // once `dp update` is fixed on those networks.
    (await installDpVersion(info.latest));
  if (ok) {
    updateEventEmitter.emit('update-success', {
      message: t('dp CLI updated: {{current}} → {{latest}}.', versionParams),
    });
  } else {
    updateEventEmitter.emit('update-failed', {
      message: t(
        'Automatic dp update failed. You can run `dp update` manually to retry.',
      ),
    });
  }
}