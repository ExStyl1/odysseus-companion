/**
 * P2.203 — A SLUG THE MODEL CHOSE MUST NOT PICK THE PERMISSION FILE.
 *
 * `SessionManager` builds four permissions contexts from
 * `managed.enabledSourceSlugs`, which arrives as a bare `z.array(z.string())`
 * with no per-entry validation — off the `spawn_session` tool the MODEL fills
 * in, off the create-session DTO, off the workspace defaults a stored session
 * replays. Every entry is then used as a path segment by `getSourcePath`.
 *
 * Measured on HEAD before the fix, through this same entry point and with
 * `['real']` / `[]` as the controls in the same run:
 *
 *   `['']`            loaded the sources directory's own `permissions.json`
 *   `['   ']`         loaded a `permissions.json` under a three-space name
 *   `['nested/deep']` loaded a grandchild of the sources directory
 *   `['../..', tmp]`  loaded a `permissions.json` from OUTSIDE the workspace and
 *                     merged its `allowedBashPatterns` into `readOnlyBashPatterns`
 *   `['real','real']` pushed one source's rules TWICE
 *
 * The escape is the sharp one and is not what the row named: source configs are
 * ADDITIVE, so a slug the model chose could only ever WIDEN the policy — an
 * arbitrary `permissions.json` on the host, merged into the allow set.
 *
 * EVERY row below carries a well-formed slug through the SAME call as the
 * malformed ones and asserts it SURVIVES. A guard that refuses everything is a
 * different defect wearing this row's fix, and a suite that only feeds malformed
 * input cannot tell the two apart.
 */
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { permissionsConfigCache, type PermissionsContext } from '../permissions-config.ts';

function writePermissions(dir: string, config: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'permissions.json'), `${JSON.stringify(config)}\n`, 'utf-8');
}

/**
 * A workspace whose every hostile slug has a REAL permissions.json waiting at
 * the end of it. Without the files the merge would compose the same answer with
 * or without the fix, and every row here would pass for the wrong reason.
 */
function fixture(): { root: string; escapeSlug: string } {
  const root = mkdtempSync(join(tmpdir(), 'nessy-unusable-slug-'));
  const outside = mkdtempSync(join(tmpdir(), 'nessy-outside-workspace-'));

  writePermissions(join(root, 'sources', 'real'), {
    blockedTools: ['RealTool'],
    allowedMcpPatterns: ['realverb'],
  });
  // What `getSourcePath(root, '')` resolves to — `join` drops an empty segment.
  writePermissions(join(root, 'sources'), { blockedTools: ['BlankSlugTool'] });
  writePermissions(join(root, 'sources', '   '), { blockedTools: ['SpaceSlugTool'] });
  writePermissions(join(root, 'sources', 'nested', 'deep'), { blockedTools: ['NestedTool'] });
  writePermissions(outside, {
    blockedTools: ['OutsideTool'],
    allowedMcpPatterns: ['outsideverb'],
  });

  return { root, escapeSlug: relative(join(root, 'sources'), outside) };
}

const merged = (root: string, activeSourceSlugs: string[]) =>
  permissionsConfigCache.getMergedConfig({ workspaceRootPath: root, activeSourceSlugs } satisfies PermissionsContext);

const fixtureTools = (root: string, slugs: string[]) =>
  [...merged(root, slugs).blockedTools].filter(name => name.endsWith('Tool')).sort();

/**
 * The allow-direction ARRAY the rows read. It was `allowedBashPatterns` until
 * F1.715, which drops that grant from every source file; the source's own
 * auto-scoped MCP patterns are the allow that survives, and they are pushed per
 * visit exactly as the bash ones were. Named by which file each came from.
 */
const fixturePatterns = (root: string, slugs: string[]) =>
  merged(root, slugs).readOnlyMcpPatterns.map(p => p.source)
    .filter(source => /(?:real|outside)verb/.test(source))
    .map(source => (source.includes('outsideverb') ? 'outside' : 'real'));

describe('a merge visits only the slugs that can name a source', () => {
  it('the rig loads source permission files at all', () => {
    // The positive control every absence claim below leans on. Without it a
    // merge that had stopped reading source files entirely would pass the lot.
    const { root } = fixture();
    expect(fixtureTools(root, ['real'])).toEqual(['RealTool']);
    expect(fixtureTools(root, [])).toEqual([]);
  });

  it('the blank, the whitespace, the nested and the escaping slug are all refused — and the real one is not', () => {
    const { root, escapeSlug } = fixture();

    // One call. One assertion. Five slugs, four of them hostile.
    expect(fixtureTools(root, ['real', '', '   ', 'nested/deep', escapeSlug])).toEqual(['RealTool']);
  });

  it('an escaping slug cannot widen the allow set with a file from outside the workspace', () => {
    // Source configs are additive, so this is the direction that matters: the
    // pattern from OUTSIDE must not arrive, and the pattern from the real source
    // must — in the same list, in the same call.
    const { root, escapeSlug } = fixture();

    expect(fixturePatterns(root, ['real', escapeSlug])).toEqual(['real']);
  });

  it('a repeated slug is composed once, not twice', () => {
    // `blockedTools` is a Set and cannot see this; the rule ARRAYS can. A second
    // visit pushes the same rules again, spends the DSL rule cap twice on one
    // source, and duplicates whatever `toolRules` resolves first-match-wins.
    const { root } = fixture();

    expect(fixturePatterns(root, ['real', 'real'])).toEqual(['real']);
  });

  it('each refusal is recorded with its reason, and a clean list records nothing', () => {
    const { root, escapeSlug } = fixture();

    // Reasons in VISIT order, which is the sorted one: '' then '../…' then the
    // second 'real'. No position is claimed — see the field's own docblock for
    // why an index would point at the wrong entry of the caller's array.
    expect(merged(root, ['real', '', escapeSlug, 'real']).unusableSourceSlugReasons)
      .toEqual(['blank', 'not-contained', 'duplicate']);

    // The negative half: a well-formed list must not acquire a diagnostic, or
    // the carrier is noise and its future reader will warn on every session.
    expect(merged(root, ['real']).unusableSourceSlugReasons).toBeUndefined();
  });

  it('the refusal carries no slug TEXT — a refused slug may itself be a path', () => {
    // Same rule as `permissionDslDiagnostics`: a closed union and nothing else.
    // The raw value stays on the debug line.
    const { root, escapeSlug } = fixture();

    const serialized = JSON.stringify(merged(root, ['real', escapeSlug]).unusableSourceSlugReasons);
    expect(serialized).not.toContain('..');
    expect(serialized).not.toContain(escapeSlug);
    expect(serialized).toContain('not-contained');
  });

  it('the caller\'s own array is never rewritten', () => {
    // `SessionManager` passes `managed.enabledSourceSlugs` straight in, so a
    // filter applied in place would permanently edit a live session's sources.
    const { root } = fixture();
    const slugs = ['real', '', 'real'];

    merged(root, slugs);

    expect(slugs).toEqual(['real', '', 'real']);
  });
});
