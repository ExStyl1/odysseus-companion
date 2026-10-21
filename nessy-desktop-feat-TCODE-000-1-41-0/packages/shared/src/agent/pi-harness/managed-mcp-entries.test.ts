import { describe, expect, test } from 'bun:test'
import {
  isManagedMcpServerAllowed,
  matchesManagedMcpUrlPattern,
  parseManagedPiPolicyTolerantV1,
  parseManagedPiPolicyV1,
} from './managed-policy.ts'

/**
 * The page's own § *Example configuration* block (`managed-mcp.md:193`-`:209`),
 * transcribed verbatim.
 *
 * It is the fixture the whole unit exists for: before S5 the three deny entries
 * parsed to an EMPTY denylist and the administrator saw an accepted policy file
 * that blocked nothing.
 */
export const DOCUMENTED_EXAMPLE_POLICY = {
  allowedMcpServers: [
    { serverUrl: 'https://api.githubcopilot.com/*' },
    { serverUrl: 'https://mcp.sentry.dev/*' },
    { serverCommand: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '.'] },
    { serverCommand: ['python', '/usr/local/bin/approved-server.py'] },
    { serverUrl: 'https://mcp.example.com/*' },
    { serverUrl: 'https://*.internal.example.com/*' },
  ],
  deniedMcpServers: [
    { serverName: 'dangerous-server' },
    { serverCommand: ['npx', '-y', 'unapproved-package'] },
    { serverUrl: 'https://*.untrusted.example.com/*' },
  ],
} as const

const tolerant = (extra: Record<string, unknown>) => parseManagedPiPolicyTolerantV1(
  { schemaVersion: 1, disabledPermissionModes: [], ...extra },
  { source: '/etc/nessy/managed-policy.json' },
)

const strict = (extra: Record<string, unknown>) => parseManagedPiPolicyV1(
  { schemaVersion: 1, disabledPermissionModes: [], ...extra },
)

describe('the documented managed MCP entry', () => {
  test('the page\'s own example policy survives parsing, entry for entry', () => {
    const { policy, drops } = tolerant(DOCUMENTED_EXAMPLE_POLICY)

    expect(drops).toEqual([])
    expect(policy.deniedMcpServers).toEqual([
      { serverName: 'dangerous-server' },
      { serverCommand: ['npx', '-y', 'unapproved-package'] },
      { serverUrl: 'https://*.untrusted.example.com/*' },
    ])
    expect(policy.allowedMcpServers).toHaveLength(6)
  })

  test('a bare string is still read as { serverName }', () => {
    // Our deployed `managed-policy.json` shape. Dropping it to gain the
    // documented one would break the administrators we already have.
    expect(strict({ allowedMcpServers: ['github'], deniedMcpServers: ['dangerous'] })).toMatchObject({
      allowedMcpServers: [{ serverName: 'github' }],
      deniedMcpServers: [{ serverName: 'dangerous' }],
    })
  })

  test('an entry needs exactly one key, and the allowlist refuses a second', () => {
    // `:132` — "an object with a single key".
    const { policy, drops } = tolerant({
      allowedMcpServers: [{ serverName: 'github', serverUrl: 'https://mcp.example.com/*' }],
    })
    expect(policy.allowedMcpServers).toEqual([])
    expect(drops).toHaveLength(1)
    expect(drops[0]).toMatchObject({ field: 'allowedMcpServers[0]', disposition: 'stripped' })
  })

  test('the DENYLIST enforces every valid key of a multi-key entry instead of un-blocking both', () => {
    // The sharp edge. Stripping an allowlist entry narrows and is safe;
    // stripping a DENY entry unblocks a server the administrator wrote down.
    // Each key it carries names a server by hand, so honouring all of them
    // blocks nothing "the policy never named" (the `deniedMcpServers` row of
    // `managed-settings.md#keys-that-fail-closed`).
    const { policy, drops } = tolerant({
      deniedMcpServers: [{ serverName: 'dangerous', serverUrl: 'https://evil.example.com/*' }],
    })
    expect(policy.deniedMcpServers).toEqual([
      { serverUrl: 'https://evil.example.com/*' },
      { serverName: 'dangerous' },
    ])
    expect(drops).toHaveLength(1)
    expect(drops[0]).toMatchObject({ field: 'deniedMcpServers[0]', disposition: 'tightened' })
  })

  test('a deny entry with a typo beside a good key keeps the good key', () => {
    const { policy, drops } = tolerant({
      deniedMcpServers: [{ serverName: 'dangerous', serverNmae: 'oops' }],
    })
    expect(policy.deniedMcpServers).toEqual([{ serverName: 'dangerous' }])
    expect(drops[0]).toMatchObject({ field: 'deniedMcpServers[0]', disposition: 'tightened' })
    expect(drops[0]?.reason).toContain('serverNmae')
  })

  test('a deny entry with nothing usable in it is stripped, and says the server is not blocked', () => {
    // The one case with nothing to salvage. The `deniedMcpServers` row rules out
    // reading it as "block everything" and
    // `managed-settings.md#invalid-entries-in-managed-settings` rules out
    // refusing the document ("…keeps enforcing every remaining valid key"), so
    // the documented strip stands — visibly.
    const { policy, drops } = tolerant({ deniedMcpServers: [{}, { serverUrl: 42 }, 'ok'] })
    expect(policy.deniedMcpServers).toEqual([{ serverName: 'ok' }])
    expect(drops.map(drop => drop.field)).toEqual(['deniedMcpServers[0]', 'deniedMcpServers[1]'])
    for (const drop of drops) {
      expect(drop.disposition).toBe('stripped')
      expect(drop.reason).toContain('NOT blocked')
    }
  })

  test('serverName validation differs by list', () => {
    // `:155` — deny takes "any non-empty string, so you can block claude.ai
    // connectors by their display name". `:156` — allow is restricted.
    expect(tolerant({ deniedMcpServers: [{ serverName: 'claude.ai Slack' }] }).policy.deniedMcpServers)
      .toEqual([{ serverName: 'claude.ai Slack' }])

    const allow = tolerant({ allowedMcpServers: [{ serverName: 'claude.ai Slack' }] })
    expect(allow.policy.allowedMcpServers).toEqual([])
    expect(allow.drops[0]).toMatchObject({ field: 'allowedMcpServers[0]', disposition: 'stripped' })

    // Neither list takes an empty name or a control character.
    expect(tolerant({ deniedMcpServers: [{ serverName: '  ' }, { serverName: 'a\nb' }] })
      .policy.deniedMcpServers).toEqual([])
  })

  test('a wholly invalid list still moves the two keys in OPPOSITE directions', () => {
    // The `allowedMcpServers` row against the `deniedMcpServers` row of
    // `managed-settings.md#keys-that-fail-closed`, now over the entry schema.
    const allow = tolerant({ allowedMcpServers: { nope: true } })
    expect(allow.policy.allowedMcpServers).toEqual([])
    expect(allow.drops[0]).toMatchObject({ field: 'allowedMcpServers', disposition: 'emptied' })

    const deny = tolerant({ deniedMcpServers: { nope: true } })
    expect(deny.policy.deniedMcpServers).toBeUndefined()
    expect(deny.drops[0]).toMatchObject({ field: 'deniedMcpServers', disposition: 'stripped' })
    expect(deny.drops[0]?.reason).toContain('no server is blocked by it')
  })

  test('the strict tier still throws on every one of those defects', () => {
    // `managed-settings.md#keys-that-fail-closed` — "This tolerance applies only
    // to managed settings. User, project, and local settings files remain
    // strict".
    for (const defect of [
      { deniedMcpServers: { nope: true } },
      { deniedMcpServers: [{}] },
      { deniedMcpServers: [{ serverName: 'x', serverUrl: 'https://x/*' }] },
      { allowedMcpServers: [{ serverName: 'claude.ai Slack' }] },
      { allowedMcpServers: [{ serverCommand: [] }] },
    ]) {
      expect(() => strict(defect)).toThrow()
    }
  })

  test('entries are bounded and de-duplicated', () => {
    expect(tolerant({ deniedMcpServers: ['dupe', { serverName: 'dupe' }] }).policy.deniedMcpServers)
      .toEqual([{ serverName: 'dupe' }])
    expect(() => strict({
      allowedMcpServers: Array.from({ length: 129 }, (_, index) => `server-${index}`),
    })).toThrow()
    expect(() => strict({ deniedMcpServers: [{ serverCommand: ['a'.repeat(1025)] }] })).toThrow()
    expect(() => strict({ deniedMcpServers: [{ serverUrl: 'https://ex ample.com' }] })).toThrow()
  })

  /**
   * P2.199 — THE CEILING IS 128, AND THIS SUITE CAN NOW SEE IT MOVE.
   *
   * Measured before these two cases existed: narrowing `MCP_ENTRIES_MAX` from
   * 128 to 64 left this file at 22 pass / 0 fail. Every assertion above is
   * about a list that is over ANY plausible ceiling (129 entries throws at 64
   * too), so none of them can distinguish one bound from another — the suite
   * that owns the two bounded paths could not see its own ceiling.
   *
   * `managed-policy.test.ts` pins the allowlist boundary from outside. The two
   * paths THIS file owns are the ones below, and each is pinned from both
   * sides: the last accepted size and the first rejected one. Re-measured with
   * the constant narrowed to 64, both fail.
   */
  test('the DENYLIST bound is 128 exactly, from both sides', () => {
    // `parseManagedMcpEntryList`'s first gate, on the deny pole: the whole
    // field is DROPPED rather than emptied, so an over-long denylist blocks
    // NOTHING. That makes the last accepted size the load-bearing number —
    // a silently narrowed ceiling turns a valid 128-entry denylist into an
    // absent one.
    const atCeiling = tolerant({
      deniedMcpServers: Array.from({ length: 128 }, (_, index) => `deny-${index}`),
    })
    expect(atCeiling.policy.deniedMcpServers).toHaveLength(128)
    // Identity, not just arity: the last entry the ceiling admits is the 128th.
    expect(atCeiling.policy.deniedMcpServers?.at(-1)).toEqual({ serverName: 'deny-127' })
    expect(atCeiling.drops).toEqual([])

    const overCeiling = tolerant({
      deniedMcpServers: Array.from({ length: 129 }, (_, index) => `deny-${index}`),
    })
    expect(overCeiling.policy.deniedMcpServers).toBeUndefined()
    expect(overCeiling.drops[0]).toMatchObject({ field: 'deniedMcpServers', disposition: 'stripped' })
    expect(overCeiling.drops[0]?.reason).toContain('no server is blocked by it')

    // And the strict tier refuses the same 129 rather than dropping it, while
    // still accepting the 128 the tolerant tier keeps.
    expect(() => strict({
      deniedMcpServers: Array.from({ length: 129 }, (_, index) => `deny-${index}`),
    })).toThrow()
    expect(strict({
      deniedMcpServers: Array.from({ length: 128 }, (_, index) => `deny-${index}`),
    }).deniedMcpServers).toHaveLength(128)
  })

  test('the per-entry drop path stops at the 128th KEPT entry, not the 128th raw one', () => {
    // The second bounded path, and the only one reachable with a
    // schema-legal-sized array: a multi-key DENY entry is reinterpreted into
    // one deny per valid key (the pole above this file's `:132` reading), so
    // 43 raw entries yield 129 kept ones. `value.length` is 43 and sails past
    // the first gate; the `kept.length >= MCP_ENTRIES_MAX` guard is what has
    // to stop it.
    const raws = Array.from({ length: 43 }, (_, index) => ({
      serverName: `multi-${index}`,
      serverUrl: `https://multi-${index}.example.com/*`,
      serverCommand: ['npx', `multi-${index}`],
    }))
    const { policy, drops } = tolerant({ deniedMcpServers: raws })
    expect(raws).toHaveLength(43)
    expect(policy.deniedMcpServers).toHaveLength(128)
    // Identity of the boundary, and the half of it a length check cannot see:
    // the keys of one entry are enforced in `MCP_ENTRY_KEYS` order, so with 126
    // kept the 43rd entry's serverUrl (127) and serverCommand (128) get in and
    // its serverName is the one cut. A ceiling that moved would cut in a
    // different entry, and a reordered `MCP_ENTRY_KEYS` would silently change
    // WHICH deny is the one lost.
    expect(policy.deniedMcpServers?.at(-2)).toEqual({ serverUrl: 'https://multi-42.example.com/*' })
    expect(policy.deniedMcpServers?.at(-1)).toEqual({ serverCommand: ['npx', 'multi-42'] })
    expect(policy.deniedMcpServers?.some(entry => 'serverName' in entry
      && entry.serverName === 'multi-42')).toBe(false)
    // The overflow is REPORTED, at the entry it happened on, naming the bound.
    const overflow = drops.filter(drop => drop.reason.includes('exceeds'))
    expect(overflow).toHaveLength(1)
    expect(overflow[0]).toMatchObject({ field: 'deniedMcpServers[42]', disposition: 'stripped' })
    expect(overflow[0]?.reason).toBe('managed Pi policy deniedMcpServers exceeds 128 entries')
  })
})

/* ------------------------------------------------------------------------- *
 * Matching — `managed-mcp.md:173`-`:187`
 * ------------------------------------------------------------------------- */

const REMOTE = (url: string, name = 'remote') => ({ name, transport: 'http' as const, url })
const STDIO = (command: readonly string[], name = 'local') => ({ name, transport: 'stdio' as const, command })

/** A policy that carries only the two MCP lists. */
const lists = (extra: Record<string, unknown>) => strict(extra)

describe('managed MCP matching', () => {
  test('every row of the documented URL pattern table', () => {
    // `:179`-`:185`.
    const rows: Array<[string, string, boolean, string]> = [
      ['https://mcp.example.com/*', 'https://mcp.example.com/api', true, 'all paths on a specific domain'],
      ['https://mcp.example.com', 'https://mcp.example.com/api/v2', true, 'a pattern with no path matches any path'],
      ['https://*.example.com/*', 'https://api.internal.example.com/mcp', true, 'any subdomain'],
      ['https://*.internal.example.com/*', 'https://external.example.com/mcp', false, 'a different subdomain'],
      ['http://localhost:*/*', 'http://localhost:3000/mcp', true, 'any port on localhost'],
      ['*://mcp.example.com/*', 'https://mcp.example.com/api', true, 'any scheme'],
      // `:177` — host case-insensitive, trailing FQDN dot ignored.
      ['https://Mcp.Example.com/*', 'https://mcp.example.com/api', true, 'host case-insensitive'],
      ['https://mcp.example.com/*', 'https://mcp.example.com./api', true, 'trailing FQDN dot ignored'],
      // `:177` — "Paths stay case-sensitive".
      ['https://mcp.example.com/API/*', 'https://mcp.example.com/api/x', false, 'paths stay case-sensitive'],
      // A wildcard in the authority must not eat the `/` and reach the path.
      ['https://*.example.com/*', 'https://evil.test/x.example.com/mcp', false, 'authority glob cannot cross the path'],
    ]
    for (const [pattern, url, expected, why] of rows) {
      expect(`${why}: ${matchesManagedMcpUrlPattern(pattern, url)}`).toBe(`${why}: ${expected}`)
    }
  })

  test('commands match exactly, every argument in order', () => {
    // `:175`'s own negative cases.
    const policy = lists({ deniedMcpServers: [{ serverCommand: ['npx', '-y', 'server'] }] })
    expect(isManagedMcpServerAllowed(policy, STDIO(['npx', '-y', 'server']))).toBe(false)
    expect(isManagedMcpServerAllowed(policy, STDIO(['npx', 'server']))).toBe(true)
    expect(isManagedMcpServerAllowed(policy, STDIO(['npx', '-y', 'server', '--flag']))).toBe(true)
  })

  test('P3.217 — a server with a RESOLVED spelling is judged on both, and on nothing else', () => {
    // The built-in dp set is CONFIGURED as `dp ai mcp <sub>` and SPAWNED as
    // `<resolved dp> ai mcp <sub>`. Both are true argvs of one server, so an
    // administrator may write the deny either way; before this the resolved
    // spelling — the one `which dp` prints — matched nothing at all.
    const BOTH = {
      name: 'dpGitlab',
      transport: 'stdio' as const,
      command: ['dp', 'ai', 'mcp', 'gitlab'],
      alternateCommands: [['/usr/local/bin/dp', 'ai', 'mcp', 'gitlab']],
    }
    const deniedBy = (serverCommand: readonly string[]) =>
      !isManagedMcpServerAllowed(lists({ deniedMcpServers: [{ serverCommand }] }), BOTH)

    expect(deniedBy(['dp', 'ai', 'mcp', 'gitlab'])).toBe(true)
    expect(deniedBy(['/usr/local/bin/dp', 'ai', 'mcp', 'gitlab'])).toBe(true)

    // NEGATIVE CONTROLS. `:175` — "Commands match exactly. Every argument, in
    // order" — still governs each comparison; the identity gained a spelling,
    // the matcher gained no prefix, suffix or basename tolerance.
    const misses: Array<readonly string[]> = [
      ['/usr/local/bin/dp', 'ai', 'mcp', 'jira'],
      ['/opt/homebrew/bin/dp', 'ai', 'mcp', 'gitlab'],
      ['dp', 'ai', 'mcp'],
      ['/usr/local/bin/dp', 'ai', 'mcp', 'gitlab', '--verbose'],
      ['dpx', 'ai', 'mcp', 'gitlab'],
      ['/usr/local/bin/dp'],
    ]
    for (const serverCommand of misses) {
      expect(`${serverCommand.join(' ')} denies: ${deniedBy(serverCommand)}`)
        .toBe(`${serverCommand.join(' ')} denies: false`)
    }

    // A server that declares only ONE spelling is unchanged — the alternate is
    // an identity a caller supplies, never one the matcher invents. This is what
    // keeps the capability mirror's narrower identity honest instead of
    // accidentally widened.
    expect(isManagedMcpServerAllowed(
      lists({ deniedMcpServers: [{ serverCommand: ['/usr/local/bin/dp', 'ai', 'mcp', 'gitlab'] }] }),
      STDIO(['dp', 'ai', 'mcp', 'gitlab'], 'dpGitlab'),
    )).toBe(true)

    // The allowlist half of `:170`/`:171`: a stdio server is admitted by a
    // `serverCommand` entry, and the resolved spelling is one.
    expect(isManagedMcpServerAllowed(
      lists({ allowedMcpServers: [{ serverCommand: ['/usr/local/bin/dp', 'ai', 'mcp', 'gitlab'] }] }),
      BOTH,
    )).toBe(true)
    expect(isManagedMcpServerAllowed(
      lists({ allowedMcpServers: [{ serverCommand: ['/usr/local/bin/dp', 'ai', 'mcp', 'jira'] }] }),
      BOTH,
    )).toBe(false)
  })

  test('${VAR} expands on BOTH sides for url and command, and never for name', () => {
    // `:176`. The environment is passed explicitly so the test never depends on
    // the machine it runs on.
    const environment = { HOME: '/opt/corp', HOST: 'mcp.example.com' }
    const policy = lists({
      deniedMcpServers: [
        { serverCommand: ['${HOME}/bin/server'] },
        { serverUrl: 'https://${HOST}/*' },
        { serverName: '${HOME}' },
      ],
    })
    // Entry references a variable, server config is literal.
    expect(isManagedMcpServerAllowed(policy, STDIO(['/opt/corp/bin/server']), environment)).toBe(false)
    // Server config references it, entry too.
    expect(isManagedMcpServerAllowed(policy, STDIO(['${HOME}/bin/server']), environment)).toBe(false)
    expect(isManagedMcpServerAllowed(policy, REMOTE('https://mcp.example.com/api'), environment)).toBe(false)
    // `serverName` matches literally and never expands.
    expect(isManagedMcpServerAllowed(policy, { name: '/opt/corp' }, environment)).toBe(true)
    expect(isManagedMcpServerAllowed(policy, { name: '${HOME}' }, environment)).toBe(false)
  })

  test('P2.375 — a variable cannot widen an allowlist URL entry', () => {
    // `managed-mcp.md#how-policy-entries-expand`, the `allowedMcpServers` row of
    // its table. Column: "Expansion that would change a URL entry's scheme,
    // host, or path scope". Cell: "Claude Code ignores the entry".
    const environment = { SCHEME: 'https', HOST: 'mcp.example.com', TEAM: 'sales' }
    const admits = (serverUrl: string, url: string) => isManagedMcpServerAllowed(
      lists({ allowedMcpServers: [{ serverUrl }] }),
      REMOTE(url),
      environment,
    )

    // Each of the three scope dimensions on its own. Every one of these entries
    // expands to a pattern that DOES cover the server — that is the point: the
    // grant is refused because a variable decided it, not because it missed.
    expect(admits('${SCHEME}://mcp.example.com/*', 'https://mcp.example.com/api')).toBe(false)
    expect(admits('https://${HOST}/*', 'https://mcp.example.com/api')).toBe(false)
    expect(admits('https://mcp.example.com/${TEAM}/*', 'https://mcp.example.com/sales/x')).toBe(false)
    // A `:-default` is no exemption: the administrator's default is what the
    // variable falls back to, not what it is pinned to.
    expect(admits('https://${HOST:-mcp.example.com}/*', 'https://mcp.example.com/api')).toBe(false)
    // Unsetting the variable leaves the token literal, so a text comparison
    // would call this "unchanged". It is still a variable-decided scope.
    expect(admits('https://${UNSET_HOST}/*', 'https://mcp.example.com/api')).toBe(false)

    // The ignored entry is still PRESENT. `:170` lets a `serverName` entry stand
    // in only when the allowlist has no `serverUrl` entries, and dropping this
    // one from that count would admit through the name what the URL entry was
    // guarding — a variable widening the allowlist by the other door.
    expect(isManagedMcpServerAllowed(
      lists({ allowedMcpServers: [{ serverUrl: 'https://${HOST}/*' }, { serverName: 'remote' }] }),
      REMOTE('https://mcp.example.com/api'),
      environment,
    )).toBe(false)

    // CONTROL — an expansion that changes nothing. A literal entry is the
    // resolution the page prescribes and the guard never touches it.
    expect(admits('https://mcp.example.com/*', 'https://mcp.example.com/api')).toBe(true)
    expect(admits('https://mcp.example.com/*', 'https://other.example.com/api')).toBe(false)
  })

  test('P2.397 — the guard is URL-ONLY, and a ${VAR} argv entry still admits', () => {
    // The counterpart of the test above, and the measured decision rather than
    // an oversight. Both sources were read before this case was written:
    //
    //  - `managed-mcp.md#how-policy-entries-expand` (re-fetched 2026-09-03)
    //    names one column, "Expansion that would change a URL entry's scheme,
    //    host, or path scope", and gives no command-side column or row.
    //  - The shipped binary (`claudeCodeVersion 2.1.247`, AHEAD of the
    //    section's "Requires Claude Code v2.1.219 or later") computes an
    //    `unsafeExpansion` verdict in the URL expander only. The command
    //    expander returns `{ expanded, missingVars }`, the allowlist's command
    //    branch reports the telemetry pair with that flag hard-coded false,
    //    and no argv entry is ever skipped.
    //
    // So a guard here would make us NARROWER than the vendor on a policy the
    // vendor accepts. This case exists so that adding one is a visible red
    // rather than a quiet fleet-wide narrowing.
    const environment = { BIN: '/opt/tools', HOME: '/home/dev' }
    const admits = (serverCommand: readonly string[], argv: readonly string[]) =>
      isManagedMcpServerAllowed(
        lists({ allowedMcpServers: [{ serverCommand }] }),
        STDIO(argv),
        environment,
      )

    // A variable decides argument 0 — the executable itself, the argv analogue
    // of "host" — and the entry still matches. This is the exact shape the URL
    // case above refuses.
    expect(admits(['${BIN}/server'], ['/opt/tools/server'])).toBe(true)
    expect(admits(['${HOME}/bin/server'], ['/home/dev/bin/server'])).toBe(true)
    // `:-default` likewise.
    expect(admits(['${BIN:-/opt/tools}/server'], ['/opt/tools/server'])).toBe(true)
    // And an UNSET variable, where the URL side treats the surviving literal as
    // variable-decided, is here just a literal that has to match verbatim.
    expect(admits(['${UNSET}/server'], ['/opt/tools/server'])).toBe(false)
    expect(admits(['${UNSET}/server'], ['${UNSET}/server'])).toBe(true)
    // `:175`'s exact match is untouched by any of this — no guard does not mean
    // no matching rule.
    expect(admits(['${BIN}/server'], ['/opt/tools/server', '--flag'])).toBe(false)
  })

  test('P2.375 — a variable cannot steer a denylist URL entry off its target', () => {
    // The same table's `deniedMcpServers` row, the opposite cell: "The entry
    // still matches". Opposite on purpose — a variable may neither widen an
    // allow nor let anything escape a deny.
    const denies = (
      serverUrl: string,
      url: string,
      environment: Record<string, string>,
    ) => !isManagedMcpServerAllowed(lists({ deniedMcpServers: [{ serverUrl }] }), REMOTE(url), environment)

    // What the administrator's shell had when the policy was written, and what
    // a user sets instead to walk past it.
    const written = { SCHEME: 'https', HOST: 'internal.example.com', TEAM: 'sales' }
    const steered = { SCHEME: 'ftp', HOST: 'nowhere.invalid', TEAM: 'decoy' }
    const TARGET = 'https://internal.example.com/sales/x'

    // Host, scheme, and path scope, each steered on its own.
    expect(denies('https://${HOST}/*', TARGET, written)).toBe(true)
    expect(denies('https://${HOST}/*', TARGET, steered)).toBe(true)
    expect(denies('${SCHEME}://internal.example.com/*', TARGET, steered)).toBe(true)
    expect(denies('https://internal.example.com/${TEAM}/*', TARGET, steered)).toBe(true)
    // Unsetting is the cheapest steer of all, and it is refused too.
    expect(denies('https://${UNSET_HOST}/*', TARGET, {})).toBe(true)

    // The widening is the VARIABLE'S SPAN and nothing more: every literal
    // character the administrator typed still has to match.
    expect(denies('https://internal.example.com/${TEAM}/*', 'https://other.example.com/sales/x', steered))
      .toBe(false)
    expect(denies('https://${HOST}/sales/*', 'https://internal.example.com/finance/x', steered)).toBe(false)

    // CONTROL — an expansion that changes nothing. A literal deny still denies
    // exactly what it names and nothing else.
    expect(denies('https://internal.example.com/*', TARGET, steered)).toBe(true)
    expect(denies('https://internal.example.com/*', 'https://other.example.com/mcp', steered)).toBe(false)
  })

  test('a serverUrl deny survives the rename that defeats a serverName deny', () => {
    // The whole reason the URL dimension exists. `:150` — the name "is the
    // label a user assigns … so a user can call any server `github`".
    const byName = lists({ deniedMcpServers: [{ serverName: 'untrusted' }] })
    const byUrl = lists({ deniedMcpServers: [{ serverUrl: 'https://*.untrusted.example.com/*' }] })
    const renamed = REMOTE('https://api.untrusted.example.com/mcp', 'totally-fine')

    expect(isManagedMcpServerAllowed(byName, renamed)).toBe(true)
    expect(isManagedMcpServerAllowed(byUrl, renamed)).toBe(false)
  })

  test('the page\'s example policy blocks all three of its deny entries', () => {
    // The mutation probe target: delete the matcher and this test must fail.
    const policy = strict(DOCUMENTED_EXAMPLE_POLICY)
    expect(isManagedMcpServerAllowed(policy, { name: 'dangerous-server' })).toBe(false)
    expect(isManagedMcpServerAllowed(policy, STDIO(['npx', '-y', 'unapproved-package']))).toBe(false)
    expect(isManagedMcpServerAllowed(policy, REMOTE('https://evil.untrusted.example.com/mcp'))).toBe(false)
    // And its allowlist still admits what it lists.
    expect(isManagedMcpServerAllowed(policy, REMOTE('https://api.githubcopilot.com/mcp/'))).toBe(true)
    expect(isManagedMcpServerAllowed(policy, STDIO(['python', '/usr/local/bin/approved-server.py']))).toBe(true)
  })

  test('nothing overrides a denylist match', () => {
    // `:165`, and the "Allowlist with denylist override" accordion at `:290`.
    const policy = lists({
      allowedMcpServers: [{ serverUrl: 'https://*.example.com/*' }],
      deniedMcpServers: [{ serverUrl: 'https://staging.example.com/*' }],
    })
    expect(isManagedMcpServerAllowed(policy, REMOTE('https://mcp.example.com/api'))).toBe(true)
    expect(isManagedMcpServerAllowed(policy, REMOTE('https://staging.example.com/api'))).toBe(false)
    expect(isManagedMcpServerAllowed(policy, REMOTE('https://other.com/mcp'))).toBe(false)
  })

  test('the type-dependent allowlist, one case per documented accordion row', () => {
    // `:170`/`:171` and the four accordions at `:219`-`:288`.
    const urlOnly = lists({
      allowedMcpServers: [
        { serverUrl: 'https://mcp.example.com/*' },
        { serverUrl: 'https://*.internal.example.com/*' },
      ],
    })
    expect(isManagedMcpServerAllowed(urlOnly, REMOTE('https://mcp.example.com/api'))).toBe(true)
    expect(isManagedMcpServerAllowed(urlOnly, REMOTE('https://api.internal.example.com/mcp'))).toBe(true)
    expect(isManagedMcpServerAllowed(urlOnly, REMOTE('https://external.example.com/mcp'))).toBe(false)
    expect(isManagedMcpServerAllowed(urlOnly, STDIO(['anything']))).toBe(false)

    const commandOnly = lists({ allowedMcpServers: [{ serverCommand: ['npx', '-y', 'approved-package'] }] })
    expect(isManagedMcpServerAllowed(commandOnly, STDIO(['npx', '-y', 'approved-package']))).toBe(true)
    expect(isManagedMcpServerAllowed(commandOnly, STDIO(['node', 'server.js']))).toBe(false)
    expect(isManagedMcpServerAllowed(commandOnly, REMOTE('https://api.test/mcp', 'my-api'))).toBe(false)

    const mixed = lists({
      allowedMcpServers: [{ serverName: 'github' }, { serverCommand: ['npx', '-y', 'approved-package'] }],
    })
    expect(isManagedMcpServerAllowed(mixed, STDIO(['npx', '-y', 'approved-package'], 'local-tool'))).toBe(true)
    expect(isManagedMcpServerAllowed(mixed, STDIO(['node', 'server.js'], 'local-tool'))).toBe(false)
    // "Blocked: stdio servers must match commands when command entries exist."
    expect(isManagedMcpServerAllowed(mixed, STDIO(['node', 'server.js'], 'github'))).toBe(false)
    // "Allowed: matches name" — no serverUrl entry displaces it for a remote.
    expect(isManagedMcpServerAllowed(mixed, REMOTE('https://api.test/mcp', 'github'))).toBe(true)
    expect(isManagedMcpServerAllowed(mixed, REMOTE('https://api.test/mcp', 'other-api'))).toBe(false)

    const nameOnly = lists({
      allowedMcpServers: [{ serverName: 'github' }, { serverName: 'internal-tool' }],
    })
    expect(isManagedMcpServerAllowed(nameOnly, STDIO(['anything'], 'github'))).toBe(true)
    expect(isManagedMcpServerAllowed(nameOnly, STDIO(['anything'], 'internal-tool'))).toBe(true)
    expect(isManagedMcpServerAllowed(nameOnly, REMOTE('https://api.test/mcp', 'github'))).toBe(true)
    expect(isManagedMcpServerAllowed(nameOnly, { name: 'other' })).toBe(false)
  })

  test('a server whose type cannot be proven is admitted only by a name-only allowlist', () => {
    // Not in the table: the identity carries neither URL nor command, so we
    // cannot show it matches the stricter kind. The enforcing pole is to refuse.
    const nameOnly = lists({ allowedMcpServers: [{ serverName: 'github' }] })
    expect(isManagedMcpServerAllowed(nameOnly, { name: 'github' })).toBe(true)

    const withStricter = lists({
      allowedMcpServers: [{ serverName: 'github' }, { serverUrl: 'https://mcp.example.com/*' }],
    })
    expect(isManagedMcpServerAllowed(withStricter, { name: 'github' })).toBe(false)
    // A deny still reaches it by name.
    expect(isManagedMcpServerAllowed(
      lists({ deniedMcpServers: [{ serverName: 'github' }] }),
      { name: 'github' },
    )).toBe(false)
  })
})

describe('managed MCP evaluation order and the unset/empty distinction', () => {
  const SERVER = REMOTE('https://mcp.example.com/api', 'github')

  test('every row of the documented unset/empty/populated table', () => {
    // `:140` — "Leaving `allowedMcpServers` unset is different from setting it
    // to an empty array", and the table at `:142`-`:145`.
    //
    // allowedMcpServers: unset = all allowed, [] = NO servers allowed,
    //                    populated = only matching.
    expect(isManagedMcpServerAllowed(lists({}), SERVER)).toBe(true)
    expect(isManagedMcpServerAllowed(lists({ allowedMcpServers: [] }), SERVER)).toBe(false)
    expect(isManagedMcpServerAllowed(
      lists({ allowedMcpServers: [{ serverUrl: 'https://mcp.example.com/*' }] }),
      SERVER,
    )).toBe(true)
    expect(isManagedMcpServerAllowed(
      lists({ allowedMcpServers: [{ serverUrl: 'https://other.example.com/*' }] }),
      SERVER,
    )).toBe(false)

    // deniedMcpServers: unset AND [] both mean nothing blocked;
    //                   populated = matching blocked.
    expect(isManagedMcpServerAllowed(lists({ deniedMcpServers: [] }), SERVER)).toBe(true)
    expect(isManagedMcpServerAllowed(
      lists({ deniedMcpServers: [{ serverUrl: 'https://mcp.example.com/*' }] }),
      SERVER,
    )).toBe(false)
  })

  test('an EMPTY allowlist is distinguishable from an absent one on the parsed policy', () => {
    // The distinction has to survive parsing, not just matching: `[]` is a
    // written decision and `undefined` is the absence of one.
    expect(strict({ allowedMcpServers: [] }).allowedMcpServers).toEqual([])
    expect(strict({}).allowedMcpServers).toBeUndefined()
    expect(strict({ deniedMcpServers: [] }).deniedMcpServers).toEqual([])
    expect(strict({}).deniedMcpServers).toBeUndefined()
  })

  test('an INVALID allowlist already lands on the empty row, and that is correct', () => {
    // R25a's tolerant parse emits `[]` for a wholly invalid grant list, which is
    // exactly what the `allowedMcpServers` row of
    // `managed-settings.md#keys-that-fail-closed` prescribes — "Enforced as an
    // empty allowlist until the value is fixed, so no MCP servers that users add
    // are admitted" — AND the `:144` empty-array row of `managed-mcp.md`. Pinned
    // rather than rediscovered.
    const { policy } = tolerant({ allowedMcpServers: 'not-a-list' })
    expect(policy.allowedMcpServers).toEqual([])
    expect(isManagedMcpServerAllowed(policy, SERVER)).toBe(false)
  })

  test('the denylist is checked first, and a match is terminal in every combination', () => {
    // `:165` — "Nothing overrides a denylist match." Including an allowlist
    // entry of the STRICTER kind, which is the strongest admission there is.
    const policy = lists({
      allowedMcpServers: [{ serverUrl: 'https://mcp.example.com/*' }],
      deniedMcpServers: [{ serverName: 'github' }],
    })
    expect(isManagedMcpServerAllowed(policy, SERVER)).toBe(false)

    // And a deny by command over an allow by the same command.
    const stdio = lists({
      allowedMcpServers: [{ serverCommand: ['npx', '-y', 'pkg'] }],
      deniedMcpServers: [{ serverCommand: ['npx', '-y', 'pkg'] }],
    })
    expect(isManagedMcpServerAllowed(stdio, STDIO(['npx', '-y', 'pkg']))).toBe(false)
  })
})
