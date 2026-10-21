import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureGatewayAuthForLaunch,
  shouldPromptGatewayLogin,
  runGatewayLoginCheck,
  readNessyGatewayJwt,
  type GatewayAuthStatusEvent,
} from '../nessy-auth'
import { isGatewayBackedConnection } from '@nessy-agent/shared/agent/backend'
import { DpAuthError, DpAuthServiceError, saveCreds } from '@nessy-agent/shared/auth/dp'

const GATEWAY_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1'

// DA1.31 — this file used to test a LOCAL gateway predicate declared beside the
// launch check, the third of four hand-kept copies of the same rule. The copy is
// gone; what these cases now pin is that the module's three exported helpers
// read the ONE exported rule, so they assert `isGatewayBackedConnection`
// directly and the behavioural cases below drive it through those helpers.
describe('the gateway rule the launch check reads (DA1.31)', () => {
  it('matches pi_compat on the gateway baseUrl', () => {
    expect(isGatewayBackedConnection({ providerType: 'pi_compat', baseUrl: GATEWAY_URL })).toBe(true)
  })
  it('does not match pi_compat on a different baseUrl', () => {
    expect(isGatewayBackedConnection({ providerType: 'pi_compat', baseUrl: 'https://other' })).toBe(false)
  })
  // Final-review finding 1 (dp-auth-resilience): claude-runtime and
  // codex-runtime share the same dp flow and Nestor-Token JWT as pi_compat,
  // so the launch-seed/prompt path (this rule gates BOTH
  // ensureGatewayAuthForLaunch and shouldPromptGatewayLogin) must see them too.
  it('matches claude-runtime and codex-runtime on the gateway baseUrl', () => {
    expect(isGatewayBackedConnection({ providerType: 'claude-runtime', baseUrl: GATEWAY_URL })).toBe(true)
    expect(isGatewayBackedConnection({ providerType: 'codex-runtime', baseUrl: GATEWAY_URL })).toBe(true)
  })
  it('does not match claude-runtime or codex-runtime on a BYO endpoint', () => {
    expect(isGatewayBackedConnection({ providerType: 'claude-runtime', baseUrl: 'https://other' })).toBe(false)
    expect(isGatewayBackedConnection({ providerType: 'codex-runtime', baseUrl: 'https://other' })).toBe(false)
    expect(isGatewayBackedConnection({ providerType: 'codex-runtime' })).toBe(false)
  })
  it('ignores unrelated providers', () => {
    expect(isGatewayBackedConnection({ providerType: 'anthropic' })).toBe(false)
  })

  // The TWO differences DA1.31 introduced at this site, each driven through the
  // helper rather than through the rule, so they pin the SITE and not the import.
  it('the comparison is normalised, so a trailing slash is still the gateway', () => {
    // The removed local copy compared with a raw equality and answered false here.
    expect(shouldPromptGatewayLogin([{ providerType: 'pi_compat', baseUrl: `${GATEWAY_URL}/` }], false)).toBe(true)
  })
  it('an endpoint-less connection is still not the gateway', () => {
    // The strict form's floor: no baseUrl is not a match, so no dp prompt is
    // raised for a connection that names no endpoint at all.
    expect(shouldPromptGatewayLogin([{ providerType: 'pi_compat' }], false)).toBe(false)
  })
})

describe('shouldPromptGatewayLogin', () => {
  it('prompts when a gateway connection exists and creds are missing', () => {
    const conns = [{ providerType: 'pi_compat', baseUrl: GATEWAY_URL }]
    expect(shouldPromptGatewayLogin(conns, false)).toBe(true)
  })
  it('does not prompt when creds are valid', () => {
    const conns = [{ providerType: 'pi_compat', baseUrl: GATEWAY_URL }]
    expect(shouldPromptGatewayLogin(conns, true)).toBe(false)
  })
  it('does not prompt when no gateway connection exists', () => {
    const conns = [{ providerType: 'anthropic' }]
    expect(shouldPromptGatewayLogin(conns, false)).toBe(false)
  })
})

describe('runGatewayLoginCheck', () => {
  it('broadcasts login-required exactly once when a prompt is needed', () => {
    const events: GatewayAuthStatusEvent[] = []
    const prompted = runGatewayLoginCheck({
      connections: [{ providerType: 'pi_compat', baseUrl: GATEWAY_URL }],
      hasValidCreds: false,
      broadcast: (s) => events.push(s),
    })
    expect(prompted).toBe(true)
    expect(events).toEqual(['login-required'])
  })
  it('broadcasts nothing when creds are valid', () => {
    const events: GatewayAuthStatusEvent[] = []
    const prompted = runGatewayLoginCheck({
      connections: [{ providerType: 'pi_compat', baseUrl: GATEWAY_URL }],
      hasValidCreds: true,
      broadcast: (s) => events.push(s),
    })
    expect(prompted).toBe(false)
    expect(events).toEqual([])
  })
})

describe('ensureGatewayAuthForLaunch', () => {
  it('returns true without probing dp when cached creds are valid', async () => {
    let calls = 0
    const valid = await ensureGatewayAuthForLaunch({
      connections: [{ providerType: 'pi_compat', baseUrl: GATEWAY_URL }],
      hasValidCreds: true,
      ensure: async () => {
        calls += 1
        return { jwt: 'jwt', username: 'u' }
      },
    })
    expect(valid).toBe(true)
    expect(calls).toBe(0)
  })

  it('skips dp probing when no gateway connection exists', async () => {
    let calls = 0
    const valid = await ensureGatewayAuthForLaunch({
      // anthropic is not one of the three gateway-backed provider types
      // (pi_compat/claude-runtime/codex-runtime) — a genuinely unrelated
      // connection, unlike codex-runtime which IS gateway-backed (finding 1).
      connections: [{ providerType: 'anthropic', baseUrl: GATEWAY_URL }],
      hasValidCreds: false,
      ensure: async () => {
        calls += 1
        return { jwt: 'jwt', username: 'u' }
      },
    })
    expect(valid).toBe(false)
    expect(calls).toBe(0)
  })

  // Final-review finding 1: this exact path (ensureGatewayAuthForLaunch) was
  // the one the bug named — a codex-gateway-only user's launch never reached
  // the nessy-cli seed (T6) because the predicate then in place rejected
  // codex-runtime outright.
  it('silently refreshes missing creds for a codex-gateway launch check', async () => {
    const seen: Array<{ interactive?: boolean }> = []
    const valid = await ensureGatewayAuthForLaunch({
      connections: [{ providerType: 'codex-runtime', baseUrl: GATEWAY_URL }],
      hasValidCreds: false,
      ensure: async (opts) => {
        seen.push({ interactive: opts?.interactive })
        return { jwt: 'jwt', username: 'u' }
      },
    })
    expect(valid).toBe(true)
    expect(seen).toEqual([{ interactive: false }])
  })

  it('silently refreshes missing creds for Pi gateway launch checks', async () => {
    const seen: Array<{ interactive?: boolean }> = []
    const valid = await ensureGatewayAuthForLaunch({
      connections: [{ providerType: 'pi_compat', baseUrl: GATEWAY_URL }],
      hasValidCreds: false,
      ensure: async (opts) => {
        seen.push({ interactive: opts?.interactive })
        return { jwt: 'jwt', username: 'u' }
      },
    })
    expect(valid).toBe(true)
    expect(seen).toEqual([{ interactive: false }])
  })

  it('returns false when the silent Pi gateway probe needs interactive login', async () => {
    const valid = await ensureGatewayAuthForLaunch({
      connections: [{ providerType: 'pi_compat', baseUrl: GATEWAY_URL }],
      hasValidCreds: false,
      ensure: async () => {
        throw new DpAuthServiceError(DpAuthError.NeedsLogin)
      },
    })
    expect(valid).toBe(false)
  })
})

describe('re-auth propagation to existing consumers', () => {
  it('readNessyGatewayJwt returns the new jwt after saveCreds rewrites the file', () => {
    // Explicit temp path — never touches the real ~/.nessy/dp_auth_creds.json.
    const credsPath = join(mkdtempSync(join(tmpdir(), 'nessy-reauth-')), 'dp_auth_creds.json')
    expect(readNessyGatewayJwt(credsPath)).toBeNull()

    // JWT-shaped (3 non-empty dot-separated segments) — readNessyGatewayJwt now
    // guards with isJwtShaped, so a placeholder like the old 'fresh-jwt' would
    // read as absent.
    saveCreds({ jwt: 'header.fresh-jwt.signature', expiresAt: Date.now() + 100000, username: 'u', userId: 'i' }, credsPath)
    expect(readNessyGatewayJwt(credsPath)).toEqual({ jwt: 'header.fresh-jwt.signature' })

    saveCreds({ jwt: 'header.newer-jwt.signature', expiresAt: Date.now() + 100000, username: 'u', userId: 'i' }, credsPath)
    expect(readNessyGatewayJwt(credsPath)).toEqual({ jwt: 'header.newer-jwt.signature' })
  })
})

describe('readNessyGatewayJwt jwt shape guard', () => {
  it('reads a non-JWT jwt value as absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-jwt-'))
    const path = join(dir, 'dp_auth_creds.json')
    writeFileSync(path, JSON.stringify({ jwt: 'sk-not-a-jwt-token', expiresAt: Date.now() + 86_400_000 }))
    expect(readNessyGatewayJwt(path)).toBeNull()
  })
})
