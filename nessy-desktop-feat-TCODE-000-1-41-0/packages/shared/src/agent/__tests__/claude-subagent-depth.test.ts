/**
 * U1 — the subagent depth ceiling reaches the Claude subprocess.
 *
 * `resolveMaxSubagentSpawnDepth` has always read `NESSY_MAX_SUBAGENT_SPAWN_DEPTH`,
 * but its only reader seeded the PI execution manifest. Setting the Nessy name to
 * `1` therefore turned nesting off on Pi sessions and did nothing at all on
 * claude-runtime ones — one knob, two runtimes, one of them deaf.
 *
 * The negative case matters as much as the positive: an operator who set the
 * Claude spelling has already decided, and we must not overwrite it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { buildClaudeSubprocessEnv } from '../options.ts';
import {
    DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH,
    MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR,
    MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR,
} from '../../config/subagent-spawn-depth.ts';

const TOUCHED = [MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR, MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR] as const;
const saved = new Map<string, string | undefined>();
for (const key of TOUCHED) saved.set(key, process.env[key]);

afterEach(() => {
    for (const key of TOUCHED) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe('U1 subagent depth on the Claude subprocess', () => {
    it('pins the documented default explicitly rather than inheriting the SDK’s', () => {
        for (const key of TOUCHED) delete process.env[key];

        const env = buildClaudeSubprocessEnv();

        expect(env[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR])
            .toBe(String(DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH));
        // Not merely "defined": the value has to be a depth that permits nesting,
        // which is the product behaviour the R60 rows cover.
        expect(Number(env[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR])).toBeGreaterThan(1);
    });

    it('carries the Nessy knob across to the Claude runtime — the gap this closes', () => {
        delete process.env[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR];
        process.env[MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR] = '1';

        expect(buildClaudeSubprocessEnv()[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR]).toBe('1');
    });

    it('never overrides an operator who set the Claude spelling themselves', () => {
        process.env[MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR] = '2';
        process.env[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR] = '5';

        expect(buildClaudeSubprocessEnv()[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR]).toBe('5');
    });

    it('respects the Claude spelling supplied through envOverrides, not just an ambient one', () => {
        // The ambient Nessy value is set on purpose and must LOSE here. Without
        // it this case passes even with the guard deleted — the resolver would
        // read the override back out of the merged env and write the same number,
        // so the test would agree with broken code. Measured, not assumed.
        process.env[MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR] = '2';
        delete process.env[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR];

        const env = buildClaudeSubprocessEnv({ [MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR]: '4' });

        expect(env[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR]).toBe('4');
    });

    it('falls back to the documented default when the Nessy value is malformed', () => {
        delete process.env[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR];
        // "Anything else is ignored, so the limit can be adjusted but not removed"
        // — and `0` must never be read as unlimited.
        for (const malformed of ['0', '2.5', '1e3', 'off', ' ']) {
            process.env[MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR] = malformed;

            expect(buildClaudeSubprocessEnv()[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR])
                .toBe(String(DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH));
        }
    });
});
