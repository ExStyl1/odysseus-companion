/**
 * C3.270 + C3.275 — `Notification` on claude, measured before anything is built.
 *
 * ## The answer, and it is an ABSENCE with its controls
 *
 * Driven against the vendored binary (self-reporting `2.1.247`) on three arms,
 * each watching three channels at once (the probe's docblock has the rig):
 *
 * | arm | settings-tier `Notification` | SDK-callback `Notification` | `system`/`notification` message |
 * | --- | --- | --- | --- |
 * | `control` (plain turn) | — | — | — |
 * | `permission` (`Write` held 2 s at `canUseTool`) | — | — | — |
 * | `idle` (streaming input, 10 s after the result) | — | — | — |
 *
 * with BOTH positive controls green on the same runs: the settings-tier
 * `SessionStart` hook, declared in the same file and running the same script,
 * wrote its payload on every arm, and the SDK-callback `PreToolUse` hook —
 * the channel `runPreToolUseChecks` rides in production — fired on the
 * `permission` arm. So the rig can see a hook of either kind, and the
 * `Notification` silence is a reading rather than a broken fixture.
 *
 * ## What that settles for each row
 *
 * **C3.270 — no host code is needed, and none is added.** The host wiring is
 * already generic: `buildSdkHooksForConfig` (`plugins/hooks-automation.ts`)
 * registers a callback matcher for every event a user's automations config
 * names, `Notification` included, and `SDK_ADDITIONAL_CONTEXT_EVENTS` already
 * carries it. Nothing is missing on our side; what is missing is a producer in
 * the runtime's SDK surface. Building a host-side producer instead would be the
 * opposite of native-first — it would mint `Notification` events on claude that
 * describe OUR permission card rather than the runtime's own notification, and
 * a matcher written against the documented vocabulary would then fire for a
 * different occurrence than it does on Pi.
 *
 * **C3.275 — G10-claude's producer question is answered NO, from its own arm.**
 * C3.94 refused to infer that from silence, correctly; this suite provokes and
 * still measures silence, with controls.
 *
 * ## The mechanism, offered as an inference rather than as evidence
 *
 * In the vendored binary the `Notification` hook runner and the OS-notification
 * dispatcher are the same call: one function reads `preferredNotifChannel`,
 * awaits the hook, then dispatches to iTerm2/Kitty/Ghostty/bell, and it sits in
 * a chunk whose neighbours are the terminal UI. The SDK surface gives the same
 * fact its own channel instead — `SDKNotificationMessage` (`type: 'system'`,
 * `subtype: 'notification'`), which this fork already consumes
 * (`backend/claude/event-adapter.ts` renders it as an `info` event). That
 * reading explains the measurement; the measurement is what is relied on.
 *
 * Gated on `NESSY_CLAUDE_SDK_E2E=1`: it spawns a 233 MB binary per arm, so it is
 * a recorded local run rather than a CI gate. Offline, no credentials.
 *
 *   NESSY_CLAUDE_SDK_E2E=1 bun test ./packages/shared/src/agent/__tests__/claude-notification-e2e.test.ts
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { HOOK_NOTIFICATION_TYPES } from '../../automations/types.ts'
import { runClaudeNotificationProbe, type ClaudeNotificationProbeResult } from './fixtures/claude-notification-probe.ts'

setDefaultTimeout(180_000)

function vendoredClaudeBinary(): string | null {
  const suffix = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  try {
    const require_ = createRequire(import.meta.url)
    const sdkRoot = dirname(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'))
    const candidate = join(dirname(sdkRoot), `claude-agent-sdk-${process.platform}-${arch}`, suffix)
    return existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}

const LIVE = process.env.NESSY_CLAUDE_SDK_E2E === '1' && vendoredClaudeBinary() !== null

/** Every channel a `Notification` could have arrived on, as one reading. */
function anyNotification(outcome: ClaudeNotificationProbeResult): boolean {
  return outcome.settingsHookPayloads.length > 0
    || outcome.sdkHookTypes.length > 0
    || outcome.notificationMessages.length > 0
}

describe('C3.270 — the host wiring that already exists, offline', () => {
  it("the documented vocabulary is this fork's, so a matcher would have something to name", () => {
    // Not a test of the runtime: a reminder of what an author CAN write today,
    // and therefore of what the measurement below leaves unreachable on claude.
    expect(HOOK_NOTIFICATION_TYPES).toContain('permission_prompt')
    expect(HOOK_NOTIFICATION_TYPES).toContain('idle_prompt')
    expect(HOOK_NOTIFICATION_TYPES.length).toBeGreaterThan(1)
  })
})

describe.skipIf(!LIVE)('C3.270 + C3.275 — driven against the vendored binary', () => {
  it('a held tool approval produces no Notification on any channel — and both controls fire', async () => {
    const outcome = await runClaudeNotificationProbe('permission')

    // The rig ran: the child answered, the callback really was consulted, and
    // the callback really did hold before allowing.
    expect(outcome.version).not.toBeNull()
    expect(outcome.resultSubtype).toBe('success')
    expect(outcome.canUseToolCalls).toContain('Write')

    // POSITIVE CONTROLS, both kinds, same run. An absence claim without them is
    // not a reading (AGENTS.md).
    expect(outcome.controlSettingsHookPayloads.length).toBeGreaterThan(0)
    expect(outcome.controlSettingsHookPayloads.join('\n')).toContain('"hook_event_name":"SessionStart"')
    expect(outcome.controlSdkHookEvents).toContain('PreToolUse')

    expect(anyNotification(outcome)).toBe(false)
  })

  it('a settled turn on a still-open session produces none either', async () => {
    const outcome = await runClaudeNotificationProbe('idle')

    expect(outcome.resultSubtype).toBe('success')
    expect(outcome.controlSettingsHookPayloads.length).toBeGreaterThan(0)
    expect(anyNotification(outcome)).toBe(false)
  })

  it('the control arm: a plain turn, nothing provoked, nothing fired', async () => {
    const outcome = await runClaudeNotificationProbe('control')

    expect(outcome.resultSubtype).toBe('success')
    expect(outcome.controlSettingsHookPayloads.length).toBeGreaterThan(0)
    expect(outcome.canUseToolCalls).toHaveLength(0)
    expect(anyNotification(outcome)).toBe(false)
  })
})
