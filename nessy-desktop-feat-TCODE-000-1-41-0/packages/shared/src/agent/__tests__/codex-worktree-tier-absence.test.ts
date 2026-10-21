/**
 * P2.497 — codex has NO worktree seam, and that answer is pinned rather than
 * remembered.
 *
 * The worktree family (P2.458 / P2.465) closes a leak per runtime: Pi already
 * owned the lease service, claude got a `WorktreeCreate`/`WorktreeRemove` port
 * with every withholding logged, and codex was left "open and silent". The row
 * asked the native-first question FIRST — *does codex already have the
 * mechanism?* — and required the answer to be recorded either way, because
 * *codex cannot* is a real and frequent answer in this family (P2.463: no
 * browser mechanism; P2.454: tool-search knobs are session-global with nothing
 * per-server to pass), not a shortcut.
 *
 * Measured 2026-09-02 on the STRONG tier — the shipped binary and the pinned
 * protocol, never a vendor page:
 *
 *   `WorktreeCreate` in `darwin-arm64/codex-app-server`            0
 *   `worktree` anywhere in `packages/codex-protocol`               0
 *   controls `preToolUse` / `sessionStart` / `subagentStart`   3 / 5 / 3
 *   negative control `nessyWorktreeCreate`                         0
 *
 * So the codex tier is CLOSED BY ABSENCE: there is no codex-created worktree for
 * the host to fail to record. The reasoning lives beside the port it explains,
 * in `backend/claude/worktree-port.ts`; this file is what fails the day the
 * answer changes.
 *
 * WHAT THIS FILE DOES **NOT** DO, and why. It does not `strings` the 178 MB
 * binary: that reading is recorded, and re-running it in every suite would cost
 * seconds per run to re-confirm a byte-identical pinned artifact. What it pins
 * is the surface that MOVES — the generated protocol, which is regenerated from
 * upstream on every codex bump, and the tool visibility that would otherwise be
 * the second way in. A codex release that adds a worktree hook event reddens
 * here at the bump, which is the moment the decision needs revisiting.
 *
 * Mutation probe: add `"worktreeCreate"` to the generated `HookEventName` union
 * → `codex publishes no worktree hook event` goes red. Add `'EnterWorktree'` to
 * a bare codex surface — drop the `worktreePortBridged` AND in
 * `getSessionToolDefs`, or the `visibility` marker itself — → `the host worktree
 * tools reach codex only over the bridge` goes red.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// P6.137 — a static top-level import, so this file's module graph is paid once
// at load and not against a per-test timer (AGENTS.md, rule 24).
import { getSessionToolNames } from '@nessy-agent/session-tools-core';

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');

const HOOK_EVENT_NAME = join(
  REPO, 'packages', 'codex-protocol', 'generated', 'v2', 'HookEventName.ts',
);
const TOOL_DEFS = join(REPO, 'packages', 'session-tools-core', 'src', 'tool-defs.ts');

/** The union members, read from the generated file rather than restated here. */
function hookEventNames(): string[] {
  const source = readFileSync(HOOK_EVENT_NAME, 'utf-8');
  return [...source.matchAll(/"([A-Za-z]+)"/g)].map(match => match[1] as string);
}

describe('P2.497 · codex has no worktree mechanism to feed', () => {
  it('reads the generated hook events at all (the gate is not vacuous)', () => {
    const events = hookEventNames();
    // Positive controls: three events codex really does publish. Without these
    // an empty read would satisfy the absence claim below.
    expect(events).toContain('preToolUse');
    expect(events).toContain('sessionStart');
    expect(events).toContain('subagentStart');
    expect(events.length).toBeGreaterThan(8);
  });

  it('codex publishes no worktree hook event', () => {
    // Claude's seam is a hook (`WorktreeCreate` / `WorktreeRemove`). Codex's
    // hook surface is the only comparable place a host could register one, and
    // nothing in it is worktree-shaped.
    expect(hookEventNames().filter(name => /worktree/i.test(name))).toEqual([]);
  });

  it('the pinned codex protocol carries no worktree surface at all', () => {
    // Not only the hook list: a `thread/worktree/*` request or a worktree field
    // on an existing one would be a second seam. The generated bindings and the
    // schemas are the pinned contract, and neither mentions one.
    const generated = readFileSync(
      join(REPO, 'packages', 'codex-protocol', 'generated', 'ClientRequest.ts'),
      'utf-8',
    );
    expect(/worktree/i.test(generated)).toBe(false);
    // Positive control on the same file: it IS the request union and it does
    // carry the methods this repo drives.
    expect(generated).toContain('thread/start');
  });

  /**
   * P6.137 — this case USED to read the `visibility: 'pi-only'` literal and
   * conclude "a codex session is never offered it". The literal is still there
   * and the conclusion is no longer what it proves, so the case is re-cut to
   * derive from the SURFACE.
   *
   * What changed, and what did not. Codex still publishes no worktree mechanism
   * — the three cases above are untouched and are what "closed by absence"
   * meant. What the host now does is carry OURS over the callback bridge, with
   * the approval floor `runPreToolUseChecks` could not give it
   * (`SessionManager.authorizeWorktreeEnter` consulting the same
   * `evaluateWorktreeApproval`). So a worktree a codex session enters is one
   * the host's own `WorktreeLeaseService` created and recorded, which is the
   * property P2.497 was protecting: there is still no codex-created worktree
   * for the host to fail to record.
   *
   * The invariant this case now pins is the one that can regress: a codex
   * session gets the tools ONLY over the bridge — never on a bare spawn, where
   * neither the routes nor the floor exist.
   */
  it('the host worktree tools reach codex only over the bridge, never a bare spawn', () => {
    const bare = getSessionToolNames({ externalStandaloneOnly: true });
    const bridged = getSessionToolNames({
      externalStandaloneOnly: true,
      hostCallbackBridge: true,
      worktreePort: true,
    });
    for (const tool of ['EnterWorktree', 'ExitWorktree', 'WorktreeBatch']) {
      expect(bare.has(tool)).toBe(false);
      expect(bridged.has(tool)).toBe(true);
    }
    // Positive control on the same two surfaces: the bare spawn is a real
    // surface and not an empty set, so the absences above mean something.
    expect(bare.has('automation_list')).toBe(true);
    expect(bare.size).toBeGreaterThan(10);
    // The definitions still carry the marker — the lift is a per-session FLAG,
    // not a dropped marker, which is what keeps claude (that ships its own
    // `EnterWorktree`) from meeting a second one.
    const defs = readFileSync(TOOL_DEFS, 'utf-8');
    const entry = defs.split('\n').find(line => line.includes("name: 'EnterWorktree'"));
    expect(entry, 'EnterWorktree tool definition not found — the probe is stale').toBeDefined();
    expect(entry).toContain("visibility: 'pi-only'");
    expect(getSessionToolNames().has('EnterWorktree')).toBe(false);
  });
});
