/**
 * C3.386 — the v2 file-change card names the files it is about, or refuses the
 * durable grant.
 *
 * ## What RS-12 read off packaged 1.37.0, verbatim
 *
 * `Permission required · Tool: ApplyPatch · Apply file changes · Allow · Always
 * Allow · Deny · Add a note` — on a patch writing into a PROTECTED directory.
 * No path, no floor sentence, and an **Always Allow** offered for an act the
 * user could not see.
 *
 * ## The frame really does carry no paths, and that is not the end of it
 *
 * `packages/codex-protocol/generated/v2/FileChangeRequestApprovalParams.ts` is
 * `{threadId, turnId, itemId, startedAtMs, reason?, grantRoot?}`, where v1's
 * `applyPatchApproval` carried `fileChanges` keyed BY path. But
 * `ThreadItem`'s `fileChange` variant carries
 * `changes: Array<FileUpdateChange>` and `FileUpdateChange` is
 * `{ path, kind, diff }` — so the paths reached this process on `item/started`,
 * and the frame's `itemId` names that item. `CodexAgent` does the correlation;
 * this function is handed the result and invents nothing.
 *
 * `grantRoot` is still NOT read as the subject, and that refusal is unchanged:
 * it is "allow writes under this root for the remainder of the session", which
 * is a session write root and not the file being written.
 */
import { describe, expect, test } from 'bun:test';
import { mapFileChangeApprovalToRequest } from '../approval-bridge.ts';

describe('C3.386 — the ApplyPatch card and its paths', () => {
  test('POSITIVE — the card names the file, and Always Allow stands', () => {
    const req = mapFileChangeApprovalToRequest('r1', {}, ['/repo/.codex/rules/x.rules']);

    expect(req.description).toContain('/repo/.codex/rules/x.rules');
    // The subject is also on `command`, which is the field the card renders as
    // the act's own line — a description alone leaves the row above it blank.
    expect(req.command).toBe('/repo/.codex/rules/x.rules');
    // A named act can be granted durably: the same set has just been handed to
    // the floor and the rule matchers, so the grant means what the card said.
    expect(req.noAlwaysAllow).toBeUndefined();
  });

  test('POSITIVE — every path of a multi-file patch is named', () => {
    const req = mapFileChangeApprovalToRequest('r2', {}, ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']);

    for (const path of ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']) {
      expect(req.description).toContain(path);
    }
    expect(req.noAlwaysAllow).toBeUndefined();
  });

  test('BOUNDARY — a long patch is capped with a remainder rather than rendered whole', () => {
    // A card is a sentence a user reads before deciding, and codex's
    // `convert_patch_changes` sorts by path with no cap of its own — a forty-file
    // patch must not render as a wall the user scrolls past.
    const paths = Array.from({ length: 9 }, (_, index) => `/repo/file-${index}.ts`);
    const req = mapFileChangeApprovalToRequest('r3', {}, paths);

    expect(req.description).toContain('/repo/file-0.ts');
    expect(req.description).toContain('/repo/file-3.ts');
    expect(req.description).toContain('and 5 more');
    // The cap is a display bound and NOT a change of subject: the fifth file is
    // still part of the act, so the grant is still offered.
    expect(req.description).not.toContain('/repo/file-4.ts');
    expect(req.noAlwaysAllow).toBeUndefined();
  });

  test('NEGATIVE — with no paths known the card refuses Always Allow', () => {
    // The load-bearing half. A durable grant minted from a frame that cannot
    // name its own subject is a promise about acts nobody enumerated — the same
    // refusal `mapCommandApprovalToRequest` already makes for a non-`command`
    // kind, and for the same stated reason.
    const req = mapFileChangeApprovalToRequest('r4', {});

    expect(req.noAlwaysAllow).toBe(true);
    // …and the one-off answers are untouched, so nothing becomes unanswerable.
    expect(req.description).toBe('Apply file changes');
    expect(req.command).toBeUndefined();
  });

  test('NEGATIVE — grantRoot is still not read as the subject', () => {
    // It is a session write root, not the file being written. With no paths it
    // remains the only thing the card can say, and it still does not unlock the
    // durable grant.
    const req = mapFileChangeApprovalToRequest('r5', { grantRoot: '/repo' }, []);

    expect(req.description).toBe('Apply file changes under /repo');
    expect(req.noAlwaysAllow).toBe(true);
  });

  test('CONTROL — blank and whitespace-only entries are not paths', () => {
    // The correlation map is fed from a runtime notification, so an empty
    // string must not turn into a named subject that reads as a file called
    // nothing — and must not unlock Always Allow either.
    const req = mapFileChangeApprovalToRequest('r6', { grantRoot: '/repo' }, ['', '   ']);

    expect(req.description).toBe('Apply file changes under /repo');
    expect(req.noAlwaysAllow).toBe(true);
  });

  test('CONTROL — `reason` still rides through, on both answers', () => {
    expect(mapFileChangeApprovalToRequest('r7', { reason: 'write access' }).reason).toBe('write access');
    expect(mapFileChangeApprovalToRequest('r8', { reason: 'write access' }, ['/repo/a.ts']).reason)
      .toBe('write access');
  });
});
