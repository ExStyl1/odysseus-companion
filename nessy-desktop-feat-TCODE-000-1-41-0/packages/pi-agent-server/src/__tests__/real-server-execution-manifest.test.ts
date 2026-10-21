import { describe, expect, it } from 'bun:test'
import {
  createRealServerAllowPermissionReceipt,
  createRealServerExecutionManifest,
} from './real-server-execution-manifest.ts'

/**
 * F1.1137 — the real-server allow receipt echoes the request's
 * `manifestResponseEpoch`, as `support/pi-permission-receipt-fixture.ts` does.
 * It used to default the epoch to 1, so every real-server test passed only
 * because none rebuilt its session; the first one that did would read as a
 * false "Pi permission receipt responseEpoch mismatch".
 */
describe('createRealServerAllowPermissionReceipt (F1.1137)', () => {
  const manifest = createRealServerExecutionManifest({ workspaceId: 'ws-f1-1137', sessionId: 'session-f1-1137' })
  const tool = manifest.tools[0]!
  const request = (manifestResponseEpoch: number) => ({
    requestId: 'pi-ptu-f1-1137',
    piName: tool.binding.piName,
    semanticId: tool.descriptor.id,
    input: {},
    manifestResponseEpoch,
  })

  it('echoes a rebuilt session epoch rather than a default', () => {
    expect(createRealServerAllowPermissionReceipt(manifest, request(2)).manifest.responseEpoch).toBe(2)
  })

  it('CONTROL: the first epoch is echoed as itself', () => {
    expect(createRealServerAllowPermissionReceipt(manifest, request(1)).manifest.responseEpoch).toBe(1)
  })
})
