import { sendDlhEvents } from '../dlh-client.js';
import type { DlhAgentToolCall } from '../dlh-types.js';
import type { Config } from '../../../config/config.js';
import {
  getDlhConfig,
  getDlhPromptId,
  getDlhSessionId,
  getCurrentDlhContext,
} from '../dlh-context.js';

const MAX_TEXT_LENGTH = 100_000;

function truncate(s: string): string {
  return s.length <= MAX_TEXT_LENGTH ? s : s.slice(0, MAX_TEXT_LENGTH);
}

export function recordDlhToolCall(
  opts: Omit<DlhAgentToolCall, 'session_id'> & {
    config?: Config;
  },
): void {
  const { config, prompt_id, inference_id, ...rest } = opts;
  const effectiveConfig = getDlhConfig(config);
  const dlhContext = getCurrentDlhContext();

  sendDlhEvents(
    [
      {
        type: 'tool_call',
        data: {
          ...rest,
          session_id: getDlhSessionId(effectiveConfig),
          prompt_id: getDlhPromptId(prompt_id),
          inference_id: inference_id ?? dlhContext?.inferenceId ?? null,
          call_json: truncate(rest.call_json),
          response: rest.response !== null ? truncate(rest.response) : null,
        },
      },
    ],
    effectiveConfig,
  );
}
