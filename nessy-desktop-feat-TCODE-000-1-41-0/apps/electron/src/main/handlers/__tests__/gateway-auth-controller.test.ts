import { describe, it, expect } from 'bun:test'
import { createGatewayAuthController } from '../nessy-auth'
import { DpAuthError, DpAuthServiceError, type GatewayAuthStatus } from '@nessy-agent/shared/auth/dp'

describe('createGatewayAuthController', () => {
  it('maps facade success to { ok, username } and never leaks the jwt', async () => {
    const controller = createGatewayAuthController({
      ensure: async () => ({ jwt: 'secret-jwt', username: 'a.user' }),
      broadcastStatus: () => {},
    })
    const result = await controller.ensure()
    expect(result).toEqual({ ok: true, username: 'a.user' })
    expect(JSON.stringify(result)).not.toContain('secret-jwt')
  })

  it('maps a DpAuthServiceError to { ok: false, code }', async () => {
    const controller = createGatewayAuthController({
      ensure: async () => {
        throw new DpAuthServiceError(DpAuthError.DpNotFound, 'dp not found — contact corp IT')
      },
      broadcastStatus: () => {},
    })
    const result = await controller.ensure()
    expect(result).toEqual({ ok: false, code: DpAuthError.DpNotFound })
  })

  it('forwards facade status codes to broadcastStatus', async () => {
    const statuses: GatewayAuthStatus[] = []
    const controller = createGatewayAuthController({
      ensure: async (opts) => {
        opts?.onStatus?.('checking')
        opts?.onStatus?.('waiting-browser')
        opts?.onStatus?.('done')
        return { jwt: 'j', username: 'u' }
      },
      broadcastStatus: (s) => statuses.push(s as GatewayAuthStatus),
    })
    await controller.ensure()
    expect(statuses).toEqual(['checking', 'waiting-browser', 'done'])
  })

  it('cancel() aborts the run signal', async () => {
    let seenSignal: AbortSignal | undefined
    const controller = createGatewayAuthController({
      ensure: (opts) =>
        new Promise((_resolve, reject) => {
          seenSignal = opts?.signal
          opts?.signal?.addEventListener('abort', () =>
            reject(new DpAuthServiceError(DpAuthError.Cancelled, 'cancelled')),
          )
        }),
      broadcastStatus: () => {},
    })
    const pending = controller.ensure()
    // Let the ensure body run and register its abort listener.
    await Promise.resolve()
    controller.cancel()
    const result = await pending
    expect(seenSignal?.aborted).toBe(true)
    expect(result).toEqual({ ok: false, code: DpAuthError.Cancelled })
  })

  it('shares one run across concurrent ensure() calls', async () => {
    let runs = 0
    const controller = createGatewayAuthController({
      ensure: async () => {
        runs += 1
        await new Promise((r) => setTimeout(r, 20))
        return { jwt: 'j', username: 'shared' }
      },
      broadcastStatus: () => {},
    })
    const [a, b] = await Promise.all([controller.ensure(), controller.ensure()])
    expect(runs).toBe(1)
    expect(a).toEqual({ ok: true, username: 'shared' })
    expect(b).toEqual({ ok: true, username: 'shared' })
  })

  // Final-review finding 2 (dp-auth-resilience): forceRefresh:true (T5) skips
  // BOTH the warm cached-creds path and the nessy-cli seed (T6). A user whose
  // creds legitimately came from nessy-cli, with dp missing/outdated, would
  // see the explicit Sign-in fail even though a usable cached/seeded JWT
  // exists — unless a non-cancel failure falls back to one non-forced,
  // non-interactive attempt that reaches the warm path and the seed.
  describe('Sign-in fallback to the warm/seed path', () => {
    it('reports success from the warm/seed path when the forced attempt fails', async () => {
      const seen: Array<{ forceRefresh?: boolean; interactive?: boolean }> = []
      const controller = createGatewayAuthController({
        ensure: async (opts) => {
          seen.push({ forceRefresh: opts?.forceRefresh, interactive: opts?.interactive })
          if (opts?.forceRefresh) {
            throw new DpAuthServiceError(DpAuthError.ExecFailed, 'dp login failed')
          }
          return { jwt: 'seeded-jwt', username: 'cli-user' }
        },
        broadcastStatus: () => {},
      })

      const result = await controller.ensure()

      expect(result).toEqual({ ok: true, username: 'cli-user' })
      // The primary attempt is forced+interactive-default; the fallback is
      // explicitly non-forced AND non-interactive — it must not re-run the
      // interactive dp login the forced attempt already tried and failed.
      expect(seen).toEqual([
        { forceRefresh: true, interactive: undefined },
        { forceRefresh: false, interactive: false },
      ])
    })

    it('never falls back after a user cancellation — reports Cancelled, not a fallback result', async () => {
      let calls = 0
      const controller = createGatewayAuthController({
        ensure: async () => {
          calls += 1
          throw new DpAuthServiceError(DpAuthError.Cancelled, 'cancelled')
        },
        broadcastStatus: () => {},
      })

      const result = await controller.ensure()

      expect(result).toEqual({ ok: false, code: DpAuthError.Cancelled })
      expect(calls).toBe(1)
    })

    it('reports the forced attempt failure when the fallback also fails, not a false success', async () => {
      const controller = createGatewayAuthController({
        ensure: async (opts) => {
          if (opts?.forceRefresh) throw new DpAuthServiceError(DpAuthError.DpNotFound, 'dp not found')
          throw new DpAuthServiceError(DpAuthError.NeedsLogin, 'no warm creds or seed')
        },
        broadcastStatus: () => {},
      })

      const result = await controller.ensure()

      expect(result).toEqual({ ok: false, code: DpAuthError.DpNotFound })
    })
  })
})
