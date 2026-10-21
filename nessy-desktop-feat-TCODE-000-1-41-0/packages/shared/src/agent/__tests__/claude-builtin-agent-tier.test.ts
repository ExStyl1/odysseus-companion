/**
 * P6.154 — a bundled agent's TIER, mapped onto the SDK's own model field.
 *
 * `scout` declares the `small` tier. On Pi that tier resolves to the gateway's
 * cheap model (`SessionManager`, T1: `resolveGatewayFastModelId(connection)`,
 * `const tierModelMap = fastModelId ? { small: fastModelId } : undefined`). On
 * claude the tier was dropped entirely, so a read-only scout burned the
 * flagship on every delegation.
 *
 * Native mechanism, asked and answered — CONFIGURE, not build: the SDK's own
 * `AgentDefinition.model` (`sdk.d.ts:55-58`, "Model alias (e.g. 'fable',
 * 'opus', 'sonnet', 'haiku') or full model ID"), already used for imported
 * agents and simply never handed the builtins' tier. Nothing is invented: the
 * id comes from `resolveGatewayFastModelId`, which matches the gateway's own
 * `fast` alias, checks it against the managed allowlist, and answers
 * `undefined` for a catalogue with none — so no branch can pin an unserved
 * model, which was the whole objection recorded in the file's old docblock.
 *
 * REJECTED as the mechanism: `CLAUDE_CODE_SUBAGENT_MODEL` — one model for every
 * delegated child, so it cannot express three tiers. Both spellings are held
 * UNSET in every arm here, because a set variable would decide the assertion
 * instead of the code under test; the version hazard that makes it dangerous on
 * the bundle we ship is pinned in `config/subagent-model.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { i18n, setupI18n } from '../../i18n/index.ts';
import {
  buildClaudeRuntimeBuiltinAgents,
  claudeBuiltinAgentTierDiagnostics,
  buildClaudeRuntimeAgents,
} from '../claude-runtime-agents.ts';
import { BUILTIN_AGENT_DEFINITIONS } from '../../agents/definitions.ts';
import {
  SUBAGENT_MODEL_ENV_VAR,
  SUBAGENT_MODEL_COMPAT_ENV_VAR,
} from '../../config/subagent-model.ts';

const FAST_ID = 'tgpt/qwen35-fast-fp8';

/** Every bundled agent whose tier the host can resolve today. */
const SMALL_TIER_NAMES = BUILTIN_AGENT_DEFINITIONS
  .filter((definition) => definition.tier === 'small')
  .map((definition) => definition.name);

let savedNessy: string | undefined;
let savedClaude: string | undefined;

beforeEach(() => {
  savedNessy = process.env[SUBAGENT_MODEL_ENV_VAR];
  savedClaude = process.env[SUBAGENT_MODEL_COMPAT_ENV_VAR];
  // `delete` before any assignment, both here and on restore: assigning to a
  // name Bun pre-creates a slot for leaves it readable by property and INVISIBLE
  // to a spread, and every subprocess env in this tree is built by spreading.
  delete process.env[SUBAGENT_MODEL_ENV_VAR];
  delete process.env[SUBAGENT_MODEL_COMPAT_ENV_VAR];
});

afterEach(() => {
  delete process.env[SUBAGENT_MODEL_ENV_VAR];
  delete process.env[SUBAGENT_MODEL_COMPAT_ENV_VAR];
  if (savedNessy !== undefined) process.env[SUBAGENT_MODEL_ENV_VAR] = savedNessy;
  if (savedClaude !== undefined) process.env[SUBAGENT_MODEL_COMPAT_ENV_VAR] = savedClaude;
});

/**
 * ENGLISH IS PINNED, and awaited, because this suite asserts English copy.
 *
 * The i18n instance is a module-scope SINGLETON shared by every file in a
 * `bun test` process, and sibling suites in this very directory switch it to
 * `ru` on purpose (`base-agent-budget-i18n.test.ts`, whose own docblock records
 * that an un-awaited restore once cost CI eight unrelated reds). This file
 * passed ALONE and failed in the whole-repo run on CI job 630520568, receiving
 * Russian where it expected English — a contamination no per-package split of
 * the job can fix, since the amputator and the victim are siblings.
 *
 * Pinning on the VICTIM rather than chasing the amputator is deliberate: it is
 * one awaited line, it holds against any future suite that switches the
 * language, and it cannot be defeated by hook-ordering between files.
 */
beforeAll(async () => {
  if (!i18n.isInitialized) setupI18n();
  await i18n.changeLanguage('en');
});

describe('buildClaudeRuntimeBuiltinAgents — the tier arm', () => {
  it('registers scout on the resolved fast model when the catalogue published the alias', () => {
    expect(SMALL_TIER_NAMES).toContain('scout');
    const agents = buildClaudeRuntimeBuiltinAgents({ small: FAST_ID });
    for (const name of SMALL_TIER_NAMES) {
      expect(agents[name]?.model).toBe(FAST_ID);
    }
  });

  it('registers scout with NO model when the connection publishes no alias', () => {
    // The absent-alias arm, and `undefined` rather than a guessed id is the
    // whole point: the SDK parses the `agents` record through one `z.record`
    // whose catch returns [], so an unserved model would not degrade one agent,
    // it would delete all of them.
    const agents = buildClaudeRuntimeBuiltinAgents();
    for (const name of SMALL_TIER_NAMES) {
      expect(agents[name]).toBeDefined();
      expect(agents[name]?.model).toBeUndefined();
      expect('model' in (agents[name] ?? {})).toBe(false);
    }
  });

  it('leaves medium and big unmapped, because Pi leaves them unmapped too', () => {
    // Parity, not residue. Pi's own map is `{ small: fastModelId }` or nothing,
    // so those two tiers run on the session model on BOTH runtimes. Copying the
    // shape includes copying what it does not say.
    const agents = buildClaudeRuntimeBuiltinAgents({ small: FAST_ID });
    const others = BUILTIN_AGENT_DEFINITIONS.filter((d) => d.tier !== 'small');
    expect(others.length).toBeGreaterThan(0);
    for (const definition of others) {
      expect(agents[definition.name]?.model).toBeUndefined();
    }
  });

  it('keeps every other translated field exactly as it was', () => {
    // The tier arm must not be a rewrite of the builder: description, prompt and
    // the SDK tool spellings are asserted identical with and without the map.
    const withTier = buildClaudeRuntimeBuiltinAgents({ small: FAST_ID });
    const without = buildClaudeRuntimeBuiltinAgents();
    for (const definition of BUILTIN_AGENT_DEFINITIONS) {
      const a = withTier[definition.name]!;
      const b = without[definition.name]!;
      expect(a.description).toBe(b.description);
      expect(a.prompt).toBe(b.prompt);
      expect(a.tools).toEqual(b.tools);
    }
  });
});

describe('claudeBuiltinAgentTierDiagnostics', () => {
  /**
   * P6.156 WIDENED THE SCOPE OF THIS FUNCTION AND THE TWO ARMS BELOW SAY SO.
   *
   * P6.154 landed it scoped to the `small` tier, so `{ small: FAST_ID }` alone
   * silenced it. That scope answered the DIVERGENCE question and left the
   * capability question unanswered: nothing resolves `medium` or `big` on any of
   * the three runtimes, so a user asking why `worker` is not on a bigger model
   * was told nothing at all. The line now names every bundled agent whose tier
   * resolved to no distinct model, and states the uniformity in itself so it can
   * still never be read as a per-runtime loss. Its GRADE is untouched — the log
   * channel, latched once a session, never the banner — which is the half of
   * P6.154's decision that rested on a measurement.
   */
  it('says nothing when EVERY tier resolves', () => {
    expect(claudeBuiltinAgentTierDiagnostics({
      small: FAST_ID, medium: 'tgpt/mid', big: 'tgpt/big',
    })).toEqual([]);
  });

  it('announces the inert tiers once, naming every affected agent', () => {
    const lines = claudeBuiltinAgentTierDiagnostics();
    expect(lines).toHaveLength(1);
    for (const definition of BUILTIN_AGENT_DEFINITIONS) {
      expect(lines[0]).toContain(definition.name);
    }
    for (const tier of ['small', 'medium', 'big']) expect(lines[0]).toContain(tier);
    // It must NOT claim a difference between runtimes: the tier map is a
    // property of the CONNECTION, so all three land on the session model in the
    // same arm, and a divergence claim here would be a line that cries wolf.
    expect(lines[0]).toContain('the same on Pi, Claude and Codex');
  });

  it('a resolved tier drops OUT of the line while the unresolved ones stay', () => {
    const lines = claudeBuiltinAgentTierDiagnostics({ small: FAST_ID });
    expect(lines).toHaveLength(1);
    for (const name of SMALL_TIER_NAMES) expect(lines[0]).not.toContain(name);
    expect(lines[0]).not.toContain('small');
    const stillInert = BUILTIN_AGENT_DEFINITIONS.filter(d => d.tier !== 'small');
    expect(stillInert.length).toBeGreaterThan(0);
    for (const definition of stillInert) expect(lines[0]).toContain(definition.name);
  });

  it('reaches the session on its OWN channel, never the banner', () => {
    // `definitions: []` is the "this runtime dispatches definitions and the user
    // authored none" case, where the builtins are exactly what Pi would have.
    //
    // The two sinks are asserted SEPARATELY, and that is the point of the row's
    // one refutation: routed to `onDiagnostic` — the user-visible banner — this
    // line fired on every connection without a `fast` alias and broke seven
    // existing assertions, one of them named "THE CONTROL — a turn with nothing
    // degraded yields no banner at all". Pi drops the same tier in the same arm
    // silently, so a banner here would manufacture a divergence rather than
    // close one.
    const banner: string[] = [];
    const tier: string[] = [];
    const agents = buildClaudeRuntimeAgents([], {
      servedModels: ['tgpt/big'],
      sessionModel: 'tgpt/big',
      onDiagnostic: (message) => banner.push(message),
      onTierNotice: (message) => tier.push(message),
    });
    expect(agents['scout']?.model).toBeUndefined();
    expect(tier.some((line) => line.includes('scout'))).toBe(true);
    expect(banner).toEqual([]);
  });

  it('says nothing when the runtime dispatches no definitions at all', () => {
    // `undefined` definitions means no builtins were seeded, so there is no
    // dropped tier to announce — the negative that keeps the banner honest.
    const seen: string[] = [];
    const agents = buildClaudeRuntimeAgents(undefined, {
      servedModels: ['tgpt/big'],
      sessionModel: 'tgpt/big',
      onDiagnostic: (message) => seen.push(message),
      onTierNotice: (message) => seen.push(message),
    });
    expect(agents['scout']).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('resolves the tier end to end through the builder', () => {
    const banner: string[] = [];
    const tier: string[] = [];
    const agents = buildClaudeRuntimeAgents([], {
      servedModels: ['tgpt/big', FAST_ID],
      sessionModel: 'tgpt/big',
      tierModelMap: { small: FAST_ID },
      onDiagnostic: (message) => banner.push(message),
      onTierNotice: (message) => tier.push(message),
    });
    expect(agents['scout']?.model).toBe(FAST_ID);
    // The banner stays empty — the grade P6.154 measured is untouched.
    expect(banner).toEqual([]);
    // P6.156: `small` resolved, so `scout` is out of the line; `medium` and
    // `big` resolve on no runtime, so the other three are still named. Under
    // P6.154's narrower scope this arm expected silence, which said nothing
    // about the two tiers that never resolve anywhere.
    expect(tier).toHaveLength(1);
    expect(tier[0]).not.toContain('scout');
    expect(tier[0]).toContain('worker');
  });

  it('every tier resolved end to end — the negative control, no line at all', () => {
    const seen: string[] = [];
    const agents = buildClaudeRuntimeAgents([], {
      servedModels: ['tgpt/big', 'tgpt/mid', FAST_ID],
      sessionModel: 'tgpt/big',
      tierModelMap: { small: FAST_ID, medium: 'tgpt/mid', big: 'tgpt/big' },
      onDiagnostic: (message) => seen.push(message),
      onTierNotice: (message) => seen.push(message),
    });
    expect(agents['scout']?.model).toBe(FAST_ID);
    expect(agents['worker']?.model).toBe('tgpt/big');
    expect(seen).toEqual([]);
  });
});
