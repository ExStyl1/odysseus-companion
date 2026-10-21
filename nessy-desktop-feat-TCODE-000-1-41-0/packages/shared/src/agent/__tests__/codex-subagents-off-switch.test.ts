/**
 * C3.109 (QH3, owner answer A, 2026-09-11; ledger H33) — codex's OWN delegation
 * off-switch gets the host setting it never had.
 *
 * ## What was and was not missing
 *
 * The mechanism was built and PROVEN INERT on purpose:
 * `CodexConfigOptions.subagentsEnabled` writes `enabled = false` first among the
 * bare `[agents]` keys, its writer tests exist, and its docblock says in its own
 * words that *"its caller does not exist yet"* — nothing minted a host setting,
 * so an operator had no way to say `false` short of hand-editing a config file
 * this product regenerates per session into a temp directory.
 *
 * This row is that caller: one key at the four sites the `codexAutoReview*` pair
 * already occupies, one reader, one line in `CodexAgent`.
 *
 * ## The conditionality is QUOTED, not assumed
 *
 * codex's own schema says what this switch can and cannot do:
 * *"Whether multi-agent tools are enabled. Defaults to true. An enabled
 * `features.multi_agent_v2` setting takes precedence."* The second sentence is
 * the limit the host inherits and cannot remove, so it is read out of the
 * shipped schema here rather than restated from memory — the day upstream
 * reverses that precedence, this fails.
 *
 * ## The default changes nothing, and that is the point
 *
 * It ships `true`, which is codex's own default, and the writer honours ONLY an
 * explicit `false`. So an operator who never touches the key gets a
 * byte-identical `config.toml`; what the key buys is the ability to say no.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCodexConfigToml } from '@nessy-agent/codex-responses-adapter/config-writer';

const HERE = import.meta.dir;
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');
const SCHEMA = join(REPO_ROOT, 'packages', 'codex-protocol', 'schema', 'config-schema.json');
const DEFAULTS_JSON = join(REPO_ROOT, 'apps', 'electron', 'resources', 'config-defaults.json');

const BASE = {
  codexHome: '/tmp/w16g-agents',
  model: 'w16g-model',
  adapterPort: 1,
  deniedReadPaths: ['/private/nessy/credentials.enc'],
} as const;

describe('C3.109 — the codex delegation off-switch', () => {
  /**
   * Scoped to the `[agents]` block on purpose. A bare
   * `not.toContain('enabled = false')` over the whole file is satisfied by
   * `[analytics]`, which carries that exact line — measured here, and it made
   * the first draft of this case red against correct output.
   */
  const agentsBlock = (toml: string): string => {
    const start = toml.indexOf('[agents]');
    if (start < 0) return '';
    const next = toml.indexOf('\n[', start + 1);
    return next < 0 ? toml.slice(start) : toml.slice(start, next);
  };

  it('writes `[agents] enabled = false` for an explicit false, and nothing otherwise', () => {
    const off = buildCodexConfigToml({ ...BASE, subagentsEnabled: false });
    expect(agentsBlock(off)).toContain('enabled = false');

    // The two arms that must stay byte-identical to a config with no opinion:
    // `true` restates codex's default and buys nothing, and `undefined` is every
    // operator who has not touched the key.
    const unset = buildCodexConfigToml({ ...BASE });
    expect(buildCodexConfigToml({ ...BASE, subagentsEnabled: true })).toEqual(unset);
    expect(agentsBlock(unset)).toBe('');
  });

  it('the shipped default is TRUE, so today\'s behaviour is unchanged', () => {
    // Read from the shipped asset rather than from the fallback, because the
    // asset is what an installed app loads and the three-site rule exists
    // precisely because those two have drifted before.
    const defaults = JSON.parse(readFileSync(DEFAULTS_JSON, 'utf8')) as {
      defaults: Record<string, unknown>;
    };
    expect(defaults.defaults.codexSubagentsEnabled).toBe(true);
    // Positive control on the same read: its neighbour is still there, so a
    // renamed/emptied block cannot satisfy the assertion above.
    expect(defaults.defaults.codexAutoReviewEnabled).toBe(false);
  });

  it('QUOTES codex\'s own precedence sentence, so the conditionality is pinned', () => {
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as {
      definitions: { AgentsToml: { properties: { enabled: { description: string } } } };
    };
    expect(schema.definitions.AgentsToml.properties.enabled.description).toBe(
      'Whether multi-agent tools are enabled. Defaults to true. An enabled `features.multi_agent_v2` setting takes precedence.',
    );
  });

  it('is WIRED: CodexAgent passes the reader to the writer', () => {
    // The caller is the whole row — the mechanism already existed — so the one
    // mutation that matters is deleting the call, and only the source can see it.
    const source = readFileSync(join(HERE, '..', 'codex-agent.ts'), 'utf8');
    expect(source).toContain('subagentsEnabled: getCodexSubagentsEnabled()');
    expect(source).toContain('getCodexSubagentsEnabled');
  });
});
