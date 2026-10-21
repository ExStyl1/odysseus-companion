/**
 * C3.304 — the two `.claude`-settings refusals reach all three runtimes, from
 * one call site, and from no agent.
 *
 * ## What this pins and why source text is the instrument
 *
 * `formatClaudeShellCommandSettingRefusal` and
 * `formatClaudeDangerousModeAckRefusal` are pure and already have thorough
 * behavioural suites of their own
 * (`packages/shared/src/agent/__tests__/claude-shell-command-settings.test.ts`,
 * `…/claude-dangerous-mode-ack-refusal.test.ts`). What they had NO test for was
 * the fact the row is about: both call themselves product-wide in their own
 * docblocks — *"correct on Pi, on claude and on codex"*, *"identical on Pi,
 * claude and codex"* — while being called from `claude-agent.ts` (the second
 * from there alone), so a Pi session got neither line. `grep -c` for either name
 * over `packages/shared/src/agent/pi-agent.ts` was 0 at HEAD before the move,
 * against 4 in `claude-agent.ts`.
 *
 * That is a WIRING fact about which files call what, and the only instrument
 * that can see it is the source. A behavioural test of the seam would assert the
 * formatters again and stay green with the wiring deleted — which is the state
 * this row closed.
 *
 * Every read is paired with a positive control proving the read found real code,
 * per AGENTS.md §"An ABSENCE finding needs a positive control on the same rig".
 */
import { describe, expect, test } from 'bun:test'

const SESSION_MANAGER = new URL('../SessionManager.ts', import.meta.url).pathname
const CLAUDE_AGENT = new URL(
  '../../../../shared/src/agent/claude-agent.ts',
  import.meta.url,
).pathname
const CODEX_AGENT = new URL(
  '../../../../shared/src/agent/codex-agent.ts',
  import.meta.url,
).pathname
const PI_AGENT = new URL('../../../../shared/src/agent/pi-agent.ts', import.meta.url).pathname

async function read(path: string): Promise<string> {
  return await Bun.file(path).text()
}

describe('C3.304 — the settings refusals live on the host seam', () => {
  test('SessionManager owns both refusals, on the seam C3.18 built', async () => {
    const manager = await read(SESSION_MANAGER)
    // The one consumer.
    expect(manager).toContain('private warnIfClaudeSettingsCarryRefusedKeys(managed: ManagedSession): void')
    expect(manager).toContain('formatClaudeShellCommandSettingRefusal({ project: projectKeys, user: userKeys })')
    expect(manager).toContain('formatClaudeDangerousModeAckRefusal(ackScopes)')
    // Called from the agent-construction slice every runtime passes through,
    // beside the sibling the row names as the seam. Its neighbour is the
    // POSITIVE CONTROL: if that call were ever moved out, this read would be
    // asserting a slice that no longer exists rather than a missing call.
    expect(manager).toContain('this.warnIfProjectSettingsWidenDefaultMode(managed)')
    expect(manager).toContain('this.warnIfClaudeSettingsCarryRefusedKeys(managed)')
  })

  test('the call site is runtime-agnostic — it is not inside a provider branch', async () => {
    const manager = await read(SESSION_MANAGER)
    const call = manager.indexOf('this.warnIfClaudeSettingsCarryRefusedKeys(managed)')
    const sibling = manager.indexOf('this.warnIfProjectSettingsWidenDefaultMode(managed)')
    expect(call).toBeGreaterThan(0)
    expect(sibling).toBeGreaterThan(0)
    // Adjacent to the sibling, ahead of the first place the provider is read to
    // choose an agent class. `resolveBackendContextForManaged` runs BEFORE both —
    // it is what supplies the connection the model-family siblings read — so the
    // bound that matters is the agent build, not the context resolution.
    expect(Math.abs(call - sibling)).toBeLessThan(400)
    const build = manager.indexOf('const agentAutomationSystem = await this.buildAgentAutomationSystem(')
    expect(build).toBeGreaterThan(call)
  })

  test('no agent carries a copy — and Pi, which never had one, now reaches both', async () => {
    const [claude, codex, pi] = await Promise.all([read(CLAUDE_AGENT), read(CODEX_AGENT), read(PI_AGENT)])
    // NEGATIVE, the row itself. Guarded on the CALL and not on the bare
    // identifier: `claude-agent.ts` still NAMES both functions, in the comment
    // that says where they went, and a guard on the name alone would fail on the
    // very commit that made it true (AGENTS.md §Traps, the stale-NAME class).
    expect(claude).not.toContain('formatClaudeShellCommandSettingRefusal(')
    expect(claude).not.toContain('formatClaudeDangerousModeAckRefusal(')
    expect(codex).not.toContain('formatClaudeShellCommandSettingRefusal(')
    // POSITIVE CONTROL on the same two files: the read found real code, and the
    // codex PROJECTION report — a runtime fact about one runtime — deliberately
    // stayed where it is.
    expect(claude).toContain('buildClaudeLauncherDropNotices(process.env)')
    expect(codex).toContain('formatCodexClaudeSettingsProjectionDiagnostics(keys)')
    // Pi never had either line and still has no copy: the seam is what reaches it.
    expect(pi).not.toContain('formatClaudeShellCommandSettingRefusal')
    expect(pi).not.toContain('formatClaudeDangerousModeAckRefusal')
    expect(pi.length).toBeGreaterThan(1000)
  })

  test('no settings VALUE is logged with the keys', async () => {
    const manager = await read(SESSION_MANAGER)
    const start = manager.indexOf('private warnIfClaudeSettingsCarryRefusedKeys')
    const body = manager.slice(start, start + 3000)
    expect(body).toContain("sessionLog.warn('claude_settings_keys_refused'")
    // The structured record carries key NAMES and scope names only. A `values:`
    // field here would put a credential-bearing settings value in a log file,
    // which is the one thing both formatters refuse to do in their own prose.
    expect(body).not.toContain('values:')
    expect(body).toContain('projectKeys,')
    expect(body).toContain('dangerousModeAckScopes: ackScopes,')
  })
})
