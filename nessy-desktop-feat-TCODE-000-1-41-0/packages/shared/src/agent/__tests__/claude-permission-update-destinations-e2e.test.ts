/**
 * C3.85 — the six `PermissionUpdate` kinds at each of the five destinations on
 * claude: WHO performs the write, and what lands.
 *
 * Ledger row G8 is about who writes a permission update. On Pi the answer is our
 * own host manager — `PiAgent.applyPermissionRequestUpdates` applies a
 * `PermissionRequest` hook's `updatedPermissions` under an explicit privilege
 * boundary and emits a `__PERMISSION_UPDATE__` receipt for every application and
 * every refusal. On claude the answer is the RUNTIME, and nobody had asked it
 * what it does.
 *
 * ## The full matrix, measured 2026-09-11 at vendored `0.3.247` / `2.1.247`
 *
 * Thirty runs, one per (kind × destination), each a scripted offline turn
 * (`fixtures/claude-permission-update-probe.ts`). EVERY one ended
 * `result: success` with nothing thrown — including the removals, which were
 * asked to remove something that had never been added.
 *
 * | destination | what the runtime wrote |
 * | --- | --- |
 * | `session` | nothing, on any of the six |
 * | `cliArg` | nothing, on any of the six |
 * | `projectSettings` | `<cwd>/.claude/settings.json` |
 * | `localSettings` | `<cwd>/.claude/settings.local.json` |
 * | `userSettings` | `<CLAUDE_CONFIG_DIR>/settings.json` |
 *
 * Contents are the update spoken in settings vocabulary: `addRules` /
 * `replaceRules` write `permissions.allow: ["Bash(echo c385:*)"]`, `removeRules`
 * writes `permissions.allow: []`, `setMode` writes `permissions.defaultMode`.
 *
 * ## The one thing the runtime REFUSES, and it refuses silently
 *
 * `setMode: 'bypassPermissions'` writes nothing — at `userSettings`, where
 * `acceptEdits` writes `permissions.defaultMode`, and at `session`, where the
 * later outside read still reached `canUseTool` (it could not have, had the mode
 * become `bypassPermissions`, which shadows the callback). No error, no result
 * subtype change, no diagnostic: the update is accepted and dropped. That
 * agrees with the host's own Pi-side refusal of the same value and is the reason
 * this file states it rather than leaving the next reader to assume symmetry
 * with `acceptEdits`.
 *
 * ## The host/SDK disagreement, stated BEFORE anything is wired
 *
 * Nothing on the claude path returns `updatedPermissions` today, and
 * `PermissionRequest` is owned by Pi's permission service
 * (`automations/types.ts`), so the event does not fire on claude at all — there
 * is no live divergence to receipt, and emitting a `__PERMISSION_UPDATE__`
 * record for an occurrence that cannot happen would be dead code. What there IS
 * is a boundary the Pi path enforces and the runtime does not, measured above:
 *
 *  - Pi refuses `userSettings` outright ("we have no reader … a write to a key
 *    nothing reads is a grant that silently does nothing"); the runtime writes it.
 *  - Pi refuses `replaceRules` / `removeRules` at any settings destination
 *    ("would let a hook delete an administrator's `deny` list"); the runtime
 *    performs both.
 *  - Pi accepts a persistent grant only when it echoes a `permission_suggestion`
 *    this host offered for that prompt; the runtime asks no such question.
 *  - Pi refuses `setMode` to `bypassPermissions` unless the session is already
 *    there — and here the two AGREE, by the runtime's own silent refusal above.
 *
 * So a future lane that wires `updatedPermissions` on claude inherits the
 * boundary rather than re-deriving it, and any wiring that forwards a hook's
 * entry straight through would be handing a plugin's stdout a write to the
 * user's settings files that the Pi arm refuses.
 *
 * **Gated on `NESSY_CLAUDE_SDK_E2E=1`** — the native binary is a ~290 MB
 * optional dependency, so a committed test that spawns it is a recorded local
 * run rather than a CI gate:
 *
 *   NESSY_CLAUDE_SDK_E2E=1 bun test ./packages/shared/src/agent/__tests__/claude-permission-update-destinations-e2e.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ClaudePermissionUpdateProbeResult,
  PermissionUpdateArm,
  PermissionUpdateKind,
} from './fixtures/claude-permission-update-probe.ts';

const ENABLED = process.env.NESSY_CLAUDE_SDK_E2E === '1';

const PROBE = new URL('./fixtures/claude-permission-update-probe.ts', import.meta.url).pathname;

async function runArm(
  arm: PermissionUpdateArm,
  kind: PermissionUpdateKind,
  mode?: string,
): Promise<ClaudePermissionUpdateProbeResult> {
  const isolated = mkdtempSync(join(tmpdir(), 'nessy-c385-host-cfg-'));
  const child = Bun.spawn(['bun', PROBE, arm, kind, ...(mode ? [mode] : [])], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NESSY_CONFIG_DIR: isolated },
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`probe(${arm}, ${kind}) exited ${code}: ${err}`);
  const line = out.trim().split('\n').filter(Boolean).pop();
  if (!line) throw new Error(`probe(${arm}, ${kind}) produced no result line. stderr: ${err}`);
  return JSON.parse(line) as ClaudePermissionUpdateProbeResult;
}

describe.if(ENABLED)('C3.85 · who writes a claude permission update, per destination', () => {
  test('the IN-MEMORY destinations write no file, and the SETTINGS destinations each write their own', async () => {
    // One representative kind across all five destinations. The full six-by-five
    // matrix is in the header with its date; what a standing test needs is the
    // property, which is per-DESTINATION and identical across the kinds.
    const [session, cliArg, project, local, user] = await Promise.all([
      runArm('session', 'addRules'),
      runArm('cliArg', 'addRules'),
      runArm('projectSettings', 'addRules'),
      runArm('localSettings', 'addRules'),
      runArm('userSettings', 'addRules'),
    ]);

    for (const result of [session, cliArg, project, local, user]) {
      // Instrument guard: an arm whose turn did not run whole cannot say
      // anything about what was written.
      expect({ arm: result.arm, requests: result.requests, subtype: result.resultSubtype, threw: result.threw })
        .toEqual({ arm: result.arm, requests: 3, subtype: 'success', threw: null });
    }

    expect({
      session: Object.keys(session.settingsFiles),
      cliArg: Object.keys(cliArg.settingsFiles),
      projectSettings: Object.keys(project.settingsFiles),
      localSettings: Object.keys(local.settingsFiles),
      userSettings: Object.keys(user.settingsFiles),
    }).toEqual({
      session: [],
      cliArg: [],
      projectSettings: ['cwd/.claude/settings.json'],
      localSettings: ['cwd/.claude/settings.local.json'],
      userSettings: ['configDir/settings.json'],
    });

    // …and what landed is the update in settings vocabulary, so "a file
    // appeared" cannot stand in for "the grant was written".
    expect(project.settingsFiles['cwd/.claude/settings.json']).toContain('Bash(echo c385:*)');
    expect(local.settingsFiles['cwd/.claude/settings.local.json']).toContain('Bash(echo c385:*)');
    expect(user.settingsFiles['configDir/settings.json']).toContain('Bash(echo c385:*)');
  }, 600_000);

  test('a REMOVAL is performed too, at a settings destination the Pi path refuses it for', async () => {
    // The boundary `PiAgent.applyPermissionRequestUpdates` states in words —
    // "`replaceRules` and `removeRules` operate on the session store only; at a
    // settings destination they are refused outright, because … would let a hook
    // delete an administrator's `deny` list". The runtime does not share it.
    const removal = await runArm('projectSettings', 'removeRules');
    expect(removal.threw).toBeNull();
    expect(removal.resultSubtype).toBe('success');
    expect(Object.keys(removal.settingsFiles)).toEqual(['cwd/.claude/settings.json']);
    expect(removal.settingsFiles['cwd/.claude/settings.json']).toContain('"allow"');
  }, 300_000);

  test('setMode PERSISTS acceptEdits and SILENTLY REFUSES bypassPermissions', async () => {
    const [accept, bypass] = await Promise.all([
      runArm('userSettings', 'setMode', 'acceptEdits'),
      runArm('userSettings', 'setMode', 'bypassPermissions'),
    ]);

    // The control arm, and it is what makes the refusal a refusal rather than a
    // destination that ignores `setMode`.
    expect(accept.settingsFiles['configDir/settings.json']).toContain('"defaultMode": "acceptEdits"');

    // The refusal: same destination, same kind, no error, nothing written.
    expect({ subtype: bypass.resultSubtype, threw: bypass.threw, files: Object.keys(bypass.settingsFiles) })
      .toEqual({ subtype: 'success', threw: null, files: [] });
  }, 300_000);

  test('a session-scope bypassPermissions does not take either, shown by the callback still being consulted', async () => {
    // In `bypassPermissions` the callback is shadowed entirely
    // (`agent-sdk/permissions.md`'s evaluation order), so a mode that had really
    // become bypass would have kept the later outside read away from it.
    const session = await runArm('session', 'setMode', 'bypassPermissions');
    expect(session.threw).toBeNull();
    expect({ consulted: session.canUseToolCalls, asked: session.askedAboutTheOutsideRead })
      .toEqual({ consulted: ['Write', 'Read'], asked: true });
  }, 300_000);
});
