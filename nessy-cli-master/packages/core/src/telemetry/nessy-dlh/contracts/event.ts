import * as crypto from 'node:crypto';
import { sendDlhEvents } from '../dlh-client.js';
import type { Config } from '../../../config/config.js';
import {
  getDlhConfig,
  getDlhOptionalPromptId,
  getDlhSessionId,
} from '../dlh-context.js';

/**
 * Sends a DLH `event` contract payload.
 *
 * Automatically uses sessionId and promptId from the current DLH context if available.
 * Falls back to explicitly provided parameters if called outside a context.
 *
 * @param type - event type name (e.g. 'slash_command')
 * @param payload - arbitrary event payload, will be JSON-serialised
 * @param promptId - optional prompt context (overrides context if provided)
 */
export function recordDlhEvent(
  type: string,
  payload: Record<string, unknown>,
  promptId?: string | null,
  config?: Config,
): void {
  const effectiveConfig = getDlhConfig(config);
  const payloadJson = JSON.stringify(payload);
  sendDlhEvents(
    [
      {
        type: 'event',
        data: {
          event_id: crypto.randomUUID(),
          session_id: getDlhSessionId(effectiveConfig),
          prompt_id: getDlhOptionalPromptId(promptId),
          type,
          payload_json: payloadJson,
          payload_json_length: payloadJson.length,
          client_created_at: Date.now(),
          sensitive_data_filtered: false,
        },
      },
    ],
    effectiveConfig,
  );
}
