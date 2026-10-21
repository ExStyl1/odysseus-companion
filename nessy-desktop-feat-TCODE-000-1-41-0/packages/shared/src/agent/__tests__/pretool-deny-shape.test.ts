/**
 * The shape a PreToolUse hook returns when it refuses ONE tool call.
 *
 * This had no test, which is how it drifted: `blockWithReason` returned
 * `{ continue: false, decision: 'block', reason }` under a comment calling that
 * "the correct SDK format". `hooks.md` says `continue: false` "stops processing
 * entirely … Takes precedence over any event-specific decision fields", and its
 * `stopReason` is "Not shown to Claude" — so a blocked tool ended the turn and
 * the model never learned why. Measured on claude-runtime: in Explore mode a
 * refused write produced no assistant message at all, on SDK 0.3.215 AND 0.3.218.
 *
 * What these cases pin is therefore not decoration. `continue` must stay absent,
 * and the reason must ride the field the page documents as reaching Claude.
 */
import { describe, expect, it } from 'bun:test';
import { blockWithReason, denyToolWithReason } from '../mode-manager.ts';

describe('PreToolUse denial shape', () => {
    it('denies the call inside hookSpecificOutput, as PreToolUse requires', () => {
        const result = denyToolWithReason('nope');

        // "Unlike other hooks that use a top-level `decision` field, PreToolUse
        // returns its decision inside a `hookSpecificOutput` object."
        expect(result.hookSpecificOutput).toEqual({
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'nope',
        });
    });

    it('never sets `continue`, which would stop the agent instead of the tool', () => {
        // The whole defect in one assertion: `continue: false` "takes precedence
        // over any event-specific decision fields", so its presence would undo
        // the deny above no matter how correct that deny is.
        expect('continue' in denyToolWithReason('nope')).toBe(false);
        expect('continue' in blockWithReason('nope')).toBe(false);
    });

    it('carries the reason on the field that reaches the model, not one that does not', () => {
        const result = denyToolWithReason('target not in allowed folders');

        // `permissionDecisionReason` for a deny is "shown to Claude"; `stopReason`
        // is explicitly "Not shown to Claude". Putting the text on the wrong one
        // is invisible in every unit test that only checks the text exists.
        expect(result.hookSpecificOutput.permissionDecisionReason)
            .toBe('target not in allowed folders');
        expect((result as { stopReason?: string }).stopReason).toBeUndefined();
        expect((result as { reason?: string }).reason).toBeUndefined();
    });

    it('keeps the [ERROR] marker on mode blocks so the model can tell a refusal from a result', () => {
        expect(blockWithReason('Write blocked (Explore mode)').hookSpecificOutput.permissionDecisionReason)
            .toBe('[ERROR] Write blocked (Explore mode)');
    });
});
