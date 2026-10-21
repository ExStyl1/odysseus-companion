/**
 * F1.825 — the markers of a FOREIGN Claude Code session stop at the claude child.
 *
 * Nessy started from a Claude Code terminal inherits that session's markers
 * (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT=claude-desktop`,
 * …) and `buildClaudeSubprocessEnv` spreads `process.env`, so without the scrub the
 * SDK child thinks it is nested in — or is — that session. Owner decision
 * 2026-09-26, option `strip-child`: one constant, scrubbed from the child env only.
 *
 * The membership half reads the vendored native binary, not a page: the four
 * subprocess markers come from the binary's OWN literal, so a fifth one fails here.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildClaudeSubprocessEnv } from '../options.ts';
import {
    CLAUDE_INHERITED_SESSION_MARKER_ENV_KEYS,
    CLAUDE_LAUNCHER_ENV_KEYS,
    CLAUDE_SDK_STRIPPED_ENV_KEYS,
} from '../../config/claude-provider-routing-env.ts';

const MARKERS = CLAUDE_INHERITED_SESSION_MARKER_ENV_KEYS as readonly string[];

/** Documented USER settings a Claude Code shell also exports — an operator's choice, kept. */
const USER_SETTINGS = ['CLAUDE_CODE_DISABLE_TERMINAL_TITLE', 'MCP_SERVER_CONNECTION_BATCH_SIZE'] as const;

/** In no strip list; the binary's alphabetical neighbour of `CLAUDE_CODE_SESSION_ID`. */
const CONTROL = 'CLAUDE_CODE_SESSION_NAME';

/** Run `fn` with `values` in `process.env`, restoring every name afterwards. */
function withHostEnv<T>(values: Record<string, string>, fn: () => T): T {
    const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
    // Delete first, then assign: Bun 1.3.14 hides a freshly INTRODUCED name from
    // the spread for some slots (docs/agents/traps.md), and the spread is what we read.
    for (const [key, value] of Object.entries(values)) {
        delete process.env[key];
        process.env[key] = value;
    }
    try {
        return fn();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            delete process.env[key];
            if (value !== undefined) process.env[key] = value;
        }
    }
}

/** The bundled native CLI as text, or `undefined` with a DECLARED skip off darwin-arm64. */
function binaryText(): string | undefined {
    const binary = fileURLToPath(new URL(
        '../../../../../node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
        import.meta.url,
    ));
    try {
        return readFileSync(binary).toString('latin1');
    } catch {
        expect(process.platform === 'darwin' && process.arch === 'arm64').toBe(false);
        return undefined;
    }
}

describe('F1.825 — inherited Claude Code session markers', () => {
    it('are absent from the claude child env, while the host env keeps them', () => {
        const values = Object.fromEntries(MARKERS.map(k => [k, `foreign-${k}`]));
        values.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop';
        withHostEnv(values, () => {
            const env = buildClaudeSubprocessEnv();
            for (const key of MARKERS) {
                expect({ key, value: env[key] }).toEqual({ key, value: undefined });
            }
            // Child env ONLY (P3.300's rule): the host process keeps them, so the Pi
            // subprocess spawned from the same host env is not changed by this row.
            expect(process.env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-desktop');
            expect(process.env.CLAUDECODE).toBe('foreign-CLAUDECODE');
        });
    });

    it('keeps the documented user settings and an unlisted neighbour — the drop is by name', () => {
        const values: Record<string, string> = { [CONTROL]: 'nessy-control', CLAUDECODE: '1' };
        for (const key of USER_SETTINGS) values[key] = `operator-${key}`;
        withHostEnv(values, () => {
            const env = buildClaudeSubprocessEnv();
            for (const key of USER_SETTINGS) {
                expect({ key, value: env[key] }).toEqual({ key, value: `operator-${key}` });
            }
            expect(env[CONTROL]).toBe('nessy-control');
            // Same rig, so the survivals above are not a scrub that never ran.
            expect(env.CLAUDECODE).toBeUndefined();
        });
    });

    it('pins the list by name and keeps it out of the other strip lists', () => {
        expect([...CLAUDE_INHERITED_SESSION_MARKER_ENV_KEYS]).toEqual([
            'CLAUDECODE',
            'CLAUDE_CODE_SESSION_ID',
            'CLAUDE_CODE_CHILD_SESSION',
            // F1.1213 — the fifth subprocess marker, arrived with 2.1.274; the
            // literal-parsing case below is what caught it.
            'CLAUDE_CODE_SESSION_ATTENDED',
            'CLAUDE_PID',
            'CLAUDE_CODE_ENTRYPOINT',
            'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
            'CLAUDE_CODE_TERMINAL_MCP_TOOLS',
            'CLAUDE_CODE_REPORT_FINDINGS',
            'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
            'CLAUDE_CODE_EAGER_FLUSH',
            'CLAUDE_CODE_DESKTOP_APP_VERSION',
        ]);
        for (const key of USER_SETTINGS) expect(MARKERS.includes(key)).toBe(false);
        // The silent union is ALSO cleared from the HOST env by `config/llm-connections.ts`;
        // a marker filed there would break the child-only rule.
        for (const key of MARKERS) {
            expect({ key, silent: (CLAUDE_SDK_STRIPPED_ENV_KEYS as readonly string[]).includes(key) })
                .toEqual({ key, silent: false });
            expect((CLAUDE_LAUNCHER_ENV_KEYS as readonly string[]).includes(key)).toBe(false);
        }
    });

    it('names only what the vendored binary carries, and covers its own subprocess-marker literal', () => {
        const text = binaryText();
        if (text === undefined) return;
        // Instrument proved on the same read: a fabricated name is absent.
        expect(text.includes('ZZQQNOTAREALNAME')).toBe(false);
        for (const key of MARKERS) {
            expect({ key, present: text.includes(key) }).toEqual({ key, present: true });
        }
        // The excluded user settings ARE read by the binary, so their absence from
        // the list is the decision, not a missing name.
        for (const key of USER_SETTINGS) expect(text.includes(`${key}:()=>`)).toBe(true);

        // The self-updating half: the binary's own env for every subprocess it spawns,
        // `{CLAUDECODE:"1",CLAUDE_CODE_SESSION_ID:…,CLAUDE_CODE_CHILD_SESSION:"1",CLAUDE_PID:…}`.
        const start = text.indexOf('{CLAUDECODE:"1",');
        expect(start).toBeGreaterThan(0);
        expect(text.indexOf('{CLAUDECODE:"1",', start + 1)).toBe(-1);
        const literal = text.slice(start, text.indexOf('}', start) + 1);
        const keys = [...literal.matchAll(/[{,]([A-Z][A-Z0-9_]*):/g)].map(m => m[1]!);
        expect(keys.length).toBeGreaterThanOrEqual(4);
        expect(keys).toContain('CLAUDE_PID');
        expect(keys.filter(k => !MARKERS.includes(k))).toEqual([]);
    });
});
