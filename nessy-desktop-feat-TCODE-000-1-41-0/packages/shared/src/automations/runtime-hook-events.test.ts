/**
 * P6.11 / P6.13 — pins for the per-runtime hook-event table.
 *
 * The hazard this suite exists for is the one AGENTS.md records six times: a
 * hand-written list beside a single source of truth, drifting silently. Every
 * claim below is checked against the thing it describes — the emitters in
 * `codex-agent.ts` and `base-agent.ts`, and codex's OWN generated
 * `HookEventName` enum — never against a restatement.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_EVENTS, type AgentEvent } from './types.ts';
import {
  CODEX_NATIVE_HOOK_EVENTS,
  CODEX_ONLY_HOOK_EVENTS,
  codexNativeHookEvent,
  hookEventEmission,
  hookEventEmissionFrom,
  hookEventNativeRoute,
  hookEventNeverFires,
  hookEventsThatNeverFire,
} from './runtime-hook-events.ts';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
const read = (relative: string) => readFileSync(join(repoRoot, relative), 'utf-8');

/** Codex's own vocabulary, parsed from the generated enum rather than retyped. */
function codexHookEventNames(): string[] {
  const source = read('packages/codex-protocol/generated/v2/HookEventName.ts');
  const alias = /export type HookEventName\s*=\s*([^;]+);/.exec(source);
  expect(alias).not.toBeNull();
  return [...alias![1]!.matchAll(/"([^"]+)"/g)].map(match => match[1]!);
}

/** Every `emitAutomationEvent('X'` / `executeAgentEvent('X'` literal in a file. */
function emittedEventLiterals(relative: string): Set<string> {
  const source = read(relative);
  const found = new Set<string>();
  for (const match of source.matchAll(/(?:emitAutomationEvent|emitDetachedAutomationEvent|executeAgentEvent)\(\s*'([A-Za-z]+)'/g)) {
    found.add(match[1]!);
  }
  return found;
}

describe('runtime hook event table', () => {
  it('is total over AGENT_EVENTS for every measured runtime', () => {
    // A new upstream event must land here as a decision, not as a silent
    // default. `Record<AgentEvent, …>` fails the typecheck; this fails the test
    // for a table widened to `Partial` or keyed by `string`.
    for (const provider of ['codex-runtime', 'anthropic', 'pi'] as const) {
      for (const event of AGENT_EVENTS) {
        const emission = hookEventEmission(provider, event);
        expect(emission.kind).not.toBe(undefined);
        expect(emission.note.length).toBeGreaterThan(20);
      }
    }
  });

  it('claims nothing about a runtime with no measured column', () => {
    // The negative that keeps this honest: a column we have not read must never
    // feed a diagnostic. `anthropic` left this list in P6.89 and `pi` in P6.90,
    // which is why the assertion is written against the columns rather than
    // against a retyped list of runtimes.
    for (const event of AGENT_EVENTS) {
      expect(hookEventNeverFires('nestor-cloud-agent', event)).toBe(false);
      expect(hookEventEmission('nestor-cloud-agent', event).kind).toBe('unmeasured');
    }
    expect(hookEventsThatNeverFire('nestor-cloud-agent')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // P6.89 — the claude column, measured in ONE direction
  // -------------------------------------------------------------------------

  it('never records an absence on claude, because the bundle cannot support one', () => {
    // The rule the whole column rests on: the SDK is closed, so `unwired` and
    // `unreachable` are claims we cannot make there however the cells were
    // read. A cell that acquires one is the failure this test exists for — it
    // would tell a user their working hook is dead.
    for (const event of AGENT_EVENTS) {
      expect(hookEventEmission('anthropic', event).kind).not.toBe('unwired');
      expect(hookEventEmission('anthropic', event).kind).not.toBe('unreachable');
    }
    expect(hookEventsThatNeverFire('anthropic')).toEqual([]);
  });

  it("every claude cell citing the SDK union cites a name the installed union really has", () => {
    // Read the declaration, not the prose — the same discipline the codex
    // column's enum pin applies. A cell may cite the union only if the
    // installed `sdk.d.ts` carries that name.
    const union = read('node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts');
    const alias = /export declare type HookEvent = ([^;]+);/.exec(union);
    expect(alias).not.toBeNull();
    const names = [...alias![1]!.matchAll(/'([^']+)'/g)].map(match => match[1]!);
    // 31 at `0.3.233`…`0.3.247`; 33 since `0.3.251` (C3.380, 2026-09-13), which
    // added `PreModelSwitch` and `PostModelSwitch`. The number is pinned rather
    // than derived on purpose: a union that SHRINKS is the case this length
    // exists to catch, and `toContain` alone could not see it.
    expect(names).toHaveLength(33);

    const table = read('packages/shared/src/automations/runtime-hook-events.ts');
    const cited = [...table.matchAll(/hook_event_name:"([A-Za-z]+)"/g)].map(match => match[1]!);
    expect(cited.length).toBeGreaterThan(0);
    for (const name of cited) expect(names).toContain(name);

    // And the events of OURS the union does not have are exactly the ones whose
    // cells say so — the control that proves the reading distinguishes. This was
    // FOUR up to `0.3.247` and is TWO since `0.3.251`: the model-switch pair
    // joined the union (C3.380, 2026-09-13), and their cells were rewritten in
    // the same commit, so a lift that moves one without the other fails here.
    const ours = AGENT_EVENTS.filter(event => !names.includes(event));
    expect([...ours].sort()).toEqual(['McpElicitation', 'McpResult']);
    for (const event of ours) {
      if (event === 'McpResult') {
        expect(hookEventEmission('anthropic', event).kind).toBe('unmeasured');
        continue;
      }
      // The other three fire host-side, so their notes must name a host emitter
      // rather than the union they are not in.
      expect(hookEventEmission('anthropic', event).kind).toBe('emitted');
      expect(hookEventEmission('anthropic', event).note).toMatch(/host[- ]side|host event|host seam/);
    }
  });

  // -------------------------------------------------------------------------
  // P6.90 — the Pi column
  // -------------------------------------------------------------------------

  it('reads pi from pi\'s own table, not from codex\'s, wherever the two disagree', () => {
    // The positive, and the assertion P6.88 exists to make possible: the two
    // columns genuinely differ, so a lookup that returned codex's rows for pi
    // would be caught here rather than by inspection. `PreToolUse` is the
    // sharpest pair — pi awaits it while the subprocess blocks, codex would
    // only report it — and `SubagentStart` is the pair where the gate, not the
    // emitter, is the difference.
    expect(hookEventEmission('pi', 'PreToolUse').kind).toBe('emitted');
    expect(hookEventEmission('codex-runtime', 'PreToolUse').kind).toBe('unwired');
    expect(hookEventEmission('pi', 'SubagentStart').kind).toBe('emitted');
    expect(hookEventEmission('codex-runtime', 'SubagentStart').kind).toBe('unreachable');
    expect(hookEventEmission('pi', 'PostToolBatch').kind).toBe('emitted');
    expect(hookEventEmission('codex-runtime', 'PostToolBatch').kind).toBe('unmeasured');
    for (const event of AGENT_EVENTS) {
      expect(hookEventEmission('pi', event).note).not.toBe(hookEventEmission('codex-runtime', event).note);
    }
  });

  it('records no absence on pi, and every cell cites the file it was read from', () => {
    // The row's own failure signal, written as a test: "an all-`emitted` Pi
    // column with no citations is the failure signal". The column IS all
    // emitted, so the citation is the whole of the evidence — a cell whose note
    // names no source file is the state this asserts against.
    const cited = /pi-agent\.ts|lifecycle-bridge\.ts|base-agent\.ts|SessionManager/;
    for (const event of AGENT_EVENTS) {
      const emission = hookEventEmission('pi', event);
      expect(emission.kind).toBe('emitted');
      expect(emission.note).toMatch(cited);
    }
    expect(hookEventsThatNeverFire('pi')).toEqual([]);
    for (const event of AGENT_EVENTS) expect(hookEventNeverFires('pi', event)).toBe(false);
  });

  it('the pi cells that cite pi-agent.ts cite an event pi-agent.ts really emits', () => {
    // Read the emitters, not the prose — the same discipline the codex enum pin
    // and the claude union pin apply. `emitAutomationEventDetached` is pi's own
    // fourth dispatch shape, so the scan has to know it or three real emissions
    // read as absent.
    const source = read('packages/shared/src/agent/pi-agent.ts');
    const emitted = new Set<string>();
    for (const match of source.matchAll(/(?:emitAutomationEvent|emitAutomationEventDetached|awaitPromptGateDecision)\(\s*'([A-Za-z]+)'/g)) {
      emitted.add(match[1]!);
    }
    // The control that proves the scan reads the file: an event pi-agent.ts
    // does not emit must be absent from it, and the six Pi-only host events are
    // exactly that case — they live in SessionManager.
    for (const host of ['SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'WorktreeCreate', 'WorktreeRemove'] as const) {
      expect(emitted.has(host)).toBe(false);
      expect(hookEventEmission('pi', host).note).toContain('SessionManager');
    }
    expect(emitted.size).toBeGreaterThan(8);
    for (const event of emitted) {
      if (!(AGENT_EVENTS as readonly string[]).includes(event)) continue;
      expect(hookEventEmission('pi', event as AgentEvent).kind).toBe('emitted');
      expect(hookEventEmission('pi', event as AgentEvent).note).toContain('pi-agent.ts');
    }
  });

  it('the pi cells that cite the subprocess bridge cite an event the bridge really emits', () => {
    // The second surface, and the one a Pi SDK bump can move without touching
    // this package: every `options.emit('X'` in the lifecycle bridge must have a
    // pi cell, and every pi cell citing the bridge must be one of those names.
    const bridge = read('packages/pi-agent-server/src/extensions/lifecycle-bridge.ts');
    const emitted = new Set(
      [...bridge.matchAll(/options\.emit\(\s*'([A-Za-z]+)'/g)].map(match => match[1]!),
    );
    expect(emitted.has('McpResult')).toBe(true);
    expect(emitted.has('InstructionsLoaded')).toBe(false);
    for (const event of emitted) {
      expect(hookEventEmission('pi', event as AgentEvent).kind).toBe('emitted');
    }
    // The reverse direction, and it reads the cells that name the bridge HANDLER
    // as the emitter — `lifecycle-bridge.ts \`pi.on(\`. A note may mention the
    // file for the opposite reason (`InstructionsLoaded` cites it to say the
    // bridge deliberately stopped emitting), and a bare filename match would
    // read that as a claim it never made.
    for (const event of AGENT_EVENTS) {
      if (/lifecycle-bridge\.ts `pi\.on\(/.test(hookEventEmission('pi', event).note)) {
        expect(emitted.has(event)).toBe(true);
      }
    }
    // The control on the same reading: a cell that names the file WITHOUT
    // naming a handler is not counted as a citation, and there is one.
    expect(hookEventEmission('pi', 'InstructionsLoaded').note).toContain('lifecycle-bridge.ts');
    expect(emitted.has('InstructionsLoaded')).toBe(false);
  });

  it("McpResult's refuted sentence is corrected on the two columns that carried it", () => {
    // The premise correction this row confirmed: both other columns said the
    // event "has no production emitter on any runtime". Pi's bridge has one, so
    // the sentence was false — and the fix must not quietly change the two
    // VERDICTS, which are still `unmeasured` for a reason that survives.
    for (const provider of ['codex-runtime', 'anthropic'] as const) {
      const note = hookEventEmission(provider, 'McpResult').note;
      expect(hookEventEmission(provider, 'McpResult').kind).toBe('unmeasured');
      expect(note).not.toMatch(/no production emitter on (any|ANY) runtime['"]?[,.]/);
      expect(note).toContain('P6.90');
    }
    expect(hookEventEmission('pi', 'McpResult').kind).toBe('emitted');
  });

  // -------------------------------------------------------------------------
  // P6.88 — the lookup is keyed by PROVIDER
  // -------------------------------------------------------------------------

  it('a measured column with an EMPTY table answers unmeasured, never the other runtime\'s rows', () => {
    // The defect: the lookup read the codex table whatever provider it was
    // handed, and was correct only while exactly one column was `true`. The
    // second column to flip would have reported codex's verdicts as its own —
    // the failure this file's own header calls worse than no claim. Driven
    // through the injectable seam because `MEASURED_HOOK_EVENT_COLUMNS` is a
    // `const` a test cannot flip.
    // P6.661 — the codex column's MEASURED notes, collected first so the
    // comparison below is unconditional. It used to sit inside
    // `if (hookEventEmission('codex-runtime', event).kind !== 'unmeasured')`,
    // which meant a codex table that went all-unmeasured would DELETE the check
    // instead of failing it. The size assertion is that discriminator, asserted
    // unconditionally: it proves the column really carries measured cells, so
    // the comparison is not vacuous.
    const measuredCodexNotes = new Set(
      AGENT_EVENTS.map(event => hookEventEmission('codex-runtime', event))
        .filter(emission => emission.kind !== 'unmeasured')
        .map(emission => emission.note),
    );
    expect(measuredCodexNotes.size).toBeGreaterThan(0);
    for (const event of AGENT_EVENTS) {
      const emission = hookEventEmissionFrom({}, event);
      expect(emission.kind).toBe('unmeasured');
      // …and specifically NOT a codex cell's note — for this event or any other,
      // which is strictly stronger than the same-event comparison it replaced.
      expect(measuredCodexNotes.has(emission.note)).toBe(false);
    }
    // A column with a cell answers that cell — the positive control that proves
    // the seam reads the table it is handed rather than always answering
    // `unmeasured`.
    const filled = hookEventEmissionFrom(
      { PreToolUse: { kind: 'emitted', note: 'a table injected by this test, not a claim about any runtime' } },
      'PreToolUse',
    );
    expect(filled.kind).toBe('emitted');
    // No column at all is the OTHER unmeasured, and the two notes differ so a
    // reader can tell a half-filled column from an absent one.
    expect(hookEventEmissionFrom(undefined, 'PreToolUse').kind).toBe('unmeasured');
    expect(hookEventEmissionFrom(undefined, 'PreToolUse').note).not.toBe(hookEventEmissionFrom({}, 'PreToolUse').note);
  });

  it('the events codex-agent.ts emits by name are exactly the ones marked emitted there', () => {
    // The pin that catches an emission landing without the table moving. It has
    // caught one: P6.118 added `PostCompact` and `StopFailure` and this list
    // said four. It counts LITERALS, so P3.335's tool-call pair is invisible to
    // it — that emission names its event through a variable — which is why this
    // case asserts the table for what it does find rather than a total.
    const emitted = emittedEventLiterals('packages/shared/src/agent/codex-agent.ts');

    expect([...emitted].sort()).toEqual([
      'PermissionDenied', 'PostCompact', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure',
      'UserPromptSubmit',
    ]);
    for (const event of emitted) {
      expect(hookEventEmission('codex-runtime', event as AgentEvent).kind).toBe('emitted');
    }
  });

  it('the shared BaseAgent emissions are marked emitted too — the "exactly four" reading counted one file', () => {
    // The ledger's G1/G4 cells read `codex-agent.ts` alone. `base-agent.ts` is
    // shared by every backend, and CodexAgent registers the elicitation handler
    // in its own constructor, so these fire on codex as well.
    const shared = emittedEventLiterals('packages/shared/src/agent/base-agent.ts');

    expect(shared).toContain('InstructionsLoaded');
    expect(shared).toContain('McpElicitation');
    expect(shared).toContain('ElicitationResult');
    expect(read('packages/shared/src/agent/codex-agent.ts')).toContain('this.registerMcpElicitationHandler()');
    for (const event of ['InstructionsLoaded', 'McpElicitation', 'ElicitationResult'] as const) {
      expect(hookEventEmission('codex-runtime', event).kind).toBe('emitted');
    }
  });

  it("every cell citing codex's own enum cites a name the generated enum really has", () => {
    // Read the enum, not the prose. This count has now moved in BOTH directions
    // for two unrelated reasons — down, when three documents were found to have
    // miscounted it, and up again at the 2026-09-11 lift to `rust-v0.150.1`,
    // which really did add an event. That is the whole argument for deriving it
    // here instead of writing it in a sentence.
    const names = codexHookEventNames();
    expect(names).toHaveLength(12);
    expect(names).toContain('permissionRequest');
    expect(names).toContain('postToolUse');
    expect(names).toContain('interrupt');

    const table = read('packages/shared/src/automations/runtime-hook-events.ts');
    for (const cited of [...table.matchAll(/`([a-z][A-Za-z]+)` (?:is|IS) in codex's own HookEventName enum/g)]) {
      expect(names).toContain(cited[1]!);
    }
    // And the two we claim codex has NO counterpart for really are absent.
    expect(names).not.toContain('postToolUseFailure');
    expect(names).not.toContain('stopFailure');
  });

  it('separates unwired from unreachable, and both from emitted', () => {
    // The row's own requirement: "those are different verdicts and must not be
    // recorded as one". PreToolUse is buildable — codex fires it natively — and
    // is deliberately still unwired after P3.335: its contract is that it can
    // DENY, and the only place a codex call can still be stopped is the approval
    // bridge, which codex does not raise under `dangerFullAccess` or
    // auto-approval. SubagentStop is a different verdict again: nothing on our
    // side spawns a subagent, so the moment never occurs.
    //
    // PostToolUse used to be this case's `unwired` exemplar and is now
    // `emitted` — P3.335 mints it and PostToolUseFailure host-side from the
    // adapter's own tool_result stream, after the owner closed the native
    // `[hooks]` route on 2026-08-29.
    expect(hookEventEmission('codex-runtime', 'PreToolUse').kind).toBe('unwired');
    expect(hookEventEmission('codex-runtime', 'PermissionRequest').kind).toBe('unwired');
    expect(hookEventEmission('codex-runtime', 'PostToolUse').kind).toBe('emitted');
    expect(hookEventEmission('codex-runtime', 'PostToolUseFailure').kind).toBe('emitted');
    expect(hookEventEmission('codex-runtime', 'SubagentStop').kind).toBe('unreachable');
    expect(hookEventEmission('codex-runtime', 'SessionStart').kind).toBe('emitted');

    const never = hookEventsThatNeverFire('codex-runtime');
    expect(never).toContain('PreToolUse');
    expect(never).toContain('SubagentStop');
    // …and an event that now fires is out of that set, which is the half a
    // P6.13-style warning reads: it would otherwise call a working hook dead.
    expect(never).not.toContain('PostToolUse');
    expect(never).not.toContain('PostToolUseFailure');
    expect(never).not.toContain('SessionStart');
    expect(never).not.toContain('Stop');
  });

  it('an unmeasured codex cell does not answer "never fires"', () => {
    // The boundary case: `unmeasured` is a fourth verdict, not a synonym for
    // absent. A diagnostic built on this must stay quiet where we did not look.
    expect(hookEventEmission('codex-runtime', 'PostToolBatch').kind).toBe('unmeasured');
    expect(hookEventNeverFires('codex-runtime', 'PostToolBatch')).toBe(false);
    expect(hookEventsThatNeverFire('codex-runtime')).not.toContain('PostToolBatch');
  });

  // -------------------------------------------------------------------------
  // P6.14 — codex's own `[hooks]` vocabulary
  // -------------------------------------------------------------------------

  it("the two config-key lists PARTITION codex's wire events, lowerCamel to PascalCase", () => {
    // The trap this pins: codex spells each of its events TWICE, and only the
    // PascalCase spelling is a `[hooks]` key. A wire-spelled key is a field
    // `HooksToml` does not have — dropped in silence, hook registered nowhere.
    // Derived from the generated enum rather than compared to a second hand
    // list, so a codex rename cannot be satisfied by editing this test.
    //
    // A PARTITION rather than an equality, since `interrupt` arrived: the two
    // lists together must be codex's whole vocabulary and must not overlap, so
    // the next event to arrive belongs to neither and reddens here. An equality
    // against `CODEX_NATIVE_HOOK_EVENTS` alone could be satisfied by appending
    // the new name to a list whose `satisfies readonly AgentEvent[]` would then
    // refuse to compile — which is a worse place to discover it.
    const wire = codexHookEventNames();
    const expected = wire.map(name => name[0]!.toUpperCase() + name.slice(1));
    const ours = [...CODEX_NATIVE_HOOK_EVENTS] as string[];
    const theirs = [...CODEX_ONLY_HOOK_EVENTS] as string[];

    expect([...ours, ...theirs].sort()).toEqual([...expected].sort());
    expect(ours.filter(key => theirs.includes(key))).toEqual([]);
    expect(CODEX_NATIVE_HOOK_EVENTS).toHaveLength(11);
    expect(CODEX_ONLY_HOOK_EVENTS).toEqual(['Interrupt']);
  });

  it('the codex-only keys are exactly the ones our own vocabulary lacks', () => {
    // The property that makes the split mean anything, and the one a reader
    // would otherwise have to take on trust: a key is in `CODEX_ONLY_HOOK_EVENTS`
    // BECAUSE no `AgentEvent` is named that, not because someone chose to put it
    // there. Mint an `Interrupt` event one day and this test says so.
    for (const key of CODEX_ONLY_HOOK_EVENTS) {
      expect(AGENT_EVENTS as string[]).not.toContain(key);
      expect(codexNativeHookEvent(key as unknown as AgentEvent)).toBeUndefined();
    }
    // The positive control on the same rig: the shared keys ARE our events.
    for (const key of CODEX_NATIVE_HOOK_EVENTS) {
      expect(AGENT_EVENTS as string[]).toContain(key);
    }
  });

  it("the two lists are also the release config-schema's own HooksToml properties", () => {
    // The second generated artifact, and the one that actually governs TOML.
    // `state` is the one HooksToml property that is NOT an event — it is the
    // trust table, and a list that swallowed it would emit `[[hooks.state]]`.
    const schema = JSON.parse(read('packages/codex-protocol/schema/config-schema.json'));
    const properties = Object.keys(schema.definitions.HooksToml.properties);
    const both = [...CODEX_NATIVE_HOOK_EVENTS, ...CODEX_ONLY_HOOK_EVENTS] as string[];

    expect(properties).toContain('state');
    expect(properties.filter((key: string) => key !== 'state').sort()).toEqual([...both].sort());
    expect(both).not.toContain('state');
  });

  it('translates only the events codex has a counterpart for', () => {
    // The three that answer `undefined` are OUR vocabulary. They are the reason
    // this is a lookup and not a cast: a cast would hand `[hooks]` a key the
    // binary silently drops.
    expect(codexNativeHookEvent('PreToolUse')).toBe('PreToolUse');
    expect(codexNativeHookEvent('SubagentStart')).toBe('SubagentStart');
    for (const ours of ['PostToolUseFailure', 'PermissionDenied', 'StopFailure'] as const) {
      expect(codexNativeHookEvent(ours)).toBeUndefined();
      expect(hookEventNativeRoute('codex-runtime', ours)).toBeUndefined();
    }
  });

  it('offers a native route only where the event never fires AND codex hooks it', () => {
    // The whole point of the row, in one assertion. Five cells are `unwired`
    // with a codex counterpart — those are OUR configuration, not codex's
    // limit — and an event that already fires offers no route because there is
    // nothing to route around.
    // THREE now, not four and not the original five: P3.335 moved PostToolUse to
    // `emitted` and P6.118 moved PostCompact, so neither offers a route for the
    // same reason SessionStart does not — there is nothing left to route around.
    // The count moving is the point of the assertion below it.
    for (const event of ['PreToolUse', 'PermissionRequest', 'PreCompact'] as const) {
      expect(hookEventEmission('codex-runtime', event).kind).toBe('unwired');
      expect(hookEventNativeRoute('codex-runtime', event)).toBe(event);
    }
    expect(hookEventNativeRoute('codex-runtime', 'SessionStart')).toBeUndefined();
    expect(hookEventNativeRoute('codex-runtime', 'Stop')).toBeUndefined();
    // The two that moved: native in codex's own enum, and no longer offered as a
    // route because the host now mints them.
    expect(hookEventNativeRoute('codex-runtime', 'PostToolUse')).toBeUndefined();
    expect(hookEventNativeRoute('codex-runtime', 'PostCompact')).toBeUndefined();
  });

  it('an unreachable-but-native event still names its route, and a foreign runtime never does', () => {
    // `SubagentStart` IS one of codex's own keys and is still `unreachable` here,
    // because our codex sessions spawn no subagent. Membership in the config
    // vocabulary and occurrence in a session are different questions, and
    // collapsing them is what P6.11 corrected.
    expect(hookEventEmission('codex-runtime', 'SubagentStart').kind).toBe('unreachable');
    expect(hookEventNativeRoute('codex-runtime', 'SubagentStart')).toBe('SubagentStart');
    // No unmeasured column may ever offer a route — that would be a claim about
    // a runtime we deliberately refuse to claim anything about.
    for (const provider of ['anthropic', 'pi', 'nestor-cloud-agent'] as const) {
      for (const event of AGENT_EVENTS) {
        expect(hookEventNativeRoute(provider, event)).toBeUndefined();
      }
    }
  });
});
