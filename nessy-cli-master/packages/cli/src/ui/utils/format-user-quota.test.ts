import { describe, expect, it } from 'vitest';
import type { UserQuotaSnapshot } from '@nestor/nessy-cli-core';
import { formatUserQuotaSnapshot } from './format-user-quota.js';

describe('formatUserQuotaSnapshot', () => {
  it('formats backend-driven quota fields', () => {
    const snapshot: UserQuotaSnapshot = {
      schemaVersion: '1.0',
      generatedAt: '2026-08-17T12:00:00Z',
      limits: [
        {
          id: 'quota',
          display: {
            title: 'Бюджет',
            description: [{ type: 'text', text: 'Общий бюджет' }],
          },
          scope: { type: 'unknown', values: ['default', 'fast'] },
          usage: 0.834,
          status: {
            state: 'unknown',
            message: 'Используется решение бэкенда.',
          },
        },
      ],
    };

    expect(formatUserQuotaSnapshot(snapshot)).toBe(
      [
        'Бюджет',
        'Общий бюджет',
        '  █████████████████░░░  Использовано: 83%',
        '  ● Используется решение бэкенда.',
        '  ◇ Область действия: unknown · default, fast',
      ].join('\n'),
    );
  });

  it('concatenates text and links and ignores unknown description parts', () => {
    const snapshot: UserQuotaSnapshot = {
      schemaVersion: '1.0',
      generatedAt: '2026-08-17T12:00:00Z',
      limits: [
        {
          id: 'quota',
          display: {
            title: 'Бюджет',
            description: [
              { type: 'text', text: 'Общий бюджет. ' },
              {
                type: 'link',
                text: 'Подробнее о квотах',
                url: 'https://example.com/docs/quotas',
              },
              { type: 'future-part', text: ' Дополнительный текст.' },
            ],
          },
          scope: { type: 'account', values: [] },
          usage: 0.5,
          status: { state: 'allowed', message: 'Запросы доступны.' },
        },
      ],
    };

    expect(formatUserQuotaSnapshot(snapshot)).toContain(
      'Общий бюджет. [Подробнее о квотах](https://example.com/docs/quotas)',
    );
    expect(formatUserQuotaSnapshot(snapshot)).not.toContain(
      'Дополнительный текст.',
    );
  });

  it('uses backend status for the status icon and clamps only the bar', () => {
    const snapshot: UserQuotaSnapshot = {
      schemaVersion: '1.0',
      generatedAt: '2026-08-17T12:00:00Z',
      limits: [
        {
          id: 'quota',
          display: { title: 'Условная квота' },
          scope: { type: 'account', values: [] },
          usage: 1.2,
          status: {
            state: 'allowed',
            message: 'Запросы всё ещё доступны.',
          },
        },
      ],
    };

    expect(formatUserQuotaSnapshot(snapshot)).toBe(
      [
        'Условная квота',
        '  ████████████████████  Использовано: 120%',
        '  ✓ Запросы всё ещё доступны.',
        '  ◇ Область действия: account',
      ].join('\n'),
    );
  });

  it('preserves the backend scope type', () => {
    const snapshot: UserQuotaSnapshot = {
      schemaVersion: '1.0',
      generatedAt: '2026-08-17T12:00:00Z',
      limits: [
        {
          id: 'quota',
          display: { title: 'Бюджет' },
          scope: { type: 'model', values: ['model-a', 'model-b'] },
          usage: 0.5,
          status: { state: 'allowed', message: 'Запросы доступны.' },
        },
      ],
    };

    expect(formatUserQuotaSnapshot(snapshot)).toContain(
      '◇ Область действия: model · model-a, model-b',
    );
  });

  it('formats an empty snapshot', () => {
    expect(
      formatUserQuotaSnapshot({
        schemaVersion: '1.0',
        generatedAt: '2026-08-17T12:00:00Z',
        limits: [],
      }),
    ).toBe('Для вашей учётной записи нет активных квот.');
  });
});
