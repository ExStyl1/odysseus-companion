import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { setLanguageAsync } from '../../i18n/index.js';

const { fetchUserQuota } = vi.hoisted(() => ({ fetchUserQuota: vi.fn() }));
vi.mock('@nestor/nessy-cli-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nestor/nessy-cli-core')>()),
  fetchUserQuota,
}));

import { quotaCommand } from './quota-command.js';

describe('quotaCommand', () => {
  beforeEach(async () => {
    fetchUserQuota.mockReset();
    await setLanguageAsync('en');
  });

  it('localizes its description using the UI language', async () => {
    expect(quotaCommand.description).toBe(
      'Show your current LLM usage and quotas',
    );

    await setLanguageAsync('ru');

    expect(quotaCommand.description).toBe(
      'Показать текущее использование и квоты LLM',
    );
  });

  it('localizes quota service messages using the UI language', async () => {
    const unavailableContext = createMockCommandContext();
    expect(await quotaCommand.action?.(unavailableContext, '')).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Quota information is unavailable.',
    });

    await setLanguageAsync('ru');

    expect(await quotaCommand.action?.(unavailableContext, '')).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Информация о квотах недоступна.',
    });

    const failedContext = createMockCommandContext({
      services: { config: { getCliVersion: vi.fn() } },
    });
    fetchUserQuota.mockRejectedValueOnce(new Error('offline'));

    expect(await quotaCommand.action?.(failedContext, '')).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Не удалось загрузить квоты.',
    });
    expect(failedContext.ui.setPendingItem).toHaveBeenNthCalledWith(1, {
      type: 'info',
      text: 'Загрузка квот...',
    });
  });

  it('falls back to English for other UI languages', async () => {
    await setLanguageAsync('de');

    expect(quotaCommand.description).toBe(
      'Show your current LLM usage and quotas',
    );
    expect(await quotaCommand.action?.(createMockCommandContext(), '')).toEqual(
      {
        type: 'message',
        messageType: 'info',
        content: 'Quota information is unavailable.',
      },
    );

    const failedContext = createMockCommandContext({
      services: { config: { getCliVersion: vi.fn() } },
    });
    fetchUserQuota.mockRejectedValueOnce(new Error('offline'));

    expect(await quotaCommand.action?.(failedContext, '')).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Failed to load quotas.',
    });
    expect(failedContext.ui.setPendingItem).toHaveBeenNthCalledWith(1, {
      type: 'info',
      text: 'Loading quotas...',
    });
  });

  it('loads and returns formatted quotas', async () => {
    const context = createMockCommandContext({
      services: { config: { getCliVersion: vi.fn() } },
    });
    fetchUserQuota.mockResolvedValue({
      schemaVersion: '1.0',
      generatedAt: '2026-08-17T12:00:00Z',
      limits: [
        {
          id: 'quota',
          display: {
            title: 'Бюджет',
            description: [
              { type: 'text', text: 'Подробнее: ' },
              {
                type: 'link',
                text: 'Документация по квотам',
                url: 'https://example.com/docs/quotas',
              },
            ],
          },
          scope: { type: 'mode', values: ['default'] },
          usage: 0.5,
          status: {
            state: 'allowed',
            message: 'Запросы доступны.',
          },
        },
      ],
    });

    const result = await quotaCommand.action?.(context, '');

    expect(fetchUserQuota).toHaveBeenCalledWith(
      context.services.config,
      context.abortSignal,
    );
    expect(result).toBeUndefined();
    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      1,
      {
        type: 'success',
        text: 'Бюджет\nПодробнее: [Документация по квотам](https://example.com/docs/quotas)\n  ██████████░░░░░░░░░░  Использовано: 50%\n  ✓ Запросы доступны.\n  ◇ Область действия: mode · default',
      },
      expect.any(Number),
    );
    expect(context.ui.setPendingItem).toHaveBeenNthCalledWith(1, {
      type: 'info',
      text: 'Loading quotas...',
    });
    expect(context.ui.setPendingItem).toHaveBeenLastCalledWith(null);
  });

  it('renders description links in non-interactive mode', async () => {
    const context = createMockCommandContext({
      executionMode: 'non_interactive',
      services: { config: { getCliVersion: vi.fn() } },
    });
    fetchUserQuota.mockResolvedValue({
      schemaVersion: '1.0',
      generatedAt: '2026-08-17T12:00:00Z',
      limits: [
        {
          id: 'quota',
          display: {
            title: 'Бюджет',
            description: [
              {
                type: 'link',
                text: 'Документация по квотам',
                url: 'https://example.com/docs/quotas',
              },
            ],
          },
          scope: { type: 'account', values: [] },
          usage: 0.5,
          status: { state: 'allowed', message: 'Запросы доступны.' },
        },
      ],
    });

    expect(await quotaCommand.action?.(context, '')).toEqual(
      expect.objectContaining({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining(
          '[Документация по квотам](https://example.com/docs/quotas)',
        ),
      }),
    );
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('renders warning and exhausted quotas with their UI colors', async () => {
    const context = createMockCommandContext({
      services: { config: { getCliVersion: vi.fn() } },
    });
    fetchUserQuota.mockResolvedValue({
      schemaVersion: '1.0',
      generatedAt: '2026-08-17T12:00:00Z',
      limits: [
        {
          id: 'warning',
          display: { title: 'Warning quota' },
          scope: { type: 'account', values: [] },
          usage: 0.9,
          status: {
            state: 'warning',
            message: 'Almost exhausted.',
          },
        },
        {
          id: 'exhausted',
          display: {
            title: 'Exhausted quota',
            description: [
              {
                type: 'link',
                text: 'Quota documentation',
                url: 'https://example.com/docs/quotas',
              },
            ],
          },
          scope: { type: 'account', values: [] },
          usage: 1,
          status: {
            state: 'exhausted',
            message: 'Exhausted.',
          },
        },
      ],
    });

    await quotaCommand.action?.(context, '');

    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'warning',
        text: expect.stringMatching(/^Warning quota/),
      }),
      expect.any(Number),
    );
    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'error',
        text: expect.stringMatching(
          /^Exhausted quota\n\[Quota documentation\]\(https:\/\/example\.com\/docs\/quotas\)/,
        ),
      }),
      expect.any(Number),
    );
  });

  it('streams every quota without failing the ACP command', async () => {
    const context = createMockCommandContext({
      executionMode: 'acp',
      services: { config: { getCliVersion: vi.fn() } },
    });
    fetchUserQuota.mockResolvedValue({
      schemaVersion: '1.0',
      generatedAt: '2026-08-17T12:00:00Z',
      limits: [
        {
          id: 'allowed',
          display: {
            title: 'Allowed quota',
            description: [
              {
                type: 'link',
                text: 'Quota documentation',
                url: 'https://example.com/docs/quotas',
              },
            ],
          },
          scope: { type: 'account', values: [] },
          usage: 0.5,
          status: {
            state: 'allowed',
            message: 'Available.',
          },
        },
        {
          id: 'warning',
          display: { title: 'Warning quota' },
          scope: { type: 'account', values: [] },
          usage: 0.9,
          status: {
            state: 'warning',
            message: 'Almost exhausted.',
          },
        },
        {
          id: 'exhausted',
          display: { title: 'Exhausted quota' },
          scope: { type: 'account', values: [] },
          usage: 1,
          status: {
            state: 'exhausted',
            message: 'Exhausted.',
          },
        },
      ],
    });

    const result = await quotaCommand.action?.(context, '');
    expect(result?.type).toBe('stream_messages');
    if (!result || result.type !== 'stream_messages') {
      throw new Error('Expected an ACP message stream.');
    }

    const messages = [];
    for await (const item of result.messages) messages.push(item);

    expect(messages).toEqual([
      expect.objectContaining({
        messageType: 'info',
        content: expect.stringMatching(
          /^Allowed quota\n\[Quota documentation\]\(https:\/\/example\.com\/docs\/quotas\)[\s\S]*\n\n$/,
        ),
      }),
      expect.objectContaining({
        messageType: 'info',
        content: expect.stringMatching(/Warning quota[\s\S]*\n\n$/),
      }),
      expect.objectContaining({
        messageType: 'info',
        content: expect.stringMatching(/Exhausted quota[\s\S]*[^\n]$/),
      }),
    ]);
    expect(
      messages
        .map(({ content }) => content)
        .join('')
        .match(/\[Quota documentation\]/g),
    ).toHaveLength(1);
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('returns a command error without ending the session', async () => {
    const context = createMockCommandContext({
      services: { config: { getCliVersion: vi.fn() } },
    });
    fetchUserQuota.mockImplementationOnce(async () => {
      throw new Error('offline');
    });

    expect(await quotaCommand.action?.(context, '')).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Failed to load quotas.',
    });
  });
});
