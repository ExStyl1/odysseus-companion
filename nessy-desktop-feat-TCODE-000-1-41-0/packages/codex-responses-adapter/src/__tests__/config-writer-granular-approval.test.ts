import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexConfigToml, validateConfigAgainstSchema } from '../config-writer.ts';
import type { CodexConfigOptions } from '../config-writer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json');

const BASE: CodexConfigOptions = {
  codexHome: '/tmp/p6224',
  model: 'tgpt/qwen35-397b-a17b-fp8',
  adapterPort: 54321,
};

/**
 * P6.224 — codex's `granular` approval policy was unemittable, and the blocker
 * was OURS.
 *
 * `AskForApproval` in the release schema is a `oneOf` whose fourth member is an
 * OBJECT — `{ "required": ["granular"], "properties": { "granular": { "$ref":
 * "#/definitions/GranularApprovalConfig" } } }` — while
 * `validateConfigAgainstSchema` flattened that `oneOf` to its string enums, so
 * the policy failed a guard codex itself would have accepted. Our own comment
 * said so and treated it as a codex fact.
 *
 * These cases pin the emission SHAPE and the guard. Nothing selects the policy:
 * which categories a Nessy session would auto-reject is an owner posture, and
 * `CODEX_PERMISSION_MODE_TABLE` still emits only `never` and `on-request`.
 *
 * The schema's own sentence is the reason the type exists and no default for it
 * does: "When a field is `true`, commands in that category are allowed. When it
 * is `false`, those requests are automatically rejected instead of shown to the
 * user." `false` is a SILENT DENIAL, not an "ask".
 */
describe('P6.224 · the granular approval policy round-trips', () => {
  const GRANULAR: CodexConfigOptions = {
    ...BASE,
    approvalPolicy: 'granular',
    granularApproval: { sandbox_approval: true, rules: true, mcp_elicitations: false },
  };

  test('emits the object variant as an inline table, and the file still parses', () => {
    const toml = buildCodexConfigToml(GRANULAR);
    expect(toml).toContain(
      'approval_policy = { granular = { sandbox_approval = true, rules = true, mcp_elicitations = false } }',
    );
    const parsed = Bun.TOML.parse(toml) as Record<string, any>;
    expect(parsed.approval_policy.granular).toEqual({
      sandbox_approval: true, rules: true, mcp_elicitations: false,
    });
    // Arm 1's fail-open is WHOLE-FILE, so the provider block is the control.
    expect(parsed.model_provider).toBe('nessy_gateway');
  });

  test('omits the two optional members when unset rather than writing codex’s own default back', () => {
    // Writing a runtime's own default back looks like a choice somebody made,
    // and the next reader cannot tell the two apart.
    expect(buildCodexConfigToml(GRANULAR)).not.toContain('request_permissions');
    expect(buildCodexConfigToml(GRANULAR)).not.toContain('skill_approval');
  });

  test('carries the two optional members when they ARE set', () => {
    const toml = buildCodexConfigToml({
      ...GRANULAR,
      granularApproval: {
        sandbox_approval: true, rules: false, mcp_elicitations: true,
        request_permissions: true, skill_approval: false,
      },
    });
    const parsed = Bun.TOML.parse(toml) as Record<string, any>;
    expect(parsed.approval_policy.granular.request_permissions).toBe(true);
    expect(parsed.approval_policy.granular.skill_approval).toBe(false);
  });

  test('validates against the real schema, which the string-enum guard could not', () => {
    expect(() => validateConfigAgainstSchema(GRANULAR, SCHEMA)).not.toThrow();
    // The string variants still validate — the object branch is additive. There
    // were THREE of them until `rust-v0.150.1`; `untrusted` was retired upstream
    // (#39630) and is no longer in the release schema's `AskForApproval`, nor in
    // `CodexApprovalPolicy`, so naming it here would not compile. Its own
    // refusal is pinned in `config-writer.test.ts`.
    for (const approvalPolicy of ['on-request', 'never'] as const) {
      expect(() => validateConfigAgainstSchema({ ...BASE, approvalPolicy }, SCHEMA)).not.toThrow();
    }
  });

  test('REFUSES the policy with no payload, at the writer, rather than shipping a rejected file', () => {
    // The schema's object variant requires `granular`, and codex's config failure
    // is whole-file — so an empty `granular = {}` would take the provider block
    // and every deny floor down with it. Loud here is the safe direction.
    expect(() => buildCodexConfigToml({ ...BASE, approvalPolicy: 'granular' })).toThrow(/granularApproval/);
    expect(() => validateConfigAgainstSchema({ ...BASE, approvalPolicy: 'granular' }, SCHEMA))
      .toThrow(/granularApproval/);
  });

  test('refuses a payload missing a schema-REQUIRED member, by that member’s name', () => {
    expect(() => validateConfigAgainstSchema({
      ...BASE,
      approvalPolicy: 'granular',
      granularApproval: { sandbox_approval: true, rules: true } as never,
    }, SCHEMA)).toThrow(/mcp_elicitations/);
  });

  test('refuses a member the schema does not have — the upstream-rename detector', () => {
    expect(() => validateConfigAgainstSchema({
      ...BASE,
      approvalPolicy: 'granular',
      granularApproval: {
        sandbox_approval: true, rules: true, mcp_elicitations: true, sandbox_approvals: true,
      } as never,
    }, SCHEMA)).toThrow(/sandbox_approvals/);
  });
});
