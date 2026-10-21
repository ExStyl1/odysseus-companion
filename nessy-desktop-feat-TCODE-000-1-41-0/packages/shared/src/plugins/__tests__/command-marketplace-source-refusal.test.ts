/**
 * P6.511 · a `command` marketplace source is refused uniformly, and the claude
 * child stops being the exception.
 *
 * Q-den 42 = option 2. Two halves, and the second is the leak: our resolver
 * refuses the kind on every runtime, while the claude child would honour one
 * declared in the user's own `extraKnownMarketplaces` — we pass
 * `settingSources: ['user','project','local']` and 2.1.233 added `command` as a
 * marketplace-entry source kind.
 */
import { describe, expect, it } from 'bun:test';

import { resolvePluginInstallSource } from '../source-resolver.ts';
import { claudeCommandPluginSourceFloor } from '../../agent/claude-managed-settings.ts';
import type { ManagedPiPolicyV1 } from '../../agent/pi-harness/managed-policy.ts';

const policy = (patch: Partial<ManagedPiPolicyV1>): ManagedPiPolicyV1 =>
  ({ version: 1, ...patch } as ManagedPiPolicyV1);

describe('P6.511 · the host resolver refuses a command source by name', () => {
  it('positive — a named diagnostic, and the managed tier is the only exception it offers', () => {
    const resolved = resolvePluginInstallSource({ kind: 'command', command: ['sh', '-c', 'x'] } as never);
    expect(resolved.source.kind).toBe('unsupported');
    const codes = resolved.diagnostics.map(d => d.code);
    expect(codes).toContain('plugin.source.command_refused');
    const message = resolved.diagnostics.find(d => d.code === 'plugin.source.command_refused')?.message ?? '';
    expect(message).toContain('MANAGED settings');
    // The route out is offered, not only the refusal.
    expect(message).toContain('archive');
  });

  it('negative — a marketplace of another kind still resolves, with no refusal', () => {
    const resolved = resolvePluginInstallSource({
      kind: 'marketplace-url',
      url: 'https://example.test/marketplace.json',
    });
    expect(resolved.source.kind).toBe('marketplace-url');
    expect(resolved.diagnostics.map(d => d.code)).not.toContain('plugin.source.command_refused');
  });
});

describe('P6.511 · the claude floor closes the leak, and defers to an administrator', () => {
  it('positive — an install with no managed policy still sends the restrictive pole', () => {
    // The leak needs no administrator: `extraKnownMarketplaces` is the user's own.
    expect(claudeCommandPluginSourceFloor(policy({}))?.disableCommandPluginSources).toBe(true);
    expect(claudeCommandPluginSourceFloor(undefined)?.disableCommandPluginSources).toBe(true);
  });

  it('silent when the administrator already answered, in EITHER direction', () => {
    // `true`: the mapper emits it, and two contributors writing one key would
    // make the merge report a collision for no reason.
    expect(claudeCommandPluginSourceFloor(policy({ disableCommandPluginSources: true }))).toBeUndefined();
    // `false`: the single managed-tier exception this product recognises — the
    // same carve-out P6.479 took for `headersHelper`, taken once.
    expect(claudeCommandPluginSourceFloor(policy({ disableCommandPluginSources: false }))).toBeUndefined();
  });

  it('the mapper\'s own invariant is untouched — a policy saying nothing still maps to nothing', async () => {
    // This is why the floor is a second CONTRIBUTOR and not a branch in the
    // mapper: sixteen managed-settings invariants rest on that emptiness.
    const { mapManagedPolicyToClaudeSettings } = await import('../../agent/claude-managed-settings.ts');
    expect(mapManagedPolicyToClaudeSettings(policy({})).settings).toBeUndefined();
  });
});
