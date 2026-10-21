/**
 * P3.226 — thinking `off` reaches codex as its own `none`, not as `minimal`.
 *
 * Read at `openai/codex` @ `rust-v0.148.0`: `ReasoningEffort` declares `None`
 * first (`protocol/src/openai_models.rs:45`) and `as_str` spells it `"none"`
 * (`:62`), so the level exists and is first-class. We mapped `off -> 'minimal'`,
 * which is a real level three of the other five map to distinctly, so the config
 * file said a user had chosen minimal reasoning when they had chosen none.
 *
 * ## The row's cost claim is refuted, and the change is made anyway
 *
 * The row said a user who turned thinking off "is still billed for minimal
 * reasoning on every codex turn". That does not survive measurement: codex puts
 * the effort into the Responses body it sends to our loopback adapter, and every
 * codex upstream this fork has goes through `to-chat.ts::toChatRequest`, whose
 * `ChatRequest` carries no reasoning member at all (positive control:
 * `max_output_tokens` IS carried, as `max_tokens`); the third upstream kind,
 * `anthropic-messages`, is refused for codex bodies by `postChat`. So the effort
 * reaches no model and no bill moves.
 *
 * What does move is what the config, codex's own turn telemetry, and every agent
 * role file say the user asked for. That is the reason recorded on the map.
 *
 * ## Why `"none"` cannot be rejected
 *
 * `config_toml.rs` types the key as `Option<ReasoningEffort>` whose `FromStr` is
 * total but for the empty string, and the release schema types it as an open
 * string (`minLength: 1`, no `enum`). The membership check in
 * `validateConfigAgainstSchema` is therefore a no-op today and is exercised
 * below so it stays honest if upstream ever closes the enum.
 */
import { describe, expect, test } from 'bun:test';
import { buildCodexAgentRoles, buildCodexConfigToml, validateConfigAgainstSchema } from '../config-writer.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json');

const BASE = {
  codexHome: '/tmp/p3226',
  model: 'tgpt/qwen35-397b-a17b-fp8',
  adapterPort: 54321,
} as const;

describe('P3.226 · thinking off maps to codex `none`', () => {
  test('off emits `model_reasoning_effort = "none"`', () => {
    expect(buildCodexConfigToml({ ...BASE, thinkingLevel: 'off' }))
      .toContain('model_reasoning_effort = "none"');
  });

  test('`minimal` is no longer produced by any of the six levels', () => {
    const levels = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
    const efforts = levels.map(level => {
      const line = buildCodexConfigToml({ ...BASE, thinkingLevel: level })
        .split('\n')
        .find(l => l.startsWith('model_reasoning_effort = '));
      return line?.slice('model_reasoning_effort = '.length);
    });
    expect(efforts).toEqual(['"none"', '"low"', '"medium"', '"high"', '"xhigh"', '"max"']);
    // Six distinct levels in, six distinct levels out — the property the
    // `xhigh`/`max` widen established and this row must not break.
    expect(new Set(efforts).size).toBe(6);
  });

  test('the agent role files read the SAME table — one map, two emitters', () => {
    const plan = buildCodexAgentRoles({
      codexHome: BASE.codexHome,
      sessionModel: BASE.model,
      sessionMode: 'default',
      definitions: [{
        key: 'plugin:x:reviewer',
        name: 'reviewer',
        selectedAsUnqualifiedAlias: true,
        description: 'reviews',
        systemPrompt: 'review it',
        effort: 'off',
      }],
    });
    expect(plan.roles[0]!.configFileToml).toContain('model_reasoning_effort = "none"');
    expect(plan.roles[0]!.configFileToml).not.toContain('minimal');
  });

  test('the schema guard accepts it (the enum is open upstream, and the check still runs)', () => {
    expect(() => validateConfigAgainstSchema({ ...BASE, thinkingLevel: 'off' }, SCHEMA)).not.toThrow();
  });
});
