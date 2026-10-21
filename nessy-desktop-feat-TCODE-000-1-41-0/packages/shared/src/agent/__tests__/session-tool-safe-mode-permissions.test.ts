/**
 * Regression tests for metadata-driven session tool safe-mode classification.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  SESSION_SAFE_ALLOWED_TOOL_NAMES,
  SESSION_SAFE_BLOCKED_TOOL_NAMES,
  SESSION_TOOL_DEFS,
  SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK,
  SESSION_TOOLS_REQUIRING_HOST_CALLBACK,
  areTaskToolsEnabled,
  getSessionToolNames,
  isCronDisabled,
} from '@nessy-agent/session-tools-core';
import { ALWAYS_ALLOWED_TOOLS, shouldAllowToolInMode } from '../../agent/mode-manager.ts';

describe('session tool safe-mode classification', () => {
  // send_developer_feedback intentionally omitted — it is feature-flagged via
  // FEATURE_FLAGS.developerFeedback (off by default outside dev runtimes), so
  // its safe-mode visibility depends on env state. The dedicated suite at
  // send-developer-feedback-permissions.test.ts owns that flag-aware behavior.
  it('allows read-only session tools in plan mode', () => {
    const allowedTools = [
      'mcp__session__call_llm',
      'mcp__session__browser_tool',
      'mcp__session__script_sandbox',
    ] as const;

    for (const toolName of allowedTools) {
      const result = shouldAllowToolInMode(toolName, {}, 'plan');
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks mutating/auth session tools in plan mode', () => {
    const blockedTools = [
      'mcp__session__source_oauth_trigger',
      'mcp__session__source_credential_prompt',
      'mcp__session__spawn_session',
      'mcp__session__update_user_preferences',
    ] as const;

    for (const toolName of blockedTools) {
      const result = shouldAllowToolInMode(toolName, {}, 'plan');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('Session configuration changes are blocked in');
      }
    }
  });

  // P2.220 — the two rows above are SPOT CHECKS, and this one is the property.
  //
  // They name seven tools between them out of a registry that carries dozens,
  // so a grant flip on a tool nobody wrote down was invisible: measured, moving
  // `transform_data` from `'allow'` to `'block'` left this file at 28 pass / 0
  // fail. That is the same shape as the ceiling defect one layer out — a suite
  // guarding the members it happens to name rather than the property that
  // decides them.
  //
  // The property is: `def.safeMode` — and nothing else about a definition —
  // decides the Explore verdict for `mcp__session__<name>`. Derived from
  // `SESSION_TOOL_DEFS` so a NEW tool joins the guard by existing, and asserted
  // against `shouldAllowToolInMode` rather than against the helper the gate
  // itself calls, because a test that mirrors the rule tests the mirror.
  //
  // P3.311 CHANGED WHAT THIS ROW ASSERTS, and the previous version is why the
  // row is worth reading. It derived its expectation from
  // `getSessionToolDefs` — the ADVERTISING projection — which meant it encoded
  // the gate's collapse AS THE CONTRACT: seven tools declaring
  // `safeMode: 'allow'` were refused in Explore, and this suite called that
  // correct. A guard that derives its expectation from the same wrong input as
  // the code cannot see the bug; it ratifies it.
  //
  // The contract is now the DECLARATION: `safeMode` decides, over the whole
  // registry. Exactly ONE thing still stands between the field and the verdict,
  // and it adds rather than subtracts — `ALWAYS_ALLOWED_TOOLS`, matched exactly
  // AND by `__<name>` suffix, SEVERAL BRANCHES EARLIER than the
  // `mcp__session__` branch, so it outranks the field itself. That is the term
  // that could silently grant a `safeMode: 'block'` tool, so it keeps its own
  // assertion below.
  //
  // Availability — `visibility`, the cron and task switches, feature flags — is
  // no longer part of this question. It is enforced by the offer surfaces and
  // by the registry the call resolves through, which is where it belongs.
  it('every session tool: safeMode decides the plan verdict', () => {
    const piOnly = new Set(
      SESSION_TOOL_DEFS.filter(def => def.visibility === 'pi-only').map(def => def.name),
    );
    // No surfacing term. P3.311: the declaration decides, over the whole
    // registry. Two earlier drafts of this line are the argument for that —
    // one enumerated the withholding reasons by hand and went red the day
    // `visibility: 'not-pi'` was added, the other asked `getSessionToolDefs`
    // and thereby ratified the seven-tool collapse it should have caught.
    // The gate's own match, both halves of it.
    const alwaysAllowed = (name: string): boolean =>
      ALWAYS_ALLOWED_TOOLS.has(name)
      || [...ALWAYS_ALLOWED_TOOLS].some(allowed => `mcp__session__${name}`.endsWith(`__${allowed}`));

    const wrong: string[] = [];
    for (const def of SESSION_TOOL_DEFS) {
      const expected = alwaysAllowed(def.name) || def.safeMode === 'allow';
      const actual = shouldAllowToolInMode(`mcp__session__${def.name}`, {}, 'plan').allowed;
      if (actual !== expected) {
        wrong.push(
          `${def.name}: safeMode=${def.safeMode}`
          + `${piOnly.has(def.name) ? ' visibility=pi-only' : ''}`
          + `${alwaysAllowed(def.name) ? ' always-allowed' : ''}`
          + ` expected=${expected} gate=${actual}`,
        );
      }
    }
    expect(wrong).toEqual([]);

    // Positive controls, so an empty `wrong` is a measurement and not a probe
    // that never ran: both poles of the field are populated, and the derived
    // set is the whole registry rather than the seven names above.
    expect([...SESSION_SAFE_ALLOWED_TOOL_NAMES].length).toBeGreaterThan(20);
    expect([...SESSION_SAFE_BLOCKED_TOOL_NAMES].length).toBeGreaterThan(15);
    expect(SESSION_TOOL_DEFS.length).toBe(
      SESSION_SAFE_ALLOWED_TOOL_NAMES.size + SESSION_SAFE_BLOCKED_TOOL_NAMES.size,
    );
  });

  it('P3.311 — NO tool declaring safeMode:allow is refused in plan', () => {
    // The row that would have caught the seven, and the successor to the one
    // that did not. Its predecessor asked "is this refusal explained by a
    // SURFACING filter?" and answered yes for `Task`, `TaskCreate`,
    // `TaskUpdate`, `TaskGet`, `TaskList`, `list_mcp_resources` and
    // `read_mcp_resource` — which is exactly how a projection collapse gets
    // ratified as a contract. An explanation is not a justification.
    //
    // Under P3.311 there is nothing left to explain: availability is enforced
    // by the offer surfaces and by the registry the call resolves through, so a
    // declaration of `safeMode: 'allow'` and an Explore refusal cannot coexist.
    // The failure message names the tools, because the seven were invisible for
    // as long as nobody had to read them out.
    const refused = SESSION_TOOL_DEFS
      .filter(def => def.safeMode === 'allow')
      .filter(def => !shouldAllowToolInMode(`mcp__session__${def.name}`, {}, 'plan').allowed)
      .map(def => `${def.name} (visibility=${def.visibility ?? 'any'})`);
    expect(refused).toEqual([]);

    // Positive controls: the probe ran over a real registry and the gate really
    // refuses things, so an empty list is a measurement rather than a loop that
    // never executed.
    expect(SESSION_TOOL_DEFS.filter(def => def.safeMode === 'allow').length).toBeGreaterThan(30);
    expect(SESSION_TOOL_DEFS
      .filter(def => def.safeMode === 'block')
      .filter(def => !shouldAllowToolInMode(`mcp__session__${def.name}`, {}, 'plan').allowed)
      .length).toBeGreaterThan(15);
  });

  it('P3.311 — the seven named tools, pinned by name', () => {
    // Derived rows survive a registry change; this one is the record of WHICH
    // tools moved, so the fix cannot be quietly undone for a subset. Four are
    // `readOnly` and all seven are `pi-only`, so the refusal bit on Pi alone —
    // which is why nothing else in the tree noticed for as long as it did.
    for (const name of [
      'Task', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
      'list_mcp_resources', 'read_mcp_resource',
    ]) {
      const def = SESSION_TOOL_DEFS.find(entry => entry.name === name);
      expect(def?.safeMode, `${name} must still declare allow for this row to mean anything`).toBe('allow');
      expect(def?.visibility, `${name} is the pi-only class this row is about`).toBe('pi-only');
      expect(
        shouldAllowToolInMode(`mcp__session__${name}`, {}, 'plan').allowed,
        `${name} declares safeMode:'allow' and must be allowed in Explore`,
      ).toBe(true);
    }
  });

  it('no always-allowed name overrides a safe-mode BLOCK', () => {
    // The one direction contributor (3) can fail dangerously in: a name landing
    // in `ALWAYS_ALLOWED_TOOLS` that `session-tools-core` classifies
    // `safeMode: 'block'` grants that tool in Explore with nothing in the
    // registry changing and no other test moving. Today the intersection is
    // empty; if it stops being empty, the addition should be deliberate and
    // this row is where it gets argued.
    const overrides = SESSION_TOOL_DEFS
      .filter(def => def.safeMode === 'block')
      .filter(def => ALWAYS_ALLOWED_TOOLS.has(def.name)
        || [...ALWAYS_ALLOWED_TOOLS].some(a => `mcp__session__${def.name}`.endsWith(`__${a}`)))
      .map(def => def.name);
    expect(overrides).toEqual([]);
    // Positive control for the intersection probe: the same match DOES fire on
    // the allow pole, so an empty result above is a measurement.
    expect(SESSION_TOOL_DEFS
      .filter(def => def.safeMode === 'allow')
      .filter(def => ALWAYS_ALLOWED_TOOLS.has(def.name)).length).toBeGreaterThan(0);
  });
});

// ============================================================
// P2.15 — safe mode is a GATE, and it is ONLY a gate, on every runtime.
//
// The row that ordered this block was written from a live cross-runtime control
// (T4 case (e), `docs/testing/cdp-runs/2026-08-22-t4-claude-scheduling.md`),
// recorded as: "Pi withholds the blocked session tools from the surface in
// Explore, claude offers them and refuses the call." Its evidence was the MODEL
// reporting *"I don't see a 'Monitor' tool listed"* — a self-report about its
// own prompt, not a reading of the offer surface, and the detector is the thing
// most likely to be wrong.
//
// Measured instead, and pinned below: NO offer surface filters by `safeMode`.
// `Monitor` is `safeMode: 'block'` and is offered by Pi, by claude, and by a
// bridged codex. The live observation has a different cause on a different
// axis — DEFERRAL: `mcp__session__Monitor` is absent from
// `PI_UPFRONT_SESSION_BINDINGS` (`pi-harness/harness-manifest.ts`), so with
// deferred tool loading on it sits in the signed manifest, findable by
// `mcp__tool_search`, but is not listed upfront — in EVERY mode, not only
// Explore. The falsifier for the safe-mode reading is on that same keep-list:
// `remember` and `Goal` are BOTH `safeMode: 'block'` AND upfront on Pi, which
// no safeMode filter could produce.
//
// So what these rows pin is the true shape: the three offer surfaces carry the
// same blocked tools, differing only by the two STRUCTURAL projection rules
// (`visibility: 'pi-only'`, and the codex host-callback split) that
// `runtime-capability-drift.test.ts` already governs; and the safe-mode rule
// lives at `shouldAllowToolInMode`, once, in none of the offer builders.
// Filtering ONE runtime's offer by `safeMode` — the shape the row originally
// proposed — is what would create the divergence, and fails here.
// ============================================================

const piSurface = () => getSessionToolNames({ projection: 'pi' });
const claudeSurface = () => getSessionToolNames();
const codexSurface = () => getSessionToolNames({ externalStandaloneOnly: true });
// D1.440, 2026-09-20 — `worktreePort` belongs here and was missing, which is the
// probe-with-no-port-bound shape the known-failing register already records once
// (`runtime-capability-drift.test.ts`'s two `ReviewDiff` probes: *"a probe that
// omits the port reads a live tool as a stale name"*). A REAL bridged codex
// session always has it — `session-mcp-server/src/index.ts` writes
// `worktreePort: hostCallbackBridge`, the same value, and
// `bridged-ports-advertised.test.ts` pins that line — so a bridge without it is
// a projection production never builds. Unbound, `WorktreeBatch` read as
// withheld with no host-callback excuse (it is in BOTH sets, so the excuse
// clause below cannot cover it) and this case failed on a tool that is offered.
// Every other bridged-surface probe in this repo passes it.
const codexBridgedSurface = () =>
  getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true, worktreePort: true });

/**
 * The projection rule that is NOT a safe-mode decision, derived from the raw
 * registry array rather than from `getSessionToolDefs` — so a filter added
 * inside that function cannot move both sides of a comparison at once.
 */
const piOnlyNames = new Set(
  SESSION_TOOL_DEFS.filter(def => def.visibility === 'pi-only').map(def => def.name),
);

const repoFile = (relativeToThisFile: string): string =>
  readFileSync(fileURLToPath(new URL(relativeToThisFile, import.meta.url)), 'utf8');

describe('safe-mode offer parity across runtimes', () => {
  // Both flags are read from process.env inside `getSessionToolDefs`, so a
  // polluted environment would silently shift every surface below. Fail loudly
  // and name the cause instead.
  it('runs with the default task/cron surface', () => {
    expect(areTaskToolsEnabled(), 'NESSY_ENABLE_TASKS is off in this test env').toBe(true);
    expect(isCronDisabled(), 'NESSY_DISABLE_CRON is set in this test env').toBe(false);
  });

  it('Pi offers every safe-mode-blocked tool — its projection has no safeMode filter', () => {
    // `SESSION_SAFE_BLOCKED_TOOL_NAMES` is built straight off `SESSION_TOOL_DEFS`
    // and never passes through `getSessionToolDefs`, which is what makes this an
    // independent route: a safeMode filter added to the pi projection drops the
    // names from `piSurface()` while this constant keeps them, and the row fails.
    expect([...SESSION_SAFE_BLOCKED_TOOL_NAMES].filter(name => !piSurface().has(name))).toEqual([]);
    // Positive control: the probe set is non-trivial, so an empty diff is a
    // measured absence and not an empty question.
    expect(SESSION_SAFE_BLOCKED_TOOL_NAMES.size).toBeGreaterThan(0);
  });

  it('claude excludes safe-mode-blocked tools exactly where Pi excludes them — nowhere', () => {
    // The row's mandated comparison, answered by measurement rather than by its
    // premise. Every blocked tool claude offers, Pi offers too...
    const claudeBlocked = [...claudeSurface()].filter(name => SESSION_SAFE_BLOCKED_TOOL_NAMES.has(name));
    expect(claudeBlocked.filter(name => !piSurface().has(name)).sort()).toEqual([]);
    // ...and the only blocked tools Pi adds are `pi-only` ones, which is the
    // visibility rule, not a safe-mode one.
    const piExtra = [...piSurface()]
      .filter(name => SESSION_SAFE_BLOCKED_TOOL_NAMES.has(name) && !claudeSurface().has(name));
    expect(piExtra.filter(name => !piOnlyNames.has(name)).sort()).toEqual([]);
    // Two positive controls, because two EMPTY sets would satisfy both rows
    // above: claude really does carry blocked tools, and the pi-only carve-out
    // is really exercised rather than vacuously true.
    expect(claudeBlocked.length).toBeGreaterThan(0);
    expect(piExtra.length).toBeGreaterThan(0);
  });

  it('codex withholds blocked tools for the host-callback split, never for the safeMode filter', () => {
    // Everything a bridged codex is missing from the claude blocked set is
    // missing because the bridge has no route for it — the same structural rule
    // `runtime-capability-drift.test.ts` asserts for the whole surface. Derived
    // from the two hand-maintained sets, so a safeMode filter reaching the codex
    // projection shows up here as a name with no host-callback excuse.
    const claudeBlocked = [...claudeSurface()].filter(name => SESSION_SAFE_BLOCKED_TOOL_NAMES.has(name));
    const unexplained = claudeBlocked.filter(name =>
      !codexSurface().has(name) && !SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name));
    expect(unexplained.sort()).toEqual([]);
    const unexplainedBridged = claudeBlocked.filter(name =>
      !codexBridgedSurface().has(name)
      && !(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name)
        && !SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK.has(name)));
    expect(unexplainedBridged.sort()).toEqual([]);
    // Positive controls: codex really does advertise blocked tools in both
    // shapes, and the bridge really does widen the blocked half of the surface.
    const codexBlocked = [...codexSurface()].filter(name => SESSION_SAFE_BLOCKED_TOOL_NAMES.has(name));
    const codexBridgedBlocked = [...codexBridgedSurface()]
      .filter(name => SESSION_SAFE_BLOCKED_TOOL_NAMES.has(name));
    expect(codexBlocked.length).toBeGreaterThan(0);
    expect(codexBridgedBlocked.length).toBeGreaterThan(codexBlocked.length);
  });

  it('offer-then-refuse is the behaviour on every runtime, Monitor included', () => {
    // The live case, stated as the pair it actually is: the tool is OFFERED and
    // the shared gate REFUSES it. `remember` and `Goal` are the falsifier for
    // the "Pi filters by safeMode" reading — both are blocked and both are on
    // Pi's upfront keep-list.
    for (const name of ['Monitor', 'remember', 'Goal'] as const) {
      expect(SESSION_SAFE_BLOCKED_TOOL_NAMES.has(name), name).toBe(true);
      expect(piSurface().has(name), `pi offers ${name}`).toBe(true);
      expect(claudeSurface().has(name), `claude offers ${name}`).toBe(true);
      expect(codexBridgedSurface().has(name), `bridged codex offers ${name}`).toBe(true);
      const gate = shouldAllowToolInMode(`mcp__session__${name}`, {}, 'plan');
      expect(gate.allowed, `explore refuses ${name}`).toBe(false);
    }
  });

  it('control: safe-mode-ALLOWED session tools stay offered, and plan allows them', () => {
    // Without this the rows above would also pass against a surface that had
    // lost every session tool.
    for (const name of ['config_validate', 'script_sandbox'] as const) {
      expect(SESSION_SAFE_ALLOWED_TOOL_NAMES.has(name), name).toBe(true);
      expect(piSurface().has(name), `pi offers ${name}`).toBe(true);
      expect(claudeSurface().has(name), `claude offers ${name}`).toBe(true);
      expect(codexSurface().has(name), `codex offers ${name}`).toBe(true);
      expect(shouldAllowToolInMode(`mcp__session__${name}`, {}, 'plan').allowed, name).toBe(true);
    }
    // `SubmitPlan` is the tool Explore is built around and it is `allow`, but it
    // needs a host callback — so the unbridged codex is the one surface without
    // it, and for the structural reason again rather than a safe-mode one.
    expect(SESSION_SAFE_ALLOWED_TOOL_NAMES.has('SubmitPlan')).toBe(true);
    expect(piSurface().has('SubmitPlan')).toBe(true);
    expect(claudeSurface().has('SubmitPlan')).toBe(true);
    expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has('SubmitPlan')).toBe(true);
    expect(codexSurface().has('SubmitPlan')).toBe(false);
    expect(shouldAllowToolInMode('mcp__session__SubmitPlan', {}, 'plan').allowed).toBe(true);
  });
});

describe('the safe-mode rule lives at the gate, not in any offer builder', () => {
  // Source reads rather than imports, because the three builders are only
  // comparable as text from here and because an absence claim needs a positive
  // control on the same rig (`readFileSync` also sees NUL-carrying files that
  // plain grep skips silently — the AGENTS.md trap).
  const SAFE_MODE_HELPERS = [
    'getSessionSafeAllowedToolNames',
    'getSessionSafeBlockedToolNames',
    'SESSION_SAFE_ALLOWED_TOOL_NAMES',
    'SESSION_SAFE_BLOCKED_TOOL_NAMES',
  ] as const;

  it('mode-manager is the one consumer of the safe-mode names, and it reads the WHOLE registry', () => {
    const modeManager = repoFile('../mode-manager.ts');
    expect(modeManager).toContain('export function shouldAllowToolInMode'); // control: right file
    // P3.311 changed WHICH name it consumes, and that is the assertion now.
    // `SESSION_SAFE_ALLOWED_TOOL_NAMES` is built straight off `SESSION_TOOL_DEFS`;
    // `getSessionSafeAllowedToolNames` runs the ADVERTISING projection first,
    // and reading it here is what refused seven declared-allow tools in Explore.
    expect(modeManager.split('SESSION_SAFE_ALLOWED_TOOL_NAMES').length - 1).toBe(2); // import + use
    expect(modeManager.split('getSessionSafeAllowedToolNames(').length - 1).toBe(0);
    expect(modeManager).toContain('Session configuration changes are blocked in');
  });

  it('no offer builder consults the safe-mode helpers', () => {
    const builders = {
      // claude's in-process session MCP server
      '../session-scoped-tools.ts': 'export function getSessionScopedTools',
      // Pi's proxy projection, and the per-turn builder that gates it
      '../backend/pi/session-tool-defs.ts': 'export function getSessionToolProxyDefs',
      '../pi-agent.ts': 'buildCurrentProxyToolDefinitions',
      // claude's per-turn disallow list
      '../claude-agent.ts': 'CLAUDE_SESSION_DISALLOWED_TOOLS',
      // codex's out-of-process session MCP server
      '../../../../session-mcp-server/src/index.ts': 'function createSessionTools',
    } as const;

    for (const [path, anchor] of Object.entries(builders)) {
      const source = repoFile(path);
      expect(source, `${path} is the file this row means`).toContain(anchor);
      for (const helper of SAFE_MODE_HELPERS) {
        expect(source.includes(helper), `${path} must not filter its offer by ${helper}`).toBe(false);
      }
    }
  });

  it('the three small builders do not read the safeMode field either', () => {
    // Narrower probe, and deliberately only on the single-purpose files: the
    // word `safeMode` already means something else in `claude-agent.ts` (a
    // private explore-mode flag), so a bare word check there would be a false
    // positive rather than a finding.
    const builders = {
      '../session-scoped-tools.ts': 'export function getSessionScopedTools',
      '../backend/pi/session-tool-defs.ts': 'export function getSessionToolProxyDefs',
      '../../../../session-mcp-server/src/index.ts': 'function createSessionTools',
    } as const;

    for (const [path, anchor] of Object.entries(builders)) {
      const source = repoFile(path);
      expect(source, `${path} is the file this row means`).toContain(anchor);
      expect(source.includes('safeMode'), `${path} must not filter its offer by safeMode`).toBe(false);
    }
    // Positive control for the needle: the registry the builders read from does
    // carry the field, so `false` above is a measured absence and not a typo.
    expect(repoFile('../../../../session-tools-core/src/tool-defs.ts')).toContain("safeMode: 'block'");
  });
});
