import type { Config } from '../../config/config.js';
import { NessyDlh } from './nessy-dlh.js';
import { createDebugLogger } from '../../utils/debugLogger.js';

const logger = createDebugLogger('NESSY-DLH-INIT');

export type { SlashCommandPayload } from './nessy-dlh.js';
export { NessyDlh } from './nessy-dlh.js';
export { flushDlhQueue } from './dlh-client.js';
export {
  runInDlhContext,
  runWithDlhCorrelation,
  getCurrentDlhContext,
  captureDlhCorrelation,
  incrementDlhTurn,
  updateDlhTurn,
  setDlhPromptId,
  getDlhConfig,
  getDlhSessionId,
  getDlhPromptId,
  getDlhOptionalPromptId,
  getDlhParentPromptId,
  getDlhParentToolCallId,
  createDlhContext,
  initializeDlhContext,
  type DlhContext,
  type DlhContextSnapshot,
} from './dlh-context.js';

let instance: NessyDlh | undefined;

/**
 * Initialize the DLH telemetry instance.
 * Should be called once when the config is loaded.
 * Creates instance but doesn't check authType yet - that's checked at send time.
 *
 * @param config - The configuration object
 */
export function initNessyDlh(config: Config): void {
  if (instance) {
    logger.debug('DLH already initialized, skipping');
    return;
  }
  
  logger.debug('Initializing DLH instance (authType checked at send time)');
  instance = new NessyDlh(config);
  logger.debug('DLH instance initialized successfully');
}

/**
 * Get the DLH telemetry instance.
 * Returns undefined if not initialized.
 */
export function getNessyDlh(): NessyDlh | undefined {
  return instance;
}

/**
 * Reset the DLH instance (useful for testing).
 */
export function resetNessyDlh(): void {
  instance = undefined;
}
