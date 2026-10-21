/**
 * The three turn-shape SDK options Nessy passes explicitly on a Claude query.
 *
 * Two of them are corrected from the docs by the SDK typings spike
 * (`docs/superpowers/specs/2026-07-25-claude-sdk-typings-spike.md`):
 * `excludeDynamicSections` nests inside `systemPrompt` rather than sitting at the
 * top level, and `maxTurns` used to be only ever a child restriction in this
 * repo — P6.276 gave it a second source, the operator's own
 * `workspaceDefaults.maxAgentTurns`, and the two are reconciled by taking the
 * smaller. The spike's sentence is kept here in its corrected form rather than
 * deleted, because the wrong version of it is what a later reader would
 * otherwise re-derive.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildClaudeMaxBudgetUsdOptions,
  buildClaudeOperatorSettingsFlagCollisionNotice,
  buildClaudeOperatorSettingsFlagNotices,
  buildClaudeStructuredOutputOptions,
  buildClaudeTurnShapeOptions,
  buildClaudeWorktreeFloorContext,
  composeClaudeSpawnSettings,
} from '../claude-agent.ts';
import { claudeLiveSessionSignature } from '../backend/claude/live-session.ts';
import { buildClaudeSubprocessEnv } from '../options.ts';
import { CLAUDE_LAUNCHER_ENV_KEYS, CLAUDE_SDK_STRIPPED_ENV_KEYS } from '../../config/claude-provider-routing-env.ts';

function buildOptionsFor(input: { mini: boolean; childMaxTurns?: number; sessionMaxTurns?: number }) {
  return buildClaudeTurnShapeOptions({
    ...(input.mini ? { miniSystemPrompt: 'lean mini prompt' } : { presetAppend: 'nessy append' }),
    ...(input.childMaxTurns === undefined ? {} : { childMaxTurns: input.childMaxTurns }),
    ...(input.sessionMaxTurns === undefined ? {} : { sessionMaxTurns: input.sessionMaxTurns }),
  });
}

describe('claude turn-shape options', () => {
  it('nests excludeDynamicSections inside the preset system prompt', () => {
    // The spike proved it is a sibling of type/preset/append, NOT a top-level
    // option. It is also a no-op on the mini branch, which returns a plain string.
    const options = buildOptionsFor({ mini: false });
    expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
    expect((options.systemPrompt as Record<string, unknown>).excludeDynamicSections).toBeDefined();
    expect('excludeDynamicSections' in options).toBe(false);
  });

  it('keeps the mini branch on a plain string prompt', () => {
    expect(buildOptionsFor({ mini: true }).systemPrompt).toBe('lean mini prompt');
  });

  /**
   * UB2.13 — upstream v0.15.1 pins `snapshot: true` on the preset rather than
   * riding the SDK default (`sdk.d.ts`: "Omitted or `snapshot: true` (the
   * default)"), so a later SDK that flips the default cannot start re-rendering
   * the prompt mid-conversation. UB5.1 measured the default recording on 0.3.280.
   */
  it('pins snapshot: true inside the preset system prompt (UB2.13)', () => {
    const options = buildOptionsFor({ mini: false });
    expect((options.systemPrompt as Record<string, unknown>).snapshot).toBe(true);
    expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code', excludeDynamicSections: true });
    expect('snapshot' in options).toBe(false);
  });

  it('carries no snapshot key on the mini plain-string prompt (UB2.13)', () => {
    // A bare string follows the SDK default; wrapping it into an object to pin
    // the key would change the mini prompt's shape, which nothing asked for.
    const options = buildOptionsFor({ mini: true });
    expect(typeof options.systemPrompt).toBe('string');
    expect('snapshot' in options).toBe(false);
  });

  /**
   * P6.439 clause (1) — `--settings`, the flag-settings TIER — and P6.1009, which
   * is why these cases no longer read this builder at all.
   *
   * NATIVE-FIRST, tier 1: the SDK owns the layering. `Options.settings` is
   * *"Additional settings to apply … loaded into the 'flag settings' layer,
   * which has the highest priority among user-controlled settings. Equivalent
   * to the `--settings` CLI flag."* So the `done_means` — above
   * user/project/local, below managed — is the child's own precedence.
   *
   * WHAT WAS WRONG, and why the old cases could not see it: the builder returned
   * `{ settings: <the flag> }`, that return was spread into `chatImpl`'s options
   * literal ~200 lines ABOVE `...claudeFlagSettingsOptions`, `settings` is ONE
   * key, and the later spread wins. The composed value is always present (its
   * `worktree` contributor is unconditional), so the flag was discarded on every
   * spawn — while these tests passed, because they asserted the BUILDER's return
   * and never the literal the child is built from.
   *
   * So the flag is now the LAST contributor to `composeClaudeSpawnSettings`, the
   * one writer of that option, and these cases pin the composed result plus the
   * two source facts that make it the FINAL value.
   */
  it('lets a flag-only key through to the composed settings the child is built from', () => {
    const composed = composeClaudeSpawnSettings({
      flags: { permissions: { deny: ['Bash(curl:*)'] } },
      worktree: { worktree: { bgIsolation: 'none' } },
      operatorSettingsFlag: { model: 'claude-opus-4-1', env: { FOO: 'bar' } },
    });
    // The operator's own keys reach the child — the whole of what the clause
    // promised and what the overwrite was taking away.
    expect(composed.settings).toMatchObject({ model: 'claude-opus-4-1', env: { FOO: 'bar' } });
    // …beside the host's, not instead of them.
    expect(composed.settings).toMatchObject({ permissions: { deny: ['Bash(curl:*)'] } });
  });

  it('refuses to let the flag lift the floor, and says whose value it kept', () => {
    const collisions: string[] = [];
    const composed = composeClaudeSpawnSettings({
      flags: { permissions: { deny: ['Bash(curl:*)'] } },
      // LAST, exactly as `chatImpl` orders it: the composer keeps the FIRST
      // writer of a key, so an operator cannot use the tier to widen the
      // credential floor by writing the same key.
      operatorSettingsFlag: { permissions: { deny: [] }, model: 'x' },
    }, message => collisions.push(message));

    expect((composed.settings as Record<string, unknown>).permissions)
      .toEqual({ deny: ['Bash(curl:*)'] });
    // The key it could NOT take is not the key it loses everything over.
    expect((composed.settings as Record<string, unknown>).model).toBe('x');
    // Spoken by name rather than resolved silently in either direction.
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toContain('permissions');
    expect(collisions[0]).toContain('operatorSettingsFlag');
  });

  it('drops a PATH value whole, audibly, instead of merging a filename into an object', () => {
    const collisions: string[] = [];
    const composed = composeClaudeSpawnSettings({
      worktree: { worktree: { bgIsolation: 'none' } },
      operatorSettingsFlag: '/etc/nessy/settings.json',
    }, message => collisions.push(message));

    // The documented flag takes a path first, and there is nothing to merge a
    // filename into. It was overwritten SILENTLY before this row; the residue is
    // that it is still not applied, and the change is that it now says so.
    expect(composed.settings).toEqual({ worktree: { bgIsolation: 'none' } });
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toContain('operatorSettingsFlag');
    expect(collisions[0]).toContain('FILE PATH');
  });

  /**
   * P6.1023 — the drop above, said where an operator reads it.
   *
   * The composer's line goes to `onCollision`, which `chatImpl` hands to
   * `this.debug`, and AGENTS.md §Traps records what that is worth on a packaged
   * build: *"packaged builds log nothing outside debug mode"*. So the operator's
   * flag did nothing AND said nothing. Nothing about the drop itself changes —
   * reading the file here stays refused for the reason
   * `config/claude-flag-settings.ts` records — only who hears it.
   */
  it('says a dropped PATH out loud, with the shape that does reach the child', () => {
    const { notices } = buildClaudeOperatorSettingsFlagNotices('/etc/nessy/settings.json');
    expect(notices).toHaveLength(1);
    // The value they typed, so an operator can tell WHICH flag was refused.
    expect(notices[0]).toContain('/etc/nessy/settings.json');
    // …and the one thing to do instead. A notice naming a refusal with no
    // remedy is the shape this row exists to stop shipping.
    expect(notices[0]).toContain('inline JSON object');
  });

  it('says nothing about a value that composes', () => {
    // The negative that keeps the positive from being a blanket warning: an
    // object contributes its keys, and a key a host floor already owns is named
    // by the composer's own per-key line, not by this one.
    expect(buildClaudeOperatorSettingsFlagNotices({ model: 'claude-opus-4-1' }).notices).toEqual([]);
    // An unset flag is the ordinary spawn — byte-identical to one built before
    // this function existed.
    expect(buildClaudeOperatorSettingsFlagNotices(undefined).notices).toEqual([]);
  });

  /**
   * P6.1031 — the per-key half, and the reason the decision is the CALLER's.
   *
   * The composer keeps the first writer and names the loser, to `this.debug`
   * and nothing else. An operator whose `--settings` object wrote a key a host
   * floor already owns therefore saw a flag that looked applied with one key
   * quietly ignored. Only a collision whose LOSER is that flag is theirs to act
   * on, which is a fact about the collision's STRUCTURE — matching on the
   * sentence would fire this for two host contributors colliding with each
   * other, which is a developer's business and not a degradation.
   */
  it('reports the loser of a key collision structurally, and only for the flag (P6.1031)', () => {
    const details: Array<{ key: string; winner: string; loser: string } | undefined> = [];
    composeClaudeSpawnSettings({
      worktree: { worktree: { bgIsolation: 'none' } },
      operatorSettingsFlag: { worktree: { bgIsolation: 'worktree' } },
    }, (_message, detail) => details.push(detail));
    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({ key: 'worktree', winner: 'worktree', loser: 'operatorSettingsFlag' });

    // NEGATIVE, and the one that keeps this from doubling P6.1023: the
    // whole-contributor PATH drop carries no detail, because the path notice
    // already speaks for it.
    const pathDetails: Array<{ key: string; winner: string; loser: string } | undefined> = [];
    composeClaudeSpawnSettings({
      worktree: { worktree: { bgIsolation: 'none' } },
      operatorSettingsFlag: '/etc/nessy/settings.json',
    }, (_message, detail) => pathDetails.push(detail));
    expect(pathDetails).toEqual([undefined]);

    // …and a collision the operator has no part in still reports its structure
    // for the debug line, with a loser that is not the flag.
    const hostDetails: Array<{ key: string; winner: string; loser: string } | undefined> = [];
    composeClaudeSpawnSettings({
      flags: { permissions: { deny: ['Read(//**/.env)'] } },
      webFetchPreflight: { permissions: { deny: [] } },
    }, (_message, detail) => hostDetails.push(detail));
    expect(hostDetails[0]?.loser).toBe('webFetchPreflight');
  });

  it('names the dropped KEY in the operator\'s own vocabulary (P6.1031)', () => {
    const { notices } = buildClaudeOperatorSettingsFlagCollisionNotice('permissions');
    expect(notices).toHaveLength(1);
    // The key they wrote, so an operator can tell WHICH part of their object was
    // not applied…
    expect(notices[0]).toContain('"permissions"');
    // …and the fact that the rest of it still arrived, which is what stops this
    // from reading as "the flag was ignored".
    expect(notices[0]).toContain('Every OTHER key');
    // Not the composer's internal contributor names: this sentence is for the
    // person who set the flag, and the debug line is for the developer.
    expect(notices[0]).not.toContain('operatorSettingsFlag');
  });

  it('decides on the structure at the call site, and queues both silences (P6.1030, P6.1031)', () => {
    // The same wiring guard the row above uses, for the same reason: a builder
    // whose return never arrives passes every test written against the builder.
    // Matched as CODE.
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    // P6.1031 — keyed on `detail.loser`, never on the message text.
    expect(source).toMatch(
      /if \(detail\?\.loser === 'operatorSettingsFlag'\) \{\n\s+for \(const notice of buildClaudeOperatorSettingsFlagCollisionNotice\(detail\.key\)\.notices\) \{\n\s+this\.queueDegradationNotice\(notice\);/,
    );
    // P6.1030 — the narrowed-`settingSources` diagnostics reach the queue rather
    // than `debug()` alone.
    expect(source).toMatch(
      /const settingSources = this\.projectTrustSettingSources\(resolveClaudeSettingSources\(\n\s+process\.env,\n\s+message => this\.queueDegradationNotice\(message\),\n\s+\)\);/,
    );
    // The positive control on the same read: a regex matching nothing would not
    // pass this block.
    expect(source).toContain('export function buildClaudeOperatorSettingsFlagCollisionNotice(');
  });

  it('queues that notice at the one call site, rather than returning it to nobody', () => {
    // THE guard this row inherits from P6.1009: a builder whose return never
    // arrives passes every test written against the builder. Matched as CODE
    // over the wiring as a whole — the call, the loop and the queue — so the
    // docblocks that name both identifiers a few thousand lines apart cannot
    // satisfy it.
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /for \(const notice of buildClaudeOperatorSettingsFlagNotices\(flagSettings\)\.notices\) \{\n\s+this\.queueDegradationNotice\(notice\);\n\s+\}/,
    );
    // The positive control on the same read: a regex matching nothing at all
    // would not pass this block.
    expect(source).toContain('export function buildClaudeOperatorSettingsFlagNotices(');
  });

  it('leaves the turn-shape builder with no settings key of its own', () => {
    // THE BOUNDARY that keeps the defect from coming back by the same route: a
    // second producer of this option in that literal is the whole bug. Pinned on
    // the builder's declared return type, which is what a reviewer would read.
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    expect(source).toContain("}): Pick<Options, 'systemPrompt' | 'settingSources' | 'maxTurns'> {");
    expect(buildClaudeTurnShapeOptions({ presetAppend: 'x' })).not.toHaveProperty('settings');
  });

  it('keeps exactly one writer of Options.settings in the turn builder', () => {
    // The other half of the same boundary, and the reason the literal's own
    // comment ("this must stay the only `settings` spread in this literal") is
    // true again: one composer call, one spread of its result.
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    // Matched as CODE, not as an identifier: a docblock a few hundred lines up
    // names both of these while explaining the defect, and a bare substring
    // count would read the prose and fail on the correct file — the stale-guard
    // shape AGENTS.md §Traps records twice.
    const composerCalls = source.match(/^\s+const claudeFlagSettingsOptions = composeClaudeSpawnSettings\($/gm) ?? [];
    const composerSpreads = source.match(/^\s+\.\.\.claudeFlagSettingsOptions,$/gm) ?? [];
    expect(composerCalls).toHaveLength(1);
    expect(composerSpreads).toHaveLength(1);
    // The positive control on the same read: the composer is defined here too,
    // so a regex that matched nothing at all would not pass this block.
    expect(source).toContain('export function composeClaudeSpawnSettings(');
  });

  it('respawns on a changed tier, because no Query member can move it', () => {
    // The other half of "construction option". `settings` has no live setter —
    // the same `sdk.d.ts` scan that guards the setter-less options — so a
    // changed value must produce a different signature or the live child keeps
    // applying the tier it launched with, silently. Read through the COMPOSED
    // value now, which is what the options literal actually carries.
    const compose = (deny: readonly string[]) => composeClaudeSpawnSettings({
      worktree: { worktree: { bgIsolation: 'none' } },
      operatorSettingsFlag: { permissions: { deny: [...deny] } },
    });
    const withA = compose(['Bash(a:*)']);
    const withB = compose(['Bash(b:*)']);
    const without = composeClaudeSpawnSettings({ worktree: { worktree: { bgIsolation: 'none' } } });
    expect(claudeLiveSessionSignature(withA as never)).not.toBe(claudeLiveSessionSignature(withB as never));
    expect(claudeLiveSessionSignature(withA as never)).not.toBe(claudeLiveSessionSignature(without as never));
    // And the control that keeps the two lines above from passing by accident:
    // the same value twice is the same signature, so an unchanged tier does not
    // churn the child every turn.
    expect(claudeLiveSessionSignature(withA as never))
      .toBe(claudeLiveSessionSignature(compose(['Bash(a:*)']) as never));
  });

  it('passes settingSources explicitly rather than leaving the SDK to guess', () => {
    // Omitting it loads all three sources; spelling out the same three keeps
    // today's behavior while making it visible.
    expect(buildOptionsFor({ mini: false }).settingSources).toEqual(['user', 'project', 'local']);
  });

  it('passes no maxTurns for a main session and the clamped value for a child', () => {
    expect(buildOptionsFor({ mini: false }).maxTurns).toBeUndefined();
    expect('maxTurns' in buildOptionsFor({ mini: false })).toBe(false);
    expect(buildOptionsFor({ mini: false, childMaxTurns: 3 }).maxTurns).toBe(3);
  });

  it("carries the operator's own turn ceiling, and an unset one changes nothing (P6.276)", () => {
    // The positive: a number a person typed reaches the SDK's own ceiling, which
    // ends the query with `error_max_turns` — already mapped to
    // `max_agent_turns` by the event adapter, the same terminal reason Pi's
    // force-abort produces.
    expect(buildOptionsFor({ mini: false, sessionMaxTurns: 12 }).maxTurns).toBe(12);
    // A mini agent runs on the same ceiling: it is the operator's session, not
    // the prompt shape, that the setting is about.
    expect(buildOptionsFor({ mini: true, sessionMaxTurns: 12 }).maxTurns).toBe(12);
    // The boundary the row's `done_means` names as its control: the default 0
    // must change NOTHING, i.e. leave the option absent rather than pass a zero
    // the CLI would reject as not a positive integer.
    for (const off of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect('maxTurns' in buildOptionsFor({ mini: false, sessionMaxTurns: off })).toBe(false);
    }
  });

  it('takes the SMALLER of the operator ceiling and a child restriction (P6.276)', () => {
    // A child restriction must not raise an operator's ceiling, and an
    // operator's ceiling must not lift a caller's child restriction. No caller
    // supplies `childMaxTurns` today, which is exactly why the rule is pinned
    // here rather than discovered by the first one that does.
    expect(buildOptionsFor({ mini: false, childMaxTurns: 3, sessionMaxTurns: 12 }).maxTurns).toBe(3);
    expect(buildOptionsFor({ mini: false, childMaxTurns: 30, sessionMaxTurns: 12 }).maxTurns).toBe(12);
    // A fractional configured value floors rather than reaching the CLI as a
    // non-integer it rejects by name ("Must be a positive integer").
    expect(buildOptionsFor({ mini: false, sessionMaxTurns: 7.9 }).maxTurns).toBe(7);
  });

  it('carries outputFormat {type: json_schema, schema} on the turn when the option is set (R18)', () => {
    // Same proven shape as the call_llm path (claude-agent.ts queryLlm).
    const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };
    expect(buildClaudeStructuredOutputOptions(schema)).toEqual({
      outputFormat: { type: 'json_schema', schema },
    });
    // Absent option keeps the turn options byte-identical: no field at all.
    expect(buildClaudeStructuredOutputOptions(undefined)).toEqual({});
    expect('outputFormat' in buildClaudeStructuredOutputOptions(undefined)).toBe(false);
  });

  it('passes the Claude SDK retry knob through the subprocess env un-renamed (R18)', () => {
    // MAX_STRUCTURED_OUTPUT_RETRIES is the SDK's OWN knob (default 5) and must
    // reach the subprocess by inheritance, never renamed on the Claude side —
    // the Nessy Pi loop has its own NESSY_-prefixed knob. The env builder only
    // strips the SDK strip set (CLAUDE_SDK_STRIPPED_ENV_KEYS,
    // authentication.md § Authentication precedence tier 1 + amazon-bedrock.md
    // § Mantle environment variables).
    const previous = process.env.MAX_STRUCTURED_OUTPUT_RETRIES;
    const previousNessy = process.env.NESSY_MAX_STRUCTURED_OUTPUT_RETRIES;
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = '7';
    delete process.env.NESSY_MAX_STRUCTURED_OUTPUT_RETRIES;
    try {
      const env = buildClaudeSubprocessEnv();
      expect(env.MAX_STRUCTURED_OUTPUT_RETRIES).toBe('7');
      // No renaming/bridging: the Nessy knob is not synthesized from the SDK's.
      expect('NESSY_MAX_STRUCTURED_OUTPUT_RETRIES' in env).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.MAX_STRUCTURED_OUTPUT_RETRIES;
      else process.env.MAX_STRUCTURED_OUTPUT_RETRIES = previous;
      if (previousNessy === undefined) delete process.env.NESSY_MAX_STRUCTURED_OUTPUT_RETRIES;
      else process.env.NESSY_MAX_STRUCTURED_OUTPUT_RETRIES = previousNessy;
    }
  });

  it('scrubs the corporate-launcher names from the child env, and they are NOT in the silent union (P3.300)', () => {
    // The binary honours CLAUDE_CODE_SHELL_PREFIX / CLAUDE_CODE_PROCESS_WRAPPER
    // for its own Bash and stdio MCP — re-measured 2026-09-12 on the shipped
    // 2.1.247 at 12 lines / 23 occurrences and 14 lines / 20 occurrences, both
    // instruments named because they disagree on a minified artefact (C3.294);
    // the superseded reading was "10 and 13 occurrences" at 2.1.233, nonsense
    // control 0 then and 0/0 now — and CLAUDE_CODE_SHELL to pick the
    // interpreter itself (still 7 standalone occurrences: the name scores 14/30
    // in total and 12/23 of that is CLAUDE_CODE_SHELL_PREFIX, which CONTAINS it,
    // so the standalone figure is a subtraction and not a grep; P6.587 added it to the same
    // list, measured: `CODEX_SHELL` 0 in the codex binary, `env.SHELL`/`PI_SHELL`
    // 0 files across the vendored Pi packages). Pi and codex have no
    // counterpart, so passing any of them through applies a launcher policy on
    // one runtime of three. They are scrubbed from a SEPARATE, announced loop
    // rather than the silent strip union — dropping an administrator's
    // deliberate setting without saying so is the same silent divergence with
    // the sign flipped.
    //
    // The control key was CLAUDE_CODE_SHELL until P6.587 scrubbed it too. With
    // both CLAUDE_CODE_SHELL* names gone there is no surviving member of that
    // prefix, so the control is now the binary's own alphabetical NEIGHBOUR of
    // the pair (CLAUDE_CODE_SESSION_NAME, 8 occurrences, in no strip list) —
    // it still proves the absences below are this scrub by name and not a
    // prefix-wide deletion.
    const controlKey = 'CLAUDE_CODE_SESSION_NAME';
    const keys = [...CLAUDE_LAUNCHER_ENV_KEYS, controlKey];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    for (const key of CLAUDE_LAUNCHER_ENV_KEYS) process.env[key] = '/opt/corp/launcher';
    process.env[controlKey] = 'nessy-control-session';
    try {
      const env = buildClaudeSubprocessEnv();
      for (const key of CLAUDE_LAUNCHER_ENV_KEYS) {
        expect({ key, present: key in env }).toEqual({ key, present: false });
      }
      // Positive control on the same rig: the CLAUDE_CODE_* name the binary
      // enumerates immediately before the scrubbed pair survives, so the
      // absence above is this scrub and not a prefix-wide deletion.
      expect(env[controlKey]).toBe('nessy-control-session');
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key]!;
      }
    }
    // Boundary: they must stay OUT of the silent union, or the announcement is
    // dead code and the drop becomes silent again.
    for (const key of CLAUDE_LAUNCHER_ENV_KEYS) {
      expect({ key, inSilentUnion: (CLAUDE_SDK_STRIPPED_ENV_KEYS as readonly string[]).includes(key) })
        .toEqual({ key, inSilentUnion: false });
    }
  });

  it('HONOURS CLAUDE_CODE_SUBPROCESS_ENV_SCRUB rather than scrubbing it (P3.310)', () => {
    // The deliberate asymmetry with the two launcher names above, and the one
    // most likely to be "tidied" by someone extending either strip list. This
    // switch only NARROWS — it forces permissionMode to default, pins the
    // filesystem policy to strict and strips credentials from the child's own
    // subprocesses — so deleting it would remove a hardening an administrator
    // chose, which is the failure `runtime-capability-gaps.md` already warns
    // about against this exact name. It must reach the child.
    const saved = process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
    process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
    try {
      const env = buildClaudeSubprocessEnv();
      expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
      else process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = saved;
    }
    // Boundary: it is in neither strip list, or the honouring is accidental.
    const inStripLists = [
      ...(CLAUDE_SDK_STRIPPED_ENV_KEYS as readonly string[]),
      ...(CLAUDE_LAUNCHER_ENV_KEYS as readonly string[]),
    ];
    expect(inStripLists).not.toContain('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB');
  });

  it('strips every name in CLAUDE_SDK_STRIPPED_ENV_KEYS from the subprocess env, and only those', () => {
    // authentication.md puts CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY at the TOP
    // precedence tier: any of them ambient in the host shell would silently
    // outrank the connection the user configured. Table-driven over the
    // exported constant so this cannot drift from the production list; the
    // surviving AWS_REGION is the required positive control for the absence.
    // Since P3.113 the constant also carries
    // `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, which is not a provider
    // toggle but is reachable on exactly the arm we always run (firstParty
    // against a loopback ANTHROPIC_BASE_URL), so it must not survive here
    // either — iterating the union is what makes that automatic.
    const controlKey = 'AWS_REGION';
    const keys = [...CLAUDE_SDK_STRIPPED_ENV_KEYS, controlKey];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    for (const key of CLAUDE_SDK_STRIPPED_ENV_KEYS) process.env[key] = '1';
    process.env[controlKey] = 'eu-west-1';
    try {
      const env = buildClaudeSubprocessEnv();
      for (const key of CLAUDE_SDK_STRIPPED_ENV_KEYS) {
        expect({ key, present: key in env }).toEqual({ key, present: false });
      }
      // Generic AWS_* is deliberately NOT stripped.
      expect(env[controlKey]).toBe('eu-west-1');
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key]!;
      }
    }
  });

  it('wires the structured-output options into the chatImpl turn query (not just a unit)', () => {
    // The series' recurring defect is a helper tested in a unit that the turn
    // path never reaches. Pin the production wiring the way the pi runtime
    // tests pin theirs: the chatImpl options literal must spread the builder
    // with the ChatOptions outputSchema.
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    // The ChatOptions outputSchema is captured before the SDK options literal
    // (which shadows the parameter name) and spread into that literal.
    expect(source).toMatch(/const turnOutputSchema = options\?\.outputSchema/);
    expect(source).toMatch(/\.\.\.buildClaudeStructuredOutputOptions\(turnOutputSchema\)/);
  });

  it('carries maxBudgetUsd only when a ceiling is configured (P2.28)', () => {
    // `getMaxBudgetUsd` already collapses every "off" spelling to 0, so the
    // builder's whole job is the boundary: a positive number is the SDK's
    // ceiling, and 0 must produce NO KEY. Passing 0 would be a real ceiling to
    // the SDK — "the query will stop if this budget is exceeded" — i.e. every
    // uncapped session stopped on its first priced event.
    const cases: Array<{ cap: number; expected: Record<string, unknown> }> = [
      { cap: 2.5, expected: { maxBudgetUsd: 2.5 } },
      { cap: 0.01, expected: { maxBudgetUsd: 0.01 } },
      { cap: 0, expected: {} },
      { cap: -1, expected: {} },
      { cap: Number.NaN, expected: {} },
      { cap: Number.POSITIVE_INFINITY, expected: {} },
    ];
    for (const { cap, expected } of cases) {
      expect({ cap, options: buildClaudeMaxBudgetUsdOptions(cap) }).toEqual({ cap, options: expected });
    }
    // Absent, not `undefined` — the turn options stay byte-identical when off.
    expect('maxBudgetUsd' in buildClaudeMaxBudgetUsdOptions(0)).toBe(false);
  });

  it('wires the budget cap into the chatImpl turn query from the shared config reader (P2.28)', () => {
    // Same defect this file already guards for structured output: a helper
    // tested in a unit the turn path never reaches. The ceiling must come from
    // `BaseAgent.getMaxBudgetUsd()` — the same per-turn `loadConfigDefaults()`
    // read the host-side loop uses — not from a second config read of its own.
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/\.\.\.buildClaudeMaxBudgetUsdOptions\(this\.getMaxBudgetUsd\(\)\)/);
  });

  it('hashes maxBudgetUsd into the live-session signature — it has no setter (P2.28)', () => {
    // A construction option with no live setter must respawn when it drifts, or
    // a raised ceiling would never reach the running child while the host loop
    // re-reads it every turn. `Query` has no `setMaxBudgetUsd` (asserted
    // mechanically against sdk.d.ts in claude-live-settings.test.ts).
    const signatureOf = (fields: Record<string, unknown>): string =>
      claudeLiveSessionSignature({ cwd: '/tmp/ws', ...fields } as unknown as Parameters<typeof claudeLiveSessionSignature>[0]);
    expect(signatureOf({ maxBudgetUsd: 5 })).not.toBe(signatureOf({}));
    expect(signatureOf({ maxBudgetUsd: 9 })).not.toBe(signatureOf({ maxBudgetUsd: 5 }));
    // And an unchanged ceiling is not a drift.
    expect(signatureOf({ maxBudgetUsd: 5 })).toBe(signatureOf({ maxBudgetUsd: 5 }));
  });

  it('never passes a sandbox key to the Claude SDK (T1 contour d — verification, not change)', () => {
    // Claude's own SDK default is off (settings.md sandbox table: "Default:
    // false"). We must never set the key ourselves — the composed Options
    // literal built for the SDK `query()` call carries no `sandbox` property
    // anywhere in this file, so a future SDK default flip cannot silently
    // re-enable OS-level sandboxing outside T1's kill switch. The cheapest
    // durable pin: a source-scan, same seam as the wiring pin above.
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/[^a-zA-Z]sandbox\s*:/);
  });
});

/**
 * P6.839 — claude's own native `EnterWorktree` passes the host floor, once.
 *
 * The floor refuses when {@link PreToolUseInput.worktree} is absent, and it was
 * always absent on this runtime: `worktreeGateContext()` is provider-agnostic on
 * `base-agent.ts` and had one call site, in `pi-agent.ts`. So claude's own tool
 * was answered with *"this session has no repository to create or enter a
 * worktree in"* whether or not the session had one.
 *
 * The owner's decision (2026-09-10, balance rule) is option A MINUS
 * `bgIsolation`: supply the repository facts, and do not make the host a second
 * enforcer of the write block claude already applies from
 * `buildClaudeWorktreeSettings`.
 */
describe('claude worktree floor context (P6.839)', () => {
  it('carries the repository facts and DROPS the natively-enforced field', () => {
    expect(buildClaudeWorktreeFloorContext({
      worktree: { repoRoot: '/projects/app', bgIsolation: 'worktree' },
    })).toEqual({ worktree: { repoRoot: '/projects/app' } });

    // `insideWorktree` is a repository FACT and stays: inside a worktree the
    // floor scopes the target instead of prompting, and losing it would widen
    // the decision rather than narrow it.
    expect(buildClaudeWorktreeFloorContext({
      worktree: { repoRoot: '/projects/app', insideWorktree: true, bgIsolation: 'none' },
    })).toEqual({ worktree: { repoRoot: '/projects/app', insideWorktree: true } });

    // Absent as a KEY, not present-and-undefined: the context object is read by
    // a gate that tests for the field's presence.
    const stripped = buildClaudeWorktreeFloorContext({
      worktree: { repoRoot: '/projects/app', bgIsolation: 'worktree' },
    });
    expect('bgIsolation' in (stripped?.worktree ?? {})).toBe(false);
  });

  it('stays undefined when the session has no repository, so the floor still fails closed', () => {
    // THE NEGATIVE. A session with no project must keep refusing `EnterWorktree`
    // — this row makes the refusal true, it does not remove it.
    expect(buildClaudeWorktreeFloorContext(undefined)).toBeUndefined();
    expect(buildClaudeWorktreeFloorContext({ worktree: undefined })).toBeUndefined();
  });

  it('wires it into the canUseTool gate context, and never the pi-shaped raw spread', () => {
    // The recurring defect this file guards for: a builder tested in a unit the
    // production path never reaches. The gate context is built inline inside
    // `chatImpl`'s `canUseTool`, so the wiring is pinned on the source.
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/\.\.\.\(buildClaudeWorktreeFloorContext\(this\.worktreeGateContext\(\)\) \?\? \{\}\)/);
    // And the shape that would double-enforce `bgIsolation` — the raw spread
    // `pi-agent.ts` uses — must not appear on this runtime.
    expect(source).not.toMatch(/\.\.\.\(this\.worktreeGateContext\(\) \?\? \{\}\)/);
  });
});
