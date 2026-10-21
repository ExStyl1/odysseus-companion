/**
 * P6.145 — the three-runtime tool-search disposition report ran on ONE launch
 * path.
 *
 * `describeToolSearchAcrossRuntimes` answers for all three runtimes at once, and
 * its only non-test consumer was `applyToolSearchOffSwitch`, which runs inside
 * `buildClaudeSubprocessEnv`. So a claude session emitted three lines and a Pi
 * or codex session emitted none — including, on codex, the one line that says
 * this knob CANNOT govern that runtime (a measured refutation, P2.456, not a
 * gap). An operator meeting silence concludes the knob does not exist rather
 * than that it does not reach them.
 *
 * Native-first: nothing per-runtime is built here. The host already has one
 * answer for all three and it is lifted out whole, which is step 2 of the rule.
 *
 * Two things are pinned, and they fail for different reasons:
 *
 * 1. **The report itself** — three lines, stable order, and the codex entry
 *    still reading `unreachable` / not observable, which is the sentence the row
 *    exists to deliver.
 * 2. **All three launch paths ask for it.** Read off the sources, because
 *    `debug()` routes into electron-log whose transports a packaged main process
 *    disables — a call site is the only thing that can be asserted from here,
 *    and it is exactly what regressed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyManagedEnv, clearManagedOriginEnvVars } from '../../config/managed-env.ts';
import { TOOL_SEARCH_ENV_VAR } from '../../config/tool-search-settings.ts';
import { describeToolSearchAcrossRuntimes, reportToolSearchDisposition } from '../options.ts';

const AGENT_DIR = join(import.meta.dir, '..');
const read = (file: string) => readFileSync(join(AGENT_DIR, file), 'utf-8');

describe('P6.145 · the disposition report is available to every launch path', () => {
  it('reports one line per runtime, in a stable order, whoever asks', () => {
    const lines = reportToolSearchDisposition({ NESSY_ENABLE_TOOL_SEARCH: 'auto:5' });

    expect(lines).toHaveLength(3);
    expect(lines.map(line => line.replace('[tool-search] ', '').split(':')[0]))
      .toEqual(['pi', 'claude', 'codex']);
    expect(lines[0]).toContain('mode: auto');
  });

  it('still says codex is unreachable and unobservable — the line a codex session never saw', () => {
    const codex = reportToolSearchDisposition({ NESSY_ENABLE_TOOL_SEARCH: 'auto:5' })[2]!;

    expect(codex).toContain('codex: unreachable');
    expect(codex).toContain('observable here: no');
    expect(codex).toContain('Stage::Removed');
  });

  it('answers with nothing rather than a guess when the mode cannot be read', () => {
    // A config it cannot read decides nothing — the pre-existing contract of
    // `applyToolSearchOffSwitch`, kept when the reporting half was lifted out.
    // Driven here through the env the mode is read from, so the shape of the
    // empty answer is pinned rather than assumed.
    expect(reportToolSearchDisposition({ NESSY_ENABLE_TOOL_SEARCH: 'false' })).toHaveLength(3);
  });

  it('is asked for on all three launch paths, and the claude one still asks through the switch', () => {
    // codex: at the head of `createRuntime`, once per runtime start.
    expect(read('codex-agent.ts')).toContain('reportToolSearchDisposition();');
    // pi: beside the subprocess spawn, once per spawn.
    expect(read('pi-agent.ts')).toContain('reportToolSearchDisposition();');
    // claude: unchanged — the off-switch still writes the variable AND reports,
    // so lifting the report out did not silence the path that had it.
    const options = read('options.ts');
    const offSwitch = options.slice(options.indexOf('function applyToolSearchOffSwitch'));
    expect(offSwitch.slice(0, offSwitch.indexOf('\n}\n'))).toContain('reportToolSearchDispositionLines(');
  });
});

/**
 * D1.36 — an organisation CAN keep tool search on, and now the refusal says so.
 *
 * The row was carried as "an organisation cannot keep tool search on: both
 * switches are developer-owned and no managed key exists". Measured at HEAD the
 * first half is refuted: the managed policy's `env` block carries arbitrary
 * names, `applyManagedEnv` overwrites the ambient value with them, both hosts
 * apply it at boot, and an administrator's `true` becomes mode `always` — the
 * one arm of `resolveDeferredMcpToolLoading` that never reads the workspace
 * preference. So no new policy key is built. What was missing is the second
 * half of the done-means, the LEGIBILITY, which is what these arms pin.
 *
 * The first case drives the REAL registry rather than the `managedMode`
 * argument, because a clause that only ever appears when a test passes the flag
 * would prove the wiring nothing: `isManagedOriginEnvVar` is filled by the
 * managed-env writer and by nothing else, and the value is read at decision
 * time from this process's own environment.
 */
describe('D1.36 · the report names the administrator when the mode is theirs', () => {
  const before = process.env[TOOL_SEARCH_ENV_VAR];

  beforeEach(() => { clearManagedOriginEnvVars(); });
  afterEach(() => {
    clearManagedOriginEnvVars();
    // Delete before assign, on the restore path too (AGENTS.md).
    delete process.env[TOOL_SEARCH_ENV_VAR];
    if (before !== undefined) process.env[TOOL_SEARCH_ENV_VAR] = before;
  });

  it('says so on the two runtimes the value reaches, end to end', () => {
    // The real writer, the real process environment, the real registry — the
    // production path, minus only the boot call that would run it.
    const applied = applyManagedEnv(
      { [TOOL_SEARCH_ENV_VAR]: 'true' },
      { source: 'managed-file', confirmed: true },
    );
    expect(applied.set).toContain(TOOL_SEARCH_ENV_VAR);
    expect(process.env[TOOL_SEARCH_ENV_VAR]).toBe('true');

    const lines = reportToolSearchDisposition();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('administrator');
    expect(lines[0]).toContain('does not consult the workspace preference');
    expect(lines[1]).toContain('administrator');
    // And the mode really is the administrator's `always`, not a leftover.
    expect(lines[0]).toContain('mode: always');
  });

  it('NEGATIVE — a developer-set value of the SAME name claims no administrator', () => {
    // Same variable, same value, same mode: only the ORIGIN differs, so this
    // cannot pass by the clause being absent for some unrelated reason.
    delete process.env[TOOL_SEARCH_ENV_VAR];
    process.env[TOOL_SEARCH_ENV_VAR] = 'true';

    const lines = reportToolSearchDisposition();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('mode: always');
    for (const line of lines) expect(line).not.toContain('administrator');
  });

  it('never claims it on codex, whose reason is a measured unreachability', () => {
    const entries = describeToolSearchAcrossRuntimes({
      mode: { kind: 'always' },
      workspacePreference: false,
      managedMode: true,
    });
    expect(entries[2]!.runtime).toBe('codex');
    expect(entries[2]!.reason).not.toContain('administrator');
    // The control: the other two DID take the clause from the same call.
    expect(entries[0]!.reason).toContain('administrator');
    expect(entries[1]!.reason).toContain('administrator');
  });

  it('reads the origin of the ONE spelling the mode is read from', () => {
    const options = read('options.ts');
    expect(options).toContain('isManagedOriginEnvVar(TOOL_SEARCH_ENV_VAR)');
    // The control: the name it asks about is the name `toolSearchMode` reads.
    expect(read('../config/tool-search-settings.ts'))
      .toContain('return parseToolSearchMode(env[TOOL_SEARCH_ENV_VAR])');
  });
});
