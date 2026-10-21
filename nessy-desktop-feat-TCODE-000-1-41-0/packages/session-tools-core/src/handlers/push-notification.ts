/**
 * `PushNotification` (R27a) — reach the user who stepped away.
 *
 * Contract, read from the raw markdown of `tools-reference.md:41`:
 *
 * > Sends a desktop notification, and a phone push when Remote Control is
 * > connected, so a long-running task or scheduled task can reach you when you
 * > step away. … Push delivery runs through Anthropic-hosted infrastructure,
 * > which is not accessible from Amazon Bedrock, Google Cloud's Agent Platform,
 * > or Microsoft Foundry.
 *
 * The provider gate is NOT ported. Read what it is a gate on: the hop to a
 * phone. We are a desktop app — the session runs on the user's own machine, so
 * the desktop half needs no hosted infrastructure and no provider is excluded
 * from it. The phone-push half is inapplicable here, not missing.
 *
 * The doc names no input fields for this tool, so `title`/`message` are ours.
 * `title` is optional; the host substitutes the session's own name.
 *
 * This is a wrapper over the notification surface the app already has
 * (`apps/electron/src/main/notifications.ts`), not a second notification path.
 */
import type { DesktopNotificationResult, SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse } from '../response.ts';
import { PushNotificationSchema } from '../tool-defs.ts';

/**
 * The bound on OS notifications one session can produce.
 *
 * A model in a loop must not be able to emit an unbounded stream of them, and
 * OS notification centres have no back-pressure of their own. Five in five
 * minutes is far above any legitimate use — the documented use is "a
 * long-running task finished", which happens once — and far below the rate at
 * which a stuck loop would become a denial of service against the user's
 * desktop.
 *
 * Only DELIVERED notifications count against the budget. A call suppressed
 * because the user is already looking at the window produced no OS
 * notification, so charging the budget for it would let a focused session
 * exhaust its quota without the user ever seeing anything.
 */
export const PUSH_NOTIFICATION_MAX_PER_WINDOW = 5;
export const PUSH_NOTIFICATION_WINDOW_MS = 5 * 60_000;

/** Delivery timestamps per session, newest last. Trimmed on every read. */
const deliveries = new Map<string, number[]>();

function recentDeliveries(sessionId: string, now: number): number[] {
  const kept = (deliveries.get(sessionId) ?? []).filter(at => now - at < PUSH_NOTIFICATION_WINDOW_MS);
  if (kept.length === 0) deliveries.delete(sessionId);
  else deliveries.set(sessionId, kept);
  return kept;
}

/** Whether the session may deliver one more notification at `now`. */
export function canDeliverPushNotification(sessionId: string, now: number): boolean {
  return recentDeliveries(sessionId, now).length < PUSH_NOTIFICATION_MAX_PER_WINDOW;
}

/** Charge one delivered notification against the session's budget. */
export function recordPushNotificationDelivery(sessionId: string, now: number): void {
  deliveries.set(sessionId, [...recentDeliveries(sessionId, now), now]);
}

/** Seconds until the oldest delivery in the window ages out. */
export function secondsUntilPushNotificationSlot(sessionId: string, now: number): number {
  const window = recentDeliveries(sessionId, now);
  const oldest = window[0];
  if (oldest === undefined) return 0;
  return Math.max(1, Math.ceil((PUSH_NOTIFICATION_WINDOW_MS - (now - oldest)) / 1000));
}

/** Drop all rate-limit state. Sessions are long-lived; tests are not. */
export function resetPushNotificationRateLimit(): void {
  deliveries.clear();
}

function outcome(text: string, result: DesktopNotificationResult): ToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: { delivered: result.delivered, ...(result.reason ? { reason: result.reason } : {}) },
    isError: false,
  };
}

export async function handlePushNotification(
  ctx: SessionToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = PushNotificationSchema.safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return errorResponse(`PushNotification input is invalid — ${detail}`);
  }

  const port = ctx.notificationPort;
  if (!port) return errorResponse('PushNotification is unavailable for this backend.');

  const now = Date.now();
  if (!canDeliverPushNotification(ctx.sessionId, now)) {
    const wait = secondsUntilPushNotificationSlot(ctx.sessionId, now);
    return errorResponse(
      `PushNotification is rate limited: at most ${PUSH_NOTIFICATION_MAX_PER_WINDOW} notifications`
      + ` per ${PUSH_NOTIFICATION_WINDOW_MS / 60_000} minutes per session.`
      + ` The next one can be sent in ${wait}s. Do not retry in a loop.`,
    );
  }

  let result: DesktopNotificationResult;
  try {
    result = await port.notify({ title: parsed.data.title, body: parsed.data.message });
  } catch (error) {
    return errorResponse(
      `PushNotification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!result.delivered) {
    // Not an error: nothing went wrong. The model is told WHY, because
    // "the user is already watching" and "notifications are off" call for
    // different next moves.
    const because = result.reason === 'window-focused'
      ? 'the user is already looking at this session\'s window'
      : result.reason === 'notifications-disabled'
        ? 'the user has notifications turned off'
        : 'no desktop shell is attached to this session';
    return outcome(`No notification was shown because ${because}.`, result);
  }

  recordPushNotificationDelivery(ctx.sessionId, now);
  return outcome('Desktop notification shown.', result);
}
