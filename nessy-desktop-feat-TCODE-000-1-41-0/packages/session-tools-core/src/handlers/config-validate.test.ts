import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleConfigValidate } from './config-validate.ts';

function createCtx(workspacePath: string) {
  return {
    configRoot: workspacePath,
    sessionId: 'test-session',
    workspacePath,
    get sourcesPath() { return join(workspacePath, 'sources'); },
    get skillsPath() { return join(workspacePath, 'skills'); },
    plansFolderPath: join(workspacePath, 'plans'),
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    },
    fs: {
      exists: (path: string) => existsSync(path),
      readFile: (path: string) => readFileSync(path, 'utf-8'),
      readFileBuffer: (path: string) => readFileSync(path),
      writeFile: (path: string, content: string) => writeFileSync(path, content),
      isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
      readdir: (path: string) => readdirSync(path),
      stat: (path: string) => {
        const s = statSync(path);
        return { size: s.size, isDirectory: () => s.isDirectory() };
      },
    },
    validators: undefined,
    loadSourceConfig: () => null,
  } as const;
}

/**
 * P6.879 — the fallback answer names the validation that ran.
 *
 * The defect: with `ctx.validators` absent (the codex path) `target: 'config'`
 * checked ONE field — that `workspaceRefs` exists — and answered
 * `✓ Validation passed`, the same sentence the full Zod validator emits, on a
 * file that validator calls invalid. `preferences`, `permissions` and
 * `automations` were weaker still: an empty required-field list, so the answer
 * meant only "the file parses". Nothing in the output said which tier had run.
 *
 * Two arms, because the two failure directions are opposite: the fallback must
 * SAY what it checked, and the full-validator path must NOT carry that sentence
 * — a note claiming basic validation on a full run would be the same lie in
 * reverse.
 */
describe('config-validate names the validation that ran (P6.879)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-validate-tier-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('FALLBACK — a config.json the full validator refuses still passes here, and the answer says so', async () => {
    // `crossSessionInbound: 'hodl'` is a typo the full schema names and this
    // tier structurally cannot see: the field is not required, and its VALUE is
    // not a shape `validateJsonFileHasFields` inspects. Before this row the
    // caller read `✓ Validation passed` and had no way to learn that.
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify({ workspaceRefs: [], crossSessionInbound: 'hodl' })
    );

    const result = await handleConfigValidate(createCtx(tempDir), { target: 'config' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Validation passed');
    expect(text).toContain('checked: config.json parses and has workspaceRefs');
    // P6.885 reworded this: the tier is no longer "the codex path" — codex binds
    // the full validators too when its config-root ground agrees — so the note
    // stopped naming a cause it can no longer know and names the tier instead.
    expect(text).toContain('no full schema validators are bound on this path');
  });

  it('FALLBACK — the empty-required-field targets say that nothing but parsing was checked', async () => {
    // The weakest tier in the switch, and the one whose bare "Validation
    // passed" was most misleading: the required-field list is `[]`.
    writeFileSync(join(tempDir, 'preferences.json'), JSON.stringify({ anything: 'at all' }));

    const result = await handleConfigValidate(createCtx(tempDir), { target: 'preferences' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('checked: preferences.json parses (no field is required here)');
  });

  it('FULL VALIDATOR — the same target carries no basic-validation note', async () => {
    // The opposite direction, and the reason this arm exists: a note asserting
    // the basic tier on a full run would be the same defect inverted. The
    // validator's own verdict is passed through untouched.
    const ctx = {
      ...createCtx(tempDir),
      validators: {
        validateConfig: () => ({
          valid: false,
          errors: [{ path: 'crossSessionInbound', message: 'Invalid option' }],
          warnings: [],
        }),
      },
    } as unknown as Parameters<typeof handleConfigValidate>[0];

    const result = await handleConfigValidate(ctx, { target: 'config' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('- crossSessionInbound: Invalid option');
    expect(text).not.toContain('checked:');
    expect(text).not.toContain('no full schema validators');
  });
});

describe('config-validate automations target', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-validate-automations-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('validates automations.json when present', async () => {
    writeFileSync(join(tempDir, 'automations.json'), JSON.stringify({ version: 2, automations: {} }));

    const result = await handleConfigValidate(createCtx(tempDir), { target: 'automations' });
    expect(result.content[0]?.text).toContain('Validation passed');
  });

  it('returns no-config message when automations.json does not exist', async () => {
    const result = await handleConfigValidate(createCtx(tempDir), { target: 'automations' });
    expect(result.content[0]?.text).toContain('No automations.json');
  });
});
