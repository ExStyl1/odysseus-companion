/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, UserQuotaSnapshot } from '@nestor/nessy-cli-core';
import { setLanguageAsync } from '../../i18n/index.js';
import { StreamingState } from '../types.js';

const { fetchUserQuota } = vi.hoisted(() => ({ fetchUserQuota: vi.fn() }));
vi.mock('@nestor/nessy-cli-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nestor/nessy-cli-core')>()),
  fetchUserQuota,
}));

import { useQuotaNotifications } from './use-quota-notifications.js';

const warningSnapshot: UserQuotaSnapshot = {
  schemaVersion: '1.0',
  generatedAt: '2026-08-20T10:00:00Z',
  limits: [
    {
      id: 'weekly',
      display: { title: 'Weekly quota' },
      scope: { type: 'account', values: ['current-user'] },
      usage: 0.9,
      status: {
        state: 'warning',
        message: 'Quota is almost exhausted.',
      },
    },
  ],
};

describe('useQuotaNotifications', () => {
  beforeEach(async () => {
    fetchUserQuota.mockReset();
    await setLanguageAsync('en');
  });

  it('checks quotas and shows a backend warning when a session starts', async () => {
    fetchUserQuota.mockResolvedValue(warningSnapshot);
    const addItem = vi.fn();
    const config = {} as Config;
    renderHook(() =>
      useQuotaNotifications({
        streamingState: StreamingState.Idle,
        sessionId: 'session-1',
        sessionPromptCount: 0,
        currentModel: 'model-a',
        config,
        addItem,
      }),
    );

    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(1));
    expect(fetchUserQuota).toHaveBeenCalledWith(
      config,
      expect.any(AbortSignal),
    );
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        text: 'Quota limits are almost exhausted. Use /quota to view details.',
      }),
      expect.any(Number),
    );
  });

  it('does not notify for an allowed quota', async () => {
    fetchUserQuota.mockResolvedValue({
      ...warningSnapshot,
      limits: [
        {
          ...warningSnapshot.limits[0],
          status: {
            state: 'allowed',
            message: 'Requests are available.',
          },
        },
      ],
    });
    const addItem = vi.fn();
    const config = {} as Config;
    renderHook(() =>
      useQuotaNotifications({
        streamingState: StreamingState.Idle,
        sessionId: 'session-1',
        sessionPromptCount: 0,
        currentModel: 'model-a',
        config,
        addItem,
      }),
    );

    await waitFor(() => expect(fetchUserQuota).toHaveBeenCalledTimes(1));
    expect(addItem).not.toHaveBeenCalled();
  });

  it('checks each model response but only notifies when notification state changes', async () => {
    fetchUserQuota
      .mockResolvedValueOnce({
        ...warningSnapshot,
        limits: [
          { ...warningSnapshot.limits[0], resetAt: '2026-08-20T12:00:00Z' },
        ],
      })
      .mockResolvedValueOnce({
        ...warningSnapshot,
        limits: [
          { ...warningSnapshot.limits[0], resetAt: '2026-08-20T13:00:00Z' },
        ],
      })
      .mockResolvedValueOnce({
        ...warningSnapshot,
        limits: [
          { ...warningSnapshot.limits[0], resetAt: '2026-08-20T14:00:00Z' },
        ],
      })
      .mockResolvedValueOnce({
        ...warningSnapshot,
        limits: [
          {
            ...warningSnapshot.limits[0],
            status: {
              state: 'exhausted',
              message: 'Quota is exhausted.',
            },
          },
        ],
      });
    const addItem = vi.fn();
    const config = {} as Config;
    const { rerender } = renderHook(
      ({ streamingState, sessionPromptCount }) =>
        useQuotaNotifications({
          streamingState,
          sessionId: 'session-1',
          sessionPromptCount,
          currentModel: 'model-a',
          config,
          addItem,
        }),
      {
        initialProps: {
          streamingState: StreamingState.Idle,
          sessionPromptCount: 0,
        },
      },
    );

    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(1));

    act(() =>
      rerender({
        streamingState: StreamingState.Responding,
        sessionPromptCount: 1,
      }),
    );
    act(() =>
      rerender({ streamingState: StreamingState.Idle, sessionPromptCount: 1 }),
    );
    await waitFor(() => expect(fetchUserQuota).toHaveBeenCalledTimes(2));

    act(() =>
      rerender({
        streamingState: StreamingState.Responding,
        sessionPromptCount: 2,
      }),
    );
    act(() =>
      rerender({ streamingState: StreamingState.Idle, sessionPromptCount: 2 }),
    );
    await waitFor(() => expect(fetchUserQuota).toHaveBeenCalledTimes(3));

    expect(addItem).toHaveBeenCalledTimes(1);

    act(() =>
      rerender({
        streamingState: StreamingState.Responding,
        sessionPromptCount: 3,
      }),
    );
    act(() =>
      rerender({ streamingState: StreamingState.Idle, sessionPromptCount: 3 }),
    );
    await waitFor(() => expect(fetchUserQuota).toHaveBeenCalledTimes(4));

    expect(addItem).toHaveBeenCalledTimes(2);
    expect(addItem).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'error',
        text: 'Quota is exhausted. Use /quota to view details.',
      }),
      expect.any(Number),
    );
  });

  it('does not check after a response-like UI transition without a new model prompt', async () => {
    fetchUserQuota.mockResolvedValue(warningSnapshot);
    const addItem = vi.fn();
    const config = {} as Config;
    const { rerender } = renderHook(
      ({ streamingState }) =>
        useQuotaNotifications({
          streamingState,
          sessionId: 'session-1',
          sessionPromptCount: 0,
          currentModel: 'model-a',
          config,
          addItem,
        }),
      { initialProps: { streamingState: StreamingState.Idle } },
    );

    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(1));

    act(() => rerender({ streamingState: StreamingState.Responding }));
    act(() => rerender({ streamingState: StreamingState.Idle }));

    expect(fetchUserQuota).toHaveBeenCalledTimes(1);
    expect(addItem).toHaveBeenCalledTimes(1);
  });

  it('checks a new session and resets the prompt-count baseline', async () => {
    fetchUserQuota.mockResolvedValue(warningSnapshot);
    const addItem = vi.fn();
    const config = {} as Config;
    const { rerender } = renderHook(
      ({ streamingState, sessionId, sessionPromptCount }) =>
        useQuotaNotifications({
          streamingState,
          sessionId,
          sessionPromptCount,
          currentModel: 'model-a',
          config,
          addItem,
        }),
      {
        initialProps: {
          streamingState: StreamingState.Idle,
          sessionId: 'session-1',
          sessionPromptCount: 5,
        },
      },
    );

    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(1));

    act(() =>
      rerender({
        streamingState: StreamingState.Idle,
        sessionId: 'session-2',
        sessionPromptCount: 0,
      }),
    );
    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(2));
    expect(fetchUserQuota).toHaveBeenCalledTimes(2);

    act(() =>
      rerender({
        streamingState: StreamingState.Responding,
        sessionId: 'session-2',
        sessionPromptCount: 1,
      }),
    );
    act(() =>
      rerender({
        streamingState: StreamingState.Idle,
        sessionId: 'session-2',
        sessionPromptCount: 1,
      }),
    );

    await waitFor(() => expect(fetchUserQuota).toHaveBeenCalledTimes(3));
  });

  it('notifies only for quotas applicable to the current model', async () => {
    fetchUserQuota.mockResolvedValue({
      ...warningSnapshot,
      limits: [
        {
          ...warningSnapshot.limits[0],
          id: 'model-a-quota',
          scope: { type: 'model', values: ['model-a'] },
        },
        {
          ...warningSnapshot.limits[0],
          id: 'model-b-quota',
          scope: { type: 'model', values: ['model-b'] },
          status: { state: 'exhausted', message: 'Quota is exhausted.' },
        },
      ],
    });
    const addItem = vi.fn();

    renderHook(() =>
      useQuotaNotifications({
        streamingState: StreamingState.Idle,
        sessionId: 'session-1',
        sessionPromptCount: 0,
        currentModel: 'model-a',
        config: {} as Config,
        addItem,
      }),
    );

    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(1));
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning' }),
      expect.any(Number),
    );
  });

  it('does not notify when no model-scoped quota applies', async () => {
    fetchUserQuota.mockResolvedValue({
      ...warningSnapshot,
      limits: [
        {
          ...warningSnapshot.limits[0],
          scope: { type: 'model', values: ['model-b'] },
          status: { state: 'exhausted', message: 'Quota is exhausted.' },
        },
      ],
    });
    const addItem = vi.fn();

    renderHook(() =>
      useQuotaNotifications({
        streamingState: StreamingState.Idle,
        sessionId: 'session-1',
        sessionPromptCount: 0,
        currentModel: 'model-a',
        config: {} as Config,
        addItem,
      }),
    );

    await waitFor(() => expect(fetchUserQuota).toHaveBeenCalledTimes(1));
    expect(addItem).not.toHaveBeenCalled();
  });

  it('preserves proactive notifications for non-model scopes', async () => {
    fetchUserQuota.mockResolvedValue({
      ...warningSnapshot,
      limits: [
        {
          ...warningSnapshot.limits[0],
          scope: { type: 'future-scope', values: ['model-a'] },
        },
      ],
    });
    const addItem = vi.fn();

    renderHook(() =>
      useQuotaNotifications({
        streamingState: StreamingState.Idle,
        sessionId: 'session-1',
        sessionPromptCount: 0,
        currentModel: 'model-a',
        config: {} as Config,
        addItem,
      }),
    );

    await waitFor(() => expect(fetchUserQuota).toHaveBeenCalledTimes(1));
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning' }),
      expect.any(Number),
    );
  });

  it('checks quotas again when the current model changes', async () => {
    fetchUserQuota.mockResolvedValue({
      ...warningSnapshot,
      limits: [
        {
          ...warningSnapshot.limits[0],
          scope: { type: 'model', values: ['model-b'] },
        },
      ],
    });
    const addItem = vi.fn();
    const config = {} as Config;
    const { rerender } = renderHook(
      ({ currentModel }) =>
        useQuotaNotifications({
          streamingState: StreamingState.Idle,
          sessionId: 'session-1',
          sessionPromptCount: 0,
          currentModel,
          config,
          addItem,
        }),
      { initialProps: { currentModel: 'model-a' } },
    );

    await waitFor(() => expect(fetchUserQuota).toHaveBeenCalledTimes(1));
    expect(addItem).not.toHaveBeenCalled();

    act(() => rerender({ currentModel: 'model-b' }));

    await waitFor(() => expect(fetchUserQuota).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(1));
  });

  it('does not repeat a non-model notification when the model changes', async () => {
    fetchUserQuota.mockResolvedValue(warningSnapshot);
    const addItem = vi.fn();
    const config = {} as Config;
    const { rerender } = renderHook(
      ({ currentModel }) =>
        useQuotaNotifications({
          streamingState: StreamingState.Idle,
          sessionId: 'session-1',
          sessionPromptCount: 0,
          currentModel,
          config,
          addItem,
        }),
      { initialProps: { currentModel: 'model-a' } },
    );

    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(1));

    act(() => rerender({ currentModel: 'model-b' }));

    await waitFor(() => expect(fetchUserQuota).toHaveBeenCalledTimes(2));
    expect(addItem).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale quota response after the current model changes', async () => {
    let resolveModelA: (snapshot: UserQuotaSnapshot) => void = () => {};
    let resolveModelB: (snapshot: UserQuotaSnapshot) => void = () => {};
    fetchUserQuota
      .mockImplementationOnce(
        () =>
          new Promise<UserQuotaSnapshot>((resolve) => {
            resolveModelA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<UserQuotaSnapshot>((resolve) => {
            resolveModelB = resolve;
          }),
      );
    const addItem = vi.fn();
    const config = {} as Config;
    const { rerender } = renderHook(
      ({ currentModel }) =>
        useQuotaNotifications({
          streamingState: StreamingState.Idle,
          sessionId: 'session-1',
          sessionPromptCount: 0,
          currentModel,
          config,
          addItem,
        }),
      { initialProps: { currentModel: 'model-a' } },
    );

    await waitFor(() => expect(fetchUserQuota).toHaveBeenCalledTimes(1));
    const modelASignal = fetchUserQuota.mock.calls[0]?.[1] as AbortSignal;

    act(() => rerender({ currentModel: 'model-b' }));

    await waitFor(() => expect(fetchUserQuota).toHaveBeenCalledTimes(2));
    expect(modelASignal.aborted).toBe(true);

    await act(async () => {
      resolveModelA({
        ...warningSnapshot,
        limits: [
          {
            ...warningSnapshot.limits[0],
            scope: { type: 'model', values: ['model-a'] },
            status: { state: 'exhausted', message: 'Quota is exhausted.' },
          },
        ],
      });
      await Promise.resolve();
    });
    expect(addItem).not.toHaveBeenCalled();

    await act(async () => {
      resolveModelB({
        ...warningSnapshot,
        limits: [
          {
            ...warningSnapshot.limits[0],
            scope: { type: 'model', values: ['model-b'] },
          },
        ],
      });
    });
    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(1));
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning' }),
      expect.any(Number),
    );
  });

  it('localizes notifications using the UI language', async () => {
    await setLanguageAsync('ru');
    fetchUserQuota.mockResolvedValue(warningSnapshot);
    const addItem = vi.fn();

    renderHook(() =>
      useQuotaNotifications({
        streamingState: StreamingState.Idle,
        sessionId: 'session-1',
        sessionPromptCount: 0,
        currentModel: 'model-a',
        config: {} as Config,
        addItem,
      }),
    );

    await waitFor(() =>
      expect(addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
          text: 'Лимиты по квотам подходят к концу. Используйте /quota, чтобы посмотреть подробности.',
        }),
        expect.any(Number),
      ),
    );
  });

  it('falls back to English for notifications in other UI languages', async () => {
    await setLanguageAsync('de');
    fetchUserQuota.mockResolvedValue(warningSnapshot);
    const addItem = vi.fn();

    renderHook(() =>
      useQuotaNotifications({
        streamingState: StreamingState.Idle,
        sessionId: 'session-1',
        sessionPromptCount: 0,
        currentModel: 'model-a',
        config: {} as Config,
        addItem,
      }),
    );

    await waitFor(() =>
      expect(addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
          text: 'Quota limits are almost exhausted. Use /quota to view details.',
        }),
        expect.any(Number),
      ),
    );
  });
});
