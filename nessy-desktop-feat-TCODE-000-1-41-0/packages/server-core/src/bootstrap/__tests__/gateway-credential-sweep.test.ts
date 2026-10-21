/**
 * DA1.33 — the one-shot startup sweep for the credential snapshot DA1.13
 * stopped writing.
 *
 * The rig injects both reads, so nothing here touches a keychain or an on-disk
 * config: the sweep's two collaborators are a connection list and a delete, and
 * the once-per-process flag deliberately lives at the bootstrap CALL SITE rather
 * than inside the function, which is what lets these cases drive it repeatedly
 * without a test-only knob.
 *
 * NO REAL CREDENTIAL ANYWHERE: the fake store holds slugs only, and the
 * assertions are on WHICH SLUGS were asked for — never a value, never a length.
 */
import { describe, expect, it } from 'bun:test'
import { sweepOrphanedGatewayCredentialSnapshots } from '../headless-start'

const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1'

function silentLogger() {
  const info: string[] = []
  const warn: string[] = []
  return { info: (m: string) => { info.push(m) }, warn: (m: string) => { warn.push(m) }, lines: { info, warn } }
}

describe('sweepOrphanedGatewayCredentialSnapshots (DA1.33)', () => {
  it('deletes the snapshot of every gateway-backed card and counts them', async () => {
    const asked: string[] = []
    const logger = silentLogger()

    const discarded = await sweepOrphanedGatewayCredentialSnapshots(logger, {
      connections: () => [
        { slug: 'nessy-gateway', providerType: 'pi_compat', baseUrl: GATEWAY_BASE_URL },
        { slug: 'claude-gateway', providerType: 'claude-runtime', baseUrl: GATEWAY_BASE_URL },
        { slug: 'codex-gateway', providerType: 'codex-runtime', baseUrl: GATEWAY_BASE_URL },
      ],
      deleteApiKey: async (slug) => { asked.push(slug); return true },
    })

    expect(asked).toEqual(['nessy-gateway', 'claude-gateway', 'codex-gateway'])
    expect(discarded).toBe(3)
    // A COUNT and nothing else — no slug's credential, no length, no value.
    expect(logger.lines.info).toHaveLength(1)
    expect(logger.lines.info[0]).toContain('Discarded 3 orphaned gateway credential snapshot(s)')
  })

  it('never touches a BYO connection, including one on the gateway HOST', async () => {
    // The scope is `isGatewayBackedConnection`, the STRICT whole-URL predicate —
    // the same one the setup RPC uses — so an endpoint that merely lives on the
    // gateway host keeps the user's own key. This is the arm that would turn a
    // tidiness sweep into a credential loss if the predicate were widened.
    const asked: string[] = []
    const logger = silentLogger()

    const discarded = await sweepOrphanedGatewayCredentialSnapshots(logger, {
      connections: () => [
        { slug: 'byo-under-prefix', providerType: 'pi_compat', baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/byo-proxy/v1' },
        { slug: 'byo-elsewhere', providerType: 'claude-runtime', baseUrl: 'https://llm-proxy.t-tech.team' },
        { slug: 'no-endpoint', providerType: 'codex-runtime' },
        { slug: 'anthropic-key', providerType: 'anthropic', baseUrl: GATEWAY_BASE_URL },
      ],
      deleteApiKey: async (slug) => { asked.push(slug); return true },
    })

    expect(asked).toEqual([])
    expect(discarded).toBe(0)
    expect(logger.lines.info).toEqual([])
  })

  it('says nothing when there is nothing to discard', async () => {
    const logger = silentLogger()
    const discarded = await sweepOrphanedGatewayCredentialSnapshots(logger, {
      connections: () => [{ slug: 'nessy-gateway', providerType: 'pi_compat', baseUrl: GATEWAY_BASE_URL }],
      deleteApiKey: async () => false,
    })
    expect(discarded).toBe(0)
    expect(logger.lines.info).toEqual([])
  })

  it('a keychain that throws warns and does not stop the boot', async () => {
    // Never throws: the entry it would have removed is INERT either way, so an
    // unreadable keychain is not a reason to refuse to start.
    const logger = silentLogger()
    const discarded = await sweepOrphanedGatewayCredentialSnapshots(logger, {
      connections: () => { throw new Error('config unreadable') },
      deleteApiKey: async () => true,
    })
    expect(discarded).toBe(0)
    expect(logger.lines.warn).toHaveLength(1)
    expect(logger.lines.warn[0]).toContain('config unreadable')
  })
})
