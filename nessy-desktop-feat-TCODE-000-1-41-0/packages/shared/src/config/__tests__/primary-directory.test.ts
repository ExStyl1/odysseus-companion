/**
 * C3.178 · the primary attached folder is a CHOICE, and it is a display and
 * ordering choice only.
 *
 * Three things are pinned and the third is the one that makes the row safe:
 *
 * - the POSITIVE CONTROL the row names — no choice stored resolves to today's
 *   derivation, exactly, so an install that never opens the control behaves as
 *   it did before the key existed;
 * - the choice takes, including the derived root itself as a legal answer;
 * - and the AUTHORITY INVARIANT: the resolver can only ever return a member of
 *   the set it was handed, so no value of `primaryDirectory` widens what a
 *   session may read or write. P6.929 closed by record 2026-09-10 with option
 *   (b) — *the primary folder is a display and ordering choice; discovery stays
 *   on the project root* — and this suite is where that stays true.
 *
 * The strict-envelope half is pinned here too rather than left to the guard:
 * `StoredConfigTopLevelSchema` is `.strict()`, so a key our own setter writes
 * and the envelope does not declare REFUSES the whole `config.json` and costs
 * the user every other setting in it.
 */
import { describe, expect, it } from 'bun:test';

import {
  orderAttachedRoots,
  PRIMARY_DIRECTORY_SETTING_KEY,
  resolveSessionPrimaryRoot,
} from '../primary-directory.ts';
import { StoredConfigSchema, StoredConfigTopLevelSchema } from '../validators.ts';
import { STORAGE_LAYOUT_VERSION } from '../paths.ts';

const DERIVED = '/repo/project';
const ATTACHED = ['/opt/shared-notes', '/srv/data'];

describe('C3.178 · resolveSessionPrimaryRoot', () => {
  it('POSITIVE CONTROL — no choice stored is today\'s derivation, exactly', () => {
    expect(resolveSessionPrimaryRoot({ derivedPrimaryRoot: DERIVED }))
      .toEqual({ primaryRoot: DERIVED, source: 'derived' });
    // An empty or whitespace value is "no choice", not a bad one: the absence of
    // the key is the documented state and a cleared control must reach it.
    expect(resolveSessionPrimaryRoot({ derivedPrimaryRoot: DERIVED, choice: '   ' }))
      .toEqual({ primaryRoot: DERIVED, source: 'derived' });
    expect(resolveSessionPrimaryRoot({
      derivedPrimaryRoot: DERIVED,
      attachedRoots: ATTACHED,
    })).toEqual({ primaryRoot: DERIVED, source: 'derived' });
  });

  it('an attached folder becomes primary, and the derived root is a legal choice', () => {
    expect(resolveSessionPrimaryRoot({
      derivedPrimaryRoot: DERIVED,
      attachedRoots: ATTACHED,
      choice: '/srv/data',
    })).toEqual({ primaryRoot: '/srv/data', source: 'chosen' });

    // Choosing the derivation explicitly is what lets the control show a settled
    // answer rather than an empty one; it must not read as a refusal.
    expect(resolveSessionPrimaryRoot({
      derivedPrimaryRoot: DERIVED,
      attachedRoots: ATTACHED,
      choice: DERIVED,
    })).toEqual({ primaryRoot: DERIVED, source: 'chosen' });
  });

  it('a non-normalised spelling of an attached folder still matches', () => {
    // Path-normalised, deliberately not realpath-resolved: this is a display
    // choice over paths the user typed. A trailing separator and a `..` segment
    // are the two spellings a folder picker actually produces.
    for (const spelling of ['/srv/data/', '/srv/nested/../data']) {
      expect(resolveSessionPrimaryRoot({
        derivedPrimaryRoot: DERIVED,
        attachedRoots: ATTACHED,
        choice: spelling,
      })).toEqual({ primaryRoot: '/srv/data', source: 'chosen' });
    }
  });

  it('NEGATIVE — a folder that is not attached is refused, and the derivation stands', () => {
    // THE AUTHORITY INVARIANT. If this ever returned the requested path, the
    // setting would have become a second way to widen a session's roots.
    expect(resolveSessionPrimaryRoot({
      derivedPrimaryRoot: DERIVED,
      attachedRoots: ATTACHED,
      choice: '/etc',
    })).toEqual({
      primaryRoot: DERIVED,
      source: 'derived',
      refusal: 'primary-directory-not-attached',
    });
  });

  it('NEGATIVE — a relative choice is refused before anything is compared', () => {
    expect(resolveSessionPrimaryRoot({
      derivedPrimaryRoot: DERIVED,
      attachedRoots: ATTACHED,
      choice: 'data',
    })).toEqual({
      primaryRoot: DERIVED,
      source: 'derived',
      refusal: 'primary-directory-not-absolute',
    });
  });

  it('the answer is ALWAYS a member of the set it was given — over every input', () => {
    // The invariant stated as a property rather than as one case, because it is
    // the whole of what keeps this key out of the permission layer.
    const candidates = [DERIVED, ...ATTACHED];
    for (const choice of [undefined, '', '/srv/data', DERIVED, '/etc', 'rel', '/srv/data/']) {
      const resolved = resolveSessionPrimaryRoot({
        derivedPrimaryRoot: DERIVED,
        attachedRoots: ATTACHED,
        ...(choice === undefined ? {} : { choice }),
      });
      expect(candidates).toContain(resolved.primaryRoot);
    }
  });
});

describe('C3.178 · orderAttachedRoots is a reordering and never a filter', () => {
  it('puts the primary first and keeps every other root in configured order', () => {
    expect(orderAttachedRoots([DERIVED, ...ATTACHED], '/srv/data'))
      .toEqual(['/srv/data', DERIVED, '/opt/shared-notes']);
  });

  it('a primary that is not in the list changes nothing but the duplicates', () => {
    expect(orderAttachedRoots([DERIVED, ...ATTACHED], '/etc'))
      .toEqual([DERIVED, ...ATTACHED]);
    // Same folder twice, and a blank entry, collapse — what a list rendered to a
    // person should show. The SET is never grown.
    expect(orderAttachedRoots(['/srv/data', '/srv/data/', '  ', DERIVED], '/srv/data'))
      .toEqual(['/srv/data', DERIVED]);
  });
});

describe('C3.178 · the strict stored-config envelope declares the new key', () => {
  it('both envelopes carry it, so writing it cannot refuse the whole config.json', () => {
    expect(Object.keys(StoredConfigTopLevelSchema.shape)).toContain(PRIMARY_DIRECTORY_SETTING_KEY);
    expect(Object.keys(StoredConfigSchema.shape)).toContain(PRIMARY_DIRECTORY_SETTING_KEY);

    const base = {
      storageLayoutVersion: STORAGE_LAYOUT_VERSION,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
    };
    // POSITIVE: a config carrying the key parses, and every neighbour survives.
    const withKey = StoredConfigTopLevelSchema.safeParse({
      ...base,
      colorTheme: 'dark',
      [PRIMARY_DIRECTORY_SETTING_KEY]: '/srv/data',
    });
    expect(withKey.success).toBe(true);
    // CONTROL: the envelope really is strict, so the assertion above is not
    // vacuous — an undeclared neighbour still refuses the document.
    expect(StoredConfigTopLevelSchema.safeParse({ ...base, aKeyNoReaderNames: true }).success)
      .toBe(false);
  });
});

describe('C3.178 · the choice reaches the DISPLAY and nothing else', () => {
  it('SessionManager resolves the snapshot primary root through it', async () => {
    const manager = await Bun.file(
      new URL('../../../../server-core/src/sessions/SessionManager.ts', import.meta.url).pathname,
    ).text();
    expect(manager).toContain('resolveSessionPrimaryRoot({');
    expect(manager).toContain('primaryRoot: boundedRuntimeText(primaryRootResolution.primaryRoot, 1024)');
    // The session's real filesystem authority is built from the project handle
    // and must NOT read the choice. If a later change hands it in, this dies.
    expect(manager).not.toContain('projectCanonicalPath: primaryRootResolution');
  });

  it('the harness AUTHORITY site still derives its primary root, and says why', async () => {
    // P6.929 option (b): discovery stays on the project root. The `primaryRoot`
    // in `sessionScopeFor` is the root `resolveScopedPath` checks containment
    // against — a settings key choosing it would move where the agent may write.
    const harness = await Bun.file(
      new URL('../../../../pi-agent-server/src/index.ts', import.meta.url).pathname,
    ).text();
    expect(harness).toContain('const primaryRoot = runtimeCwd || initConfig?.workingDirectory');
    expect(harness).not.toContain('resolveSessionPrimaryRoot');
    expect(harness).toContain('C3.178 DELIBERATELY DOES NOT REACH HERE');
  });
});
