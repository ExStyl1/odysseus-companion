import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../config/config.js';
import { emitDlhVisionBridge } from './vision-bridge.js';

const mockSendDlhEvents = vi.hoisted(() => vi.fn());

vi.mock('../dlh-client.js', () => ({
  sendDlhEvents: mockSendDlhEvents,
}));

describe('emitDlhVisionBridge', () => {
  beforeEach(() => {
    mockSendDlhEvents.mockReset();
  });

  it('reads the session ID from Config without losing its receiver', () => {
    const config = {
      sessionId: 'runtime-session',
      getSessionId(this: { sessionId: string }) {
        return this.sessionId;
      },
    } as unknown as Config;

    expect(() =>
      emitDlhVisionBridge(
        config,
        'vision-model',
        undefined,
        1,
        0,
        'success',
        null,
        42,
      ),
    ).not.toThrow();

    expect(mockSendDlhEvents).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          data: expect.objectContaining({
            session_id: 'runtime-session',
          }),
        }),
      ],
      config,
    );
  });

  it('emits with an unknown session ID when no session context is available', () => {
    const config = {
      getSessionId: () => 'unknown',
    } as unknown as Config;

    emitDlhVisionBridge(
      config,
      'vision-model',
      undefined,
      1,
      0,
      'success',
      null,
      42,
    );

    expect(mockSendDlhEvents).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          data: expect.objectContaining({
            session_id: 'unknown',
          }),
        }),
      ],
      config,
    );
  });

  it('does not let a telemetry error break the vision bridge', () => {
    const config = {
      sessionId: 'runtime-session',
      getSessionId(this: { sessionId: string }) {
        return this.sessionId;
      },
    } as unknown as Config;
    mockSendDlhEvents.mockImplementation(() => {
      throw new Error('telemetry failed');
    });

    expect(() =>
      emitDlhVisionBridge(
        config,
        'vision-model',
        undefined,
        1,
        0,
        'success',
        null,
        42,
      ),
    ).not.toThrow();
  });
});
