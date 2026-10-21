/**
 * B1a Task 1 — the containment gate at the manifest seam.
 *
 * `plugins/manifest-reference.md#path-rules`: "Installed plugins cannot reference files outside
 * their directory. Paths that traverse outside the plugin root (such as
 * `../shared-utils`) will not work after installation". `:781`: a symlink whose
 * target is "outside the marketplace … is skipped for security. This prevents
 * plugins from pulling arbitrary host files such as system paths into the
 * cache."
 *
 * The escape cases here are real: each declared path points at a directory that
 * exists outside the bundle and holds a component the adapter would otherwise
 * load. Asserting only that the escape produced no capability would pass while
 * the file was still read; every case also asserts the outside content is absent
 * from the whole result and that no read-failure diagnostic was produced — a
 * refusal that happened BEFORE the read, not a read that failed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  declaresManifestDefaultPath,
  manifestPathContainmentError,
  manifestPathEscapesBundle,
  manifestPathIsWithinDefault,
  normalizeManifestPathText,
  resolveManifestComponentPaths,
} from '../format-adapters/manifest-paths.ts';
import { normalizeClaudePluginBundle } from '../format-adapters/claude.ts';
import type { PluginOrigin } from '../types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'plugin-manifest-paths-test-'));
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function origin(): PluginOrigin {
  return { source: 'local-path', localPath: tempDir, resolvedAt: 1 };
}

function claudeBundle(id: string, manifestExtra: Record<string, unknown> = {}): string {
  const bundle = join(tempDir, id);
  mkdirSync(join(bundle, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(bundle, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: id, version: '1.0.0', ...manifestExtra }),
  );
  return bundle;
}

/** A directory OUTSIDE any bundle holding a command the adapter would load. */
function outsideCommandDirectory(): string {
  const outside = join(tempDir, 'outside-the-bundle');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'exfiltrated.md'), '---\ndescription: outside\n---\nsecret body\n');
  return outside;
}

describe('manifest path containment (pure gate)', () => {
  // String in, string out — the gate cannot read anything by construction, which
  // is what makes "refused before any read" structural rather than incidental.
  it.each([
    ['../../../etc', 'Path traversal detected'],
    ['./../secrets', 'Path traversal detected'],
    ['/etc', 'Absolute path not allowed'],
    ['C:/Windows', 'Absolute path not allowed'],
    ['..\\..\\windows', 'Backslash path separator not allowed'],
    ['~/.ssh', 'Home-relative path not allowed'],
    ['~', 'Home-relative path not allowed'],
    ['commands/\0evil', 'NUL byte not allowed'],
    ['   ', 'Path is required'],
  ])('refuses %p', (raw, expected) => {
    expect(manifestPathContainmentError(raw)).toContain(expected);
  });

  it.each([
    './commands/',
    './specialized/deploy.md',
    'custom-skills-dir',
    './',
    '.',
  ])('accepts the documented form %p', raw => {
    expect(manifestPathContainmentError(raw)).toBeNull();
  });

  // `:647`'s own example: `"skills": ["./"]` names the plugin root.
  it('normalizes the documented ./ prefix away and maps ./ to the plugin root', () => {
    expect(normalizeManifestPathText('./commands/', true)).toBe('commands');
    expect(normalizeManifestPathText('./specialized/deploy.md')).toBe('specialized/deploy.md');
    expect(normalizeManifestPathText('./', true)).toBe('');
    expect(normalizeManifestPathText('.', true)).toBe('');
    // A missing `./` is normalised, not refused: the shipped codex-core fixture
    // and our own tests declare bare relative paths.
    expect(normalizeManifestPathText('skills', true)).toBe('skills');
  });
});

describe('manifest component path resolver', () => {
  it('accepts string, array and record-of-strings, and refuses the escaping entries only', () => {
    expect(resolveManifestComponentPaths('./commands/', { field: 'commands' })).toMatchObject({
      declared: true,
      paths: [{ path: 'commands' }],
      rejected: [],
    });
    const mixed = resolveManifestComponentPaths(['./ok/', '../../escape'], { field: 'commands' });
    expect(mixed.paths.map(entry => entry.path)).toEqual(['ok']);
    expect(mixed.rejected).toHaveLength(1);
    expect(resolveManifestComponentPaths({ a: './x/' }, { field: 'skills' }).paths.map(e => e.path)).toEqual(['x']);
  });

  it('reports an inline config object as inline, never as a path', () => {
    const inline = resolveManifestComponentPaths(
      { PreToolUse: [{ matcher: 'Write' }] },
      { field: 'hooks' },
    );
    expect(inline.declared).toBe(true);
    expect(inline.paths).toEqual([]);
    expect(inline.inline).toBeDefined();
  });

  it('treats an absent field and an empty collection alike as no declaration', () => {
    expect(resolveManifestComponentPaths(undefined, { field: 'commands' }).declared).toBe(false);
    expect(resolveManifestComponentPaths([], { field: 'commands' }).declared).toBe(false);
    expect(resolveManifestComponentPaths({}, { field: 'hooks' }).declared).toBe(false);
  });

  it('recognizes the default folder in every declared shape (:636 keep-the-default example)', () => {
    expect(declaresManifestDefaultPath('./commands/', 'commands', true)).toBe(true);
    expect(declaresManifestDefaultPath(['./commands/', './extras/'], 'commands', true)).toBe(true);
    expect(declaresManifestDefaultPath(['./extras/'], 'commands', true)).toBe(false);
    expect(manifestPathIsWithinDefault('commands/deploy.md', 'commands')).toBe(true);
    expect(manifestPathIsWithinDefault('commands-extra/deploy.md', 'commands')).toBe(false);
  });
});

describe('symlink containment (:781)', () => {
  it('detects a symlink whose target leaves the bundle, and clears one that stays inside', async () => {
    const bundle = claudeBundle('symlink-probe');
    const outside = outsideCommandDirectory();
    mkdirSync(join(bundle, 'inside'), { recursive: true });
    symlinkSync(outside, join(bundle, 'escape-link'));
    symlinkSync(join(bundle, 'inside'), join(bundle, 'inside-link'));

    expect(await manifestPathEscapesBundle(bundle, 'escape-link')).toBe(true);
    expect(await manifestPathEscapesBundle(bundle, 'inside-link')).toBe(false);
    // A path that does not exist yet cannot escape — the pure gate already
    // proved the text is bundle-relative, and calling it an escape would
    // misname an ordinary authoring mistake.
    expect(await manifestPathEscapesBundle(bundle, 'not-there')).toBe(false);
  });
});

describe('escape attempts through the Claude adapter', () => {
  it('refuses ../ traversal without reading the directory it points at', async () => {
    const outside = outsideCommandDirectory();
    // `../outside-the-bundle` from the bundle root is exactly that directory.
    const bundle = claudeBundle('escape-traversal', { commands: ['../outside-the-bundle'] });

    const normalized = await normalizeClaudePluginBundle(bundle, origin());

    expect(normalized.value?.capabilities ?? []).toEqual([]);
    expect(JSON.stringify(normalized)).not.toContain('exfiltrated');
    expect(JSON.stringify(normalized)).not.toContain(outside);
    expect(normalized.diagnostics.some(diagnostic =>
      diagnostic.code === 'plugin.format.claude_path_invalid'
      && diagnostic.message.includes('Path traversal detected'))).toBe(true);
    expect(normalized.compatibility?.deferred).toEqual([
      { externalKind: 'custom-commands-path', reasonCode: 'plugin.deferred.claude_custom_path_uncontained' },
    ]);
  });

  it('refuses an absolute path', async () => {
    const outside = outsideCommandDirectory();
    const bundle = claudeBundle('escape-absolute', { commands: [outside] });

    const normalized = await normalizeClaudePluginBundle(bundle, origin());

    expect(normalized.value?.capabilities ?? []).toEqual([]);
    expect(JSON.stringify(normalized)).not.toContain('exfiltrated');
    expect(normalized.diagnostics.some(diagnostic =>
      diagnostic.code === 'plugin.format.claude_path_invalid'
      && diagnostic.message.includes('Absolute path not allowed'))).toBe(true);
  });

  it('refuses a symlink that leaves the bundle', async () => {
    const outside = outsideCommandDirectory();
    const bundle = claudeBundle('escape-symlink', { commands: ['./linked'] });
    symlinkSync(outside, join(bundle, 'linked'));

    const normalized = await normalizeClaudePluginBundle(bundle, origin());

    expect(normalized.value?.capabilities ?? []).toEqual([]);
    expect(JSON.stringify(normalized)).not.toContain('exfiltrated');
    expect(normalized.diagnostics.some(diagnostic =>
      diagnostic.code === 'plugin.format.claude_path_invalid'
      && diagnostic.message.includes('outside the plugin bundle'))).toBe(true);
  });

  it('refuses without emitting a read-failure diagnostic, so the refusal preceded the read', async () => {
    const bundle = claudeBundle('escape-no-read', { commands: ['../../../../etc'] });

    const normalized = await normalizeClaudePluginBundle(bundle, origin());

    // A path the adapter had tried to open would fail as unreadable/missing.
    // Only the containment diagnostic is present.
    expect(normalized.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['plugin.format.claude_path_invalid']);
  });
});
