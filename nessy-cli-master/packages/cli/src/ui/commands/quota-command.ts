import {
  fetchUserQuota,
  type UserQuota,
  type UserQuotaSnapshot,
} from '@nestor/nessy-cli-core';
import { t } from '../../i18n/index.js';
import { formatUserQuotaSnapshot } from '../utils/format-user-quota.js';
import type {
  MessageActionReturn,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';

// [nessy-fork] user-quota-display
export const quotaCommand: SlashCommand = {
  name: 'quota',
  get description() {
    return t('Show your current LLM usage and quotas');
  },
  kind: CommandKind.BUILT_IN,
  userInvocable: true,
  completionPriority: 100,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context): Promise<SlashCommandActionReturn | void> => {
    const config = context.services.config;
    if (!config) {
      return message(t('Quota information is unavailable.'));
    }

    if (context.executionMode === 'interactive') {
      context.ui.setPendingItem({
        type: 'info',
        text: t('Loading quotas...'),
      });
    }

    try {
      const snapshot = await fetchUserQuota(config, context.abortSignal);
      if (context.executionMode === 'acp') {
        return {
          type: 'stream_messages',
          messages: quotaMessages(snapshot),
        };
      }

      if (
        context.executionMode === 'interactive' &&
        snapshot.limits.length > 0
      ) {
        const timestamp = Date.now();
        snapshot.limits.forEach((quota, index) => {
          context.ui.addItem(
            {
              type: historyItemType(quota),
              text: formatUserQuotaSnapshot({
                ...snapshot,
                limits: [quota],
              }),
            },
            timestamp + index,
          );
        });
        return;
      }

      return message(
        formatUserQuotaSnapshot(snapshot),
        aggregateMessageType(snapshot),
      );
    } catch {
      return message(t('Failed to load quotas.'), 'error');
    } finally {
      if (context.executionMode === 'interactive') {
        context.ui.setPendingItem(null);
      }
    }
  },
};

async function* quotaMessages(snapshot: UserQuotaSnapshot): AsyncGenerator<{
  messageType: MessageActionReturn['messageType'];
  content: string;
}> {
  if (snapshot.limits.length === 0) {
    yield {
      messageType: 'info',
      content: formatUserQuotaSnapshot(snapshot),
    };
    return;
  }

  for (const [index, quota] of snapshot.limits.entries()) {
    const separator = index < snapshot.limits.length - 1 ? '\n\n' : '';
    yield {
      messageType: 'info',
      content:
        formatUserQuotaSnapshot({
          ...snapshot,
          limits: [quota],
        }) + separator,
    };
  }
}

function historyItemType(
  quota: UserQuota,
): 'success' | 'warning' | 'error' | 'info' {
  switch (quota.status.state.toLowerCase()) {
    case 'allowed':
      return 'success';
    case 'warning':
      return 'warning';
    case 'exhausted':
      return 'error';
    default:
      return 'info';
  }
}

function aggregateMessageType(
  snapshot: UserQuotaSnapshot,
): MessageActionReturn['messageType'] {
  const states = new Set(
    snapshot.limits.map((quota) => quota.status.state.toLowerCase()),
  );
  if (states.has('exhausted')) return 'error';
  if (states.has('warning')) return 'warning';
  return 'info';
}

function message(
  content: string,
  messageType: MessageActionReturn['messageType'] = 'info',
): MessageActionReturn {
  return { type: 'message', messageType, content };
}
