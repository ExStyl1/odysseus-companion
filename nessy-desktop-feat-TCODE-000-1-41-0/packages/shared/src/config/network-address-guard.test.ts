/**
 * `tools-reference.md` on Monitor's ws source: "Claude Code denies URLs that
 * point at a private, link-local, or cloud-metadata address, including hostnames
 * that resolve to one. It also denies hosts in `sandbox.network.deniedDomains`,
 * and when `allowManagedDomainsOnly` is set in managed settings, any host
 * outside the managed allowlist."
 *
 * All four clauses. The third — "including hostnames that resolve to one" — is
 * the one a naive implementation misses, so it gets the most cases.
 */
import { describe, expect, test } from 'bun:test'
import { isDeniedNetworkTarget, validateWsWatchInput } from './network-address-guard.ts'

const neverResolves = async (host: string): Promise<string[]> => {
  throw new Error(`unexpected DNS lookup for ${host}`)
}

const check = (host: string, options: Partial<Parameters<typeof isDeniedNetworkTarget>[1]> = {}) =>
  isDeniedNetworkTarget(host, { resolve: neverResolves, deniedDomains: [], ...options })

describe('literal addresses', () => {
  const denied: [string, string][] = [
    ['127.0.0.1', 'loopback'],
    ['127.5.5.5', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['169.254.1.1', 'link-local'],
    ['169.254.169.254', 'cloud metadata'],
    ['[::1]', 'loopback'],
    ['::1', 'loopback'],
    ['fd00::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['[fd00:ec2::254]', 'cloud metadata'],
  ]

  for (const [host, expectation] of denied) {
    test(`denies ${host} (${expectation})`, async () => {
      const result = await check(host)
      expect(result.denied).toBe(true)
      expect(result.reason).toBeString()
      expect(result.reason!.length).toBeGreaterThan(0)
    })
  }

  const allowed = ['93.184.216.34', '8.8.8.8', '172.32.0.1', '[2606:2800:220:1:248:1893:25c8:1946]']
  for (const host of allowed) {
    test(`allows the public address ${host}`, async () => {
      expect(await check(host)).toEqual({ denied: false })
    })
  }
})

describe('hostnames that RESOLVE to a blocked address', () => {
  test('denies a hostname resolving to the cloud-metadata address', async () => {
    const result = await check('metadata.internal.example.test', {
      resolve: async () => ['169.254.169.254'],
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain('169.254.169.254')
  })

  test('denies when ANY resolved address is blocked, not only the first', async () => {
    const result = await check('split.example.test', {
      resolve: async () => ['93.184.216.34', '10.1.2.3'],
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain('10.1.2.3')
  })

  test('allows a hostname that resolves only to public addresses', async () => {
    expect(await check('example.test', { resolve: async () => ['93.184.216.34'] }))
      .toEqual({ denied: false })
  })

  test('denies a hostname that resolves to nothing rather than connecting blind', async () => {
    const result = await check('void.example.test', { resolve: async () => [] })
    expect(result.denied).toBe(true)
  })

  test('denies when resolution fails', async () => {
    const result = await check('broken.example.test', { resolve: async () => { throw new Error('ENOTFOUND') } })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain('ENOTFOUND')
  })
})

describe('deniedDomains', () => {
  test('denies an exact host and its subdomains without a DNS lookup', async () => {
    expect((await check('blocked.example.test', { deniedDomains: ['blocked.example.test'] })).denied).toBe(true)
    expect((await check('api.blocked.example.test', { deniedDomains: ['blocked.example.test'] })).denied).toBe(true)
  })

  test('the documented wildcard form matches, and a bare star does not', async () => {
    // `settings.md`'s `deniedDomains` row: "Supports the same wildcard syntax as
    // `allowedDomains`", whose row gives `*.example.com`. That spelling used to
    // match NOTHING — it was compared literally, so no host equalled it and none
    // ended with `.*.example.com`. An administrator writing the documented form
    // got an entry that silently did not apply, which on a DENY list is
    // under-enforcement.
    //
    // ASSERT THE REASON, NOT `denied`. A host that fails to match the deny list
    // falls through to `resolve`, `neverResolves` throws, and the guard returns
    // `denied: true` with a *resolution* reason — so a `denied` assertion passes
    // whether the wildcard matched or not. The first draft of this test did
    // exactly that and survived its own mutation probe.
    const denied = ['*.blocked.example.test']
    const byList = /deniedDomains/
    expect((await check('api.blocked.example.test', { deniedDomains: denied })).reason).toMatch(byList)
    expect((await check('deep.api.blocked.example.test', { deniedDomains: denied })).reason).toMatch(byList)
    // The apex too: `settings.md` pairs "github.com" with "*.npmjs.org" in one
    // example as if they were the same kind of entry, and on a deny list the
    // wider reading is the safer one.
    expect((await check('blocked.example.test', { deniedDomains: denied })).reason).toMatch(byList)

    // A lookalike still must not match through the wildcard.
    expect((await check('notblocked.example.test', {
      deniedDomains: denied,
      resolve: async () => ['93.184.216.34'],
    })).denied).toBe(false)

    // A bare `*` denies NOTHING rather than everything. An allowlist that
    // silently became "allow all" from one typo is the worse failure, and this
    // matcher serves both lists.
    expect((await check('anything.at.all', {
      deniedDomains: ['*'],
      resolve: async () => ['93.184.216.34'],
    })).denied).toBe(false)
  })

  test('does not deny a lookalike suffix', async () => {
    expect(await check('notblocked.example.test', {
      deniedDomains: ['blocked.example.test'],
      resolve: async () => ['93.184.216.34'],
    })).toEqual({ denied: false })
  })

  test('is case- and trailing-dot-insensitive', async () => {
    expect((await check('BLOCKED.Example.Test.', { deniedDomains: ['blocked.example.test'] })).denied).toBe(true)
  })
})

describe('allowManagedDomainsOnly', () => {
  test('denies a host outside the managed allowlist', async () => {
    const result = await check('other.example.test', { managedAllowlist: ['inside.example.test'] })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain('managed')
  })

  test('allows a host inside the managed allowlist, and its subdomains', async () => {
    expect(await check('inside.example.test', {
      managedAllowlist: ['inside.example.test'],
      resolve: async () => ['93.184.216.34'],
    })).toEqual({ denied: false })
    expect(await check('a.inside.example.test', {
      managedAllowlist: ['inside.example.test'],
      resolve: async () => ['93.184.216.34'],
    })).toEqual({ denied: false })
  })

  test('the same host is allowed when the flag is off (no allowlist passed)', async () => {
    expect(await check('other.example.test', { resolve: async () => ['93.184.216.34'] }))
      .toEqual({ denied: false })
  })

  test('an EMPTY managed allowlist denies everything rather than allowing everything', async () => {
    expect((await check('anything.example.test', { managedAllowlist: [] })).denied).toBe(true)
  })

  test('the allowlist never rescues a blocked address class', async () => {
    const result = await check('inside.example.test', {
      managedAllowlist: ['inside.example.test'],
      resolve: async () => ['169.254.169.254'],
    })
    expect(result.denied).toBe(true)
  })

  test('the allowlist never overrides deniedDomains', async () => {
    expect((await check('inside.example.test', {
      managedAllowlist: ['inside.example.test'],
      deniedDomains: ['inside.example.test'],
    })).denied).toBe(true)
  })
})

describe('a literal IP is a host — deny rules and allowlists apply (R3)', () => {
  // `tools-reference.md:303` binds all three deny rules to the URL's HOST, and
  // a raw IP is a host. The guard used to return early for any literal IP that
  // was not blocked outright, so a caller could walk around a managed
  // allowlist — a documented DENY — by writing the address instead of the name.
  //
  // EVERY case asserts the REASON, not just the verdict: the wildcard-domain
  // fix on this same file survived its own mutation probe until the test
  // pinned the reason.

  test('deniedDomains naming the exact address denies the literal IP', async () => {
    const result = await check('93.184.216.34', { deniedDomains: ['93.184.216.34'] })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain('deniedDomains')
  })

  test('under allowManagedDomainsOnly a public literal IP outside the allowlist is DENIED, not promptable', async () => {
    // An allowlist of NAMES cannot admit a raw IP.
    const result = await check('93.184.216.34', { managedAllowlist: ['corp.example.test'] })
    expect(result.denied).toBe(true)
    expect(result.reason).toBe('93.184.216.34 is outside the managed domain allowlist')
  })

  test('an allowlist entry naming the exact address admits it, with no DNS lookup', async () => {
    // `resolve` is `neverResolves`: a literal address has nothing to resolve,
    // so an admitted IP must return without touching DNS.
    expect(await check('93.184.216.34', { managedAllowlist: ['93.184.216.34'] }))
      .toEqual({ denied: false })
  })

  test('a blocked address class is denied FIRST, even when a list names it', async () => {
    const result = await check('169.254.169.254', { managedAllowlist: ['169.254.169.254'] })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain('cloud-metadata')
  })

  test('the same posture applies to an IPv6 literal', async () => {
    const result = await check('[2606:2800:220:1:248:1893:25c8:1946]', {
      managedAllowlist: ['corp.example.test'],
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain('managed domain allowlist')
  })
})

describe('validateWsWatchInput — the ws field rules (tools-reference.md:296-297)', () => {
  test('accepts a plain ws/wss URL and valid distinct subprotocol tokens', () => {
    expect(validateWsWatchInput({ url: 'wss://events.example.test/stream' })).toEqual({ ok: true })
    expect(validateWsWatchInput({
      url: 'ws://events.example.test/stream',
      protocols: ['chat', 'chat.v2', 'x-corp+log'],
    })).toEqual({ ok: true })
  })

  test('refuses embedded credentials, and the reason never echoes them', () => {
    for (const url of [
      'ws://user:secret@93.184.216.34/stream',
      'wss://user@events.example.test/stream',
    ]) {
      const verdict = validateWsWatchInput({ url })
      expect(verdict.ok).toBe(false)
      expect(verdict.reason).toContain('credentials')
      expect(verdict.reason).not.toContain('secret')
      expect(verdict.reason).not.toContain('user')
      expect(verdict.reason).not.toContain(url)
    }
  })

  test('refuses whitespace and non-ASCII characters in the url', () => {
    for (const url of [
      'ws://events.example.test/a b',
      'ws://events.example.test/\ttab',
      'ws://пример.example.test/stream',
    ]) {
      const verdict = validateWsWatchInput({ url })
      expect(verdict.ok).toBe(false)
      expect(verdict.reason).toContain('ASCII')
    }
  })

  test('refuses a non-ws scheme and an unparseable url', () => {
    expect(validateWsWatchInput({ url: 'https://events.example.test/s' }).reason)
      .toContain('must use ws: or wss:')
    expect(validateWsWatchInput({ url: 'not-a-url' }).reason).toContain('not a valid URL')
  })

  test('refuses an invalid subprotocol token and a duplicate entry, by index', () => {
    // The challenger started a watch with `['a b', 'dup', 'dup']`.
    const invalid = validateWsWatchInput({
      url: 'ws://events.example.test/s',
      protocols: ['a b', 'dup', 'dup'],
    })
    expect(invalid.ok).toBe(false)
    expect(invalid.reason).toBe('ws protocols[0] is not a valid subprotocol token')

    const duplicate = validateWsWatchInput({
      url: 'ws://events.example.test/s',
      protocols: ['dup', 'dup'],
    })
    expect(duplicate.ok).toBe(false)
    expect(duplicate.reason).toBe('ws protocols[1] duplicates an earlier entry')
  })
})
