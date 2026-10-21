import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * P6.317 (2) — the four sites that must agree about `sessionAgents`, pinned by
 * SOURCE because the property they hold is not observable from any one of them.
 *
 * `PiRuntimeAgentDefinitionDescriptor.definitionDigest` is
 * `sha256(JSON.stringify(descriptor))`, and the host PINS the set it built for
 * one capability generation. A call site that materializes definitions WITHOUT
 * the session's `--agents` entries therefore builds a different set from the one
 * the subprocess was handed, and every spawn dies on
 * `runtime-agent-definition-identity-mismatch` — the exact failure `projectTrusted`
 * already had (see `agentDefinitionHookTrust`'s docblock), reproduced for a
 * second field.
 *
 * A behavioural test cannot see this: each call site is correct on its own, and
 * the disagreement only appears when a live session spawns a child. What CAN be
 * checked cheaply is the invariant that produces it — every site that spreads
 * the trust half spreads the session half beside it, and the value also reaches
 * Pi's per-turn refresh, which is the fourth site and lives in another package.
 *
 * Guarded by the CALL form, never the bare identifier: AGENTS.md §Traps (W9-f,
 * P6.665) — a bare-name guard fails on the very commit that removes the name,
 * because the comment explaining the removal spells it.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const SESSION_MANAGER = readFileSync(join(HERE, '..', 'SessionManager.ts'), 'utf8')
const PI_AGENT = readFileSync(
  join(HERE, '..', '..', '..', '..', 'shared', 'src', 'agent', 'pi-agent.ts'),
  'utf8',
)

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

describe('P6.317 (2) — sessionAgents reaches every site that pins a definition digest', () => {
  it('spreads the session half at every site that spreads the trust half, plus the agent config', () => {
    const trust = occurrences(SESSION_MANAGER, 'agentDefinitionHookTrust(capabilityRuntime)')
    const session = occurrences(SESSION_MANAGER, 'agentDefinitionSessionAgents(managed)')
    // Three materialize call sites carry both; the fourth occurrence of the
    // session half is the agent config, which hands the UNMATERIALIZED map to
    // the backend for Pi's refresh. So the session half is the trust half plus
    // exactly one — a new materialize site that forgets it lowers this to
    // equality, and a stray spread raises it.
    expect(trust).toBe(3)
    expect(session).toBe(trust + 1)
  })

  it('reads the map off the create options and holds it in memory only', () => {
    expect(SESSION_MANAGER).toContain('managed.sessionAgents = structuredClone(options.agents)')
    // Not persisted: the flag writes nothing to disk, so the field must not
    // appear in any stored-session shape. `sessionStore.create` is the one call
    // that mints the record.
    const storedCreate = SESSION_MANAGER.slice(
      SESSION_MANAGER.indexOf('await this.sessionStore.create(workspace.id, {'),
    ).slice(0, 600)
    expect(storedCreate).not.toContain('sessionAgents')
  })

  it("Pi's per-turn refresh passes the same map, beside the other digest input", () => {
    const refresh = PI_AGENT.slice(PI_AGENT.indexOf('const refreshedAgentDefinitions =')).slice(0, 2000)
    expect(refresh).toContain('projectTrusted: this.config.projectTrusted === true')
    expect(refresh).toContain('sessionAgents: this.config.sessionAgents')
  })
})
