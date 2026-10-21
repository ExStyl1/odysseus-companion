/**
 * P6.23 — deferred tool loading was Pi's alone, and the SDK's own ran where we
 * could neither see it nor turn it off.
 *
 * ## The two mechanisms, and the measurement that separates them
 *
 * Ours is CLIENT-SIDE: `mcp__tool_search` / `mcp__tool_load` plus a host
 * catalog, decided by `resolveDeferredMcpToolLoading` from
 * `NESSY_ENABLE_TOOL_SEARCH` and `workspaceDefaults.deferredMcpToolLoading`. Its
 * only consumer is the Pi execution manifest. The SDK's is the API beta, and
 * `agent-sdk/tool-search.md`'s `(unset)` row says what happens when nobody
 * chooses: "Tool search is on. Tool definitions are deferred and discovered on
 * demand."
 *
 * So the one switch a user can see governed one runtime. On a claude connection
 * the SDK talks to directly, an operator who turned deferral off still had tool
 * definitions withheld from the model — by a mechanism inside the subprocess
 * that emits no category, no transcript row and no diagnostic here.
 *
 * ## Which values cross the seam, and where — AMENDED BY P6.529
 *
 * The page's `true` row: "The SDK sends the beta header through proxies, and
 * requests fail on proxies that don't support `tool_reference` blocks." A
 * `claude-runtime` session's `ANTHROPIC_BASE_URL` is `http://127.0.0.1:<port>` —
 * this session's own Anthropic-Messages adapter, which translates to the
 * gateway's OpenAI wire and forwards no `tool_reference` block. The SDK already
 * protects us there by itself: "The SDK also disables tool search when
 * `ANTHROPIC_BASE_URL` points to a non-first-party host, since most proxies
 * don't forward `tool_reference` blocks." Projecting `true` there would override
 * that fallback and break the turn on our own default card.
 *
 * **This file used to say the ON arms therefore write NOTHING, anywhere, and
 * that made the operator's own control stop controlling on the connections the
 * caveat does not cover.** The same page sentence ends *"You can override that
 * default with the `ENABLE_TOOL_SEARCH` environment variable"*, and a direct
 * first-party connection has no proxy to drop a `tool_reference` block. Q-den 66
 * took option 3 (2026-09-05): honour `true` and `auto:N` where the base URL IS
 * first-party, decline them on the loopback, and make the report SAY which of
 * the two applied to this connection — because one runtime with two behaviours
 * is only safe while both are named.
 *
 * The second describe is therefore about a BOUNDARY, not a symmetry: it fails if
 * someone mirrors the ON direction onto the loopback, and it fails if someone
 * removes the first-party arm again.
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import * as configStorage from '../../config/storage.ts';

// `mock.module` is process-global and bun runs every file in one process: spread
// the real module so nothing else is amputated, and restore in `afterAll`. The
// snapshot is taken BEFORE the mock is installed, because restoring from the
// imported namespace afterwards would restore the mock.
const realStorage = { ...configStorage };

let deferredPreference: boolean | Error = true;

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  loadConfigDefaults: () => {
    if (deferredPreference instanceof Error) throw deferredPreference;
    const real = realStorage.loadConfigDefaults();
    return { ...real, workspaceDefaults: { ...real.workspaceDefaults, deferredMcpToolLoading: deferredPreference } };
  },
}));

afterAll(() => {
  mock.module('../../config/storage.ts', () => realStorage);
});

const { buildClaudeSubprocessEnv, describeToolSearchAcrossRuntimes } = await import('../options.ts');

const VARIABLE = 'ENABLE_TOOL_SEARCH';

afterEach(() => {
  deferredPreference = true;
});

/**
 * The knob is read off the MERGED env, so an override is enough to drive it —
 * no `process.env` assignment, which in Bun 1.3.14 is the trap that makes a name
 * readable by property and invisible to a spread.
 */
function envFor(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return buildClaudeSubprocessEnv({ ...overrides });
}

describe('P6.23 — the OFF direction crosses the seam', () => {
  it('projects an explicit NESSY_ENABLE_TOOL_SEARCH=false onto the SDK spelling', () => {
    expect(envFor({ NESSY_ENABLE_TOOL_SEARCH: 'false' })[VARIABLE]).toBe('false');
  });

  it('projects the workspace preference when no override names a mode', () => {
    deferredPreference = false;
    expect(envFor()[VARIABLE]).toBe('false');
  });

  it('outranks an ambient ENABLE_TOOL_SEARCH that would re-arm the child', () => {
    // The same rule `CLAUDE_CODE_DISABLE_CRON` and the auto-memory switch state:
    // written AFTER the overrides, and deliberately not "unless the operator set
    // it". A login-shell `ENABLE_TOOL_SEARCH=true` defeating the in-app toggle is
    // the defect, not a preference to respect.
    expect(envFor({ NESSY_ENABLE_TOOL_SEARCH: 'false', ENABLE_TOOL_SEARCH: 'true' })[VARIABLE])
      .toBe('false');
  });
});

/**
 * P6.529 — the ON directions cross the seam, and ONLY on a first-party base URL.
 *
 * Both arms are asserted against an EXPLICIT `ANTHROPIC_BASE_URL`, never against
 * whatever the developer's shell happens to carry: the first-party test reads an
 * unset value as first-party, so an ambient gateway URL would silently move
 * every assertion here to the other arm and the suite would still be green.
 */
const FIRST_PARTY = 'https://api.anthropic.com';
const LOOPBACK = 'http://127.0.0.1:51234';

describe('P6.529 — the ON directions cross only where the base URL is first-party', () => {
  it('projects an explicit always onto a first-party connection', () => {
    expect(envFor({ NESSY_ENABLE_TOOL_SEARCH: 'true', ANTHROPIC_BASE_URL: FIRST_PARTY })[VARIABLE])
      .toBe('true');
  });

  it('projects auto and auto:N as the page\'s own auto:<percent> spelling', () => {
    // The bare `auto` is the page's 10%, which our parser already substitutes,
    // so writing the number out widens and narrows nothing.
    expect(envFor({ NESSY_ENABLE_TOOL_SEARCH: 'auto', ANTHROPIC_BASE_URL: FIRST_PARTY })[VARIABLE])
      .toBe('auto:10');
    expect(envFor({ NESSY_ENABLE_TOOL_SEARCH: 'auto:5', ANTHROPIC_BASE_URL: FIRST_PARTY })[VARIABLE])
      .toBe('auto:5');
  });

  it('declines every ON direction on the loopback adapter', () => {
    // `true` would send the beta header through the adapter every
    // `claude-runtime` session runs on, and the page says such a request FAILS.
    // Unset keeps the SDK's own non-first-party fallback in force rather than
    // replacing the SDK's classifier with our reading of it.
    for (const mode of ['true', 'auto', 'auto:5']) {
      expect(envFor({ NESSY_ENABLE_TOOL_SEARCH: mode, ANTHROPIC_BASE_URL: LOOPBACK })[VARIABLE], mode)
        .toBeUndefined();
    }
  });

  it('declines every ON direction on any other non-first-party host', () => {
    // The boundary that is not the loopback: a corporate proxy is the case the
    // vendor sentence is actually about.
    expect(envFor({ NESSY_ENABLE_TOOL_SEARCH: 'true', ANTHROPIC_BASE_URL: 'https://gateway.example.com/v1' })[VARIABLE])
      .toBeUndefined();
  });

  it('leaves the variable unset when the preference is on and nothing overrides', () => {
    // `default` names no mode of ours, first-party or not: there is nothing to
    // project and the SDK's own default is the right answer, not a value we
    // invent for it.
    deferredPreference = true;
    expect(envFor({ ANTHROPIC_BASE_URL: FIRST_PARTY })[VARIABLE]).toBeUndefined();
    expect(envFor({ ANTHROPIC_BASE_URL: LOOPBACK })[VARIABLE]).toBeUndefined();
  });

  it('the OFF direction stays unconditional on BOTH arms', () => {
    // The forced off is kept, which is the other half of Q-den 66's option 3.
    for (const baseUrl of [FIRST_PARTY, LOOPBACK]) {
      expect(envFor({ NESSY_ENABLE_TOOL_SEARCH: 'false', ANTHROPIC_BASE_URL: baseUrl })[VARIABLE], baseUrl)
        .toBe('false');
    }
    deferredPreference = false;
    expect(envFor({ ANTHROPIC_BASE_URL: FIRST_PARTY })[VARIABLE]).toBe('false');
  });
});

describe('P6.23 — a config that cannot be read decides nothing', () => {
  it('leaves the variable unset when the stored config throws', () => {
    deferredPreference = new Error('unsupported storage layout');
    expect(envFor()[VARIABLE]).toBeUndefined();
  });

  it('POSITIVE CONTROL: the same call still projects the other knobs', () => {
    // Without this, every `toBeUndefined()` above is consistent with
    // `buildClaudeSubprocessEnv` having done nothing at all.
    deferredPreference = new Error('unsupported storage layout');
    expect(envFor().CLAUDE_CODE_DISABLE_CRON).toBe('1');
  });
});

/**
 * P6.23's second half — the DIFFERENCE, reported.
 *
 * The switch above makes the OFF state uniform. It never made the difference
 * legible, and the two lines it used to emit made it worse: the off line said
 * deferral was "off on both runtimes" when there are three and one of them was
 * never listening, and the on line said nothing about the fallback that is
 * already deciding for every `claude-runtime` session.
 *
 * These assertions are about a REPORT, not a control, so they are written the
 * way a report has to be checked: each runtime named, each state named, and the
 * observability flag asserted separately — because `observable: false` is the
 * whole of what `AGENTS.md` calls an unauditable influence on what the model
 * can see, and a report that omits it reads as a closed gap.
 */
describe('P6.23 — the three-way difference is reported', () => {
    const OFF = { mode: { kind: 'never' } as const, workspacePreference: true };
    const ON = { mode: { kind: 'default' } as const, workspacePreference: true };

    it('names all three runtimes, always, in a stable order', () => {
        for (const input of [OFF, ON]) {
            expect(describeToolSearchAcrossRuntimes(input).map(entry => entry.runtime))
                .toEqual(['pi', 'claude', 'codex']);
        }
    });

    it('reports our own knob turning both reachable runtimes off', () => {
        const off = describeToolSearchAcrossRuntimes(OFF);
        expect(off.find(entry => entry.runtime === 'pi')).toMatchObject({ state: 'upfront', observable: true });
        expect(off.find(entry => entry.runtime === 'claude')).toMatchObject({ state: 'upfront', observable: true });
    });

    it('reports the SDK deferring, and UNOBSERVABLY, on a first-party connection', () => {
        // The `(unset)` row: "Tool search is on. Tool definitions are deferred
        // and discovered on demand." Nothing on this side counts those loads —
        // that is P2.457, and this flag is where it is said out loud.
        const claude = describeToolSearchAcrossRuntimes(ON).find(entry => entry.runtime === 'claude');
        expect(claude).toMatchObject({ state: 'sdk', observable: false });
        expect(describeToolSearchAcrossRuntimes({ ...ON, claudeBaseUrl: 'https://api.anthropic.com' })
            .find(entry => entry.runtime === 'claude')).toMatchObject({ state: 'sdk', observable: false });
    });

    it('reports the SDK disabling ITSELF behind our loopback adapter', () => {
        // "The SDK also disables tool search when `ANTHROPIC_BASE_URL` points to
        // a non-first-party host" — which every claude-runtime session is, so
        // those sessions load upfront whatever our knob says.
        const claude = describeToolSearchAcrossRuntimes({ ...ON, claudeBaseUrl: 'http://127.0.0.1:51234' })
            .find(entry => entry.runtime === 'claude');
        expect(claude).toMatchObject({ state: 'upfront', observable: true });
        expect(claude?.reason).toContain('127.0.0.1:51234');
    });

    it('treats a base URL it cannot read as non-first-party, never as first-party', () => {
        // A report that guesses "first-party" on an unparseable value would claim
        // the SDK is deferring where it is not. Conservative in the safe direction.
        expect(describeToolSearchAcrossRuntimes({ ...ON, claudeBaseUrl: 'not a url' })
            .find(entry => entry.runtime === 'claude')).toMatchObject({ state: 'upfront' });
        expect(describeToolSearchAcrossRuntimes({ ...ON, claudeBaseUrl: 'https://gateway.example.com/v1' })
            .find(entry => entry.runtime === 'claude')).toMatchObject({ state: 'upfront' });
        // The control: a subdomain of the real host IS first-party.
        expect(describeToolSearchAcrossRuntimes({ ...ON, claudeBaseUrl: 'https://api.anthropic.com/v1' })
            .find(entry => entry.runtime === 'claude')).toMatchObject({ state: 'sdk' });
    });

    it('reports codex as unreachable in EVERY arm, because the knob cannot govern it', () => {
        // P2.456, measured at the source: both keys are `Stage::Removed`, the
        // applier skips them before the enable arm, and the real gate is model
        // metadata no config key reaches. `cannot`, stated honestly — not
        // `absent`, which would read as something nobody got round to.
        for (const input of [OFF, ON, { ...ON, claudeBaseUrl: 'http://127.0.0.1:1' }]) {
            const codex = describeToolSearchAcrossRuntimes(input).find(entry => entry.runtime === 'codex');
            expect(codex).toMatchObject({ state: 'unreachable', observable: false });
            expect(codex?.reason).toContain('Stage::Removed');
        }
    });

    it('says WHICH of the two arms applied to this connection (P6.529)', () => {
        // The whole point of option 3: one runtime, two behaviours, both named.
        // On the loopback our threshold does not cross and the report says so;
        // on a first-party connection it does, and the report names the value.
        const declined = describeToolSearchAcrossRuntimes({
            mode: { kind: 'auto', percentOfContextWindow: 5 },
            workspacePreference: true,
            claudeBaseUrl: 'http://127.0.0.1:1',
        });
        expect(declined.find(entry => entry.runtime === 'pi')?.reason).toContain('5%');
        expect(declined.find(entry => entry.runtime === 'claude')?.reason).toContain('NOT projected');

        const honoured = describeToolSearchAcrossRuntimes({
            mode: { kind: 'auto', percentOfContextWindow: 5 },
            workspacePreference: true,
            claudeBaseUrl: 'https://api.anthropic.com',
        });
        const claude = honoured.find(entry => entry.runtime === 'claude');
        expect(claude?.reason).toContain('IS projected');
        expect(claude?.reason).toContain('ENABLE_TOOL_SEARCH=auto:5');
        expect(claude?.reason).not.toContain('NOT projected');

        expect(describeToolSearchAcrossRuntimes({ ...ON, claudeBaseUrl: 'http://127.0.0.1:1' })
            .find(entry => entry.runtime === 'claude')?.reason).not.toContain('NOT projected');
        // The OFF direction DOES cross, so it carries no such caveat.
        expect(describeToolSearchAcrossRuntimes(OFF).find(entry => entry.runtime === 'claude')?.reason)
            .not.toContain('NOT projected');
    });

    it('still reports when the workspace preference is what turns it off', () => {
        const claude = describeToolSearchAcrossRuntimes({ mode: { kind: 'default' }, workspacePreference: false })
            .find(entry => entry.runtime === 'claude');
        expect(claude).toMatchObject({ state: 'upfront', observable: true });
    });
});
