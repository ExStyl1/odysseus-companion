/**
 * P6.605 — the bundled `reviewer` reaches the codex role writer, with its
 * read-only obligation.
 *
 * P6.485 built the writer half (owner Q17(b)) and left the projection untaken:
 * `BUILTIN_AGENT_DEFINITIONS` are spawned through `SessionManager` and were not
 * part of `piRuntimeAgentDefinitions`, the only source of
 * `CodexConfigOptions.agents`. So `/code-review` on codex spawned an unnamed
 * agent with the parent's full tools.
 *
 * These cases drive the REAL writer rather than asserting the projection's own
 * shape, because the thing that can rot is the agreement between this filter and
 * the writer's by-name exception set — which lives in the other package and
 * cannot be imported from here.
 */
import { describe, expect, it } from 'bun:test';
import {
  buildCodexAgentRoles,
  buildCodexConfigToml,
  formatCodexUnhonouredRoleToolGrantNotice,
} from '@nessy-agent/codex-responses-adapter/config-writer';
import type { CodexConfigOptions } from '@nessy-agent/codex-responses-adapter/config-writer';
import { BUILTIN_AGENT_DEFINITIONS } from '../../agents/definitions.ts';
import {
  CODEX_BUILTIN_ROLE_NAMES,
  codexBuiltinRoleDescriptors,
} from '../codex-runtime-builtin-roles.ts';

const BASE: CodexConfigOptions = {
  codexHome: '/tmp/p6605',
  model: 'tgpt/qwen35-397b-a17b-fp8',
  adapterPort: 54321,
};

function withBuiltins(): CodexConfigOptions {
  return { ...BASE, agents: codexBuiltinRoleDescriptors() };
}

describe('P6.605 the bundled reviewer role on codex', () => {
  it('projects a bundled definition at all — the half that was missing', () => {
    const roles = codexBuiltinRoleDescriptors();
    expect(roles.map(role => role.name)).toEqual(['reviewer']);
    const reviewer = roles[0]!;
    expect(reviewer.key).toBe('builtin:reviewer');
    // `true` is load-bearing: the writer names a role
    // `selectedAsUnqualifiedAlias ? name : key`, so `false` would declare
    // `builtin_reviewer` — a name that matches neither the writer's by-name
    // exception nor the one `/code-review` spawns. Measured, not assumed: with
    // `false` this suite's writer cases return zero roles.
    expect(reviewer.selectedAsUnqualifiedAlias).toBe(true);
    // The grant is CARRIED: it is what makes the writer prepend the obligation.
    expect(reviewer.tools.length).toBeGreaterThan(0);
  });

  it('every projected name is a real bundled definition', () => {
    for (const name of CODEX_BUILTIN_ROLE_NAMES) {
      expect(BUILTIN_AGENT_DEFINITIONS.some(definition => definition.name === name)).toBe(true);
    }
  });

  it('reaches the writer as a declared `[agents.reviewer]` role', () => {
    const toml = buildCodexConfigToml(withBuiltins());
    expect(toml).toContain('[agents.reviewer]');
    expect(toml).toContain(BUILTIN_AGENT_DEFINITIONS.find(d => d.name === 'reviewer')!.description);
  });

  it('carries the read-only obligation, which is the whole of Q17', () => {
    // The obligation rides the ROLE's own config layer, not the main file, and
    // it is prepended precisely because the tool grant was not honoured.
    const plan = buildCodexAgentRoles({
      codexHome: '/tmp/p6605',
      sessionModel: BASE.model,
      sessionMode: 'default',
      definitions: codexBuiltinRoleDescriptors(),
    });
    expect(plan.roles.map(role => role.roleName)).toEqual(['reviewer']);
    expect(plan.denied).toEqual([]);
    expect(plan.roles[0]!.configFileToml).toContain('READ-ONLY OBLIGATION');
    // And the widening is SAID, on its own channel — a widening is not a drop.
    expect(plan.unhonouredToolGrants.map(entry => entry.key)).toEqual(['builtin:reviewer']);
    expect(formatCodexUnhonouredRoleToolGrantNotice(plan).join(' ')).toContain('reviewer');
  });

  it('loses to a user-authored definition of the same name, by ORDER', () => {
    // The collision is settled by the writer's `claimed` gate, first arrival
    // wins — which is why the call site spreads the bundled list LAST. A user's
    // own reviewer keeps the name, as it does on Pi and on claude.
    const authored = {
      key: 'project:reviewer',
      name: 'reviewer',
      selectedAsUnqualifiedAlias: true,
      description: 'The reviewer this workspace authored.',
      systemPrompt: 'Review as this project prefers.',
    };
    const plan = buildCodexAgentRoles({
      codexHome: '/tmp/p6605',
      sessionModel: BASE.model,
      sessionMode: 'default',
      definitions: [authored, ...codexBuiltinRoleDescriptors()],
    });
    expect(plan.roles.map(role => role.roleName)).toEqual(['reviewer']);
    expect(plan.roles[0]!.configFileToml).toContain('Review as this project prefers.');
    expect(plan.denied.map(entry => entry.key)).toEqual(['builtin:reviewer']);
  });

  it('the projection and the writer AGREE on which names get through', () => {
    // The coupling this test exists for: the writer's exception set is private
    // to the other package, so the only way to check the two have not drifted is
    // to drive the writer and see the role appear. A name added to
    // CODEX_BUILTIN_ROLE_NAMES that the writer still denies fails here.
    const toml = buildCodexConfigToml(withBuiltins());
    for (const name of CODEX_BUILTIN_ROLE_NAMES) {
      expect(toml).toContain(`[agents.${name}]`);
    }
  });
});
