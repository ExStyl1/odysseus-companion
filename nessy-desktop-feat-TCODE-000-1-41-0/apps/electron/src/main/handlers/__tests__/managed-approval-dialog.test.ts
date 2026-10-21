import { describe, expect, test } from 'bun:test'
import { salvageDeliveredPayload } from '@nessy-agent/shared/config/managed-delivery'
import { managedPayloadDigest } from '@nessy-agent/shared/config/managed-approval'
import { createManagedApprovalGate } from '../managed-approval-dialog'

const NEEDS_APPROVAL = {
  schemaVersion: 1,
  env: { ANTHROPIC_API_KEY: 'sk-super-secret', HTTPS_PROXY: 'http://user:hunter2@proxy:3128' },
}
const SAFE = { schemaVersion: 1, deniedMcpServers: ['blocked'] }

function harness(response: number) {
  const shown: Array<{ detail: string; message: string; buttons: string[] }> = []
  let rejected = 0
  const gate = createManagedApprovalGate({
    showMessageBox: async (options) => {
      shown.push({ detail: options.detail, message: options.message, buttons: options.buttons })
      return { response }
    },
    onReject: () => { rejected += 1 },
    mode: 'interactive',
  })
  return { gate, shown, rejected: () => rejected }
}

describe('the managed approval dialog', () => {
  test('approving applies, persists and stamps the digest', async () => {
    const salvage = salvageDeliveredPayload(NEEDS_APPROVAL)
    const { gate, shown, rejected } = harness(0)
    const verdict = await gate(salvage, {})
    expect(verdict).toEqual({
      apply: true,
      persist: true,
      approvedDigest: managedPayloadDigest(salvage.payload),
    })
    expect(shown).toHaveLength(1)
    expect(rejected()).toBe(0)
  })

  test('rejecting applies nothing and quits the app (:216)', async () => {
    const { gate, rejected } = harness(1)
    const verdict = await gate(salvageDeliveredPayload(NEEDS_APPROVAL), {})
    expect(verdict).toEqual({ apply: false, persist: false })
    expect(rejected()).toBe(1)
  })

  test('the modal never renders a delivered value', async () => {
    const { gate, shown } = harness(0)
    await gate(salvageDeliveredPayload(NEEDS_APPROVAL), {})
    const rendered = JSON.stringify(shown[0])
    expect(rendered).not.toContain('sk-super-secret')
    expect(rendered).not.toContain('hunter2')
    expect(rendered).toContain('ANTHROPIC_API_KEY')
  })

  test('a payload needing no approval never opens a modal', async () => {
    const { gate, shown } = harness(1)
    expect(await gate(salvageDeliveredPayload(SAFE), {})).toEqual({ apply: true, persist: true })
    expect(shown).toHaveLength(0)
  })

  test('an already-approved payload is not re-prompted', async () => {
    const salvage = salvageDeliveredPayload(NEEDS_APPROVAL)
    const { gate, shown } = harness(1)
    const verdict = await gate(salvage, { approvedDigest: managedPayloadDigest(salvage.payload) })
    expect(verdict.apply).toBe(true)
    expect(shown).toHaveLength(0)
  })

  test('a headless run applies for that run only and never prompts (:221)', async () => {
    let shown = 0
    const gate = createManagedApprovalGate({
      showMessageBox: async () => { shown += 1; return { response: 0 } },
      onReject: () => { throw new Error('must not exit a headless run') },
      mode: 'non-interactive',
    })
    expect(await gate(salvageDeliveredPayload(NEEDS_APPROVAL), {}))
      .toEqual({ apply: true, persist: false })
    expect(shown).toBe(0)
  })

  test('a session that cannot show the dialog keeps the last approved settings (:218)', async () => {
    const gate = createManagedApprovalGate({
      showMessageBox: async () => { throw new Error('must not be called') },
      onReject: () => { throw new Error('must not exit') },
      mode: 'interactive-unavailable',
    })
    expect(await gate(salvageDeliveredPayload(NEEDS_APPROVAL), {}))
      .toEqual({ apply: false, persist: false })
  })
})
