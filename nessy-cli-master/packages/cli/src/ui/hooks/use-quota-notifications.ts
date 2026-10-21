/**
 * @license
 * Copyright 2025 Nessy team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  fetchUserQuota,
  type Config,
  type UserQuota,
} from '@nestor/nessy-cli-core';
import { t } from '../../i18n/index.js';
import { MessageType, StreamingState } from '../types.js';
import type { HistoryItemWithoutId } from '../types.js';

// [nessy-fork] user-quota-display
type QuotaNotificationState = 'warning' | 'error';

function getQuotaNotificationState(
  state: string,
): QuotaNotificationState | undefined {
  const normalizedState = state.toLowerCase();
  if (normalizedState === 'exhausted') return 'error';
  if (normalizedState === 'warning') return 'warning';
  return undefined;
}

interface UseQuotaNotificationsOptions {
  streamingState: StreamingState;
  sessionId: string;
  sessionPromptCount: number;
  currentModel: string;
  config: Config;
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void;
}

function quotaAppliesToModel(quota: UserQuota, currentModel: string): boolean {
  const scopeType = quota.scope.type.toLowerCase();
  if (scopeType !== 'model') return true;
  return quota.scope.values.includes(currentModel);
}

function quotaNotificationKey(quota: UserQuota): string {
  return `${quota.id}:${quota.scope.type}:${[...quota.scope.values].sort().join(',')}`;
}

/**
 * Checks quotas when a session starts and after completed model responses,
 * adding a warning to history for a new warning or exhausted state.
 */
export function useQuotaNotifications({
  streamingState,
  sessionId,
  sessionPromptCount,
  currentModel,
  config,
  addItem,
}: UseQuotaNotificationsOptions): void {
  const hadResponsePhase = useRef(false);
  const observedSessionId = useRef<string | undefined>(undefined);
  const lastCheckedPromptCount = useRef(sessionPromptCount);
  const lastObservedNotificationState = useRef(new Map<string, string>());
  const currentPromptCount = useRef(sessionPromptCount);
  const activeRequest = useRef<AbortController | undefined>(undefined);

  currentPromptCount.current = sessionPromptCount;

  const checkQuotas = useCallback(() => {
    activeRequest.current?.abort();

    const abortController = new AbortController();
    activeRequest.current = abortController;

    void fetchUserQuota(config, abortController.signal)
      .then((snapshot) => {
        if (abortController.signal.aborted) return;

        const nextObservedNotificationState = new Map<string, string>();
        let notificationState: QuotaNotificationState | undefined;

        for (const quota of snapshot.limits) {
          if (!quotaAppliesToModel(quota, currentModel)) continue;

          const quotaNotificationState = getQuotaNotificationState(
            quota.status.state,
          );
          const observedState = quotaNotificationState ?? 'normal';
          const notificationKey = quotaNotificationKey(quota);
          nextObservedNotificationState.set(notificationKey, observedState);

          if (
            quotaNotificationState &&
            lastObservedNotificationState.current.get(notificationKey) !==
              observedState
          ) {
            if (quotaNotificationState === 'error') {
              notificationState = 'error';
            } else if (!notificationState) {
              notificationState = 'warning';
            }
          }
        }

        lastObservedNotificationState.current = nextObservedNotificationState;
        if (!notificationState) return;

        addItem(
          {
            type:
              notificationState === 'error'
                ? MessageType.ERROR
                : MessageType.WARNING,
            text:
              notificationState === 'error'
                ? t('Quota is exhausted. Use /quota to view details.')
                : t(
                    'Quota limits are almost exhausted. Use /quota to view details.',
                  ),
          },
          Date.now(),
        );
      })
      .catch(() => {
        // Quota notifications are best-effort and must never disrupt a turn.
      })
      .finally(() => {
        if (activeRequest.current === abortController) {
          activeRequest.current = undefined;
        }
      });
  }, [config, addItem, currentModel]);

  useEffect(() => {
    const sessionChanged = observedSessionId.current !== sessionId;
    observedSessionId.current = sessionId;
    if (sessionChanged) {
      hadResponsePhase.current = false;
      lastCheckedPromptCount.current = currentPromptCount.current;
      lastObservedNotificationState.current = new Map();
    }
    checkQuotas();

    return () => {
      activeRequest.current?.abort();
    };
  }, [sessionId, checkQuotas]);

  useEffect(() => {
    if (streamingState === StreamingState.Responding) {
      hadResponsePhase.current = true;
    }

    const completedResponse =
      hadResponsePhase.current && streamingState === StreamingState.Idle;
    if (!completedResponse) return;
    hadResponsePhase.current = false;

    if (sessionPromptCount <= lastCheckedPromptCount.current) return;
    lastCheckedPromptCount.current = sessionPromptCount;
    checkQuotas();
  }, [streamingState, sessionPromptCount, checkQuotas]);
}
