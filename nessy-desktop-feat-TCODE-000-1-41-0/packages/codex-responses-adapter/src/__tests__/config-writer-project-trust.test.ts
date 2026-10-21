/**
 * P6.540 — the host's `projectTrusted` decision, projected onto codex's own
 * `trust_level`, so a repository's checked-in `.codex/` layer can load at all.
 *
 * Every expectation is anchored to the SOURCE rather than to a page. The
 * anchor was taken at `rust-v0.148.0` and is RE-TAKEN at `rust-v0.154.0`
 * (I2.27, 2026-09-17) — which is also the correction of a sentence that had
 * gone false here: this said `rust-v0.148.0` was *"the tag
 * `packages/codex-protocol/manifest.json` pins"*, and two lifts later that
 * manifest pins `rust-v0.154.0`. A stamp that names the manifest ages the
 * moment the manifest moves, so the stamp is now a date and a tag rather than
 * a claim about another file. The gate below is unchanged at the new tag —
 * `disabled_reason_for_decision` still withholds exactly *"project-local
 * config, hooks, and exec policies"*, and `ProjectTrustDecision::is_trusted`
 * is still `matches!(self.trust_level, Some(TrustLevel::Trusted))`, so an
 * ABSENT `[projects]` entry is still not-trusted rather than untrusted:
 *
 * - the shape is `config/src/config_toml.rs`'s
 *   `pub projects: Option<HashMap<String, ProjectConfig>>` over
 *   `ProjectConfig { trust_level: Option<TrustLevel> }`, mirrored in the pinned
 *   `config-schema.json` (`additionalProperties: false`, `TrustLevel` an enum of
 *   `trusted` / `untrusted`);
 * - the GATE is `config/src/loader/mod.rs`'s `disabled_reason_for_decision`,
 *   which withholds *"project-local config, hooks, and exec policies"* from any
 *   project that is not `is_trusted()`;
 * - the KEY is a path: `project_trust_context` reads `projects` off the merged
 *   USER config — which is the `CODEX_HOME/config.toml` this writer produces —
 *   and looks up the cwd, then the project root, then the git repo root through
 *   `normalized_project_trust_keys`.
 */
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCodexConfigToml,
  buildCodexProjectTrustToml,
  validateConfigAgainstSchema,
  writeCodexConfig,
  type CodexConfigOptions,
} from '../config-writer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json');
const ROOT = '/Users/dev/work/some repo';

function opts(over: Partial<CodexConfigOptions> = {}): CodexConfigOptions {
  return {
    codexHome: '/tmp/codex-home',
    model: 'tgpt/qwen35-397b-a17b-fp8',
    adapterPort: 54321,
    ...over,
  };
}

describe('P6.540 — codex project trust', () => {
  test('POSITIVE — a trusted project gets a keyed [projects] entry', () => {
    const toml = buildCodexConfigToml(opts({ projectRoot: ROOT, projectTrusted: true }));
    // A quoted key, because a real path carries spaces and separators.
    expect(toml).toContain(`[projects."${ROOT}"]`);
    expect(toml).toContain('trust_level = "trusted"');
  });

  test('NEGATIVE, FLIPPED BY DECISION (F1.750) — a project the host did not trust is written `untrusted`', () => {
    // Until F1.750 this pinned the opposite — "an untrusted project writes NOTHING, not
    // `untrusted`" — on the premise that an ABSENT entry is codex's fail-closed pole. Measured
    // false on the shipped 0.156.1 (WJ-crit-t, F1.723): `thread_start_task`
    // (`app-server/src/request_processors/thread_processor.rs`, `rust-v0.156.1`) AUTO-TRUSTS any
    // cwd whose `active_project.trust_level.is_none()` and writes `trust_level = "trusted"` itself,
    // so absent became trusted on the first thread open — and a project the user kept RESTRICTED
    // had its `.codex` layer (MCP server commands, hooks, rules) loaded. An explicit `untrusted` is
    // `Some(..)`, so the auto-trust never fires; `disabled_reason_for_decision` keeps the layer out.
    //
    // DECIDED by the controller (F1.750): the user's "Keep restricted" means restricted. The cost,
    // stated: `core/src/agents_md.rs` `load_project_instructions` reads no project AGENTS.md for an
    // `is_untrusted()` project (I2.27) — the same repository-owned content the host itself
    // withholds from an untrusted project. `approval_policy` and `sandbox_mode` are always written
    // (and restated as the request layer, F1.723), so `untrusted` seeds neither.
    // `undefined` is the host's fail-closed default ("anything but an explicit 'trusted' decision
    // stays untrusted"), so it takes the same answer as `false`.
    for (const projectTrusted of [false, undefined]) {
      const toml = buildCodexConfigToml(opts({ projectRoot: ROOT, ...(projectTrusted === undefined ? {} : { projectTrusted }) }));
      expect(toml).toContain(`[projects."${ROOT}"]`);
      expect(toml).toContain('trust_level = "untrusted"');
      expect(toml).not.toContain('trust_level = "trusted"');
    }
  });

  test('BOUNDARY — either decision with no project path says nothing, because the key IS the path', () => {
    for (const projectTrusted of [true, false]) {
      for (const projectRoot of [undefined, '', '   ']) {
        expect(buildCodexProjectTrustToml({
          projectTrusted,
          ...(projectRoot === undefined ? {} : { projectRoot }),
        })).toEqual([]);
      }
    }
  });

  test('the table sits among the tables and never after the load-bearing [agents] block', () => {
    // Every key under `[agents]` is a ROLE NAME, so a table opened after it is
    // swallowed — the same placement rule `[features]` and `[otel]` follow.
    const toml = buildCodexConfigToml(opts({
      projectRoot: ROOT,
      projectTrusted: true,
      defaultSubagentModel: 'tgpt/qwen35-mini',
      agents: [{
        key: 'plugin:x:researcher',
        name: 'researcher',
        selectedAsUnqualifiedAlias: true,
        description: 'Researches things',
        systemPrompt: 'You research.',
      }],
    }));
    const projectsAt = toml.indexOf('[projects.');
    const agentsAt = toml.indexOf('[agents]');
    expect(projectsAt).toBeGreaterThanOrEqual(0);
    expect(agentsAt).toBeGreaterThanOrEqual(0);
    expect(projectsAt).toBeLessThan(agentsAt);
  });

  test('a path with a quote or a backslash is escaped, not injected', () => {
    const nasty = '/tmp/we"ird\\path';
    const [header] = buildCodexProjectTrustToml({ projectRoot: nasty, projectTrusted: true });
    expect(header).toBe('[projects."/tmp/we\\"ird\\\\path"]');
  });

  test('the schema drift guard accepts it, and the whole config still validates', () => {
    expect(() => validateConfigAgainstSchema(opts({ projectRoot: ROOT, projectTrusted: true }), SCHEMA)).not.toThrow();
    expect(() => validateConfigAgainstSchema(opts({ projectRoot: ROOT, projectTrusted: false }), SCHEMA)).not.toThrow();
    expect(() => validateConfigAgainstSchema(opts(), SCHEMA)).not.toThrow();
  });

  test('F1.750 — the drift guard refuses a schema whose TrustLevel lost the member the entry spells', () => {
    // A value the enum lacks fails deserialization on codex's side rather than being ignored (read,
    // not measured; P2.436 measured a wrong-typed value discarding the whole file), so the guard
    // names a renamed member before spawn instead.
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
    schema.definitions.TrustLevel = { ...schema.definitions.TrustLevel, enum: ['trusted'] };
    const dir = mkdtempSync(join(tmpdir(), 'f1750-schema-'));
    try {
      const path = join(dir, 'config-schema.json');
      writeFileSync(path, JSON.stringify(schema));
      expect(() => validateConfigAgainstSchema(opts({ projectRoot: ROOT, projectTrusted: false }), path)).toThrow('"untrusted"');
      expect(() => validateConfigAgainstSchema(opts({ projectRoot: ROOT, projectTrusted: true }), path)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('end to end — the entry lands in the CODEX_HOME config we actually write', () => {
    const home = mkdtempSync(join(tmpdir(), 'p6540-'));
    try {
      writeCodexConfig(opts({ codexHome: home, projectRoot: ROOT, projectTrusted: true }));
      const written = readFileSync(join(home, 'config.toml'), 'utf8');
      expect(written).toContain(`[projects."${ROOT}"]`);
      expect(written).toContain('trust_level = "trusted"');
      writeCodexConfig(opts({ codexHome: home, projectRoot: ROOT, projectTrusted: false }));
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('trust_level = "untrusted"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
