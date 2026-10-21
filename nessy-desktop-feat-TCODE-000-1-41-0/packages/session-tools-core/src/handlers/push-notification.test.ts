import { beforeEach, describe, expect, test } from 'bun:test';

import {
  canDeliverPushNotification,
  handlePushNotification,
  PUSH_NOTIFICATION_MAX_PER_WINDOW,
  PUSH_NOTIFICATION_WINDOW_MS,
  recordPushNotificationDelivery,
  resetPushNotificationRateLimit,
  secondsUntilPushNotificationSlot,
} from './push-notification.ts';
import type { DesktopNotificationResult, SessionToolContext } from '../context.ts';

function contextWith(result: DesktopNotificationResult, sessionId = 'sess-1') {
  const calls: Array<{ title?: string; body: string }> = [];
  const ctx = {
    sessionId,
    notificationPort: {
      notify: async (input: { title?: string; body: string }) => {
        calls.push(input);
        return result;
      },
    },
  } as unknown as SessionToolContext;
  return { ctx, calls };
}

beforeEach(() => {
  resetPushNotificationRateLimit();
});

describe('PushNotification', () => {
  test('delivers the model text and reports delivery', async () => {
    const { ctx, calls } = contextWith({ delivered: true });
    const result = await handlePushNotification(ctx, { message: 'Build finished.', title: 'nessy-desktop' });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([{ title: 'nessy-desktop', body: 'Build finished.' }]);
    expect(result.structuredContent).toEqual({ delivered: true });
  });

  test('a focused window suppresses the notification without failing the call', async () => {
    const { ctx } = contextWith({ delivered: false, reason: 'window-focused' });
    const result = await handlePushNotification(ctx, { message: 'Build finished.' });

    // Not an error: nothing went wrong, and the model must not retry.
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ delivered: false, reason: 'window-focused' });
    expect(result.content[0]!.text).toContain('already looking at');
  });

  test('a suppressed call does not consume the rate-limit budget', async () => {
    const { ctx } = contextWith({ delivered: false, reason: 'window-focused' });
    for (let index = 0; index < PUSH_NOTIFICATION_MAX_PER_WINDOW + 3; index += 1) {
      const result = await handlePushNotification(ctx, { message: `attempt ${index}` });
      expect(result.isError).toBe(false);
    }
    expect(canDeliverPushNotification('sess-1', Date.now())).toBe(true);
  });

  test('the rate limit refuses the call past the bound, per session', async () => {
    const { ctx, calls } = contextWith({ delivered: true });
    for (let index = 0; index < PUSH_NOTIFICATION_MAX_PER_WINDOW; index += 1) {
      expect((await handlePushNotification(ctx, { message: `finished ${index}` })).isError).toBe(false);
    }

    const refused = await handlePushNotification(ctx, { message: 'one too many' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('rate limited');
    // The port was never reached, so no OS notification was produced.
    expect(calls).toHaveLength(PUSH_NOTIFICATION_MAX_PER_WINDOW);

    // The bound is per session: a different session still has its full budget.
    const other = contextWith({ delivered: true }, 'sess-2');
    expect((await handlePushNotification(other.ctx, { message: 'from another session' })).isError).toBe(false);
  });

  test('the rate-limit window rolls forward', () => {
    const start = 1_000_000;
    for (let index = 0; index < PUSH_NOTIFICATION_MAX_PER_WINDOW; index += 1) {
      recordPushNotificationDelivery('sess-1', start + index);
    }
    expect(canDeliverPushNotification('sess-1', start + PUSH_NOTIFICATION_MAX_PER_WINDOW)).toBe(false);
    expect(secondsUntilPushNotificationSlot('sess-1', start)).toBe(PUSH_NOTIFICATION_WINDOW_MS / 1000);

    // Once the oldest delivery ages out, one slot opens — the cap is a rolling
    // window, not a permanent ceiling on the session.
    expect(canDeliverPushNotification('sess-1', start + PUSH_NOTIFICATION_WINDOW_MS)).toBe(true);
  });

  test('reports unavailability instead of pretending when no desktop shell is attached', async () => {
    const result = await handlePushNotification({ sessionId: 'sess-1' } as SessionToolContext, { message: 'hi' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unavailable');
  });

  test('an empty message is a tool error', async () => {
    const { ctx, calls } = contextWith({ delivered: true });
    const result = await handlePushNotification(ctx, { message: '   ' });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
