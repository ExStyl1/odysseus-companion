/**
 * P2.276 — the carrier half: a dropped permission rule leaves a HOST-READABLE
 * record on the merged config, not only a `debug()` line.
 *
 * ## What this completes
 *
 * `managed-settings.md#keys-that-fail-closed`, verbatim: "User, project, and
 * local settings files remain strict: a file whose JSON or top-level shape fails
 * validation is rejected as a whole and reported, and an individual entry that
 * fails, such as a malformed permission rule, is skipped with a warning while
 * the rest of the file applies."
 *
 * P2.270 shipped the skipping. P2.271 shipped the warning onto `debug()`, which
 * reaches stderr and `main.log` **only with debug logging enabled** — so an
 * ordinary user whose project settings silently lost a deny rule still had no
 * signal. This file asserts the third hop: the same drop now leaves
 * `MergedPermissionsConfig.permissionDslDiagnostics`, which
 * `SessionManager.announcePermissionPolicyDiagnostics` turns into a session
 * notice with no debug flag involved.
 *
 * ## Why the real path
 *
 * Every case below drives `parsePermissionsJson` →
 * `permissionsConfigCache.getMergedConfig` → `compilePermissionDslV1`, the same
 * chain a session builds, and reads the field off the returned object. A double
 * that was handed a diagnostic and asked whether it received one would pass with
 * the compiler removed.
 */
import { describe, expect, it } from 'bun:test';
import { parsePermissionsJson, permissionsConfigCache } from '../permissions-config.ts';

const SETTINGS_ROOT = '/nonexistent/settings-source-carrier';

let workspace = 0;

/** Build a merged config from a project settings block, on the production path. */
function build(block: Record<string, string[]>, scope: 'project' | 'workspace' = 'project') {
  const config = parsePermissionsJson(JSON.stringify({ permissions: block }), SETTINGS_ROOT);
  permissionsConfigCache.clear();
  return permissionsConfigCache.getMergedConfig({
    workspaceRootPath: `/nonexistent/ws-carrier-${workspace++}`,
    pinnedRevision: 'gen',
    projectTrusted: true,
    pinnedConfigs: [{ config, scope }],
  });
}

describe('P2.276 — a dropped rule reaches the host, not only the debug stream', () => {
  it('carries one entry per dropped rule, with the code and the scope that points at the file', () => {
    const merged = build({ deny: ['Read(C:\\Users\\alice\\.env)'], allow: ['Bash(ls:*)'] });
    // The drop is the state being described; without it the carrier would be
    // correct and vacuous.
    expect(merged.permissionDsl?.droppedRules.map(rule => rule.id)).toEqual(['claude-settings-deny-0']);
    expect(merged.permissionDslDiagnostics).toEqual([{ code: 'unparseable-rule', scope: 'project' }]);
  });

  it('one entry EACH, not one aggregate — three malformed rules, three entries', () => {
    // The page says "with a warning for each"; a user told only that "your
    // settings had problems" cannot repair the second and third rules.
    const merged = build({
      deny: ['Read(C:\\Users\\alice\\.env)', 'Cd(/a\\b)'],
      ask: ['Read(~//x)'],
      allow: ['Bash(ls:*)'],
    });
    expect(merged.permissionDsl?.droppedRules).toHaveLength(3);
    expect(merged.permissionDslDiagnostics).toHaveLength(3);
    for (const entry of merged.permissionDslDiagnostics ?? []) {
      expect(entry).toEqual({ code: 'unparseable-rule', scope: 'project' });
    }
  });

  it('the scope is the LAYER the rule came from, not a constant', () => {
    // Discriminates the join from a hardcoded string: the same malformed rule
    // under a different layer must report that layer.
    const merged = build({ deny: ['Read(C:\\Users\\alice\\.env)'] }, 'workspace');
    expect(merged.permissionDslDiagnostics).toEqual([{ code: 'unparseable-rule', scope: 'workspace' }]);
  });

  it('NOTHING free-form crosses: no rule id, no message', () => {
    const merged = build({ deny: ['Read(C:\\Users\\alice\\.env)'] });
    const serialized = JSON.stringify(merged.permissionDslDiagnostics);
    expect(serialized).not.toContain('claude-settings-deny-0');
    expect(serialized).not.toContain('skipped');
    // Positive control on the same rig: the free-form text really is present one
    // level up, so the absences above are a filter working and not an empty
    // object.
    expect(JSON.stringify(merged.permissionDsl?.diagnostics)).toContain('claude-settings-deny-0');
    // Exactly two keys, so a field added later has to come back through here.
    for (const entry of merged.permissionDslDiagnostics ?? []) {
      expect(Object.keys(entry).sort()).toEqual(['code', 'scope']);
    }
  });

  it('an AUTHOR-WRITTEN rule id can carry a path, and it does not cross', () => {
    /**
     * The row that asked for this carrier argued it was safe to ship the rule
     * id, because `claude-settings-deny-0` is synthetic and path-free. That is
     * true of the ids `claudeSettingsPermissionDsl` mints and FALSE in general:
     * a `permissionDsl` block in a workspace or plugin `permissions.json`
     * carries ids its author wrote, and the compiler interpolates the id
     * verbatim into `diagnostics[].message`.
     *
     * Measured 2026-08-28 — the id below reaches the message intact. So the
     * carrier ships `code` and `scope` (closed unions, path-free by type) and
     * neither the id nor the message.
     */
    const authored = {
      ...parsePermissionsJson(JSON.stringify({ permissions: {} }), SETTINGS_ROOT),
      permissionDsl: {
        sourceDigest: 'deadbeef',
        document: {
          version: 1,
          rules: [{
            id: '/Users/alice/secret-project/.env-rule',
            action: 'deny',
            match: { kind: 'pathGlob', pattern: 'C:\\Users\\alice\\.env', anchor: 'absolute' },
          }],
        },
      },
    } as ReturnType<typeof parsePermissionsJson>;

    permissionsConfigCache.clear();
    const merged = permissionsConfigCache.getMergedConfig({
      workspaceRootPath: `/nonexistent/ws-carrier-${workspace++}`,
      pinnedRevision: 'gen',
      projectTrusted: true,
      pinnedConfigs: [{ config: authored!, scope: 'workspace' }],
    });

    // Positive control: the path really is in the compiler's own diagnostic.
    expect(JSON.stringify(merged.permissionDsl?.diagnostics)).toContain('/Users/alice/secret-project');
    // ...and it is absent from what a host is handed.
    expect(JSON.stringify(merged.permissionDslDiagnostics)).not.toContain('alice');
    expect(merged.permissionDslDiagnostics).toEqual([{ code: 'unparseable-rule', scope: 'workspace' }]);
  });

  it('a clean policy carries NO field at all — with a positive control on the same rig', () => {
    // An absence claim needs one, or a carrier that silently stopped being
    // written reads exactly like a clean settings file.
    const clean = build({ deny: ['Bash(curl:*)'], allow: ['Bash(npm run *)'] });
    expect(clean.permissionDsl?.droppedRules).toHaveLength(0);
    expect(clean.permissionDslDiagnostics).toBeUndefined();

    const dirty = build({ deny: ['Read(C:\\Users\\alice\\.env)'] });
    expect(dirty.permissionDslDiagnostics).toHaveLength(1);
  });
});
