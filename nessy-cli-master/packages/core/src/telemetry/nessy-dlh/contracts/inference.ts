import * as crypto from 'node:crypto';
import { sendDlhEvents } from '../dlh-client.js';
import type { DlhAgentInference } from '../dlh-types.js';
import type { Config } from '../../../config/config.js';
import {
  getDlhConfig,
  getDlhPromptId,
  getDlhSessionId,
} from '../dlh-context.js';

const MAX_TEXT_LENGTH = 10_000_000;

function truncate(s: string): string {
  return s.length <= MAX_TEXT_LENGTH ? s : s.slice(0, MAX_TEXT_LENGTH);
}

export function recordDlhInference(
  opts: Omit<DlhAgentInference, 'inference_id'> & {
    inference_id?: string;
    config?: Config;
  },
): void {
  const { inference_id, config, prompt_id, session_id, ...rest } = opts;
  const effectiveConfig = getDlhConfig(config);

  sendDlhEvents(
    [
      {
        type: 'inference',
        data: {
          inference_id: inference_id || crypto.randomUUID(),
          session_id: session_id || getDlhSessionId(effectiveConfig),
          prompt_id: getDlhPromptId(prompt_id),
          ...rest,
          prompt_text: truncate(rest.prompt_text),
          model_response:
            rest.model_response !== null ? truncate(rest.model_response) : null,
        },
      },
    ],
    effectiveConfig,
  );
}
