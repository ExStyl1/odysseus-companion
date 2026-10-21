/**
 * P6.160 — an agent pinned to `opus` on a claude-runtime connection resolves,
 * instead of being substituted and warned at.
 *
 * `buildAgentModelPolicy` builds `servedModels` from the connection's catalogue
 * IDS, so an alias can never be a member of it, and `resolvedModelField`
 * therefore dropped every alias-declaring agent with a warning — correct as a
 * failure mode (measured live 2026-08-14, Q6-LIVE claim 3: the SDK child died
 * with "model not available") and unnecessary as an outcome.
 *
 * Native mechanism, asked and answered — CONFIGURE, not build.
 * `model-config.md#environment-variables`, verbatim: "`ANTHROPIC_DEFAULT_OPUS_MODEL`
 * | The model to use for `opus`, or for `opusplan` when Plan Mode is active."
 * All four names are in the binary we ship (OPUS 23, SONNET 18, FABLE 14,
 * HAIKU 18; `ANTHROPIC_API_KEY` 105 positive control, `ZZZ_FAKE_CONTROL` 0
 * negative), while `git grep` over `packages`/`apps` scored the first three at
 * 0 hits INCLUDING tests, with HAIKU's 11 as the same-family control.
 *
 * Mapped to the SESSION model — the value `resolvedModelField` was already
 * substituting — so behaviour is preserved by construction and no owner call
 * arises. REFUSED: mapping onto "the catalogue's coder model", which would
 * change which model a pinned agent talks to (the test that made P2.318 an
 * owner call).
 */
import { describe, expect, it } from 'bun:test';
import {
  buildClaudeRuntimeAliasModelEnv,
  buildClaudeRuntimeAliasModels,
} from '../claude-agent.ts';
import {
  buildClaudeRuntimeAgents,
  CLAUDE_SDK_MODEL_ALIASES,
} from '../claude-runtime-agents.ts';
import type { PiRuntimeAgentDefinitionDescriptor } from '../pi-harness/runtime-agent-definition.ts';

const SESSION_MODEL = 'tgpt/qwen35-397b-a17b-fp8';
const MINI_MODEL = 'tgpt/qwen35-fast-fp8';

/** Mirrors `claude-runtime-agents.test.ts`'s own helper, `schemaVersion` included. */
function descriptor(model: string): PiRuntimeAgentDefinitionDescriptor {
  return {
    schemaVersion: 2,
    key: 'agent.sec',
    name: 'sec',
    description: 'security reviewer',
    selectedAsUnqualifiedAlias: true,
    systemPrompt: 'You are a reviewer.',
    sha256: 'deadbeef',
    provenance: 'agent.sec@gen-1',
    capabilityGeneration: 'gen-1',
    definitionDigest: 'digest-1',
    model,
  };
}

describe('buildClaudeRuntimeAliasModels', () => {
  it('maps opus, sonnet and fable onto the session model, and haiku onto the mini model', () => {
    const map = buildClaudeRuntimeAliasModels({
      sessionModel: SESSION_MODEL,
      miniModel: MINI_MODEL,
      servedModels: [SESSION_MODEL, MINI_MODEL],
    });
    expect(map).toEqual({
      opus: SESSION_MODEL,
      sonnet: SESSION_MODEL,
      fable: SESSION_MODEL,
      haiku: MINI_MODEL,
    });
    // Totality against the SDK's own alias list, so a fifth alias cannot be
    // added upstream and silently go unmapped here.
    for (const alias of CLAUDE_SDK_MODEL_ALIASES) expect(map[alias]).toBeTruthy();
  });

  it('maps nothing when the session model is not in the connection catalogue', () => {
    // The no-mapping arm the row calls for. There is no id we can honestly
    // promise the endpoint serves, so the substitution and its warning stay.
    const map = buildClaudeRuntimeAliasModels({
      sessionModel: 'tgpt/some-stale-id',
      miniModel: undefined,
      servedModels: [SESSION_MODEL],
    });
    expect(map).toEqual({});
    expect(buildClaudeRuntimeAliasModelEnv(map)).toEqual({});
  });

  it('keeps haiku out of the ENV while keeping it in the MAP', () => {
    // Both spawn paths already write ANTHROPIC_DEFAULT_HAIKU_MODEL from the
    // mini model. Writing it twice from two resolutions is how one of them
    // silently wins — but an agent declaring `haiku` must still be admitted,
    // which is why the map carries it and the env does not.
    const map = buildClaudeRuntimeAliasModels({
      sessionModel: SESSION_MODEL,
      miniModel: MINI_MODEL,
      servedModels: [SESSION_MODEL, MINI_MODEL],
    });
    const env = buildClaudeRuntimeAliasModelEnv(map);
    expect(map.haiku).toBe(MINI_MODEL);
    expect(env).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: SESSION_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: SESSION_MODEL,
      ANTHROPIC_DEFAULT_FABLE_MODEL: SESSION_MODEL,
    });
    expect('ANTHROPIC_DEFAULT_HAIKU_MODEL' in env).toBe(false);
  });
});

describe('the alias admission in resolvedModelField', () => {
  it('registers an opus-pinned agent as "opus", with no substitution warning', () => {
    const heard: string[] = [];
    const agents = buildClaudeRuntimeAgents([descriptor('opus')], {
      servedModels: [SESSION_MODEL],
      sessionModel: SESSION_MODEL,
      aliasModels: { opus: SESSION_MODEL, sonnet: SESSION_MODEL, fable: SESSION_MODEL },
      onDiagnostic: (message) => heard.push(message),
    });
    expect(agents.sec?.model).toBe('opus');
    expect(heard).toEqual([]);
  });

  it('still substitutes and still warns when the alias was never seeded', () => {
    // The negative, and it is the arm that keeps this safe: an alias with no
    // ANTHROPIC_DEFAULT_*_MODEL behind it would reach the child and resolve to
    // the binary's own default, which on a gateway is an unserved model.
    const heard: string[] = [];
    const agents = buildClaudeRuntimeAgents([descriptor('opus')], {
      servedModels: [SESSION_MODEL],
      sessionModel: SESSION_MODEL,
      onDiagnostic: (message) => heard.push(message),
    });
    expect('model' in (agents.sec ?? {})).toBe(false);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain('"opus"');
    expect(heard[0]).toContain(SESSION_MODEL);
  });

  it('does not admit an alias the map does not carry', () => {
    // `sonnet` seeded, `fable` not: the admission is per-alias rather than
    // "any of the four", so a partially-seeded map cannot let one through.
    const heard: string[] = [];
    const agents = buildClaudeRuntimeAgents([descriptor('fable')], {
      servedModels: [SESSION_MODEL],
      sessionModel: SESSION_MODEL,
      aliasModels: { sonnet: SESSION_MODEL },
      onDiagnostic: (message) => heard.push(message),
    });
    expect('model' in (agents.sec ?? {})).toBe(false);
    expect(heard).toHaveLength(1);
  });

  it('leaves a real served id and the no-policy pass-through untouched', () => {
    // Two pre-existing behaviours this row must not have moved: a catalogue id
    // is kept silently, and with no policy at all (the direct anthropic
    // contract) an alias passes through because the SDK resolves it itself.
    const heard: string[] = [];
    const served = buildClaudeRuntimeAgents([descriptor(SESSION_MODEL)], {
      servedModels: [SESSION_MODEL],
      sessionModel: SESSION_MODEL,
      aliasModels: { opus: SESSION_MODEL },
      onDiagnostic: (message) => heard.push(message),
    });
    expect(served.sec?.model).toBe(SESSION_MODEL);
    expect(heard).toEqual([]);
    expect(buildClaudeRuntimeAgents([descriptor('opus')]).sec?.model).toBe('opus');
  });
});
