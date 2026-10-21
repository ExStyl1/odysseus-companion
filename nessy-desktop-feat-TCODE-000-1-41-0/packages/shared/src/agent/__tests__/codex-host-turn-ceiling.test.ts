/**
 * C3.75 (QF9, owner answer A, 2026-09-11) — codex takes P6.276's opt-in, and
 * the other two runtimes must NOT.
 *
 * ## What is pinned here, and why it is three claims and not one
 *
 * P6.276 built the shared ceiling and left it OFF for every backend, because
 * turning it on where a native cap already exists would count the same session
 * twice under one setting name. `base-agent-max-agent-turns.test.ts` pins the
 * MECHANISM with the flag stubbed on a `TestAgent`. What it cannot see is which
 * real backends set it — and that is the whole of this row.
 *
 *  1. **codex opts IN.** `CodexAgent.countsAgentTurnsInSharedLoop` is `true`,
 *     and codex is the arm that needs it: the release
 *     `packages/codex-protocol/schema/config-schema.json` carries zero
 *     `max_turn*` keys, so there is nothing to configure and the host ceiling is
 *     the only seam. The key count is read from the schema rather than restated,
 *     with a positive control on the same file.
 *  2. **Pi and claude do NOT**, so their native enforcement is not doubled.
 *     Read off the classes, because the regression this guards is a second
 *     backend quietly adopting the flag.
 *  3. **The shipped default changes nothing.** `workspaceDefaults.maxAgentTurns`
 *     is 0, and the ceiling is inert at 0 — so this row turns a mechanism on for
 *     codex without changing any session until an operator sets a cap.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAgent } from '../claude-agent.ts';
import { CodexAgent } from '../codex-agent.ts';
import { PiAgent } from '../pi-agent.ts';
import { createMockBackendConfig } from './test-utils.ts';
import type { BackendConfig } from '../backend/types.ts';
import { loadConfigDefaults } from '../../config/storage.ts';

const SCHEMA = join(
  import.meta.dir, '..', '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json',
);

/** The protected flag, as the loop reads it. */
function hostCounts(agent: object): boolean {
  return (agent as { countsAgentTurnsInSharedLoop: boolean }).countsAgentTurnsInSharedLoop;
}

describe('C3.75 — which backends ask the shared loop to count their turns', () => {
  it('codex opts IN', () => {
    const agent = new CodexAgent({
      ...createMockBackendConfig(),
      provider: 'codex-runtime',
      model: 'codex/test-model',
      isHeadless: true,
    } as BackendConfig);
    expect(hostCounts(agent)).toBe(true);
  });

  it('CONTROL: Pi and claude do NOT, so their native caps are not counted twice', () => {
    const pi = new PiAgent({ ...createMockBackendConfig(), provider: 'pi', isHeadless: true } as BackendConfig);
    const claude = new ClaudeAgent({
      ...createMockBackendConfig(), provider: 'anthropic', isHeadless: true,
    } as BackendConfig);
    expect(hostCounts(pi)).toBe(false);
    expect(hostCounts(claude)).toBe(false);
  });

  it('THE REASON codex needs it: its release config schema has no turn cap at all', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    // Read rather than restated: the day codex ships one, this fails and the
    // opt-in above owes a second look.
    expect(schema.match(/max_turn/g)).toBeNull();
    // Positive controls on the same file, so an unreadable/renamed schema cannot
    // satisfy the assertion above by being empty.
    expect(schema).toContain('interrupt_turn');
    expect(schema).toContain('turn_metadata_includes_tool_info');
  });

  it('the shipped default leaves the ceiling OFF, so no session changes today', () => {
    expect(loadConfigDefaults().workspaceDefaults.maxAgentTurns ?? 0).toBe(0);
  });
});
