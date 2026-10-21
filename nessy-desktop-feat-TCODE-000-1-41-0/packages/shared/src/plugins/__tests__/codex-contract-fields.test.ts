/**
 * The Codex adapter against fields its published contract specifies and we do
 * not carry. Each case quotes the sentence it is written against; the pages are
 * `developers.openai.com/plugins/deploy/submission-errors.md` and
 * `learn.chatgpt.com/docs/hooks.md`, both fetched as their `.md` twins.
 *
 * A separate file from `format-adapters.test.ts` on purpose: that suite covers
 * every adapter and is edited by other units concurrently.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// `management-service-v2.ts` first, and it is load-bearing. Entering the
// adapter graph through `format-adapters/codex.ts` before `format-adapters.ts`
// throws `ReferenceError: Cannot access 'CODEX_MANIFEST_RELATIVE_PATH' before
// initialization` at `format-adapters.ts:706` — a pre-existing import cycle
// between those two files, reproduced on a two-import scratch file that touches
// nothing this suite changed. Inert in production only because every entry
// point today loads `format-adapters.ts` first.
import { PluginManagementServiceV2 } from '../management-service-v2.ts';
import { PluginStoreV2 } from '../store-v2.ts';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { normalizeCodexPluginManifest, readCodexHookCommand } from '../format-adapters/codex.ts';
import type { PluginOrigin } from '../types.ts';

let bundle: string;

beforeEach(() => {
  bundle = mkdtempSync(join(tmpdir(), 'codex-contract-'));
});

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  if (bundle) rmSync(bundle, { recursive: true, force: true });
});

function origin(): PluginOrigin {
  return { kind: 'local-path', path: bundle, installedAt: 0 } as unknown as PluginOrigin;
}

describe('Codex listing and publisher metadata (D3)', () => {
  /**
   * `plugins/build/plugins.md` § *Manifest fields*: "`author`, `homepage`,
   * `repository`, `license`, and `keywords` provide publisher and discovery
   * metadata." The `interface` half is `submission-errors.md` § *Listing and
   * interface errors*. All 180 published manifests carry `keywords`, 179 carry
   * `repository` and `license`, and every one drops its whole `interface` block
   * here — 29 of them while reporting `supported`.
   */
  it('names every dropped listing field and persists it in the adapter warnings', async () => {
    const normalized = await normalizeCodexPluginManifest({
      name: 'linear',
      version: '0.0.3',
      description: 'Find and reference issues and projects.',
      repository: 'https://github.com/openai/plugins',
      license: 'MIT',
      keywords: ['issues'],
      author: { name: 'OpenAI', email: 'plugins@example.invalid', url: 'https://linear.app/' },
      interface: {
        displayName: 'Linear',
        shortDescription: 'Find and reference issues.',
        longDescription: 'Manage issues, projects, and team workflows.',
        category: 'Productivity',
        capabilities: [],
        defaultPrompt: ['Triage relevant issues'],
        brandColor: '#5E6AD2',
        composerIcon: './assets/linear-icon.svg',
        logo: './assets/app-icon.png',
        privacyPolicyURL: 'https://linear.app/privacy',
        termsOfServiceURL: 'https://linear.app/terms',
      },
    }, bundle, origin());

    const dropped = normalized.diagnostics.find(d => d.code === 'plugin.format.codex_listing_metadata_dropped');
    expect(dropped?.severity).toBe('warning');
    expect(dropped?.details?.fields).toEqual([
      'repository',
      'license',
      'keywords',
      'author.email',
      'author.url',
      'interface.longDescription',
      'interface.category',
      'interface.capabilities',
      'interface.defaultPrompt',
      'interface.brandColor',
      'interface.composerIcon',
      'interface.logo',
      'interface.privacyPolicyURL',
      'interface.termsOfServiceURL',
    ]);
    // Carried into the persisted adapter record, so the drop is machine-readable
    // after install — but NOT a `deferred` entry, which would flip
    // `compatibility.state` to `partial` and gate the install behind a
    // confirmation for metadata with no runtime effect. See the constant's note.
    expect(normalized.value?.compatibility?.adapter?.warnings?.map(warning => warning.code))
      .toContain('plugin.format.codex_listing_metadata_dropped');
    expect(normalized.compatibility?.deferred).toEqual([]);
  });

  it('carries the drop onto the install result the RPC turns into diagnosticCodes', async () => {
    // D3, second half. The row was demoted because the diagnostic looked
    // confined to `compatibility.adapter.warnings`, which is persisted with
    // zero readers repo-wide (control: `deferred` IS read —
    // `plugin-install-state.ts` turns `partial` into `needsConfirmEnable`).
    //
    // Measured here instead of argued: the SAME diagnostic is pushed into the
    // array the adapter RETURNS, so it survives normalization onto
    // `PluginManagementInstallResult.diagnostics`, which
    // `rpc/marketplace.ts` maps to `diagnosticCodes` on EVERY install — success
    // or blocked. The channel is live all the way to the renderer; what is
    // missing is a reader on the success path, and that is renderer-side.
    //
    // This assertion is the contract that renderer half will be built against:
    // if the code stops reaching the install result, the surface that reads it
    // silently shows nothing, exactly as before.
    const pluginRoot = join(bundle, 'listing-metadata');
    mkdirSync(join(pluginRoot, '.codex-plugin'), { recursive: true });
    mkdirSync(join(pluginRoot, 'skills', 'review'), { recursive: true });
    writeFileSync(join(pluginRoot, 'skills', 'review', 'SKILL.md'), '# Review\n');
    writeFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'listing-metadata',
      version: '1.0.0',
      description: 'Drops a listing block, like all 180 published manifests.',
      repository: 'https://github.com/openai/plugins',
      license: 'MIT',
      keywords: ['issues'],
      skills: './skills/',
      interface: { displayName: 'Listing Metadata', logo: './assets/app-icon.png' },
    }));

    const store = new PluginStoreV2({ rootDirectory: join(bundle, 'plugins') });
    const service = installs.track(new PluginManagementServiceV2({
      store,
      policyStore: new CapabilityPolicyStore({ globalPath: join(bundle, 'capabilities.json') }),
      trustStore: new CapabilityTrustStore({ path: join(bundle, 'capability-trust.json') }),
      baseTempDir: join(bundle, 'stages'),
      fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
    }));

    const result = await service.install({ kind: 'local-path', path: pluginRoot });

    expect(result.ok).toBe(true);
    // This is the array `rpc/marketplace.ts` maps into `diagnosticCodes`.
    expect(result.diagnostics.map(diagnostic => diagnostic.code))
      .toContain('plugin.format.codex_listing_metadata_dropped');
    // And it did NOT buy that reach by flipping the install into a
    // confirmation step, which is what a `deferred` entry would have cost.
    expect(result.compatibility?.state).toBe('supported');
  });

  it('stays silent for a manifest that declares none of them', async () => {
    const normalized = await normalizeCodexPluginManifest({
      name: 'minimal',
      version: '1.0.0',
      description: 'No listing block at all.',
      author: { name: 'OpenAI' },
      interface: { displayName: 'Minimal', shortDescription: 'No listing block at all.' },
    }, bundle, origin());

    expect(normalized.diagnostics.some(d => d.code === 'plugin.format.codex_listing_metadata_dropped')).toBe(false);
    expect(normalized.compatibility?.state).toBe('supported');
  });
});

describe('Codex prompt and agent hook handlers (D2)', () => {
  /**
   * `hooks.md` § *Config shape*: "Only `type: \"command\"` handlers run today.
   * `prompt` and `agent` handlers are parsed but skipped." We registered both,
   * and `hooks-automation.ts` dispatches them with no dialect filter.
   */
  it.each([
    ['prompt', { type: 'prompt', id: 'brief', prompt: 'Follow the style guide.' }],
    ['agent', { type: 'agent', id: 'review', agent: 'reviewer' }],
  ])('parses a %s handler, reports it, and never registers it', async (kind, handler) => {
    const normalized = await normalizeCodexPluginManifest({
      name: 'codex-skipped-handlers',
      version: '1.0.0',
      hooks: { SessionStart: [{ hooks: [handler] }] },
    }, bundle, origin());

    expect(normalized.value?.capabilities.some(capability => capability.kind === 'hook')).toBe(false);
    expect(normalized.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'plugin.format.codex_hook_handler_skipped',
      details: expect.objectContaining({ hookType: kind }),
    }));
    expect(normalized.compatibility?.deferred).toContainEqual({
      externalKind: `hook-${kind}`,
      reasonCode: 'plugin.deferred.codex_hook_handler_skipped',
    });
  });

  it('still registers the one handler type Codex runs', async () => {
    const normalized = await normalizeCodexPluginManifest({
      name: 'codex-command-handler',
      version: '1.0.0',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', id: 'start', command: 'sh ./run.sh' }] }] },
    }, bundle, origin());

    expect(normalized.value?.capabilities).toEqual([expect.objectContaining({
      kind: 'hook',
      hook: expect.objectContaining({ event: 'SessionStart', type: 'command', command: 'sh ./run.sh' }),
    })]);
    expect(normalized.diagnostics.some(d => d.code === 'plugin.format.codex_hook_handler_skipped')).toBe(false);
  });
});

describe('Codex command-hook fields (D5)', () => {
  /**
   * `hooks.md` § *Config shape*: "`commandWindows` is an optional Windows-only
   * command override. In TOML, use `command_windows` or `commandWindows`."
   */
  it.each([
    ['commandWindows', { command: 'sh ./run.sh', commandWindows: 'py -3 run.py' }],
    ['command_windows', { command: 'sh ./run.sh', command_windows: 'py -3 run.py' }],
  ])('selects %s on Windows and the POSIX command everywhere else', (_label, entry) => {
    expect(readCodexHookCommand(entry, 'win32')).toBe('py -3 run.py');
    expect(readCodexHookCommand(entry, 'darwin')).toBe('sh ./run.sh');
  });

  it('falls back to the POSIX command on Windows when no override is declared', () => {
    expect(readCodexHookCommand({ command: 'sh ./run.sh' }, 'win32')).toBe('sh ./run.sh');
  });

  /**
   * `hooks.md`: "Omit `additionalContextLimit` to use the default `2500`-token
   * threshold", and "The `async` option is parsed, but asynchronous command
   * hooks aren't supported yet." Both are parsed and reported; neither is
   * applied, and `async` is deliberately NOT set on the descriptor — running a
   * Codex hook in the background is exactly the widening D2 closes.
   */
  it('reports additionalContextLimit and async without applying either', async () => {
    const normalized = await normalizeCodexPluginManifest({
      name: 'codex-hook-fields',
      version: '1.0.0',
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', id: 'start', command: 'sh ./run.sh', additionalContextLimit: 5000, async: true }],
        }],
      },
    }, bundle, origin());

    const hook = normalized.value?.capabilities.find(capability => capability.kind === 'hook');
    expect(hook).toBeDefined();
    expect(hook && 'hook' in hook ? hook.hook.async : undefined).toBeUndefined();
    const unread = normalized.diagnostics.filter(d => d.code === 'plugin.format.codex_hook_field_unread');
    expect(unread.map(d => d.details?.field)).toEqual(['additionalContextLimit', 'async']);
    expect(unread.every(d => d.path?.startsWith('hooks.SessionStart.0.hooks.0.'))).toBe(true);
    expect(normalized.compatibility?.deferred).toContainEqual({
      externalKind: 'hook-additionalContextLimit',
      reasonCode: 'plugin.deferred.codex_hook_field_unread',
    });
  });

  it('stays silent for a command hook that declares neither', async () => {
    const normalized = await normalizeCodexPluginManifest({
      name: 'codex-plain-hook',
      version: '1.0.0',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', id: 'start', command: 'sh ./run.sh' }] }] },
    }, bundle, origin());

    expect(normalized.diagnostics.some(d => d.code === 'plugin.format.codex_hook_field_unread')).toBe(false);
    expect(normalized.compatibility?.state).toBe('supported');
  });
});

// F1.424 — every case here runs a REAL plugin-store install: a per-CASE budget, and a teardown that waits for every
// install still copying before it removes a root (`packages/shared/src/testing/install-tracker.ts` says why and what
// the tracker does not change). Placed last so no cited line moves: imports hoist, and bun applies a default set
// at module load to the cases registered above it (measured 2026-09-24).
import { MODULE_GRAPH_CASE_BUDGET_MS } from '../../testing/module-graph-budgets.ts';
import { createInstallTracker } from '../../testing/install-tracker.ts';
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS);
const installs = createInstallTracker();
