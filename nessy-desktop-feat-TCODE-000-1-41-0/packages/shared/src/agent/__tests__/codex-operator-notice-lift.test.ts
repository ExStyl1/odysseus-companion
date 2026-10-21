/**
 * P3.267 — three switch-visible facts that reached NOBODY on a packaged build.
 *
 * ## The row is a grading, not a missing channel
 *
 * Rows 26 (codex sandbox egress) and 28 (the execpolicy grant note) were graded
 * "honest" because they ARE reported — on `onDiagnostic`, which `CodexAgent`
 * binds to `debug()`, which routes through electron-log, whose transports the
 * packaged main process disables. So both were honest two grades weaker than
 * they read, and the same misgrading rides every `onDiagnostic` binding that was
 * chosen for convenience. Nothing new is built: `surfaceCodexOperatorNotice`
 * (P3.120) and its bounded defer queue already exist.
 *
 * ## The prefixes are pinned against REAL formatter output
 *
 * `codex-agent.ts` restates the three config-writer prefixes because
 * `config-writer.ts` does not export them (a one-line change in a file another
 * lane holds this wave). A restated string eventually disagrees with itself, so
 * every case below drives the ACTUAL formatter and feeds its ACTUAL output into
 * the agent — a reworded prefix upstream fails here rather than silently
 * turning the lift off. The requirement half needs no such pin: it imports the
 * prefixes from the module that emits them.
 *
 * WHAT EACH TEST KILLS:
 *  - "lifts the sandbox egress line" / "lifts the execpolicy grant line" die if
 *    the `:2103` binding goes back to `this.debug(message)` alone — the shipped
 *    state, and rows 26 and 28's entire evidence.
 *  - "leaves the per-entry families on the debug channel" dies if the lift is
 *    widened to every config-writer diagnostic, which would push the two
 *    families this row is about off an eight-deep queue.
 *  - "lifts an administrator requirement nobody applied" dies if the
 *    requirements binding stops calling the reader.
 *  - "leaves a SATISFIED requirement on the debug channel" dies if the
 *    requirement lift is widened to every `[managed]` line, filling the queue
 *    with controls that are working.
 *  - the three SOURCE-shape cases die if a reader exists and nothing calls it,
 *    which is the real risk when the units under test are private methods. They
 *    are source assertions for the same reason `codex-config-requirements.test.ts`
 *    uses one for its own guard: the bindings live inside `createRuntime`, which
 *    needs a real app-server and an adapter port to reach.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCodexAgentRoles,
  CODEX_APPROVAL_POSTURE_PREFIX,
  CODEX_BOUNDED_APPROVAL_NOTICE,
  CODEX_UNBOUNDED_APPROVAL_NOTICE,
  formatCodexAgentRoleDropDiagnostics,
  formatCodexExecpolicyGrantSandboxDiagnostics,
  formatCodexSandboxEgressDiagnostics,
  writeCodexConfig,
} from '@nessy-agent/codex-responses-adapter/config-writer';
import {
  CODEX_REQUIREMENT_CLOCK_PREFIX,
  CODEX_REQUIREMENT_UNENFORCED_PREFIX,
  formatCodexConfigRequirementsDiagnostics,
  readCodexConfigRequirements,
} from '../codex-config-requirements.ts';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

const WORKSPACE_ID = 'ws-codex-notice-lift';
const SESSION_ID = 'session-codex-notice-lift';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Codex Notice Lift Workspace',
      rootPath: '/tmp/ws-codex-notice-lift-root',
      workspaceRootPath: '/tmp/ws-codex-notice-lift-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-notice-lift',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-codex-notice-lift-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

interface Event { type: string; message?: string; level?: string }

function harness() {
  const agent = new CodexAgent(createConfig());
  const internals = agent as unknown as {
    turnSink: { push: (e: Event) => void } | null;
    noteCodexConfigWriterDiagnostic: (message: string) => void;
    noteCodexUnappliedRequirementDiagnostic: (message: string) => void;
    noteCodexRequirementClock: (reading: unknown) => void;
  };
  const events: Event[] = [];
  internals.turnSink = { push: (e: Event) => events.push(e) };
  return {
    events,
    writerDiagnostic: (m: string) => internals.noteCodexConfigWriterDiagnostic(m),
    requirementDiagnostic: (m: string) => internals.noteCodexUnappliedRequirementDiagnostic(m),
    requirementClock: (reading: unknown) => internals.noteCodexRequirementClock(reading),
  };
}

describe('P3.267 · the config-writer facts reach a person', () => {
  it('lifts the sandbox egress line, taken from the real formatter', () => {
    const [line] = formatCodexSandboxEgressDiagnostics({ sandboxMode: 'workspace-write' });
    expect(line).toBeDefined();
    const h = harness();
    h.writerDiagnostic(line!);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.type).toBe('info');
    // Durable + warning is the ONE family `SessionManager` persists, so the
    // fact survives a reload rather than scrolling past.
    expect(h.events[0]!.level).toBe('warning');
    expect(h.events[0]!.message).toBe(line);
  });

  it('lifts the execpolicy grant line, both arms, from the real formatter', () => {
    // Unsandboxed arm: a grant with no denied-read entry.
    const [unsandboxed] = formatCodexExecpolicyGrantSandboxDiagnostics({
      execpolicyAllowPrefixes: [['git', 'status']],
      sandboxMode: 'workspace-write',
    });
    // Retained arm: the same grant with a denied-read path present.
    const [retained] = formatCodexExecpolicyGrantSandboxDiagnostics({
      execpolicyAllowPrefixes: [['git', 'status']],
      sandboxMode: 'workspace-write',
      deniedReadPaths: ['/tmp/ws-codex-notice-lift-root/secret.env'],
    });
    expect(unsandboxed).toBeDefined();
    expect(retained).toBeDefined();
    expect(unsandboxed).not.toBe(retained);

    const h = harness();
    h.writerDiagnostic(unsandboxed!);
    h.writerDiagnostic(retained!);
    expect(h.events.map(e => e.message)).toEqual([unsandboxed, retained]);
    expect(h.events.every(e => e.type === 'info' && e.level === 'warning')).toBe(true);
  });

  /**
   * P3.337 — the fourth family, and the one with the widest blast radius: a
   * definition carrying `tools` is DENIED, so no `[agents.<role>]` block and no
   * role file exist and the model cannot spawn it. `tools` is ordinary agent
   * frontmatter — codex's own plugin fixture (`agents/reviewer.md`) declares
   * `tools: Read, Grep` — so an agent authored in codex's own format vanishes on
   * codex and runs on the other two.
   *
   * Driven from the REAL builder and the REAL formatter, like its three
   * siblings, so a reworded prefix upstream fails here rather than silently
   * turning the lift off.
   */
  it('lifts the dropped-agent-roles line, taken from the real builder and formatter', () => {
    const plan = buildCodexAgentRoles({
      codexHome: '/tmp/ws-codex-notice-lift-home',
      sessionModel: 'codex/test-model',
      definitions: [
        {
          // P6.485 moved the example off `reviewer`, and the swap is the point
          // rather than housekeeping: `reviewer` is now the ONE name that is
          // declared despite an unhonourable tool grant, so it can no longer
          // stand for "a definition this runtime cannot declare". Any other
          // tool-granting name still can, which is what this line asserts.
          key: 'scan-researcher',
          name: 'scan-researcher',
          description: 'researches',
          systemPrompt: 'research things',
          tools: ['Read', 'Grep'],
        } as never,
        { key: 'planner', name: 'planner', description: 'plans', systemPrompt: 'plan things' } as never,
      ],
    });
    // The denied one produced no role; the untouched one did. Without this the
    // case could pass on a builder that denied everything.
    expect(plan.roles.map(role => role.roleName)).toEqual(['planner']);
    expect(plan.denied.map(entry => entry.key)).toEqual(['scan-researcher']);

    const [line] = formatCodexAgentRoleDropDiagnostics(plan);
    expect(line).toBeDefined();
    expect(line).toContain('scan-researcher');
    expect(line).not.toContain('planner');

    const h = harness();
    h.writerDiagnostic(line!);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.type).toBe('info');
    expect(h.events[0]!.level).toBe('warning');
    expect(h.events[0]!.message).toBe(line);
  });

  /**
   * The AGGREGATION is the affordability argument, so it is asserted rather
   * than assumed: nine denied definitions must still cost ONE of the eight
   * notice slots.
   */
  it('names every dropped definition in ONE line', () => {
    const plan = buildCodexAgentRoles({
      codexHome: '/tmp/ws-codex-notice-lift-home',
      sessionModel: 'codex/test-model',
      definitions: Array.from({ length: 9 }, (_, i) => ({
        key: `agent-${i}`,
        name: `agent-${i}`,
        description: 'x',
        systemPrompt: 'y',
        tools: ['Read'],
      })) as never,
    });
    const lines = formatCodexAgentRoleDropDiagnostics(plan);
    expect(lines).toHaveLength(1);
    for (let i = 0; i < 9; i++) expect(lines[0]).toContain(`agent-${i}`);
  });

  /** NEGATIVE CONTROL: a session where nothing was denied emits no line. */
  it('emits no dropped-roles line when every definition became a role', () => {
    const plan = buildCodexAgentRoles({
      codexHome: '/tmp/ws-codex-notice-lift-home',
      sessionModel: 'codex/test-model',
      definitions: [
        { key: 'planner', name: 'planner', description: 'plans', systemPrompt: 'plan things' } as never,
      ],
    });
    expect(plan.roles).toHaveLength(1);
    expect(formatCodexAgentRoleDropDiagnostics(plan)).toEqual([]);
  });

  it('leaves the per-entry families on the debug channel', () => {
    const h = harness();
    // The two the row deliberately does NOT lift: they are per entry and can be
    // many, and the notice queue's bound is eight.
    h.writerDiagnostic('Imported agent reviewer is not declared as a codex agent role: it declares a tool grant');
    h.writerDiagnostic('Codex hook not projected for preToolUse: the host authored none');
    h.writerDiagnostic('codex-denied-read-mirror: 9 workspace globs');
    expect(h.events).toEqual([]);
  });
});

describe('P3.267 · an unapplied administrator requirement reaches a person', () => {
  it('lifts the ENFORCED BY NOBODY line, taken from the real formatter', () => {
    // `models` is the ONE field this build's enforcement table verdicts
    // `'client'`, so it is what actually reaches the ENFORCED BY NOBODY bucket.
    const reading = readCodexConfigRequirements({
      requirements: { models: { newThread: { model: 'gpt-5' } } },
    });
    const line = formatCodexConfigRequirementsDiagnostics(reading)
      .find(l => l.startsWith(CODEX_REQUIREMENT_UNENFORCED_PREFIX));
    expect(line).toBeDefined();
    const h = harness();
    h.requirementDiagnostic(line!);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.level).toBe('warning');
    expect(h.events[0]!.message).toBe(line);
  });

  it('leaves a SATISFIED requirement on the debug channel', () => {
    const h = harness();
    h.requirementDiagnostic('[managed] codex reports no config requirements');
    h.requirementDiagnostic('[managed] codex requirements applied by Nessy: featureRequirements.in_app_updates');
    h.requirementDiagnostic(
      '[managed] codex requirements enforced by the codex app-server itself, so Nessy does not '
      + 're-implement them: allowedSandboxModes',
    );
    expect(h.events).toEqual([]);
  });
});

/**
 * P6.78 — the CLOCK statement, on the same queue and in the same shape.
 *
 * Codex reads an organisation's requirements PER SESSION, after `initialize`;
 * the host composes its own managed policy ONCE at process bootstrap and
 * `SessionManager` captures that composition per session. Neither half is a
 * defect; together they are a fact an administrator has to know, and nothing
 * said it.
 *
 * WHAT EACH TEST KILLS:
 *  - "announces the clock" dies if the notice stops being raised — the shipped
 *    state, where the carrier existed and the sentence did not.
 *  - "says nothing when no requirement arrived" is the negative control:
 *    `status: 'none'` is the ordinary case and has nothing to disagree about,
 *    so a notice there would fill an eight-deep queue with news for everyone.
 *  - "names the fields it read" dies if the line degrades to a bare statement.
 *    A clock without a subject is not actionable.
 *  - "is latched" dies if a re-spawn re-announces. `createRuntime` runs more
 *    than once per session on a teardown-and-respawn.
 *  - the binding case dies if the reader exists and the probe path stops
 *    calling it, which is precisely the defect class this file exists for.
 */
describe('P6.78 · the requirement channel says WHEN it was read', () => {
  it('announces the clock once for a session that carries a requirement', () => {
    const reading = readCodexConfigRequirements({
      requirements: { models: { newThread: { model: 'gpt-5' } } },
    });
    const h = harness();
    h.requirementClock(reading);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.level).toBe('warning');
    expect(h.events[0]!.message).toContain(CODEX_REQUIREMENT_CLOCK_PREFIX);
  });

  it('says nothing when the server reported no requirements at all', () => {
    const h = harness();
    h.requirementClock(readCodexConfigRequirements({ requirements: {} }));
    expect(h.events).toEqual([]);
  });

  it('names the fields this session actually read, and the other clock', () => {
    const reading = readCodexConfigRequirements({
      requirements: { models: { newThread: { model: 'gpt-5' } }, allowedSandboxModes: ['read-only'] },
    });
    const h = harness();
    h.requirementClock(reading);
    const message = h.events[0]!.message ?? '';
    expect(message).toContain('models');
    expect(message).toContain('allowedSandboxModes');
    // The half an administrator cannot see from inside codex: the OTHER clock,
    // and what resolves a disagreement between the two.
    // F1.1148 — the host re-reads its policy at each turn boundary
    // (`SessionManager.refreshManagedPiPolicy`); only what it built at startup
    // waits for a restart. The old "composed once" sentence is the boundary arm.
    expect(message).toContain('re-reads its own managed policy at each turn boundary');
    expect(message).toContain('restarted');
    expect(message).not.toContain('composed once when this app starts');
  });

  it('is latched: a respawn does not re-announce it', () => {
    const reading = readCodexConfigRequirements({
      requirements: { models: { newThread: { model: 'gpt-5' } } },
    });
    const h = harness();
    h.requirementClock(reading);
    h.requirementClock(reading);
    h.requirementClock(reading);
    expect(h.events).toHaveLength(1);
  });
});

/**
 * The bindings themselves. A reader nothing calls is exactly the shape of the
 * defect this row is about — a channel that exists and reaches nobody — so the
 * call sites are pinned as well as the readers.
 */
/**
 * P6.167 — the per-family `.claude` settings statement, on the same queue.
 *
 * The formatter and its table are pinned in the adapter
 * (`config-writer-claude-settings-projection.test.ts`). What CANNOT be tested
 * there is the half this file exists for: that a real session READS its own
 * project's settings files and lifts the line onto a surface a packaged build
 * shows. The reader is `CodexAgent`'s because the two files are the project's,
 * not the writer's.
 *
 * WHAT EACH TEST KILLS:
 *  - "lifts one line naming only the families codex does not honour" dies if the
 *    reader stops reading, or starts naming host-enforced families. Its POSITIVE
 *    CONTROL is in the same file: the permission block sits beside the excluded
 *    one and must not be named as a loss.
 *  - "says nothing for a project whose settings carry only honoured families"
 *    dies if the line becomes unconditional — the bound every diagnostic in this
 *    family respects, and the reason a line nobody reads is worse than none.
 *  - "is latched per agent" dies if a second probe re-queues the same sentence,
 *    which on an eight-deep queue is how one family crowds out seven.
 */
describe('P6.167 · a codex session says which .claude settings families it honours', () => {
  function projectWith(settings: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'nessy-p6167-'));
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(settings), 'utf-8');
    return root;
  }

  function noticeHarness(root: string) {
    const config = createConfig();
    (config.session as { workingDirectory: string }).workingDirectory = root;
    const agent = new CodexAgent(config);
    const internals = agent as unknown as {
      turnSink: { push: (e: Event) => void } | null;
      noteClaudeSettingsProjection: () => void;
    };
    const events: Event[] = [];
    internals.turnSink = { push: (e: Event) => events.push(e) };
    return { events, note: () => internals.noteClaudeSettingsProjection() };
  }

  it('lifts one line naming only the families codex does not honour', () => {
    const root = projectWith({
      permissions: { deny: ['Read(./secret)'] },
      claudeMdExcludes: ['docs/**'],
      skillOverrides: { review: 'off' },
    });
    try {
      const h = noticeHarness(root);
      h.note();
      expect(h.events).toHaveLength(1);
      expect(h.events[0]!.type).toBe('info');
      expect(h.events[0]!.message).toContain('codex-claude-settings-unprojected: ');
      expect(h.events[0]!.message).toContain('instructionExcludes');
      // Positive controls in the same run: two honoured families sat in the same
      // file and neither is reported as a loss.
      expect(h.events[0]!.message).not.toContain('skillOverrides');
      expect(h.events[0]!.message).toContain('permission block in the same file DOES take effect');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('says nothing for a project whose settings carry only honoured families', () => {
    const root = projectWith({ permissions: { allow: ['Bash(ls:*)'] }, crossSessionInbound: 'hold' });
    try {
      const h = noticeHarness(root);
      h.note();
      expect(h.events).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('says nothing when the project has no .claude settings at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-p6167-bare-'));
    try {
      const h = noticeHarness(root);
      h.note();
      expect(h.events).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is latched per agent', () => {
    const root = projectWith({ env: { PATH: '/attacker/bin' } });
    try {
      const h = noticeHarness(root);
      h.note();
      h.note();
      h.note();
      expect(h.events).toHaveLength(1);
      // And the refused family really is the one that fired.
      expect(h.events[0]!.message).toContain('env');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * D1.358 — the approval posture reaches the operator, once per config write.
 *
 * The defect this closes: `CODEX_BOUNDED_APPROVAL_NOTICE` and
 * `CODEX_UNBOUNDED_APPROVAL_NOTICE` were the only config-writer diagnostics with
 * no machine prefix, so `noteCodexConfigWriterDiagnostic` — which matches on the
 * prefixes alone — lifted neither, and both reached `debug`, which a packaged
 * build does not write. The POSITIVE CONTROL is in this block and not merely in
 * prose: the egress line comes out of the SAME `writeCodexConfig` call and has
 * been lifted since P3.267.
 *
 * Driven through the REAL writer rather than a hand-built string, for the reason
 * the P3.267 block above gives about its own formatters: the prefix is restated
 * nowhere now (it is imported), but the WIRING between the writer's sink and the
 * agent's classifier is exactly what a hand-built string cannot test.
 *
 * WHAT EACH TEST KILLS:
 *  - "lifts the bounded posture" dies if the prefix or the list entry goes, i.e.
 *    in the shipped state every user is in.
 *  - "lifts the unbounded posture" dies the same way for a session with no
 *    permission profile, and is the second arm rather than a repeat: the two
 *    notices are different strings on one prefix.
 *  - "one posture line per write, and a second write is a second line" is the
 *    cadence claim — per WRITE, not per turn: a `writeCodexConfig` runs at spawn
 *    and on a runtime rebuild, and nothing on the turn path emits it.
 *  - "the deferred path keeps one copy" is the other half of that cadence, on
 *    the queue a notice takes when no turn is listening.
 *  - "the debug sink still gets it" dies if the lift REPLACES the debug line
 *    instead of standing beside it.
 */
describe('D1.358 · the approval posture reaches the operator queue', () => {
  /** What `CodexAgent.buildRuntime` passes on every real session. */
  const REAL_FLOOR = {
    deniedReadPaths: ['/Users/x/.nessy-agent/credentials.enc'],
    deniedReadPatterns: ['**/.env'],
  } as const;

  function writeInto(home: string, extra: Record<string, unknown>, sink: (m: string) => void): void {
    writeCodexConfig({
      codexHome: home,
      model: 'codex/test-model',
      adapterPort: 54321,
      mode: 'default',
      sandboxGloballyEnabled: false,
      onDiagnostic: sink,
      ...extra,
    } as never);
  }

  it('lifts the bounded posture a real session earns, from the real writer', () => {
    const home = mkdtempSync(join(tmpdir(), 'nessy-d1358-'));
    try {
      const h = harness();
      writeInto(home, { ...REAL_FLOOR }, h.writerDiagnostic);
      const posture = h.events.filter(e => e.message?.startsWith(CODEX_APPROVAL_POSTURE_PREFIX));
      expect(posture).toHaveLength(1);
      expect(posture[0]!.message).toBe(CODEX_BOUNDED_APPROVAL_NOTICE);
      // Durable + warning is the ONE family `SessionManager` persists.
      expect(posture[0]!.type).toBe('info');
      expect(posture[0]!.level).toBe('warning');
      // THE POSITIVE CONTROL, from the same call: the line that was already
      // lifted. Without it a broken writer would read as a broken lift.
      expect(h.events.filter(e => e.message?.startsWith('codex-sandbox-egress-denied: '))).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('lifts the unbounded posture when no permission profile is written', () => {
    const home = mkdtempSync(join(tmpdir(), 'nessy-d1358-'));
    try {
      const h = harness();
      writeInto(home, {}, h.writerDiagnostic);
      const posture = h.events.filter(e => e.message?.startsWith(CODEX_APPROVAL_POSTURE_PREFIX));
      expect(posture).toHaveLength(1);
      expect(posture[0]!.message).toBe(CODEX_UNBOUNDED_APPROVAL_NOTICE);
      expect(posture[0]!.level).toBe('warning');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('one posture line per write, and a second write is a second line', () => {
    const home = mkdtempSync(join(tmpdir(), 'nessy-d1358-'));
    try {
      const h = harness();
      writeInto(home, { ...REAL_FLOOR }, h.writerDiagnostic);
      expect(h.events.filter(e => e.message?.startsWith(CODEX_APPROVAL_POSTURE_PREFIX))).toHaveLength(1);
      // A rebuild — a permission-mode change or a re-fork — writes the config
      // again, and the posture may have changed with it, so it is reported
      // again. Nothing on the TURN path emits this line at all.
      writeInto(home, { ...REAL_FLOOR }, h.writerDiagnostic);
      expect(h.events.filter(e => e.message?.startsWith(CODEX_APPROVAL_POSTURE_PREFIX))).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('the deferred path keeps ONE copy when no turn is listening', () => {
    const home = mkdtempSync(join(tmpdir(), 'nessy-d1358-'));
    try {
      const agent = new CodexAgent(createConfig());
      const internals = agent as unknown as {
        turnSink: unknown;
        pendingServerWarningNotices: string[];
        noteCodexConfigWriterDiagnostic: (message: string) => void;
      };
      // No turn sink: this is the state around `initialize`/`thread/start`,
      // which is when a config write actually happens.
      internals.turnSink = null;
      writeInto(home, { ...REAL_FLOOR }, m => internals.noteCodexConfigWriterDiagnostic(m));
      writeInto(home, { ...REAL_FLOOR }, m => internals.noteCodexConfigWriterDiagnostic(m));
      const held = internals.pendingServerWarningNotices
        .filter(m => m.startsWith(CODEX_APPROVAL_POSTURE_PREFIX));
      expect(held).toEqual([CODEX_BOUNDED_APPROVAL_NOTICE]);
      // The control: the queue is not empty of everything, so the filter above
      // is reading a real list and the dedupe is what kept it at one.
      expect(internals.pendingServerWarningNotices.length).toBeGreaterThan(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('P3.267 · the three bindings exist at their call sites', () => {
  const SOURCE = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');

  it('the config-writer binding lifts as well as debugs', () => {
    expect(SOURCE).toContain('this.noteCodexConfigWriterDiagnostic(message);');
    // The shipped state, verbatim. Its absence is the point.
    expect(SOURCE).not.toContain('onDiagnostic: (message) => this.debug(message),');
    // D1.358 · AS WELL AS, not instead of. The developer log keeps every
    // diagnostic, including the families this list deliberately leaves off it,
    // so the debug line must still sit above the lift at the same binding.
    const lift = SOURCE.indexOf('this.noteCodexConfigWriterDiagnostic(message);');
    const debugLine = SOURCE.lastIndexOf('this.debug(message);', lift);
    expect(debugLine).toBeGreaterThan(-1);
    expect(SOURCE.slice(debugLine, lift)).not.toContain('onDiagnostic');
  });

  it('the requirements probe binding lifts as well as debugs', () => {
    expect(SOURCE).toContain('this.noteCodexUnappliedRequirementDiagnostic(message);');
    expect(SOURCE).not.toContain('probeCodexConfigRequirements(this.recordManagedApprovalsReviewers(client), {\n        onDiagnostic: message => this.debug(message),');
  });

  it('the clock statement is raised from the probe path, not merely defined', () => {
    // P6.78. A latched notice with no call site is the same defect one layer
    // over, and this file exists because that shape shipped once already.
    expect(SOURCE).toContain('this.noteCodexRequirementClock(requirements);');
    const call = SOURCE.indexOf('this.noteCodexRequirementClock(requirements);');
    // It has to sit AFTER the probe that produced the reading.
    expect(SOURCE.slice(0, call)).toContain('await probeCodexConfigRequirements(this.recordManagedApprovalsReviewers(client), {');
  });

  it('the settings-family statement is raised from the probe path too (P6.167)', () => {
    // Same shape as the clock pin above and for the same reason: a reader with
    // no call site is the defect this file exists for.
    expect(SOURCE).toContain('this.noteClaudeSettingsProjection();');
    const call = SOURCE.indexOf('this.noteClaudeSettingsProjection();');
    expect(SOURCE.slice(0, call)).toContain('await probeCodexConfigRequirements(this.recordManagedApprovalsReviewers(client), {');
  });

  it('a bridge that did not start says so on a surface a packaged build shows', () => {
    // Eleven bridge-only tools disappear with it — the `bridgeTools` row in
    // `runtime-switch-costs.ts` is about exactly this set — so a session that
    // lost them silently is a runtime quietly less capable than the one the
    // user switched from.
    //
    // WI-bc 2026-09-18 · this case was RED at HEAD and is repaired in place, not
    // by a lane that touched it: `3913a723a` (D1.255/D1.256) moved the sentence
    // into the locales, so the literal it asserted occurred ZERO times in
    // `codex-agent.ts` while the fact itself was intact. Guard the CALL and the
    // VALUE instead of the literal — a key the source spells and a sentence the
    // user reads — which is the pair the old assertion collapsed into one.
    const call = "i18n.t('chat.codexNotice.callbackBridgeUnavailable'";
    expect(SOURCE).toContain(call);
    const lift = SOURCE.indexOf(call);
    expect(SOURCE.slice(0, lift)).toContain('this.surfaceCodexOperatorNotice(');
    // The other half: the key still says the thing the case is about, so the
    // pair cannot be satisfied by emptying the string.
    const en = JSON.parse(readFileSync(
      fileURLToPath(new URL('../../i18n/locales/en.json', import.meta.url)), 'utf8',
    )) as Record<string, string>;
    expect(en['chat.codexNotice.callbackBridgeUnavailable'])
      .toContain('SCHEDULING AND ADVISOR TOOLS ARE UNAVAILABLE');
  });
});
