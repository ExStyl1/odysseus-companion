/**
 * P6.364 (K10), the claude arm — the operator's subagent model reaches the
 * Claude subprocess, as the DEFAULT the documented order makes it.
 *
 * The Pi and codex arms landed with the row (`86b7f3b8e`); this file is the
 * third. `buildClaudeSubprocessEnv` spreads `process.env`, so an operator who
 * exported the CLAUDE spelling always reached the child — our own
 * `NESSY_SUBAGENT_MODEL` reached nothing at all.
 *
 * ## F1.588 (2026-09-24): the FORCE gate is gone, because the binary caught up
 *
 * Until the 0.3.267 lift the projection happened only under
 * `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`: the vendored bundle (2.1.247, then
 * 2.1.251) scored 0 occurrences of the FORCE variable and implemented the order
 * `sub-agents.md#choose-a-model` records as superseded — "Before v2.1.251,
 * `CLAUDE_CODE_SUBAGENT_MODEL` came first in this order and overrode both the
 * per-invocation parameter and the frontmatter, including `model: inherit`" —
 * so projecting unconditionally would have given claude the opposite order to
 * Pi's spawner.
 *
 * At 2.1.267 (both self-reports) the ORDER was driven on the vendored binary,
 * env scrubbed and binary pinned, with a loopback Messages stub recording the
 * model of the subagent's first request after one `Agent` call:
 *
 * | arm | subagent's model |
 * | --- | --- |
 * | nothing set (control) | the main model |
 * | `CLAUDE_CODE_SUBAGENT_MODEL` only | the variable's |
 * | the variable + a definition `model` | the DEFINITION's |
 * | the variable + a definition `model` + FORCE=1 | the variable's |
 *
 * That is the page's order and its FORCE override, arm for arm — so the value
 * is projected whenever it is declared, as a default below a per-call or
 * definition `model`, which is what `NESSY_SUBAGENT_MODEL` already means on Pi.
 * FORCE rides the ordinary `process.env` spread and the binary applies it (with
 * both of its documented exceptions) per spawn.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { buildClaudeSubprocessEnv } from '../options.ts';
import {
    SUBAGENT_MODEL_COMPAT_ENV_VAR,
    SUBAGENT_MODEL_ENV_VAR,
    SUBAGENT_MODEL_FORCE_ENV_VAR,
} from '../../config/subagent-model.ts';
import { MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR } from '../../config/subagent-spawn-depth.ts';

const TOUCHED = [
    SUBAGENT_MODEL_ENV_VAR,
    SUBAGENT_MODEL_COMPAT_ENV_VAR,
    SUBAGENT_MODEL_FORCE_ENV_VAR,
] as const;
const saved = new Map<string, string | undefined>();
for (const key of TOUCHED) saved.set(key, process.env[key]);

afterEach(() => {
    for (const key of TOUCHED) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

/**
 * The positive control, asserted in every case — including the ones whose
 * verdict is an ABSENCE. A sibling knob that already binds through this same
 * call proves the harness built an env at all.
 */
function expectHarnessAlive(env: NodeJS.ProcessEnv): void {
    expect(env[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR]).toBeDefined();
}

function clear(): void {
    for (const key of TOUCHED) delete process.env[key];
}

describe('P6.364 the subagent-model override on the Claude subprocess', () => {
    it('projects the operator value onto the child under FORCE — the gap P6.364 closed', () => {
        clear();
        process.env[SUBAGENT_MODEL_ENV_VAR] = 'haiku';
        process.env[SUBAGENT_MODEL_FORCE_ENV_VAR] = '1';

        const env = buildClaudeSubprocessEnv();

        expectHarnessAlive(env);
        expect(env[SUBAGENT_MODEL_COMPAT_ENV_VAR]).toBe('haiku');
    });

    it('projects without FORCE too — a DEFAULT, the order the vendored 2.1.267 implements (F1.588)', () => {
        clear();
        process.env[SUBAGENT_MODEL_ENV_VAR] = 'haiku';

        const env = buildClaudeSubprocessEnv();

        expectHarnessAlive(env);
        expect(env[SUBAGENT_MODEL_COMPAT_ENV_VAR]).toBe('haiku');
        // The projection adds no FORCE of its own: a definition `model` keeps winning.
        expect(env[SUBAGENT_MODEL_FORCE_ENV_VAR]).toBeUndefined();
    });

    it('carries an operator FORCE through the spread untouched, so the binary applies it', () => {
        clear();
        process.env[SUBAGENT_MODEL_ENV_VAR] = 'haiku';
        process.env[SUBAGENT_MODEL_FORCE_ENV_VAR] = '1';

        const env = buildClaudeSubprocessEnv();

        expectHarnessAlive(env);
        expect(env[SUBAGENT_MODEL_COMPAT_ENV_VAR]).toBe('haiku');
        expect(env[SUBAGENT_MODEL_FORCE_ENV_VAR]).toBe('1');
    });

    it('decides nothing from FORCE alone — the page: "subagents run on the main conversation\'s model"', () => {
        clear();
        process.env[SUBAGENT_MODEL_FORCE_ENV_VAR] = '1';

        const env = buildClaudeSubprocessEnv();

        expectHarnessAlive(env);
        expect(env[SUBAGENT_MODEL_COMPAT_ENV_VAR]).toBeUndefined();
    });

    it('never overrides an operator who set the Claude spelling themselves', () => {
        clear();
        process.env[SUBAGENT_MODEL_ENV_VAR] = 'haiku';
        process.env[SUBAGENT_MODEL_FORCE_ENV_VAR] = '1';
        process.env[SUBAGENT_MODEL_COMPAT_ENV_VAR] = 'sonnet';

        const env = buildClaudeSubprocessEnv();

        expectHarnessAlive(env);
        expect(env[SUBAGENT_MODEL_COMPAT_ENV_VAR]).toBe('sonnet');
    });

    it('respects the Claude spelling supplied through envOverrides, not just an ambient one', () => {
        // The ambient Nessy value is set on purpose and must LOSE. Without it
        // the case would pass against broken code, which would read the
        // override back out of the merged env and write the same string.
        clear();
        process.env[SUBAGENT_MODEL_ENV_VAR] = 'haiku';
        process.env[SUBAGENT_MODEL_FORCE_ENV_VAR] = '1';

        const env = buildClaudeSubprocessEnv({ [SUBAGENT_MODEL_COMPAT_ENV_VAR]: 'opus' });

        expectHarnessAlive(env);
        expect(env[SUBAGENT_MODEL_COMPAT_ENV_VAR]).toBe('opus');
    });

    it('ignores an exported-but-blank value rather than sending an empty model name', () => {
        clear();
        process.env[SUBAGENT_MODEL_FORCE_ENV_VAR] = '1';
        for (const blank of ['', '   ']) {
            process.env[SUBAGENT_MODEL_ENV_VAR] = blank;

            const env = buildClaudeSubprocessEnv();

            expectHarnessAlive(env);
            expect(env[SUBAGENT_MODEL_COMPAT_ENV_VAR]).toBeUndefined();
        }
    });
});
