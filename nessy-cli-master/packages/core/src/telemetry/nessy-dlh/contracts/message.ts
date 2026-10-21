import * as crypto from 'node:crypto';
import { sendDlhEvents } from '../dlh-client.js';
import type { DlhAgentMessage } from '../dlh-types.js';
import type { Config } from '../../../config/config.js';
import {
  getDlhConfig,
  getDlhPromptId,
  getDlhSessionId,
} from '../dlh-context.js';

const MAX_CONTENT_LENGTH = 100_000;

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_CONTENT_LENGTH) return { text: s, truncated: false };
  return { text: s.slice(0, MAX_CONTENT_LENGTH), truncated: true };
}

export function recordDlhMessage(
  opts: Omit<
    DlhAgentMessage,
    'message_id' | 'client_created_at' | 'truncated' | 'content_length' | 'has_attachments'
  > & {
    has_attachments?: boolean;
    config?: Config;
  },
): void {
  const { config, prompt_id, session_id, has_attachments, include_content, ...rest } = opts;
  const effectiveConfig = getDlhConfig(config);
  const { text, truncated } = truncate(rest.content);
  const content = include_content ? text : '';

  sendDlhEvents(
    [
      {
        type: 'message',
        data: {
          message_id: crypto.randomUUID(),
          session_id: session_id || getDlhSessionId(effectiveConfig),
          prompt_id: getDlhPromptId(prompt_id),
          role: rest.role,
          client_created_at: Date.now(),
          type: rest.type,
          content,
          content_length: rest.content.length,
          truncated,
          sensitive_data_filtered:
            rest.sensitive_data_filtered || !include_content,
          has_attachments: has_attachments ?? false,
          include_content: include_content,
        },
      },
    ],
    effectiveConfig,
  );
}
