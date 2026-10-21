/**
 * P3.296 — the per-session `CODEX_HOME` destroys codex's OWN durable state, and
 * one piece of it is cheap to give back.
 *
 * ## What was measured, on the shipped binary
 *
 * `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`, 2026-09-03,
 * a real `initialize` → `thread/start` → one turn into a scratch home. Codex
 * writes `installation_id`, five sqlite databases with their WALs (`state_5`,
 * `goals_1`, `logs_2`, `memories_1`, `queue_1`), the re-extracted bundled
 * `skills/` tree (87 entries), `shell_snapshots/`, `thread-writer-locks/` and
 * `.sandbox_migration` — about 2.6 MiB by `du` — and `createRuntime` deletes all
 * of it. Two cold homes come back with two DIFFERENT `installation_id`s, which
 * is the positive control that the value is regenerated rather than derived.
 *
 * ## THE DETAIL THAT WOULD HAVE BEEN INVENTED WRONG
 *
 * The seed must be a CANONICAL UUID. Four arms in one run:
 * `nessy-host-stable-0000-0000` came back REPLACED by a fresh UUID, while
 * `00000000-1111-2222-3333-444444444444` survived verbatim, with and without a
 * trailing newline. A host-stable id of any other shape looks exactly like the
 * bug it was meant to fix.
 *
 * WHAT EACH TEST KILLS:
 *  - "mints once and then returns the same id" dies if the value is regenerated
 *    per call — the whole point of the row, and indistinguishable from today's
 *    behaviour without this assertion.
 *  - "the id it mints is a canonical UUID" dies if the format drifts to anything
 *    the binary would discard, which is silent: the session simply gets codex's
 *    own fresh id and nothing says so.
 *  - "replaces a stored value the binary would discard" dies if the read stops
 *    validating, which would let a corrupted file pin a non-identity forever.
 *  - "keeps the file private" dies if the mode is dropped: this is a stable
 *    per-install identifier.
 *  - "returns null rather than throwing" dies if the helper stops being
 *    best-effort — an identity convenience must never stop a runtime starting.
 *  - the source pin dies if `createRuntime` stops seeding the home, which would
 *    leave the file written and unused.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHostStableCodexInstallationId } from '../codex-agent.ts';

/** The shape the binary keeps. Anything else it overwrites — measured, above. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'w2s-install-id-'));
}

describe('P3.296 · a host-stable codex installation id', () => {
  it('mints once and then returns the same id', () => {
    const dir = scratch();
    const first = resolveHostStableCodexInstallationId(dir);
    const second = resolveHostStableCodexInstallationId(dir);
    expect(first).not.toBeNull();
    expect(second).toBe(first!);
    expect(readFileSync(join(dir, 'codex-installation-id'), 'utf8')).toBe(first!);
    // The control that this test can see a change at all: a DIFFERENT config
    // directory is a different install and gets its own id.
    expect(resolveHostStableCodexInstallationId(scratch())).not.toBe(first!);
  });

  it('the id it mints is a canonical UUID, which is the only shape codex keeps', () => {
    expect(resolveHostStableCodexInstallationId(scratch())).toMatch(UUID);
  });

  it('replaces a stored value the binary would discard', () => {
    const dir = scratch();
    // The exact seed measured being overwritten by the shipped binary.
    writeFileSync(join(dir, 'codex-installation-id'), 'nessy-host-stable-0000-0000');
    const resolved = resolveHostStableCodexInstallationId(dir);
    expect(resolved).toMatch(UUID);
    expect(resolved).not.toBe('nessy-host-stable-0000-0000');
  });

  it('accepts a stored canonical UUID, including one with a trailing newline', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'codex-installation-id'), '00000000-1111-2222-3333-444444444444\n');
    expect(resolveHostStableCodexInstallationId(dir)).toBe('00000000-1111-2222-3333-444444444444');
  });

  it('keeps the file private', () => {
    const dir = scratch();
    resolveHostStableCodexInstallationId(dir);
    expect(statSync(join(dir, 'codex-installation-id')).mode & 0o777).toBe(0o600);
  });

  it('returns null rather than throwing when the location is unusable', () => {
    const blocked = join(scratch(), 'not-a-directory');
    writeFileSync(blocked, 'x');
    expect(resolveHostStableCodexInstallationId(blocked)).toBeNull();
  });
});

/**
 * The seed itself is pinned in source: `createRuntime` needs a real app-server
 * and an adapter port to reach, the same reason its sibling guards are pinned
 * this way.
 */
describe('P3.296 · the runtime builder seeds the home', () => {
  const SOURCE = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');

  it('writes the resolved id into the per-session CODEX_HOME', () => {
    expect(SOURCE).toContain('const installationId = resolveHostStableCodexInstallationId();');
    expect(SOURCE).toContain("writeFileSync(join(codexHome, 'installation_id'), installationId, { mode: 0o600 });");
  });

  it('records what is DECLINED beside it, with the measured cost', () => {
    // A declined capability that nobody wrote down is indistinguishable from one
    // nobody noticed — which is the rule this plan applies to every silent gap.
    expect(SOURCE).toContain('957 ms cold against 771 ms warm');
    expect(SOURCE).toContain('DECLINED');
  });
});
