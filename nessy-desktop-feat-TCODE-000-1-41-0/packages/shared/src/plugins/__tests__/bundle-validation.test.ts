/**
 * B1d Task 1 — the door on the bundle normalizer.
 *
 * These tests assert the STORE's state, not only the returned verdict. A
 * validate that half-installs is worse than no validate, and the difference
 * between testing the normalizer (already covered by the adapter suites) and
 * testing this door is exactly that assertion.
 *
 * `plugins/cli-reference.md#plugin-validate` — "Run `claude plugin validate ./my-plugin` ... to
 * check `plugin.json`, skill/agent/command frontmatter, and `hooks/hooks.json`
 * for syntax and schema errors". `:477`/`:479`/`:486` fix the warning rule and
 * `--strict`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginBundleValidator, validatePluginBundle } from '../management-service-v2.ts';
import { PluginInstallService } from '../acquisition.ts';
import { PluginStoreV2 } from '../store-v2.ts';

let dir: string;

/** Any network reach from a validate is a test failure, not a slow test. */
const forbidNetwork = (async () => {
  throw new Error('network forbidden');
}) as unknown as typeof fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-bundle-validate-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function storeRoot(): string {
  return join(dir, 'plugins');
}

function stagingRoot(): string {
  return join(dir, 'staging');
}

function newValidator() {
  return createPluginBundleValidator({ fetchImpl: forbidNetwork, baseTempDir: stagingRoot() });
}

/**
 * The whole point of this task: after a validate the store must look exactly as
 * it did before one was ever run. Checked structurally — no registry file, no
 * cache tree, an empty registry read, and no leftover staged copy of the bundle.
 */
async function expectStoreUntouched(): Promise<void> {
  const store = new PluginStoreV2({ rootDirectory: storeRoot() });
  expect(existsSync(join(storeRoot(), 'installed.json'))).toBe(false);
  expect(existsSync(join(storeRoot(), 'cache'))).toBe(false);
  expect(existsSync(join(storeRoot(), 'lock.json'))).toBe(false);
  expect(existsSync(join(storeRoot(), 'update-journal.json'))).toBe(false);
  const registry = await store.readInstalledRegistry();
  expect(registry.plugins).toEqual([]);
  expect(registry.active).toEqual({});
  // A success path that forgets its own cleanup leaves a full copy of the bundle
  // behind; the staging root must be empty (or absent) once validate returns.
  if (existsSync(stagingRoot())) expect(readdirSync(stagingRoot())).toEqual([]);
}

describe('validatePluginBundle', () => {
  it('validates a good bundle clean and still does not install it', async () => {
    const result = await newValidator().validate({ kind: 'local-path', path: createGoodBundle() });

    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.plugin).toEqual({
      pluginId: 'toolkit',
      name: 'Toolkit',
      version: '1.0.0',
      capabilityKinds: ['skill'],
    });
    await expectStoreUntouched();
  });

  it('reports a broken bundle\'s diagnostics and still does not install it', async () => {
    const result = await newValidator().validate({ kind: 'local-path', path: createBrokenBundle() });

    expect(result.ok).toBe(false);
    expect(result.errorCount).toBeGreaterThan(0);
    // The diagnostics are the product, so assert they carry a code and a
    // message a plugin author can act on rather than only that `ok` is false.
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.code).toMatch(/^plugin\./);
      expect(diagnostic.message.length).toBeGreaterThan(0);
    }
    expect(result.diagnostics.map(diagnostic => diagnostic.code).sort()).toEqual([
      'plugin.manifest.capabilities_not_array',
      'plugin.manifest.missing_id',
    ]);
    expect(result.plugin).toBeUndefined();
    await expectStoreUntouched();
  });

  it('passes a warning-only bundle unless --strict promotes the warning', async () => {
    const path = createWarningOnlyBundle();

    // `:479` — "A plugin with only unrecognized-field warnings still passes
    // validation and loads at runtime."
    const lenient = await newValidator().validate({ kind: 'local-path', path });
    expect(lenient.warningCount).toBeGreaterThan(0);
    expect(lenient.errorCount).toBe(0);
    expect(lenient.ok).toBe(true);
    expect(lenient.strict).toBe(false);
    // The staging path validates the manifest twice (adapter, then the
    // normalizer over the adapter's output), so the same finding arrives twice.
    // A report a plugin author reads must print it once.
    expect(lenient.diagnostics.map(diagnostic => diagnostic.code))
      .toEqual(['plugin.format.claude_user_config_incomplete']);
    await expectStoreUntouched();

    // `:486` — "Pass `--strict` to treat warnings as errors."
    const strict = await newValidator().validate({ kind: 'local-path', path }, { strict: true });
    expect(strict.ok).toBe(false);
    expect(strict.strict).toBe(true);
    expect(strict.errorCount).toBe(0);
    expect(strict.warningCount).toBe(lenient.warningCount);
    await expectStoreUntouched();
  });

  it('reports a missing bundle directory as a diagnostic rather than throwing', async () => {
    const result = await newValidator().validate({
      kind: 'local-path',
      path: join(dir, 'does-not-exist'),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    await expectStoreUntouched();
  });

  it('accepts an injected stager so a host with its own installer reuses one normalizer', async () => {
    const installer = new PluginInstallService({
      fetchImpl: forbidNetwork,
      baseTempDir: stagingRoot(),
    });
    const result = await validatePluginBundle(installer, {
      kind: 'local-path',
      path: createGoodBundle(),
    });

    expect(result.ok).toBe(true);
    await expectStoreUntouched();
  });
});

function createGoodBundle(): string {
  const root = join(dir, 'good');
  mkdirSync(join(root, 'skills', 'review'), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: 'toolkit',
    name: 'Toolkit',
    version: '1.0.0',
    capabilities: [{
      kind: 'skill',
      id: 'review',
      skill: { slug: 'review', path: 'skills/review/SKILL.md' },
    }],
  }));
  writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '# Review');
  return root;
}

/** No `id`, and a `capabilities` value of the wrong type — both hard errors. */
function createBrokenBundle(): string {
  const root = join(dir, 'broken');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    name: 'Broken',
    version: '1.0.0',
    capabilities: 'not-an-array',
  }));
  return root;
}

/**
 * A Claude bundle whose `userConfig` option omits the documented `title` and
 * `description`. The adapter reports it as a warning rather than an error
 * (B1b's deliberate downgrade: refusing an option because it lacks a caption
 * costs the user a working option), so it is exactly the warning-only shape
 * `:479` says still loads and `:486` says CI should reject.
 */
function createWarningOnlyBundle(): string {
  const root = join(dir, 'warning-only');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'skills', 'review'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'caption-less',
    version: '1.0.0',
    userConfig: {
      endpoint: { type: 'string' },
    },
  }));
  writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\n\n# Review\n');
  return root;
}
/**
 * P2.443 — the cross-product name warnings, and the one of them that lands here.
 *
 * `plugins/marketplace-reference.md#validation-messages` lists five non-blocking
 * warnings; three name a foreign product. P2.430 read all three as belonging to a
 * marketplace-DIRECTORY validate mode this fork does not have. MEASURED against
 * the shipped `claude plugin validate`, that is right for two of them and wrong
 * for the third: `Plugin name "x" is not kebab-case` fires from a PLUGIN
 * directory with no marketplace anywhere near it, which is exactly this
 * validator's surface. The two marketplace-NAME warnings never fire there. The
 * full ownership table and the version-direction verdict are in
 * `marketplace/reserved-names.ts`.
 *
 * This suite is a PARITY LEDGER: each row carries the verdict measured from the
 * shipped binary beside the verdict this validator produces, so a divergence is
 * a visible row rather than a discovery. Every native verdict below was measured
 * on `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, one fixture per run.
 */
describe('the claude.ai kebab-case warning, on the surface that owns it', () => {
  /**
   * A Claude-format bundle, because that is the format the rule is documented
   * for: `plugin.json` carries one `name` and the adapter preserves it verbatim
   * into the identifier. Nessy-native manifests split `id` from `name`, and the
   * fixtures above (`Toolkit`, id `toolkit`) are the case that must stay silent.
   */
  function claudeBundle(label: string, name: string): string {
    const root = join(dir, `kebab-${label}`);
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name,
      version: '1.0.0',
      description: 'parity ledger fixture',
      author: { name: 'parity ledger' },
    }));
    return root;
  }

  /** `warns` is what the SHIPPED binary did, measured one fixture per run. */
  const LEDGER: readonly { label: string; name: string; warns: boolean }[] = [
    { label: 'plain', name: 'my-plugin', warns: false },
    { label: 'doubled-hyphen', name: 'my--plugin', warns: true },
    { label: 'trailing-hyphen', name: 'my-plugin-', warns: true },
    { label: 'dot', name: 'my.plugin', warns: true },
    { label: 'underscore', name: 'my_plugin', warns: true },
    { label: 'pascal', name: 'MyPlugin', warns: true },
    { label: 'mixed-segment', name: 'my-Plugin', warns: true },
    { label: 'digits-only', name: '123', warns: false },
    { label: 'single-letter', name: 'a', warns: false },
    { label: 'trailing-digit', name: 'plugin1', warns: false },
    { label: 'digit-segment', name: 'my-1-plugin', warns: false },
  ];

  it('matches the shipped verb on every measured name, and never blocks', async () => {
    for (const row of LEDGER) {
      const result = await newValidator()
        .validate({ kind: 'local-path', path: claudeBundle(row.label, row.name) });

      const codes = result.diagnostics.map(diagnostic => diagnostic.code);
      expect(codes.includes('plugin.validate.name_not_kebab_case')).toBe(row.warns);
      // Non-blocking on BOTH sides: the binary exits 0 with "Validation passed
      // with warnings", so a fixture that warns must still pass here.
      expect(result.errorCount).toBe(0);
      expect(result.ok).toBe(true);
    }
  });

  it('names the identifier and what to rename it to, and --strict promotes it', async () => {
    const path = claudeBundle('message', 'My_Plugin');

    const lenient = await newValidator().validate({ kind: 'local-path', path });
    expect(lenient.diagnostics.map(diagnostic => diagnostic.code))
      .toEqual(['plugin.validate.name_not_kebab_case']);
    // "reserved" is not actionable and neither is "not kebab-case": the offending
    // identifier and the target shape both have to be in the message.
    expect(lenient.diagnostics[0]?.message).toContain('"My_Plugin"');
    expect(lenient.diagnostics[0]?.message).toContain('claude.ai');
    expect(lenient.diagnostics[0]?.message).toContain('my-plugin');
    expect(lenient.diagnostics[0]?.path).toBe('id');
    expect(lenient.ok).toBe(true);

    // `plugins/cli-reference.md#plugin-validate` — `--strict` is for CI "before publishing", and
    // a name the claude.ai sync rejects is a publish-time problem. The cost is
    // deliberate and recorded on the helper.
    const strict = await newValidator().validate({ kind: 'local-path', path }, { strict: true });
    expect(strict.ok).toBe(false);
    expect(strict.errorCount).toBe(0);
    expect(strict.warningCount).toBe(1);
    await expectStoreUntouched();
  });

  it('stays silent on the three warnings that belong to Claude Desktop', async () => {
    // Measured on the shipped binary: from a PLUGIN directory neither Desktop
    // warning fires. `my$plugin` (outside Desktop's charset) and a 201-character
    // name (past Desktop's 128) both produce only the kebab warning or nothing —
    // the Desktop checks live in the marketplace pass, on `marketplace.json`'s
    // `name` and on each `plugins[N].name`, and this validator never sees either.
    const long = await newValidator()
      .validate({ kind: 'local-path', path: claudeBundle('long', 'a'.repeat(201)) });
    expect(long.diagnostics).toEqual([]);
    expect(long.ok).toBe(true);

    // A leading hyphen is the one measured DIVERGENCE, recorded rather than
    // silently absorbed: the binary warns kebab-case and passes, while this
    // fork's pre-existing id charset refuses it outright. That rule predates this
    // row and belongs to whoever owns plugin identifiers — ids reach filesystem
    // paths and store keys here, which the upstream name does not.
    const leading = await newValidator()
      .validate({ kind: 'local-path', path: claudeBundle('leading', '-my-plugin') });
    expect(leading.diagnostics.map(diagnostic => diagnostic.code))
      .toEqual(['plugin.manifest.invalid_id']);
    expect(leading.ok).toBe(false);

    // Positive control on the same rig: the kebab check IS armed on this run, so
    // the empty diagnostics above are a scope decision and not a dead helper.
    const control = await newValidator()
      .validate({ kind: 'local-path', path: claudeBundle('control', 'Not_Kebab') });
    expect(control.diagnostics.map(diagnostic => diagnostic.code))
      .toEqual(['plugin.validate.name_not_kebab_case']);
  });
});
