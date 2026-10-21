/**
 * C3.7 — does a `PermissionUpdate` returned from `canUseTool` apply to the
 * RUNNING TURN on claude?
 *
 * Ledger row A62 ("Open `/permissions`, or run `/add-dir <path>`, while Claude
 * is working — and have the rule change apply to the rest of the current turn")
 * reads `absent` for claude, and the row that ordered this measurement says why
 * the measurement comes first: **a type is not a behaviour**. `sdk.d.ts`
 * declaring `{ type: 'addDirectories', directories, destination }` proves only
 * that we can return one.
 *
 * ## The answer, measured 2026-09-11 at vendored `0.3.247` / `2.1.247`
 *
 * | arm | `canUseTool` consulted about | settings file written |
 * | --- | --- | --- |
 * | `none` (CONTROL) | `Write`, then **`Read`** | none |
 * | `session` | `Write` only | **none** |
 * | `projectSettings` | `Write` only | **`<cwd>/.claude/settings.json`** |
 *
 * So YES: a session-scoped `addDirectories` returned mid-turn applies to the
 * rest of that turn, with no respawn — the outside read is resolved at the
 * allow-rules step and the callback never sees it, while the file's content
 * still reaches the model. The `none` arm is what makes that absence
 * load-bearing: without a grant, the same read DOES reach the callback.
 *
 * ## The second reading, which corrects a premise this fork acted on
 *
 * `buildClaudeCanUseTool`'s docblock refuses `updatedPermissions` wholesale
 * because "taking them writes rules into the user's settings files behind an
 * 'always allow' click". Measured, that is true of the SETTINGS destinations and
 * false of `session`: the `projectSettings` arm wrote
 * `permissions.additionalDirectories` into a file a repository checks in, and
 * the `session` arm wrote nothing anywhere. The refusal is therefore correct
 * per-destination rather than per-field, which is what makes a narrow wiring
 * thinkable at all.
 *
 * ## What this file does NOT claim
 *
 * That the product does it. Nothing on the claude path returns an update today:
 * session-scoped grants are declared on `PiAgent` alone
 * (`getSessionAdditionalDirectories`), so there is no host trigger to forward,
 * and building one is a row of its own. This is the measurement A62 was waiting
 * on, and the kinds other than `addDirectories` are deliberately not
 * generalised from it.
 *
 * **Gated on `NESSY_CLAUDE_SDK_E2E=1`** — the native binary is a ~290 MB
 * optional dependency, so a committed test that spawns it is a recorded local
 * run rather than a CI gate:
 *
 *   NESSY_CLAUDE_SDK_E2E=1 bun test ./packages/shared/src/agent/__tests__/claude-permission-update-e2e.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ClaudePermissionUpdateProbeResult,
  PermissionUpdateArm,
} from './fixtures/claude-permission-update-probe.ts';

const ENABLED = process.env.NESSY_CLAUDE_SDK_E2E === '1';

const PROBE = new URL('./fixtures/claude-permission-update-probe.ts', import.meta.url).pathname;

async function runArm(arm: PermissionUpdateArm): Promise<ClaudePermissionUpdateProbeResult> {
  // `NESSY_CONFIG_DIR` exported BEFORE bun starts in the child — the only form
  // that isolates on every invocation shape (AGENTS.md).
  const isolated = mkdtempSync(join(tmpdir(), 'nessy-c37-host-cfg-'));
  const child = Bun.spawn(['bun', PROBE, arm], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NESSY_CONFIG_DIR: isolated },
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`probe(${arm}) exited ${code}: ${err}`);
  const line = out.trim().split('\n').filter(Boolean).pop();
  if (!line) throw new Error(`probe(${arm}) produced no result line. stderr: ${err}`);
  return JSON.parse(line) as ClaudePermissionUpdateProbeResult;
}

describe.if(ENABLED)('C3.7 · a mid-turn addDirectories grant on claude', () => {
  test('CONTROL: with no update, the outside read DOES reach canUseTool', async () => {
    // Run first and asserted on its own, because every claim below is an
    // ABSENCE and an absence with no positive control is worthless: if the
    // outside read never prompted, the `session` arm would look like a grant
    // that worked while nothing had happened.
    const control = await runArm('none');
    expect(control.threw).toBeNull();
    expect(control.resultSubtype).toBe('success');
    // The scripted turn ran whole — three upstream requests.
    expect({ requests: control.requests }).toEqual({ requests: 3 });
    expect(control.canUseToolCalls).toEqual(['Write', 'Read']);
    expect(control.askedAboutTheOutsideRead).toBe(true);
    expect(control.someSettingsFileNamesTheDirectory).toBe(false);

    // C3.312 — the same control run answers a SECOND question, and it is the one
    // that decided which cards may offer "always allow": the runtime offers a
    // suggestion on BOTH consultations, and they are NOT the same kind.
    // `Write` inside the working directory gets a `setMode` (which
    // `claudeSessionPermissionUpdateBoundary` refuses, and which C3.281 measured
    // the runtime accepting and silently dropping); the outside `Read` gets a
    // session `addRules` the boundary forwards. Asserted here rather than
    // described, because `claude-card-session-grant-producer.test.ts` pins these
    // two payloads as CONSTANTS and this is the run they came from.
    expect(control.offeredSuggestions.map(offered => (offered ?? []).map(
      entry => (entry as { type?: string }).type,
    ))).toEqual([['setMode'], ['addRules']]);
    const outsideReadSuggestion = (control.offeredSuggestions[1] ?? [])[0] as {
      behavior?: string; destination?: string; rules?: { toolName?: string }[];
    };
    expect({
      behavior: outsideReadSuggestion.behavior,
      destination: outsideReadSuggestion.destination,
      toolName: outsideReadSuggestion.rules?.[0]?.toolName,
    }).toEqual({ behavior: 'allow', destination: 'session', toolName: 'Read' });
  }, 300_000);

  test('SESSION: the grant applies to the rest of the turn, and writes nothing to disk', async () => {
    const session = await runArm('session');
    expect(session.threw).toBeNull();
    expect(session.resultSubtype).toBe('success');
    expect({ requests: session.requests }).toEqual({ requests: 3 });

    // The finding A62 was waiting on: the callback is consulted ONCE, and the
    // outside read still happens.
    expect({
      consulted: session.canUseToolCalls,
      askedAboutTheOutsideRead: session.askedAboutTheOutsideRead,
      readReachedTheModel: session.outsideReadReachedTheModel,
    }).toEqual({
      consulted: ['Write'],
      askedAboutTheOutsideRead: false,
      readReachedTheModel: true,
    });

    // …and the half that makes a narrow wiring thinkable: session scope is not
    // a settings write.
    expect({ settingsFiles: Object.keys(session.settingsFiles) }).toEqual({ settingsFiles: [] });
  }, 300_000);

  test('PROJECT SETTINGS: the same grant WRITES a file a repository checks in', async () => {
    const project = await runArm('projectSettings');
    expect(project.threw).toBeNull();
    expect(project.resultSubtype).toBe('success');

    // It applies to the running turn too — so the difference between the two
    // destinations is not whether the grant takes, it is what it leaves behind.
    expect(project.askedAboutTheOutsideRead).toBe(false);

    // The measured reason the wholesale refusal in `buildClaudeCanUseTool` is
    // right for THIS destination: a file, in the user's repository, under
    // `permissions.additionalDirectories`.
    expect(Object.keys(project.settingsFiles)).toContain('cwd/.claude/settings.json');
    expect(project.settingsFiles['cwd/.claude/settings.json']).toContain('additionalDirectories');
    expect(project.someSettingsFileNamesTheDirectory).toBe(true);
  }, 300_000);
});
