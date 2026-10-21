/**
 * P6.594 — codex's own implicit-invocation spelling gets a reader.
 *
 * `allow_implicit_invocation: false` in a bundled skill's
 * `agents/openai.yaml` reached NOTHING before this: `git grep -ain
 * allow_implicit_invocation -- packages apps` → 0 at HEAD, because the codex
 * adapter's skill scan reads only `SKILL.md` and its root `agents/` scan reads
 * only `*.md`.
 *
 * The mapping target already has readers: `buildSkillListingPart`
 * (`agent/core/prompt-builder.ts`) filters `disableModelInvocation !== true`
 * out of the model's listing, and `BaseAgent` refuses a model-origin dispatch
 * against it — which is why W7-t's hand-off says this closes with no further
 * change.
 *
 * Contract, `plugins/deploy/submission-errors.md` § *Skill agent metadata
 * errors* — the closest thing codex publishes to a schema:
 *
 *   `skill_agent_allow_implicit_invocation_wrong_type` — "`policy` may contain
 *   only `products` and `allow_implicit_invocation`. `products` must contain
 *   `CHAT`, `CODEX`, or both, and `allow_implicit_invocation` must be `true` or
 *   `false`."
 *
 * and the location, same section: "A bundled skill can define its own
 * `interface` in `skills/<skill>/agents/openai.yaml`."
 *
 * EVIDENCE TIER: STRONG, and this is a correction to W7-t's hand-off, which had
 * only the page. `apps/electron/resources/bin/codex/darwin-arm64/
 * codex-app-server` carries the name 13 times, including a validator that
 * emits "`policy.allow_implicit_invocation` must be a boolean" — which is the
 * refusal the fourth test below asserts — and its own bundled `skill-creator`
 * skill, stating the semantics verbatim:
 *
 *   "Automatic skill selection is allowed by default. Change that default only
 *   when the user explicitly requests an explicit-only skill: … This keeps the
 *   skill available when explicitly invoked as `$skill-name` without adding it
 *   to the model context automatically."
 *
 * Out of the model context, still dispatchable by name, is exactly what
 * `disableModelInvocation` means here — and the permissive DEFAULT in that same
 * sentence is why only the restrictive direction is mapped.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// `format-adapters.ts` FIRST — entering the adapter graph through
// `format-adapters/codex.ts` trips a pre-existing import cycle (recorded in
// `codex-contract-fields.test.ts`).
import { normalizePluginBundle } from '../format-adapters.ts';
import type { PluginOrigin, PluginSkillCapability } from '../types.ts';

const ORIGIN: PluginOrigin = { source: 'local-path', resolvedAt: 0 };

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

interface Fixture {
  /** Contents of `agents/openai.yaml` beside the skill, or omitted for none. */
  agentYaml?: string;
  /** Extra `SKILL.md` frontmatter lines. */
  frontmatter?: string[];
}

async function skillCapability(fixture: Fixture): Promise<{
  capability: PluginSkillCapability | undefined;
  warnings: string[];
}> {
  const root = mkdtempSync(join(tmpdir(), 'codex-skill-agent-policy-'));
  created.push(root);
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'skill-policy', version: '1.0.0', description: 'Fixture.' }),
  );
  const skillDir = join(root, 'skills', 'summarize');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), [
    '---',
    'name: summarize',
    'description: Summarize a document.',
    ...(fixture.frontmatter ?? []),
    '---',
    '',
    'Body.',
  ].join('\n'));
  if (fixture.agentYaml !== undefined) {
    mkdirSync(join(skillDir, 'agents'), { recursive: true });
    writeFileSync(join(skillDir, 'agents', 'openai.yaml'), fixture.agentYaml);
  }
  const result = await normalizePluginBundle(root, ORIGIN);
  expect(result.ok).toBe(true);
  return {
    capability: result.value?.capabilities.find(
      (capability): capability is PluginSkillCapability => capability.kind === 'skill',
    ),
    warnings: (result.diagnostics ?? []).map(diagnostic => diagnostic.message),
  };
}

describe('codex skill agents/openai.yaml policy', () => {
  it('POSITIVE — allow_implicit_invocation: false keeps the skill out of the model listing', async () => {
    const { capability } = await skillCapability({
      agentYaml: [
        'interface:',
        '  display_name: "Summarize documents"',
        '  short_description: "Summarize a document"',
        'policy:',
        '  products: [CODEX]',
        '  allow_implicit_invocation: false',
        '',
      ].join('\n'),
    });

    expect(capability?.skill.slug).toBe('summarize');
    expect(capability?.skill.disableModelInvocation).toBe(true);
  });

  it('NEGATIVE — allow_implicit_invocation: true sets nothing, and neither does an absent file', async () => {
    const allowed = await skillCapability({
      agentYaml: 'policy:\n  allow_implicit_invocation: true\n',
    });
    expect(allowed.capability?.skill.disableModelInvocation).toBeUndefined();

    // The control that proves the fixture rig is not simply failing to build a
    // skill: same bundle, no yaml at all, same shape.
    const none = await skillCapability({});
    expect(none.capability?.skill.slug).toBe('summarize');
    expect(none.capability?.skill.disableModelInvocation).toBeUndefined();
  });

  it('never WIDENS what the skill\'s own frontmatter narrowed', async () => {
    // `disable-model-invocation: true` in SKILL.md with codex's default
    // (`allow_implicit_invocation: true`) beside it: the restriction stands.
    // Only the restrictive direction is mapped, so codex's permissive default
    // can never silently undo the author's own control.
    const { capability } = await skillCapability({
      frontmatter: ['disable-model-invocation: true'],
      agentYaml: 'policy:\n  allow_implicit_invocation: true\n',
    });

    expect(capability?.skill.disableModelInvocation).toBe(true);
  });

  it('refuses a non-boolean rather than guessing, and says which file', async () => {
    // `skill_agent_allow_implicit_invocation_wrong_type` — "must be `true` or
    // `false`". A quoted "false" is a string; coercing it would be inventing.
    const { capability, warnings } = await skillCapability({
      agentYaml: 'policy:\n  allow_implicit_invocation: "false"\n',
    });

    expect(capability?.skill.disableModelInvocation).toBeUndefined();
    expect(warnings.some(message => message.includes('openai.yaml'))).toBe(true);
  });

  it('ignores malformed YAML with a warning instead of failing the bundle', async () => {
    const { capability, warnings } = await skillCapability({
      agentYaml: 'policy:\n  - allow_implicit_invocation: false\n   bad indent: [\n',
    });

    expect(capability?.skill.slug).toBe('summarize');
    expect(capability?.skill.disableModelInvocation).toBeUndefined();
    expect(warnings.some(message => message.includes('openai.yaml'))).toBe(true);
  });
});
