import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import { AuthType } from '../../core/contentGenerator.js';
import type { DlhEvent } from './dlh-types.js';
import {
  sendDlhEvents,
  flushDlhQueue,
  resetDlhAuthState,
  _setDlhQueueSize,
  _setDlhQueueBytes,
} from './dlh-client.js';

const { debugLogger, getValidCredentials, performNessyAuth } = vi.hoisted(
  () => ({
    debugLogger: {
      isEnabled: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getValidCredentials: vi.fn(),
    performNessyAuth: vi.fn(),
  }),
);

vi.mock('../../utils/debugLogger.js', () => ({
  createDebugLogger: () => debugLogger,
}));

vi.mock('../../dp/dp-token-manager.js', () => ({
  getValidCredentials,
}));

vi.mock('../../dp/dp-auth-service.js', () => ({
  performNessyAuth,
}));

const DLH_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/dlh';

function createConfig(apiKey?: string, authType = AuthType.DP_AUTH): Config {
  return {
    getAuthType: () => authType,
    getCliVersion: () => '1.2.3',
    getContentGeneratorConfig: () => ({ apiKey }),
  } as unknown as Config;
}

function sentEvents(): DlhEvent[] {
  const call = vi.mocked(fetch).mock.calls[0];
  return (JSON.parse(call?.[1]?.body as string) as { events: DlhEvent[] })
    .events;
}

// [nessy-fork] dlh-non-dp-auth-telemetry
describe('sendDlhEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getValidCredentials.mockReturnValue(null);
    performNessyAuth.mockReset();
    resetDlhAuthState();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('sends events using Nestor-Token for the backend-exchanged JWT', async () => {
    sendDlhEvents([event('a')], createConfig('backend-exchanged-jwt'));
    await flushDlhQueue();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      DLH_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          'Nestor-Token': 'backend-exchanged-jwt',
        }),
      }),
    );
  });

  it('logs successful delivery with the event count', async () => {
    sendDlhEvents([event('a')], createConfig('backend-exchanged-jwt'));
    await flushDlhQueue();

    expect(debugLogger.debug).toHaveBeenCalledWith(
      'DLH events sent successfully: count=1, status=200 OK',
    );
  });

  it('logs failed delivery without success log', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    } as Response);

    sendDlhEvents([event('a')], createConfig('backend-exchanged-jwt'));
    await flushDlhQueue();

    expect(debugLogger.debug).toHaveBeenCalledWith(
      'DLH send failed: 401 Unauthorized',
    );
    expect(debugLogger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('DLH events sent successfully'),
    );
  });

  it('uses Bearer auth for the delegated environment token', async () => {
    vi.stubEnv('NESSY_CLI_DP_AUTH_TOKEN', 'delegated-jwt');

    sendDlhEvents([event('a')], createConfig('delegated-jwt'));
    await flushDlhQueue();

    expect(fetch).toHaveBeenCalledWith(
      DLH_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer delegated-jwt',
        }),
      }),
    );
  });

  it('does not send without the current DP auth token', async () => {
    sendDlhEvents([event('a')], createConfig());
    await flushDlhQueue();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not send with the unresolved DP auth token placeholder', async () => {
    sendDlhEvents([event('a')], createConfig('DP_AUTH_DYNAMIC_TOKEN'));
    await flushDlhQueue();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('retries the batch when the first send fails', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      } as Response)
      .mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      } as Response);

    sendDlhEvents([event('a')], createConfig('backend-exchanged-jwt'));
    await flushDlhQueue(); // first attempt fails, batch stays queued
    await flushDlhQueue(); // retried

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(debugLogger.debug).toHaveBeenCalledWith(
      'DLH events sent successfully: count=1, status=200 OK',
    );
  });

  it('keeps events queued on a persistent network failure', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    } as Response);

    sendDlhEvents([event('a')], createConfig('backend-exchanged-jwt'));
    await flushDlhQueue();

    expect(fetch).toHaveBeenCalledTimes(1);

    // Network recovered — the event that failed is still queued and gets sent.
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response);
    await flushDlhQueue();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sentEvents()).toHaveLength(1);
  });

  it('logs in via performNessyAuth and sends when no stored credentials', async () => {
    performNessyAuth.mockResolvedValue({
      jwt: 'fresh-dp-jwt',
      expiresAt: Date.now() + 10000,
      username: 'u',
      userId: 'id',
      models: [],
    });

    sendDlhEvents(
      [event('a')],
      createConfig('custom-key', AuthType.USE_OPENAI),
    );
    await flushDlhQueue();

    expect(performNessyAuth).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      DLH_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          'Nestor-Token': 'fresh-dp-jwt',
        }),
      }),
    );
  });

  it('uses stored dp-auth credentials without logging in', async () => {
    getValidCredentials.mockReturnValue({
      jwt: 'stored-dp-jwt',
      expiresAt: Date.now() + 10000,
      username: 'u',
      userId: 'id',
    });

    sendDlhEvents(
      [event('a')],
      createConfig('custom-key', AuthType.USE_OPENAI),
    );
    await flushDlhQueue();

    expect(performNessyAuth).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      DLH_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          'Nestor-Token': 'stored-dp-jwt',
        }),
      }),
    );
  });

  it('queues events while no token is available and flushes once it is', async () => {
    performNessyAuth.mockRejectedValue(new Error('not logged in'));

    // First attempt: no token, login fails — event stays queued, nothing sent.
    sendDlhEvents(
      [event('a')],
      createConfig('custom-key', AuthType.USE_OPENAI),
    );
    await flushDlhQueue();
    expect(fetch).not.toHaveBeenCalled();

    // Token becomes available later (e.g. user logged in via CLI).
    getValidCredentials.mockReturnValue({
      jwt: 'stored-dp-jwt',
      expiresAt: Date.now() + 10000,
      username: 'u',
      userId: 'id',
    });

    await flushDlhQueue();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      DLH_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          'Nestor-Token': 'stored-dp-jwt',
        }),
      }),
    );
  });

  it('drops the oldest events when the queue overflows', async () => {
    _setDlhQueueSize(2);

    sendDlhEvents(
      [event('a'), event('b'), event('c')],
      createConfig('backend-exchanged-jwt'),
    );
    await flushDlhQueue();

    // Only the two most recent events (b, c) survive the overflow.
    expect(sentEvents().map((e) => e.data)).toEqual(['b', 'c']);
  });

  it('drops the oldest events when the total-size cap is exceeded', async () => {
    _setDlhQueueBytes(10 * 1024); // 10 KB

    const big = (id: string): DlhEvent =>
      ({
        type: 'event',
        data: { id, payload: 'x'.repeat(6 * 1024) },
      }) as unknown as DlhEvent;

    sendDlhEvents(
      [big('a'), big('b'), big('c')],
      createConfig('backend-exchanged-jwt'),
    );
    await flushDlhQueue();

    // Each event is ~6 KB; the 10 KB cap keeps only the newest event.
    expect(
      sentEvents().map((e) => (e.data as unknown as { id: string }).id),
    ).toEqual(['c']);
  });

  it('waits for an in-flight send when drain is called again', async () => {
    let resolveFetch!: (value: Response | PromiseLike<Response>) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    sendDlhEvents([event('a')], createConfig('backend-exchanged-jwt'));
    const first = flushDlhQueue();

    // Второй flush во время идущей отправки должен присоединиться к первой
    // попытке, а не начать собственную.
    const second = flushDlhQueue();

    await Promise.resolve();
    await Promise.resolve();
    // Пока первый запрос летит — fetch вызван ровно один раз.
    expect(fetch).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, status: 200, statusText: 'OK' } as Response);
    await first;
    await second;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sentEvents()).toHaveLength(1);
  });

  it('keeps events enqueued during a failed send for the next retry', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      } as Response)
      .mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      } as Response);

    sendDlhEvents([event('a')], createConfig('backend-exchanged-jwt'));
    const flush = flushDlhQueue();

    // Событие добавлено, пока первая отправка ещё в полёте.
    sendDlhEvents([event('b')], createConfig('backend-exchanged-jwt'));
    await flush; // первая попытка провалилась

    await flushDlhQueue(); // retry — должны уйти оба события
    const body = vi.mocked(fetch).mock.calls[1]?.[1]?.body as string;
    const events = (JSON.parse(body) as { events: DlhEvent[] }).events;
    expect(events.map((e) => e.data)).toEqual(['a', 'b']);
  });

  function event(id: string): DlhEvent {
    return { type: 'event', data: id } as unknown as DlhEvent;
  }
});
