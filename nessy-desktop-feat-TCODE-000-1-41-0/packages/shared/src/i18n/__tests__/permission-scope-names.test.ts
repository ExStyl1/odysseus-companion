/**
 * F1.1238 (final sitting SIT2-c, 2026-10-01, RC 831fde57f) — the Russian fail-closed policy
 * warning read "Настройки разрешений в workspace не удалось применить…": the settings tier is
 * interpolated as a raw token. `setupI18n` now formats `{{scopes, permissionScopes}}` through
 * `chat.permissionPolicy.scopeName.<tier>` in the sentence's own language.
 */
import { describe, expect, it } from 'bun:test';
import { i18n, setupI18n } from '../index.ts';
import en from '../locales/en.json';
import ru from '../locales/ru.json';

/** `PermissionDslScope` (`agent/pi-harness/permission-dsl.ts`), spelled out: a type has no runtime list. */
const TIERS = ['managed', 'global', 'workspace', 'project', 'plugin'] as const;

describe('F1.1238 · the policy notices translate the settings tier', () => {
  it('Russian: the fail-closed warning and a two-tier list name the tiers in Russian', () => {
    setupI18n();
    const failed = i18n.t('chat.permissionPolicy.policyFailedClosed', { lng: 'ru', scopes: 'workspace' });
    expect(failed).toStartWith('Настройки разрешений в рабочем пространстве не удалось применить');
    expect(failed).not.toContain('workspace');
    const list = i18n.t('chat.permissionPolicy.rulesDropped', { lng: 'ru', count: 3, scopes: 'project, workspace' });
    expect(list).toContain('(в проекте, рабочем пространстве)');
  });

  it('BOUNDARY: English is unchanged, and text that is not a tier word passes through', () => {
    setupI18n();
    expect(i18n.t('chat.permissionPolicy.policyFailedClosed', { lng: 'en', scopes: 'workspace' }))
      .toStartWith('The permission settings in workspace could not be applied');
    const unknown = i18n.t('chat.permissionPolicy.scopeUnknown', { lng: 'ru' });
    expect(i18n.t('chat.permissionPolicy.policyFailedClosed', { lng: 'ru', scopes: unknown }))
      .toStartWith(`Настройки разрешений в ${unknown} не удалось`);
    expect(i18n.t('chat.permissionPolicy.policyFailedClosed', { lng: 'ru', scopes: 'nova' }))
      .toStartWith('Настройки разрешений в nova не удалось');
  });

  it('every tier has its name in both locales', () => {
    for (const messages of [en, ru] as Array<Record<string, string>>) {
      for (const tier of TIERS) expect(typeof messages[`chat.permissionPolicy.scopeName.${tier}`]).toBe('string');
    }
  });
});
