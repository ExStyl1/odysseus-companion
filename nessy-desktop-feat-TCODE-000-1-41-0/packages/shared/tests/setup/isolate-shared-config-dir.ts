/**
 * Test-only isolation preload for `bun test packages/shared`.
 *
 * `packages/shared/src/config/paths.ts` resolves CONFIG_DIR once, at import
 * time, from NESSY_CONFIG_DIR (falling back to the real ~/.nessy-agent).
 * `bun test` runs every matched file's in-process (non-subprocess) code in a
 * single process, so whichever module happens to import paths.ts first
 * (directly or transitively — e.g. this repo's own unified-network-interceptor.ts
 * preload does, via interceptor-common.ts) freezes CONFIG_DIR for every test
 * file in the run that doesn't spawn its own isolated subprocess.
 *
 * Without this preload, any in-process test that calls a config getter (e.g.
 * PiAgent's getRtkEnabled(), getNessyAssistantPrompt()'s getBrowserToolEnabled())
 * silently reads the *real* developer machine's ~/.nessy-agent/config.json.
 * That was harmless while loadStoredConfig() failed open (legacy/corrupt
 * configs quietly became null), but the W3 fail-closed guard makes a legacy
 * (pre-v2) or corrupt config throw UnsupportedStorageLayoutError instead —
 * so on any machine whose real config.json predates storageLayoutVersion: 2
 * (e.g. an existing dev install), dozens of unrelated in-process tests turn
 * red for a reason that has nothing to do with what they're testing.
 *
 * Point every in-process test at a private, per-run temp directory so no test
 * ever depends on (or can touch) the real machine's config. This must be the
 * first entry in bunfig.toml's `[test].preload` list so it runs before
 * anything else can freeze CONFIG_DIR.
 *
 * The directory also needs the same one-time seeding real startup performs
 * (config-defaults.json, docs, tool-icons — see ensureConfigDir() in
 * config/storage.ts) — otherwise code that assumes startup already ran (e.g.
 * loadConfigDefaults() reading config-defaults.json) fails for the opposite
 * reason: nothing there instead of unsupported legacy content.
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.NESSY_CONFIG_DIR) {
  process.env.NESSY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'nessy-shared-tests-config-'));
}

/**
 * DA1.39 (wave-A review R-s1) — the SAME isolation, for the names that are read
 * LIVE instead of being frozen at import.
 *
 * `NESSY_CONFIG_DIR` above only has to be seeded once because `CONFIG_DIR`
 * freezes at first import. `NESSY_HOME` does not freeze: `creds-store.ts` symbol
 * `getNessyDir` reads `process.env` on every call, deliberately, so the three
 * deny floors that must cover the credential follow it unconditionally
 * (its own docblock, §"Read LIVE, and not latched"). The consequence for tests
 * is that `config/home-latch.ts` symbol `relatchHomeDirForTests` no longer
 * isolates the creds paths at all: a suite that relatches to a fake home still
 * resolves `<the developer's NESSY_HOME>/dp_auth_creds.json` if that variable is
 * exported on the machine. Wave A measured the adjacent version of this — a
 * `mock.module` spread that un-stubbed one reader and let a suite read the real
 * `~/.nessy/dp_auth_creds.json`.
 *
 * Deleted rather than assigned: an absent variable is what makes every reader
 * fall back to the latched home, and `delete` before any assignment is the rule
 * AGENTS.md records for `process.env` under Bun.
 *
 * The two dp names go with it for exactly the same reason, and they are new this
 * wave: `NESSY_DP` (the ladder's rung 1) and `DP_WORKDIR` (dp's own state root)
 * are both read live by `auth/dp/dp-binary.ts` symbol `resolveDpRuntime`, so a
 * developer who exported either would move a suite's dp onto their own machine's
 * binary or session.
 *
 * DA1.23 adds the fourth, and it is the one with teeth: `NESSY_CLI_DP_AUTH_TOKEN`
 * is nessy-cli's variable, and `auth/dp/env-token.ts` symbol
 * `cliEnvTokenIsTheOnlyOne` now reads it live to DIAGNOSE a failed sign-in. A
 * developer who exported it for the CLI would turn every dp failure in every
 * suite in this repository into `DpAuthError.CliEnvTokenOnly` — a red that names
 * their shell rather than their change. It is never read as a credential, here or
 * in production.
 */
/**
 * DA1.51 — the list is EXPORTED, and the deletes are driven from it.
 *
 * Until this row the four deletes were four separate statements in this file
 * and the only thing in the tree that could see one go away was a hand-written
 * triple inside one unrelated suite (`auth/dp/__tests__/creds-store.test.ts`).
 * That is one file's `describe` standing guard over a REPO-WIDE preload, and
 * nothing would have added the fifth name to it.
 *
 * Exporting the list and looping over it makes both directions cheap: a name
 * added here is deleted AND asserted the moment it is added, and removing one
 * is a one-line diff in the list that is this file's whole subject rather than
 * a deletion buried among a hundred lines of preload.
 *
 * MEMBERSHIP RULE, so the next reader does not have to guess: a name belongs
 * here when a PRODUCTION reader reads it LIVE from `process.env` rather than
 * latching or freezing it at import. That is what makes it invisible to
 * `config/home-latch.ts` symbol `relatchHomeDirForTests` and therefore able to
 * follow the developer's own shell into a suite. A name that is read once at
 * import time does not belong here — `NESSY_CONFIG_DIR` above is seeded rather
 * than deleted for exactly that reason.
 */
export const RELOCATED_LIVE_ENV_NAMES = [
  'NESSY_HOME',
  'NESSY_DP',
  'DP_WORKDIR',
  'NESSY_CLI_DP_AUTH_TOKEN',
] as const;

for (const name of RELOCATED_LIVE_ENV_NAMES) delete process.env[name];

const { ensureConfigDir } = await import('../../src/config/storage.ts');
ensureConfigDir();

/* ------------------------------------------------------------------------- *
 * P6.582 — the repo-root cleanliness net
 * ------------------------------------------------------------------------- */

/**
 * A win32 `path` mock that outlives its own file writes literal-backslash
 * DIRECTORIES into the repository root, and nothing noticed for two days.
 *
 * The mechanism: `mock.module('node:path', () => winPath)` makes `join` win32
 * for every later file in the same `bun test` invocation, and win32 `join`
 * normalises separators — so `join(tmpdir(), 'nessy-codex-home-')` (CODEX_HOME's `$TMPDIR` fallback in `newCodexHome` since F1.652, taken since F1.680 only where nothing shields the host root: the host root outside the config dir, or a writable root inside the config dir; every other test home lands under `join(CONFIG_DIR, 'codex-home')`, which a win32 mock bends the same way) becomes
 * `\var\folders\…\nessy-codex-home-`, which on POSIX is one RELATIVE file name
 * and is created under the process's cwd. The controller removed 30+ such
 * entries from the repo root on 2026-09-06, twice in two days
 * (`\Users\…\__tmp_build_call_llm__`, `\var\folders\…\nessy-codex-home-*`).
 *
 * The two win32-mocking files each verify their own restore, which is the fix
 * at the source. This is the NET, and it lives in the preload rather than in
 * either of them because the leak is not the leaker's own symptom: the entries
 * are written by whichever unrelated file happens to run next.
 *
 * **It blames a run only for what that run created.** The baseline is taken at
 * preload time and the exit check reports the DIFFERENCE, so a stray another
 * process left behind can never turn a sibling lane's suite red — which matters
 * here, where a dozen lanes run `bun test` against one working tree.
 *
 * It does not delete anything. Deleting files in a repository root from a test
 * preload is a worse failure mode than the litter.
 */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

/** No legitimate path on this platform carries a backslash in one name. */
function backslashEntries(): Set<string> {
  try {
    return new Set(readdirSync(REPO_ROOT).filter(entry => entry.includes('\\')));
  } catch {
    // A preload must never be the reason a suite cannot start.
    return new Set();
  }
}

const strayBaseline = backslashEntries();

process.on('exit', () => {
  const created = [...backslashEntries()].filter(entry => !strayBaseline.has(entry));
  if (created.length === 0) return;
  process.exitCode = 1;
  console.error('');
  console.error(
    `WIN32 PATH MOCK ESCAPED (P6.582) — this run created ${created.length} backslash-named `
    + `entr${created.length === 1 ? 'y' : 'ies'} in the repository root:`,
  );
  for (const entry of created.slice(0, 10)) console.error(`  ${JSON.stringify(entry)}`);
  console.error('');
  console.error('  A `mock.module(\'node:path\', …)` outlived its own test file, so a later file\'s');
  console.error('  `join(tmpdir(), …)` produced a win32 path that POSIX read as a relative name.');
  console.error('  Delete these entries and fix the restore in whichever file installed the mock.');
  console.error('');
});
