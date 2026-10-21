/**
 * R7 Task 5 — deferred-tool-call mode restore rules (hooks.md "Defer a tool
 * call for later"): "resume restores the permission mode that was active when
 * the call was deferred, except `plan` and `bypassPermissions` which are
 * never carried over and `auto` which is restored only if the account still
 * qualifies." Our `allow-all` is the bypassPermissions analogue.
 */
import { describe, expect, it } from 'bun:test';
import { resolveDeferredModeRestore } from './deferred-tool-call.ts';

describe('resolveDeferredModeRestore', () => {
  it('restores ordinary modes, never plan/bypassPermissions, and auto only while qualified', () => {
    const table: Array<[string, boolean, string | undefined]> = [
      ['default', true, 'default'],
      ['acceptEdits', true, 'acceptEdits'],
      ['dontAsk', true, 'dontAsk'],
      // Never carried over.
      ['plan', true, undefined],
      ['bypassPermissions', true, undefined],
      // auto only if still qualified.
      ['auto', true, 'auto'],
      ['auto', false, undefined],
      // Qualification does not affect non-auto modes.
      ['default', false, 'default'],
      ['plan', false, undefined],
    ];
    for (const [deferredMode, autoStillQualified, expected] of table) {
      expect(
        resolveDeferredModeRestore({ deferredMode: deferredMode as never, autoStillQualified }),
        `${deferredMode} qualified=${autoStillQualified}`,
      ).toBe(expected as never);
    }
  });
});
