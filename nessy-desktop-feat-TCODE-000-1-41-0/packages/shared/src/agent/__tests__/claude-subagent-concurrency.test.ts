/**
 * P6.16 — the concurrent-subagent ceiling reaches the Claude subprocess.
 *
 * `NESSY_MAX_CONCURRENT_SUBAGENTS` had exactly one enforcement site
 * (`pi-agent-server/src/orchestrator/spawner.ts`), so an operator who capped
 * concurrent subagents got it enforced on Pi sessions and **silently ignored on
 * claude-runtime ones** — one knob, two runtimes, one of them deaf. The same
 * shape `claude-subagent-depth.test.ts` closed for the sibling depth knob, and
 * that test file is this one's positive control: every case below asserts the
 * depth variable arrived too, so a failure here can never be a broken harness.
 *
 * NATIVE-FIRST, measured before building anything: the SDK's native binary
 * already owns this gate. `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
 * carries the refusal verbatim — "Concurrent subagent limit reached. You can run
 * ${n} subagents at once. Do not retry. If the user wants more concurrent
 * subagents, ask them to increase CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS" — and
 * checks its own `ultracode` exemption beside it. So the host's whole job is to
 * hand the operator's number to a gate that already exists; nothing here
 * re-implements a counter.
 *
 * WHAT IS DELIBERATELY NOT FORWARDED, and this is the row's premise corrected
 * rather than executed. `maxConcurrentSubagents()` narrows the documented
 * default of 20 to `hostLiveAgentCeiling - 1` — one agent runtime per 2 GiB of
 * RAM — and `config/subagent-limits.ts` states the reason in its own words: "A
 * Claude Code subagent is another context window inside one process; ours is a
 * whole Pi subprocess at roughly a gibibyte". That narrowing prices a Pi
 * subprocess. A claude-runtime subagent is the first half of that sentence: the
 * SDK runs it inside the one subprocess this session already holds, the host
 * mints no runtime for it (`live-agent-ceiling.ts` counts it as a BUSY domain on
 * the parent, never as a new occupant), and no gibibyte is spent. Projecting the
 * Pi formula onto it would refuse work for memory nobody allocates, and would
 * contradict `sub-agents.md#concurrent-subagent-limit` — "By default, when 20
 * subagents are running in a session, spawning another with the Agent tool fails
 * with `Concurrent subagent limit reached`" — for no measured cost. So an unset
 * knob leaves the SDK's documented default in force, and the residual difference
 * (Pi narrows by RAM, claude does not) is stated rather than papered over.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { buildClaudeSubprocessEnv } from '../options.ts';
import {
    MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV,
    MAX_CONCURRENT_SUBAGENTS_ENV,
} from '../../config/subagent-limits.ts';
import { MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR } from '../../config/subagent-spawn-depth.ts';

const TOUCHED = [MAX_CONCURRENT_SUBAGENTS_ENV, MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV] as const;
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
 * The positive control, asserted in every case: the sibling knob U1 landed still
 * arrives through this same call. An ABSENCE finding needs one on the same rig.
 */
function expectHarnessAlive(env: NodeJS.ProcessEnv): void {
    expect(env[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR]).toBeDefined();
}

describe('P6.16 concurrent-subagent ceiling on the Claude subprocess', () => {
    it('carries the Nessy knob across to the Claude runtime — the gap this closes', () => {
        delete process.env[MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV];
        process.env[MAX_CONCURRENT_SUBAGENTS_ENV] = '5';

        const env = buildClaudeSubprocessEnv();

        expectHarnessAlive(env);
        expect(env[MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV]).toBe('5');
    });

    it('leaves the ceiling to the SDK when no operator set one', () => {
        // NOT the RAM-narrowed number: see the file header. The SDK's own
        // documented default of 20 governs, and it governs from inside the gate
        // that would enforce ours anyway.
        for (const key of TOUCHED) delete process.env[key];

        const env = buildClaudeSubprocessEnv();

        expectHarnessAlive(env);
        expect(env[MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV]).toBeUndefined();
    });

    it('never overrides an operator who set the Claude spelling themselves', () => {
        process.env[MAX_CONCURRENT_SUBAGENTS_ENV] = '2';
        process.env[MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV] = '9';

        const env = buildClaudeSubprocessEnv();

        expectHarnessAlive(env);
        expect(env[MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV]).toBe('9');
    });

    it('respects the Claude spelling supplied through envOverrides, not just an ambient one', () => {
        // The ambient Nessy value is set on purpose and must LOSE. Without it
        // this case would pass against broken code: the resolver would read the
        // override back out of the merged env and write the same number.
        process.env[MAX_CONCURRENT_SUBAGENTS_ENV] = '2';
        delete process.env[MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV];

        const env = buildClaudeSubprocessEnv({ [MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV]: '4' });

        expectHarnessAlive(env);
        expect(env[MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV]).toBe('4');
    });

    it('ignores a malformed Nessy value rather than inventing a cap from it', () => {
        delete process.env[MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV];
        // `env-vars.md`, the `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` row: "Accepts
        // a positive whole number in plain digits; anything else is ignored, so
        // the variable can adjust the cap but can't disable it." `0` is therefore
        // not a disable value, and neither spelling of it may reach the child.
        for (const malformed of ['0', '2.5', '1e3', 'off', ' ', '']) {
            process.env[MAX_CONCURRENT_SUBAGENTS_ENV] = malformed;

            const env = buildClaudeSubprocessEnv();

            expectHarnessAlive(env);
            expect(env[MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV]).toBeUndefined();
        }
    });
});
