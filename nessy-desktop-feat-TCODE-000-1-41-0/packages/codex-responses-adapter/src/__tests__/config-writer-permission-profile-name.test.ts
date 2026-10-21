/**
 * P2.380 — the reserved permission-profile namespace, guarded at the writer.
 *
 * ## The row's premise does not survive the source, and the real rule is
 * different AND stricter
 *
 * The row came from a docs page naming `codex_security_scan` as a RESERVED
 * profile id, and worried that our writer "does not know that name is taken: a
 * collision would silently rebind a reserved profile". Read at `openai/codex` @
 * `rust-v0.148.0`:
 *
 *  - `codex_security_scan` appears **zero times** in the entire tree. Positive
 *    control on the same rig, same command: `security_scan` DOES hit nine times
 *    (analytics and plugin-metrics fixtures), so the absence is a finding and
 *    not a broken grep.
 *  - The reserved namespace is a **prefix, not a name**:
 *    `core/src/config/permissions.rs::validate_user_permission_profile_names`
 *    rejects every `[permissions.<name>]` whose key starts with `:` —
 *    *"permissions profile `{profile_name}` uses a reserved built-in profile
 *    prefix"*. The three built-ins are `:read-only`, `:workspace` and
 *    `:danger-full-access` (`protocol/src/models.rs:306-312`).
 *  - A collision is therefore **loud**: an `io::Error` at config load, not the
 *    silent rebinding the row assumed. So the blast radius the row feared — a
 *    reserved profile quietly overriding `sandbox_mode` and `approval_policy`
 *    together — is not reachable this way.
 *
 * ## What is left worth pinning, and it is not nothing
 *
 * The rule is a namespace, so the invariant is a namespace invariant: every
 * profile this writer DECLARES must stay out of the colon namespace, and every
 * built-in it REFERENCES must stay in it. Those are opposite requirements on the
 * same character, one line apart in the emitted file, which is exactly the kind
 * of pair a rename gets wrong. Both are asserted below, from the emitted TOML
 * rather than from the constants, so a future `[permissions.…]` table added by
 * any lane is covered without that lane knowing this file exists.
 */
import { describe, expect, test } from 'bun:test';
import { buildCodexConfigToml, buildCodexRuntimeConfigOverride } from '../config-writer.ts';

const BASE = {
  codexHome: '/tmp/p2380',
  model: 'tgpt/qwen35-397b-a17b-fp8',
  adapterPort: 54321,
  // Anything that gives the writer a filesystem policy makes it open the
  // `[permissions.<profile>]` tables at all.
  deniedReadPaths: ['/Users/someone/.ssh/id_rsa'],
} as const;

/** Every `[permissions.<name>…]` table header the config opens, by first segment. */
function declaredProfiles(toml: string): string[] {
  const names = new Set<string>();
  for (const line of toml.split('\n')) {
    const match = /^\[permissions\.([^\].]+)/.exec(line);
    if (match) names.add((match[1] as string).replace(/^"|"$/g, ''));
  }
  return [...names];
}

describe('P2.380 · codex reserves the colon namespace, and this writer stays out of it', () => {
  test('the config opens at least one permissions table (the control for every row below)', () => {
    expect(declaredProfiles(buildCodexConfigToml(BASE)).length).toBeGreaterThan(0);
  });

  test('no DECLARED profile name is in the reserved colon namespace', () => {
    for (const name of declaredProfiles(buildCodexConfigToml(BASE))) {
      expect(name.startsWith(':')).toBe(false);
    }
  });

  test('no declared profile name collides with a built-in, colon or not', () => {
    const builtins = [':read-only', ':workspace', ':danger-full-access'];
    const bare = builtins.map(name => name.slice(1));
    for (const name of declaredProfiles(buildCodexConfigToml(BASE))) {
      expect(builtins).not.toContain(name);
      expect(bare).not.toContain(name);
    }
  });

  test('`extends` REFERENCES a built-in, so it keeps the colon the declaration must not have', () => {
    const workspace = buildCodexConfigToml(BASE);
    expect(workspace).toContain('extends = ":workspace"');
    const readOnly = buildCodexConfigToml({ ...BASE, sandboxMode: 'read-only' });
    expect(readOnly).toContain('extends = ":read-only"');
  });

  test('the per-thread config layer names the same profile, and the same namespace rule holds', () => {
    const override = buildCodexRuntimeConfigOverride(BASE) as {
      default_permissions?: string;
      permissions?: Record<string, unknown>;
    };
    const declared = Object.keys(override.permissions ?? {});
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) expect(name.startsWith(':')).toBe(false);
    expect(typeof override.default_permissions).toBe('string');
    expect(declared).toContain(override.default_permissions as string);
  });
});
