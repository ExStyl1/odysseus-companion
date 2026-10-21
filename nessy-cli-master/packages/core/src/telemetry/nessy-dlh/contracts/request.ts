import { sendDlhEvents } from '../dlh-client.js';
import type { DlhAgentRequest } from '../dlh-types.js';
import { getDlhConfig, getDlhSessionId } from '../dlh-context.js';
import type { Config } from '../../../config/config.js';

export function recordDlhRequest(
  opts: Omit<DlhAgentRequest, 'session_id'>,
  config?: Config,
): void {
  const effectiveConfig = getDlhConfig(config);
  const data: DlhAgentRequest = {
    ...opts,
    session_id: getDlhSessionId(effectiveConfig),
  };
  sendDlhEvents([{ type: 'request', data }], effectiveConfig);
}
