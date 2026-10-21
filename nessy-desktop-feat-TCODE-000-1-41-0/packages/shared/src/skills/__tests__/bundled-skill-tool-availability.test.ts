/**
 * P2.212 — a bundled skill may not instruct the model to call a tool that is not
 * there on a runtime the skill is offered on.
 *
 * Bundled skills are seeded into the managed skills root and surface through the
 * ordinary skill inventory, so `/code-review` and `/loop` are offered on Pi,
 * claude-runtime and codex alike. A SKILL.md is the model-facing implementation
 * of that command: if it names a tool the session does not have, the surface is
 * advertised without its consumer, and the failure is silent — the model reads
 * an instruction it cannot follow and answers as though it had.
 *
 * Two such gaps were measured, and both remedies are in the skill text, so both
 * are pinned here TOGETHER WITH THE REASON they are needed. Every "this tool is
 * missing" premise below is DERIVED from `getSessionToolNames(...)` at test
 * time — never transcribed — so the day a tool becomes cross-runtime, the row
 * that says it is absent fails and the fallback can be retired deliberately
 * instead of rotting into a lie.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CRON_TOOL_NAMES, getSessionToolNames } from '@nessy-agent/session-tools-core';

import type { EffectiveCapabilitySnapshot } from '../../capabilities/resolver.ts';
import type { AgentRuntimeView } from '../../capabilities/views.ts';
import {
  createPiExecutionManifestSeed,
  finalizePiExecutionManifest,
  PI_DEFERRABLE_BUILTIN_BINDINGS,
} from '../../agent/pi-harness/harness-manifest.ts';

/** A bundled SKILL.md, read from the packaged source of truth (never `dist/`). */
function bundledSkill(slug: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../../apps/electron/resources/skills/${slug}/SKILL.md`, import.meta.url)),
    'utf8',
  );
}

/** A file under the repository root, read as the packaged source of truth. */
function repoFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../../${relativePath}`, import.meta.url)), 'utf8');
}

/**
 * The tool surface a NON-Pi runtime gets in-process (the default projection —
 * `session-scoped-tools.ts` passes no `projection`, which is what Claude uses).
 */
const crossRuntimeTools = getSessionToolNames();

/** The harshest real surface: an external standalone subprocess with no bridge. */
const codexWithoutBridge = getSessionToolNames({ externalStandaloneOnly: true });

/** The same subprocess once the T5 host-callback bridge is up. */
const codexWithBridge = getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true });

/**
 * The same in-process surface once the host binds its diff port. `ReviewDiff`
 * is gated on the port and not on the runtime (`isOfferedByHostPorts` returns
 * `options?.reviewDiffPort ?? false`), so the default projection above does NOT
 * contain it and this one does — which is exactly the two branches the skill
 * text has to distinguish.
 */
const crossRuntimeToolsWithReviewPort = getSessionToolNames({ reviewDiffPort: true });

describe('P2.212 · the code-review skill and the Pi-only `review` tool', () => {
  /**
   * The premise. `review` is an orchestrator tool that lives in the Pi harness
   * (`pi-agent-server/src/orchestrator/review-tool.ts`), so it is in NO session
   * tool surface — not Claude's in-process one, not Codex's with a bridge.
   */
  it('`review` is absent from every cross-runtime tool surface', () => {
    expect(crossRuntimeTools.has('review')).toBe(false);
    expect(codexWithBridge.has('review')).toBe(false);
    // Positive control for the whole probe: the sets are populated and the
    // membership test does answer `true` for something. Without this, a renamed
    // export or an empty registry would satisfy every `false` above.
    expect(crossRuntimeTools.size).toBeGreaterThan(0);
    expect(crossRuntimeTools.has('ReportFindings')).toBe(true);
  });

  /**
   * …and the reporting channel the fallback routes through IS cross-runtime, so
   * the fallback is a real path and not a second dead end. Codex without a
   * bridge is included deliberately: it is the thinnest surface any session
   * runs on, and the fallback has to work there too.
   */
  it('`ReportFindings` is present on every runtime the skill is offered on', () => {
    expect(crossRuntimeTools.has('ReportFindings')).toBe(true);
    expect(codexWithoutBridge.has('ReportFindings')).toBe(true);
  });

  it('the skill states the fallback rather than instructing an unconditional call', () => {
    const skill = bundledSkill('code-review');
    // The instruction that names `review` must be CONDITIONAL. The shipped text
    // read "Run the `review` tool —" with no condition and no alternative.
    expect(skill).toContain('When the `review` tool is in your tool list, run it.');
    // …and the alternative must exist, be reachable from the top, and route
    // through the tool the row above proved is cross-runtime.
    expect(skill).toContain('## Reviewing without the `review` tool');
    expect(skill).toContain('Reviewing without the `review` tool" at the end of this');
    const fallback = skill.slice(skill.indexOf('## Reviewing without the `review` tool'));
    expect(fallback).toContain('git diff');
    expect(fallback).toContain('ReportFindings');
    // The failure this exists to prevent is the model answering as though a
    // review ran, so the instruction not to must survive an edit.
    expect(skill).toContain('do not answer as though a review had run');
  });

  /**
   * P3.204 — the fallback ran the review IN the invoking conversation, which is
   * the one property `/code-review` is documented not to have.
   *
   * `code-review.md#review-a-diff-locally`, verbatim: "The review runs as a
   * background subagent with its own context window, so it doesn't fill your
   * conversation." On Pi the `review` tool provides that by spawning a child;
   * on every other runtime the shipped text said "YOU are the reviewer", so the
   * diff landed in the user's own context and the guarantee quietly did not
   * hold. NATIVE-FIRST: the isolation is the RUNTIME's — a claude-runtime
   * session has the SDK's own `Agent` tool and a codex one has `spawn_agent` —
   * so the fix is an instruction to delegate, not a host mechanism.
   *
   * The inline path is kept, LAST, because a runtime that cannot spawn a
   * subagent must still produce a real review rather than an apology.
   */
  it('the fallback delegates to a subagent and keeps the inline path as the last resort', () => {
    const skill = bundledSkill('code-review');
    const fallback = skill.slice(skill.indexOf('## Reviewing without the `review` tool'));

    // The documented guarantee, quoted in the text the model reads.
    expect(fallback).toContain("its own context window, so it doesn't fill your\nconversation.");
    expect(fallback).toContain('delegate the review to a subagent');
    // …and it asks for a read-only agent type, which is the reviewer's other
    // documented property ("it is read-only — it never edits").
    expect(fallback).toContain('read-only');

    // The inline path survives, and is explicitly the last resort rather than
    // the default it used to be.
    expect(fallback).toContain('If this runtime cannot spawn a subagent at all');
    expect(fallback).toContain('This is the last resort, not the\ndefault');
    expect(fallback.indexOf('delegate the review to a subagent'))
      .toBeLessThan(fallback.indexOf('If this runtime cannot spawn a subagent at all'));
  });

  /**
   * P6.123 — the fallback told the model to run `git diff` by hand on the two
   * runtimes that have the host's own diff tool.
   *
   * `ReviewDiff` (`tool-defs.ts`) exists precisely so the scope of a review is
   * identical everywhere: "do not review the diff yourself in this conversation,
   * and do not run git diff by hand — this tool is what makes the scope the same
   * on every runtime." The shipped SKILL.md never named it, and its git-diff
   * table read as the only path, so a claude or codex session with the port
   * bound followed the weaker instruction.
   *
   * The premise is DERIVED from the projection, not transcribed: the day the
   * tool stops being port-gated, this row fails instead of rotting.
   */
  it('the fallback names `ReviewDiff` first and keeps the git-diff table as the no-port path', () => {
    // Premise: port-gated, so the two branches the text describes are real.
    expect(crossRuntimeTools.has('ReviewDiff')).toBe(false);
    expect(crossRuntimeToolsWithReviewPort.has('ReviewDiff')).toBe(true);
    // …and it is not Pi's: `review` is still absent on both sides.
    expect(crossRuntimeToolsWithReviewPort.has('review')).toBe(false);

    const skill = bundledSkill('code-review');
    const fallback = skill.slice(skill.indexOf('## Reviewing without the `review` tool'));

    expect(fallback).toContain('When `ReviewDiff` is in your tool list, call it\n   first.');
    expect(fallback).toContain('do **not** run `git diff` by hand while the tool is there');
    // The table survives, and only as the branch taken when the port is absent.
    expect(fallback).toContain('Only if `ReviewDiff` is absent too');
    expect(fallback).toContain('| Target | Diff to read |');
    expect(fallback.indexOf('`ReviewDiff`'))
      .toBeLessThan(fallback.indexOf('| Target | Diff to read |'));
    expect(fallback.indexOf('Only if `ReviewDiff` is absent too'))
      .toBeLessThan(fallback.indexOf('| Target | Diff to read |'));
  });

  /**
   * P3.204's other half, and the reason the row says the obvious build is the
   * wrong one: a worktree-isolated reviewer would review the WRONG TREE.
   *
   * `worktrees.md#choose-the-base-branch` — a new worktree branches from the
   * default branch or from HEAD — so it carries no uncommitted changes, and the
   * documented default scope of `/code-review` is "your branch's commits ahead
   * of its upstream plus any uncommitted changes". Half of what the review
   * exists to read is exactly what a worktree does not have. The isolation that
   * belongs here is the subagent's CONTEXT, which the runtime already provides.
   */
  it('the fallback forbids an isolated worktree and says why', () => {
    const fallback = bundledSkill('code-review')
      .slice(bundledSkill('code-review').indexOf('## Reviewing without the `review` tool'));

    expect(fallback).toContain('Do not ask for an isolated copy of the repository');
    expect(fallback).toContain('no uncommitted changes');
    expect(fallback).toContain('must see the **live** working tree');
    // The instruction must never leak the opposite spelling into the model's
    // reading — a worktree request is what this section exists to prevent.
    expect(fallback).not.toContain('isolation: worktree');
  });
});

/**
 * F1.147 (origin SIT-11 pi driver, P-SIT11-3) — on a real gateway `pi` session
 * the model reported the `review` tool unavailable and took the fallback, while
 * the skill said `review` ships with the Pi runtime. Settled then from the
 * SOURCE: `review` is a static child binding (`harness-manifest.ts`
 * `STATIC_CHILD_BINDINGS`), built unconditionally in the Pi subprocess
 * (`pi-agent-server/src/index.ts`, `buildOrchestratorTools`), and WAS one of the
 * nine on-demand built-ins in `PI_DEFERRABLE_BUILTIN_BINDINGS` — deferred on
 * every default Pi session, with a skill clause (and F1.803's same-request
 * load) to route the model through search → load → run.
 *
 * RETIRED ON PURPOSE, by this very arm's rule: SIT-i D1 (2026-09-25, the build
 * already carrying the clause) measured the model taking the background-subagent
 * fallback anyway and telling the user twice that the tool "isn't available",
 * with `ReportFindings` deferred besides — F1.728. `review` left the deferrable
 * set and `mcp__session__ReportFindings` joined the session keep-list, so the
 * clause and its subsection are gone from the skill. What remains pinned here is
 * the FLIP: the day anyone re-defers `review`, these arms fail and the change is
 * a deliberate posture reversal, not a drift. The manifest-side premise lives in
 * the F1.728 describe below.
 */
describe('F1.147 · retired by F1.728 — `review` is not a deferral candidate any more', () => {
  const view: AgentRuntimeView = {
    generation: 'generation-f1147',
    sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
    promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
  };
  const snapshot = {
    context: { workspaceId: 'workspace-1', sessionId: 'session-1', projectTrustState: 'none', projectTrustRevision: '' },
    generation: view.generation,
    leaseId: 'lease',
    entries: [],
    installedPlugins: [],
    diagnostics: [],
  } as EffectiveCapabilitySnapshot;
  const finalize = (deferredMcpEnabled: boolean) => finalizePiExecutionManifest(
    createPiExecutionManifestSeed({ snapshot, view, sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' } }),
    [],
    { deferredMcpEnabled },
  );

  it('`review` is out of the deferrable set, and the skill no longer says Pi defers it', () => {
    const shipped = JSON.parse(repoFile('apps/electron/resources/config-defaults.json')) as {
      workspaceDefaults: { deferredMcpToolLoading: unknown };
    };
    expect(shipped.workspaceDefaults.deferredMcpToolLoading).toBe(true);
    expect(PI_DEFERRABLE_BUILTIN_BINDINGS.has('review')).toBe(false);

    const manifest = finalize(true);
    const piNames = manifest.tools.map(tool => tool.binding.piName);
    expect(manifest.deferredMcp.enabled).toBe(true);
    // Upfront, not a candidate: the model runs it from its tool list (F1.728).
    expect(piNames).toContain('review');
    expect(manifest.deferredMcp.candidatePiNames).not.toContain('review');
    // The fallback the skill routes to on OTHER runtimes is still resident.
    expect(piNames).toContain('subagent');
    expect(manifest.deferredMcp.candidatePiNames).not.toContain('subagent');

    // CONTROL on the same seed: with the preference off nothing is deferred and
    // `review` is upfront — so the arms above can fail, and deferral-off was
    // never the thing that put `review` on the surface.
    const off = finalize(false);
    expect(off.deferredMcp.enabled).toBe(false);
    expect(off.deferredMcp.candidatePiNames).toEqual([]);
    expect(off.tools.map(tool => tool.binding.piName)).toContain('review');
  });

  it('the deferred-load promise F1.803 made still holds in source, for every tool that IS deferred', () => {
    // The skill clause that cited this promise is retired (F1.728); the
    // subprocess promise itself is untouched and still load-bearing for the
    // eight deferrable built-ins and every deferred MCP tool.
    expect(repoFile('packages/pi-agent-server/src/deferred-mcp-tools.ts'))
      .toContain('A loaded tool is callable from your next step in this same request');
  });
});

/**
 * F1.728 (origin SIT-i D1, 2026-09-25, packaged `5896a66d2` — the build already
 * carried F1.147's clause, and the model STILL took the background-subagent
 * fallback and told the user twice that "The `review` tool isn't available on
 * this runtime", while `ReportFindings` stayed deferred and the findings were
 * printed as text) — the /code-review flow does not depend on the model
 * choosing to search-then-load: its two tools are on the UPFRONT surface.
 *
 * The premise is the manifest's own decision on the shipped default
 * (`deferredMcpToolLoading: true`), read the same way F1.147 read it, with the
 * verdict now INVERTED on purpose: `review` is resident (the skill's first
 * instruction runs as written, no search/load detour for the model to fumble —
 * D1 measured it fumbling), and `mcp__session__ReportFindings` is resident so
 * the report channel is callable in the same turn (F1.150's empty-array answer
 * then gives a clean diff its "No findings"). A session tool stays upfront when
 * the turn's own control flow needs it — reporting the review's verdict is
 * exactly that.
 */
describe('F1.728 · the /code-review flow rides the upfront surface on Pi', () => {
  const view: AgentRuntimeView = {
    generation: 'generation-f1728',
    sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
    promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
  };
  const snapshot = {
    context: { workspaceId: 'workspace-1', sessionId: 'session-1', projectTrustState: 'none', projectTrustRevision: '' },
    generation: view.generation,
    leaseId: 'lease',
    entries: [],
    installedPlugins: [],
    diagnostics: [],
  } as EffectiveCapabilitySnapshot;
  /** One session tool entering the manifest as production enters them (dynamic). */
  const reportFindings = [{
    bindingName: 'mcp__session__ReportFindings',
    description: 'Report the review findings.',
    inputSchema: { type: 'object' },
    modelSchemaVersion: 1,
    bindingSchemaVersion: 1,
    provenance: { capabilityKey: 'runtime:pi-session', generation: view.generation },
  }];
  const finalize = () => finalizePiExecutionManifest(
    createPiExecutionManifestSeed({ snapshot, view, sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' } }),
    reportFindings,
    { deferredMcpEnabled: true },
  );

  it('PREMISE: on the shipped default `review` and `ReportFindings` are upfront, not deferred candidates', () => {
    const manifest = finalize();
    const piNames = manifest.tools.map(tool => tool.binding.piName);
    expect(manifest.deferredMcp.enabled).toBe(true);
    // The review tool itself: in the signed manifest AND callable this turn.
    expect(piNames).toContain('review');
    expect(manifest.deferredMcp.candidatePiNames).not.toContain('review');
    // The report channel: same-turn callable, so the findings go through
    // `ReportFindings` (F1.150's empty-array answer) and not as prose.
    expect(piNames).toContain('mcp__session__ReportFindings');
    expect(manifest.deferredMcp.candidatePiNames).not.toContain('mcp__session__ReportFindings');
  });

  it('the skill no longer claims Pi defers `review`; the cross-runtime fallback stays for the runtimes that lack the tool', () => {
    const skill = bundledSkill('code-review');
    // The retired claim and its subsection — retired, not left to rot (the
    // rule F1.147's own premise arm stated).
    expect(skill).not.toContain('deferred by default');
    expect(skill).not.toContain('### On Pi, `review` is usually deferred');
    expect(skill).not.toContain('`mcp__tool_load` makes it callable from your next step');
    // The primary path is the whole Pi path now, and the fallback keeps
    // covering the runtimes where `review` genuinely does not exist.
    expect(skill).toContain('When the `review` tool is in your tool list, run it.');
    expect(skill).toContain('## Reviewing without the `review` tool');
    expect(skill).toContain('do not answer as though a review had run');
  });
});

describe('P2.212 · the loop skill and a session that cannot schedule', () => {
  /**
   * The premise, derived: every cron tool leaves the surface of an external
   * standalone subprocess that has no host-callback bridge, and comes back when
   * it does. A Codex session runs in exactly that state whenever
   * `startCallbackBridge` fails — a documented non-fatal path
   * (`codex-agent.ts`: "scheduling tools stay unavailable this session") — while
   * `/loop` is still offered, because the offer is gated on the RUNTIME rather
   * than on the live bridge.
   */
  it('every cron tool is missing from a bridge-less codex surface and present with a bridge', () => {
    expect(CRON_TOOL_NAMES.size).toBeGreaterThan(0);
    for (const name of CRON_TOOL_NAMES) {
      expect(codexWithoutBridge.has(name), `${name} without bridge`).toBe(false);
      expect(codexWithBridge.has(name), `${name} with bridge`).toBe(true);
    }
  });

  it('the skill refuses instead of describing a schedule it did not create', () => {
    const skill = bundledSkill('loop');
    expect(skill).toContain('## First: check that this session can schedule');
    const guard = skill.slice(
      skill.indexOf('## First: check that this session can schedule'),
      skill.indexOf('## Parsing the interval'),
    );
    // Derived, not transcribed: the guard has to name the tools that actually
    // go missing, so adding a fifth cron tool fails this row rather than leaving
    // the guard quietly incomplete.
    for (const name of CRON_TOOL_NAMES) {
      expect(guard, `the guard must name ${name}`).toContain(name);
    }
    expect(guard).toContain('say so in one line and stop');
    expect(guard).toContain('nothing will wake you');
  });
});
