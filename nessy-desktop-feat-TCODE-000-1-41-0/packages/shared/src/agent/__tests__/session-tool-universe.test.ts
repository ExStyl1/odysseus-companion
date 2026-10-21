/**
 * P6.217 — a session can be restricted to a set of BUILT-IN tools.
 *
 * Almost nothing had to be built: Pi already ENFORCES `piAllowedTools`
 * (`base-agent.ts`: *"the turn's tool universe when the host pins one"*), and
 * claude narrows its built-ins through the SDK `tools` option (F1.638's
 * `buildClaudeSessionToolsOption`; never `allowedTools`, which pre-approves and
 * restricts nothing) beside `disallowedTools`. What was missing was an INPUT:
 * no producer for the whitelist, and only a host constant as the blacklist.
 *
 * So the subject here is the resolver and the two shapes that would have made
 * the feature dangerous rather than absent:
 *
 *  - an EMPTY whitelist. `tools: []` means "Disable all built-in tools"
 *    (`sdk.d.ts`), so a present-but-empty setting would brick every session
 *    rather than leave it unrestricted. Absent and empty must resolve alike.
 *  - a blacklist that could REPLACE the host constant. Those entries each carry
 *    their own reason — `CLAUDE_SESSION_DISALLOWED_TOOLS` bans two names whose
 *    host twins must be reached through the gate — so a user list that could
 *    unban one would be a permission widening dressed as a preference.
 *
 * Codex is structurally denied (`enabled_tools`/`disabled_tools` reach MCP
 * SERVERS only, ledger A10) and is named by P6.596's switch row rather than
 * silently dropped.
 *
 * ## P6.912 — and a THIRD dangerous shape, which is the one that shipped
 *
 * The input lived in `config-defaults.json`'s `workspaceDefaults`, and that file
 * is rewritten from the bundled asset on every launch by `syncConfigDefaults`.
 * The bundled asset ships neither key, so a hand-written entry was gone by the
 * next start and the resolver returned two empty lists on every install that has
 * ever existed — a feature described as live in three places with a structurally
 * empty input. The keys are in `config.json` now, on the strict envelope, and
 * this suite writes THERE. The first case below is the one that would have
 * caught it: it asserts the shipped default, and the four after it assert that a
 * written value survives to be read, which is exactly what the old home could
 * not do.
 */
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../../config/paths.ts';
import { getSessionToolUniverse } from '../../config/storage.ts';
import { CLAUDE_SESSION_DISALLOWED_TOOLS } from '../claude-agent.ts';

const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/**
 * P6.912 — written straight into `config.json`, which is where the two keys live
 * now. There is no setter for either and that is deliberate: they are
 * operator-shaped, so the doctor reads them and no control writes them
 * (P6.824's family decision).
 *
 * The isolate preload hands this run an empty temp `CONFIG_DIR`, so the file is
 * seeded with the minimum a strict envelope accepts rather than copied from
 * anywhere. That is also what makes the default case below meaningful: a config
 * carrying neither key is exactly what every install has.
 */
const PRISTINE_CONFIG = {
  storageLayoutVersion: 2,
  workspaceRefs: [],
  activeWorkspaceId: null,
  activeSessionId: null,
};

let pristine = '';

beforeAll(() => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(PRISTINE_CONFIG, null, 2), 'utf-8');
  }
  pristine = readFileSync(CONFIG_PATH, 'utf-8');
});

function writeWorkspaceDefaults(patch: Record<string, unknown>): void {
  const raw = JSON.parse(pristine) as Record<string, unknown>;
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...raw, ...patch }, null, 2), 'utf-8');
}

afterEach(() => {
  writeFileSync(CONFIG_PATH, pristine, 'utf-8');
});

describe('P6.217 · the session tool universe', () => {
  it('is absent by default — nothing shipped, so nothing is restricted', () => {
    const universe = getSessionToolUniverse();
    expect(universe).toEqual({ allowed: [], disallowed: [] });
  });

  it('reads both halves, trimmed and de-duplicated', () => {
    writeWorkspaceDefaults({
      sessionAllowedTools: ['Read', '  Read  ', 'Grep', '   ', 'Glob'],
      sessionDisallowedTools: ['Bash', 'Bash'],
    });

    const universe = getSessionToolUniverse();

    expect(universe.allowed).toEqual(['Read', 'Grep', 'Glob']);
    expect(universe.disallowed).toEqual(['Bash']);
  });

  it('an EMPTY whitelist reads as no restriction, never as "allow nothing"', () => {
    writeWorkspaceDefaults({ sessionAllowedTools: [], sessionDisallowedTools: [] });
    expect(getSessionToolUniverse().allowed).toEqual([]);

    // The same answer a whitelist of blanks gives, which is the shape a user
    // typing into an empty field actually produces.
    writeWorkspaceDefaults({ sessionAllowedTools: ['', '   '] });
    expect(getSessionToolUniverse().allowed).toEqual([]);
  });

  it('a non-array, or non-string entries, read as absent rather than throwing', () => {
    writeWorkspaceDefaults({ sessionAllowedTools: 'Read', sessionDisallowedTools: [1, null, 'Bash'] });

    const universe = getSessionToolUniverse();

    expect(universe.allowed).toEqual([]);
    expect(universe.disallowed).toEqual(['Bash']);
  });

  it('the host constant is a floor the user list adds to and cannot unban', () => {
    // The producer does `[...CLAUDE_SESSION_DISALLOWED_TOOLS]` then pushes, so
    // this pins the property the code relies on rather than the code shape: the
    // constant is non-empty, and the setting is a separate list.
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS.length).toBeGreaterThan(0);

    writeWorkspaceDefaults({ sessionDisallowedTools: [...CLAUDE_SESSION_DISALLOWED_TOOLS] });
    const merged = [...CLAUDE_SESSION_DISALLOWED_TOOLS, ...getSessionToolUniverse().disallowed];

    // Naming a banned tool in the setting cannot remove it; it is still denied.
    for (const banned of CLAUDE_SESSION_DISALLOWED_TOOLS) expect(merged).toContain(banned);
  });
});
