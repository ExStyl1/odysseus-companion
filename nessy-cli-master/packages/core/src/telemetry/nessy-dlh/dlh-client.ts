import { buildNestorAuthHeaders } from '../../dp/nestor-auth-header.js';
import { NESTOR_SERVER_URL } from '../../core/openaiContentGenerator/constants.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { AuthType } from '../../core/contentGenerator.js';
import { getValidCredentials } from '../../dp/dp-token-manager.js';
import { performNessyAuth } from '../../dp/dp-auth-service.js';
import type { Config } from '../../config/config.js';
import type { DlhEvent } from './dlh-types.js';

const logger = createDebugLogger('NESSY-DLH');

const DLH_ENDPOINT = `${NESTOR_SERVER_URL}/api/v1/cli/dlh`;
const LOCAL_PROXY_URL =
  process.env['NESSY_DLG_PROXY_URL'] || 'http://localhost:8080';
const USE_LOCAL_PROXY = process.env['NESSY_DLG_PROXY'] === 'true';

logger.debug(
  `DLH client initialized: USE_LOCAL_PROXY=${USE_LOCAL_PROXY}, endpoint=${USE_LOCAL_PROXY ? LOCAL_PROXY_URL : DLH_ENDPOINT}`,
);

// [nessy-fork] dlh-non-dp-auth-telemetry
// Buffered queue with periodic delivery (mirrors StatistClient): events are
// enqueued and flushed by a single sender. Unlike Statist, a failed send keeps
// the batch in the queue so nothing is lost while the network is flaky.
const DLH_SEND_INTERVAL = 20 * 1000; // ms (same cadence as Statist)
const DLH_MAX_QUEUE_BYTES = 50 * 1024 * 1024; // 50 MB cap on total payload
let dlhQueueSize = 100; // max pending events; oldest dropped on overflow
let dlhQueueBytesLimit = DLH_MAX_QUEUE_BYTES;

/** Cached dp-auth JWT for non-DP_AUTH users, reused across sends. */
let cachedNonDpJwt: string | undefined;
/** Prevents repeated interactive dp-auth login attempts within one process after a failure. */
let suppressNonDpAuthLogin = false;

interface QueuedEvent {
  event: DlhEvent;
  bytes: number;
}

let pendingItems: QueuedEvent[] = [];
let pendingBytes = 0;
let lastConfig: Config | undefined;
let sendingPromise: Promise<void> | undefined;
let sendTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Enqueue events for delivery. Fire-and-forget: returns immediately and does
 * not block the caller; delivery happens in the background.
 */
export function sendDlhEvents(events: DlhEvent[], config?: Config): void {
  if (events.length === 0) return;

  lastConfig = config ?? lastConfig;
  for (const event of events) {
    enqueue(event);
  }

  ensureSender();
}

function enqueue(event: DlhEvent): void {
  const bytes = estimateEventBytes(event);
  pendingItems.push({ event, bytes });
  pendingBytes += bytes;

  // Drop the oldest events until both the count and total-size caps hold.
  while (
    pendingItems.length > dlhQueueSize ||
    pendingBytes > dlhQueueBytesLimit
  ) {
    const dropped = pendingItems.shift();
    if (!dropped) break;
    pendingBytes -= dropped.bytes;
  }
}

function estimateEventBytes(event: DlhEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), 'utf8');
  } catch {
    return 0;
  }
}

function ensureSender(): void {
  if (!sendTimer) {
    sendTimer = setInterval(() => {
      void drainQueue();
    }, DLH_SEND_INTERVAL);
  }
}

/**
 * Immediately run one drain round, sending whatever is queued. Safe no-op when
 * the queue is empty. Useful for tests and short-lived CLI commands that exit
 * before the periodic interval fires.
 */
export async function flushDlhQueue(): Promise<void> {
  await drainQueue();
}

async function drainQueue(): Promise<void> {
  if (sendingPromise) return sendingPromise;
  if (pendingItems.length === 0) return;

  // Assign the promise synchronously, before the first await, so a concurrent
  // drain (timer tick or shutdown flush) joins this round instead of starting
  // a duplicate send while the token is still being resolved.
  sendingPromise = (async () => {
    try {
      const token = await resolveDlhToken(lastConfig);
      if (!token) {
        // No usable token yet — keep events queued; they will flush once one
        // is available (e.g. after a successful login).
        return;
      }
      const batch = pendingItems.splice(0);
      pendingBytes = 0;
      const ok = await postEvents(
        batch.map((item) => item.event),
        token,
        lastConfig,
      );
      if (!ok) {
        pendingItems.unshift(...batch);
        // Use += so events enqueued while the send was in flight are still
        // counted toward the byte cap instead of being reset to just `batch`.
        pendingBytes += batch.reduce((sum, item) => sum + item.bytes, 0);
      }
    } finally {
      sendingPromise = undefined;
    }
  })();
  return sendingPromise;
}

async function postEvents(
  events: DlhEvent[],
  token: string,
  config?: Config,
): Promise<boolean> {
  const version = config?.getCliVersion() || 'unknown';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `NessyCLI/${version} (${process.platform}; ${process.arch})`,
    ...buildNestorAuthHeaders(token),
  };

  const endpoint = USE_LOCAL_PROXY ? LOCAL_PROXY_URL : DLH_ENDPOINT;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ events }),
      keepalive: true,
    });
    if (!res.ok) {
      logger.debug(`DLH send failed: ${res.status} ${res.statusText}`);
      return false;
    }
    logger.debug(
      `DLH events sent successfully: count=${events.length}, status=${res.status} ${res.statusText}`,
    );
    return true;
  } catch (e) {
    logger.debug('DLH send error:', e);
    return false;
  }
}

/**
 * Resolve the dp-auth token used to authenticate the DLH request.
 *
 * Prefers the active model's generation token on DP_AUTH. For custom models /
 * custom keys (the "gray zone" that bypasses the nestor backend) falls back to
 * stored dp-auth credentials, and if those are missing or expired attempts a
 * dp-auth login to obtain a fresh token. Returns undefined when no usable token
 * could be obtained.
 */
async function resolveDlhToken(config?: Config): Promise<string | undefined> {
  const authType = config?.getAuthType();
  if (authType === AuthType.DP_AUTH) {
    const apiKey = config?.getContentGeneratorConfig().apiKey;
    if (apiKey && apiKey !== 'DP_AUTH_DYNAMIC_TOKEN') {
      return apiKey;
    }
    return undefined;
  }

  if (cachedNonDpJwt) return cachedNonDpJwt;

  const stored = getValidCredentials()?.jwt;
  if (stored) {
    cachedNonDpJwt = stored;
    return stored;
  }

  if (suppressNonDpAuthLogin) return undefined;

  try {
    const { jwt } = await performNessyAuth(config);
    cachedNonDpJwt = jwt;
    return jwt;
  } catch (e) {
    suppressNonDpAuthLogin = true;
    logger.debug('DLH dp-auth login failed, suppressing further attempts:', e);
    return undefined;
  }
}

/** Reset cached token, queue, and auth state (useful for testing). */
export function resetDlhAuthState(): void {
  cachedNonDpJwt = undefined;
  suppressNonDpAuthLogin = false;
  pendingItems = [];
  pendingBytes = 0;
  sendingPromise = undefined;
  dlhQueueSize = 100;
  dlhQueueBytesLimit = DLH_MAX_QUEUE_BYTES;
  if (sendTimer) {
    clearInterval(sendTimer);
    sendTimer = undefined;
  }
}

/** Test-only hook to override the pending queue count limit. */
export function _setDlhQueueSize(size: number): void {
  dlhQueueSize = size;
}

/** Test-only hook to override the pending queue total-size (bytes) limit. */
export function _setDlhQueueBytes(bytes: number): void {
  dlhQueueBytesLimit = bytes;
}
