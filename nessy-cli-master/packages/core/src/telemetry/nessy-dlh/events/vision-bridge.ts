import { createHash } from 'node:crypto';
import type { Config } from '../../../config/config.js';
import { createDebugLogger } from '../../../utils/debugLogger.js';
import { promptIdContext } from '../../../utils/promptIdContext.js';
import { sendDlhEvents } from '../dlh-client.js';
import type { DlhEvent } from '../dlh-types.js';
import {
  getDlhConfig,
  getDlhOptionalPromptId,
  getDlhSessionId,
} from '../dlh-context.js';

const logger = createDebugLogger('VISION_BRIDGE_DLH');

/**
 * [nessy-fork] vision-bridge-dlh-event
 * Emit a DLH event for vision bridge execution.
 * Called when the bridge completes (success, error, or abort).
 */
export function emitDlhVisionBridge(
  config: Config,
  modelId: string,
  modelEndpoint: string | undefined,
  imagesSent: number,
  imagesOmitted: number,
  status: 'success' | 'error' | 'aborted',
  errorMessage: string | null,
  descriptionLength: number | null,
): void {
  const effectiveConfig = getDlhConfig(config);
  const sessionId = getDlhSessionId(effectiveConfig);

  // Get prompt ID from async local context
  const promptId = promptIdContext.getStore() ?? sessionId;

  const payload = {
    vision_bridge_id: createHash('sha256')
      .update(`${sessionId}:${promptId}:${Date.now()}`)
      .digest('hex')
      .slice(0, 16),
    model_id: modelId,
    model_endpoint: modelEndpoint ?? null,
    images_sent: imagesSent,
    images_omitted: imagesOmitted,
    status,
    error_message: errorMessage,
    description_length: descriptionLength,
  };

  const payloadJson = JSON.stringify(payload);

  const event: DlhEvent = {
    type: 'event',
    data: {
      event_id: createHash('sha256')
        .update(`${sessionId}:${promptId}:${Date.now()}:event`)
        .digest('hex')
        .slice(0, 16),
      session_id: sessionId,
      prompt_id: getDlhOptionalPromptId(promptId),
      type: 'vision_bridge',
      payload_json: payloadJson,
      payload_json_length: payloadJson.length,
      client_created_at: Date.now(),
      sensitive_data_filtered: false,
    },
  };

  try {
    sendDlhEvents([event], effectiveConfig);
  } catch (error) {
    logger.debug('Failed to emit vision bridge event:', error);
  }
}
