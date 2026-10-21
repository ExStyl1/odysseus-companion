/**
 * L5, second half — a refused panel control has to be REPORTED.
 *
 * `useAgentPanel` ended every control in `.catch(() => null)` and never read
 * `ok`, so `child-session-not-active`, `child-session-not-running` and
 * `pi-child-service-unavailable` all rendered as a cleared input box: the user
 * saw their follow-up disappear and could not tell it from a delivered one
 * (`docs/testing/cdp-live-checklist.md`, AGT-2, 2026-07-30).
 *
 * Both refusal shapes are asserted because the panel meets both: the child
 * service THROWS its refusals, and the control result carries `{ok: false}` for
 * the ones the host answers with.
 */
import { describe, expect, test } from 'bun:test'
import type { PiHarnessRuntimeControlRequestV1, PiHarnessRuntimeControlResultV1 } from '@nessy-agent/core/types'
import { runAgentPanelControl } from '../useAgentPanel'

const request: PiHarnessRuntimeControlRequestV1 = {
  schemaVersion: 1,
  session: { workspaceId: 'w', sessionId: 's' },
  action: 'steer_child',
  agentId: 'fork-1',
  message: 'also check the parser tests',
}

describe('runAgentPanelControl', () => {
  test('a thrown refusal is reported with the code that names it', async () => {
    for (const code of ['child-session-not-active', 'child-session-not-running', 'pi-child-service-unavailable']) {
      const outcome = await runAgentPanelControl(async () => { throw new Error(code) }, request)
      expect(outcome).toEqual({ ok: false, reason: code })
    }
  })

  test('an ok:false result is reported, and a refusal with no message still names something', async () => {
    const answered = await runAgentPanelControl(
      async () => ({ schemaVersion: 1, ok: false, error: 'checkpoint-rewind-failed' }) as PiHarnessRuntimeControlResultV1,
      request,
    )
    expect(answered).toEqual({ ok: false, reason: 'checkpoint-rewind-failed' })

    const silent = await runAgentPanelControl(
      async () => ({ schemaVersion: 1, ok: false }) as PiHarnessRuntimeControlResultV1,
      request,
    )
    expect(silent).toEqual({ ok: false, reason: 'unknown-error' })
  })

  test('a delivered control returns its result unchanged', async () => {
    const result = { schemaVersion: 1, ok: true, output: 'hello', nextCursor: 5 } as PiHarnessRuntimeControlResultV1
    expect(await runAgentPanelControl(async () => result, request)).toEqual({ ok: true, result })
  })
})
