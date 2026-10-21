/**
 * P2.398 — an administrator can see that a policy entry was neutralised.
 *
 * P2.375 landed the two fail-directions of
 * `managed-mcp.md#how-policy-entries-expand` (anchor read off the rendered
 * page; `#how-a-server-is-evaluated` and
 * `#match-servers-by-url-command-or-name` are the positive controls on the same
 * fetch). Its table gives them in one row — column "Expansion that would change
 * a URL entry's scheme, host, or path scope", `allowedMcpServers` → "Claude
 * Code ignores the entry", `deniedMcpServers` → "The entry still matches" — and
 * both happen SILENTLY. Nothing told the operator that the allowlist they wrote
 * grants less than it reads, or that the denylist blocks more.
 *
 * `ManagedPolicyDropV1` cannot say it: `stripped`, `emptied` and `tightened`
 * all mean *not applied*, and neither of these is a drop. The deny side is
 * applied MORE broadly than written. So the caveat is its own type with its own
 * heading, and this file is what keeps it from reporting the wrong thing —
 * which would be worse than reporting nothing.
 *
 * Fixtures here are URLs, not filesystem paths, so the executor refusal harness
 * this lane self-tests lives in `managed-mcp-pinned-environment.test.ts`
 * alongside the home-shaped values that need it.
 */
import { describe, expect, test } from 'bun:test'
import {
  collectManagedPolicyCaveats,
  DEFAULT_MANAGED_PI_POLICY,
  formatManagedPolicyCaveat,
  formatManagedPolicyCaveatSummary,
  isManagedMcpServerAllowed,
  parseManagedPiPolicyV1,
  reportManagedPolicyCaveats,
  type ManagedMcpServerIdentityV1,
  type ManagedPiPolicyV1,
} from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { resolveEnforcedManagedPolicy } from '../managed-policy-resolution.ts'

const lists = (extra: Record<string, unknown>): ManagedPiPolicyV1 => parseManagedPiPolicyV1({
  schemaVersion: 1,
  disabledPermissionModes: [],
  ...extra,
})

const REMOTE = (url: string): ManagedMcpServerIdentityV1 => ({
  name: 'remote',
  transport: 'http',
  url,
})

/** The environment the administrator's shell had when the policy was written. */
const WRITTEN = { SCHEME: 'https', HOST: 'internal.example.com', TEAM: 'sales' }

describe('P2.398 — the two cases that earn a caveat', () => {
  test('an allowlist URL entry a variable decides is retained, admitting nothing', () => {
    const policy = lists({ allowedMcpServers: [{ serverUrl: 'https://${HOST}/*' }] })

    expect(collectManagedPolicyCaveats(policy)).toEqual([{
      field: 'allowedMcpServers[0]',
      entry: 'https://${HOST}/*',
      disposition: 'retained-admitting-nothing',
    }])

    // The caveat is not a guess about the gate — the gate agrees. The entry
    // expands to a pattern that DOES cover this server, and the grant is still
    // refused, which is exactly what "admits nothing" claims.
    expect(isManagedMcpServerAllowed(
      policy,
      REMOTE('https://internal.example.com/api'),
      WRITTEN,
    )).toBe(false)
  })

  test('a denylist URL entry a variable decides is retained, WIDENED', () => {
    const policy = lists({ deniedMcpServers: [{ serverUrl: 'https://internal.example.com/${TEAM}/*' }] })

    expect(collectManagedPolicyCaveats(policy)).toEqual([{
      field: 'deniedMcpServers[0]',
      entry: 'https://internal.example.com/${TEAM}/*',
      disposition: 'retained-widened',
    }])

    // "MORE than the text describes" is the load-bearing half of that sentence,
    // and this is what makes it true: the entry as written names `/sales/`, and
    // the enforced entry blocks a path the administrator never wrote.
    expect(isManagedMcpServerAllowed(
      policy,
      REMOTE('https://internal.example.com/marketing/x'),
      WRITTEN,
    )).toBe(false)
    // Every LITERAL character still has to match, so the widening is the
    // variable's own span and not the whole entry.
    expect(isManagedMcpServerAllowed(
      policy,
      REMOTE('https://elsewhere.example.com/sales/x'),
      WRITTEN,
    )).toBe(true)
  })

  test('both lists at once, in policy order', () => {
    const policy = lists({
      allowedMcpServers: [
        { serverUrl: 'https://mcp.example.com/*' },
        { serverUrl: 'https://${HOST}/*' },
      ],
      deniedMcpServers: [
        { serverUrl: 'https://${HOST}/admin/*' },
        { serverUrl: 'https://blocked.example.com/*' },
      ],
    })
    expect(collectManagedPolicyCaveats(policy).map(caveat => [caveat.field, caveat.disposition]))
      .toEqual([
        ['allowedMcpServers[1]', 'retained-admitting-nothing'],
        ['deniedMcpServers[0]', 'retained-widened'],
      ])
  })
})

describe('P2.398 — what must NOT earn a caveat', () => {
  test('a literal entry, which P2.375 deliberately keeps outside the guard', () => {
    // The whole reason the guard is a comparison rather than "contains a `${`":
    // an administrator who followed the page's own advice sees no change, and
    // must not be handed a warning about an entry that means exactly what it
    // says. A caveat on a literal entry would be the failure this row is about,
    // pointing the other way.
    const policy = lists({
      allowedMcpServers: [{ serverUrl: 'https://mcp.example.com/*' }],
      deniedMcpServers: [
        { serverUrl: 'https://*.untrusted.example.com/*' },
        { serverUrl: 'http://localhost:*/*' },
      ],
    })
    expect(collectManagedPolicyCaveats(policy)).toEqual([])
    // …and a `*` wildcard is not a variable. Both entries still enforce.
    expect(isManagedMcpServerAllowed(policy, REMOTE('https://mcp.example.com/api'), WRITTEN)).toBe(true)
    expect(isManagedMcpServerAllowed(policy, REMOTE('https://a.untrusted.example.com/x'), WRITTEN))
      .toBe(false)
  })

  test('`serverCommand` and `serverName`, which the guard does not reach', () => {
    // The page's column names "a URL entry's scheme, host, or path scope" and
    // nothing else, and `serverName` "values match literally and never expand".
    // Reporting a caveat here would describe a neutralisation that does not
    // happen. `serverCommand`'s own `${VAR}` exposure is a different question
    // and was closed by P2.396, by pinning the environment it expands from.
    const policy = lists({
      deniedMcpServers: [
        { serverCommand: ['${HOST}/bin/server'] },
        { serverName: '${HOST}' },
      ],
    })
    expect(collectManagedPolicyCaveats(policy)).toEqual([])
  })

  test('an empty or list-less policy', () => {
    expect(collectManagedPolicyCaveats(lists({}))).toEqual([])
    expect(collectManagedPolicyCaveats(lists({ allowedMcpServers: [], deniedMcpServers: [] })))
      .toEqual([])
  })
})

describe('P2.398 — caveat and guard are the same set', () => {
  // The collector tests `referencesConfigVariable`, which is the guard's own
  // FIRST clause and not the whole conjunction. These are the forms where the
  // two could conceivably part company, pinned from the outside through the
  // gate's verdicts rather than by reaching into a private predicate.
  const VARIABLE_FORMS = [
    ['a host', 'https://${HOST}/*'],
    ['a scheme', '${SCHEME}://internal.example.com/*'],
    ['a path scope', 'https://internal.example.com/${TEAM}/*'],
    ['a `:-default`', 'https://${HOST:-internal.example.com}/*'],
    ['an UNSET variable', 'https://${NOT_SET_ANYWHERE}/*'],
  ] as const

  test.each(VARIABLE_FORMS)('%s — caveat recorded AND the allow grant refused', (_label, serverUrl) => {
    const policy = lists({ allowedMcpServers: [{ serverUrl }] })
    expect(collectManagedPolicyCaveats(policy)).toHaveLength(1)
    // Each of these expands to a pattern that covers the server. The refusal is
    // the guard firing, not a miss — so a caveat here is a true report.
    expect(isManagedMcpServerAllowed(
      policy,
      REMOTE('https://internal.example.com/sales/x'),
      WRITTEN,
    )).toBe(false)
  })

  test('the control: a literal form is admitted, and carries no caveat', () => {
    const policy = lists({ allowedMcpServers: [{ serverUrl: 'https://internal.example.com/*' }] })
    expect(collectManagedPolicyCaveats(policy)).toEqual([])
    expect(isManagedMcpServerAllowed(
      policy,
      REMOTE('https://internal.example.com/sales/x'),
      WRITTEN,
    )).toBe(true)
  })
})

describe('P2.398 — the report an administrator actually reads', () => {
  const policy = lists({
    allowedMcpServers: [{ serverUrl: 'https://${HOST}/*' }],
    deniedMcpServers: [{ serverUrl: 'https://internal.example.com/${TEAM}/*' }],
  })

  test('says what each entry does, not what it is called', () => {
    const summary = formatManagedPolicyCaveatSummary(collectManagedPolicyCaveats(policy))!
    // NOT the drop heading. Every entry here IS applied.
    expect(summary).not.toContain('were not applied')
    expect(summary).toContain('2 managed MCP policy entries are enforced differently from how they read')
    // The consequence, in full, including the counter-intuitive half.
    expect(summary).toContain('admits NOTHING')
    expect(summary).toContain('the allowlist grants less than it reads')
    expect(summary).toContain('blocks MORE than the text describes')
    // The remedy — the page's own.
    expect(summary).toContain('Use literal URLs and commands for entries you rely on for enforcement.')
    // Both fields, so the entry can be found in whichever fragment wrote it.
    expect(summary).toContain('allowedMcpServers[0]')
    expect(summary).toContain('deniedMcpServers[0]')
  })

  test('nothing to report prints nothing', () => {
    expect(formatManagedPolicyCaveatSummary([])).toBeUndefined()
    const written: string[] = []
    expect(reportManagedPolicyCaveats([], { write: message => written.push(message) })).toBe(0)
    expect(written).toEqual([])
  })

  test('one line, on the managed-settings channel, counted', () => {
    const written: string[] = []
    const reported = reportManagedPolicyCaveats(collectManagedPolicyCaveats(policy), {
      write: message => written.push(message),
    })
    expect(reported).toBe(2)
    expect(written).toHaveLength(1)
    expect(written[0]!.startsWith('[managed-settings] ')).toBe(true)
  })

  test('entry text is flattened and capped before it reaches a terminal', () => {
    // Belt on the display side, exactly as `formatManagedPolicyDrop` has: the
    // parse layer already refuses control characters in an MCP entry, and a
    // second reader of this type must not be the one that discovers otherwise.
    //
    // The separators are written as ESCAPES, never as literal characters. A raw
    // U+2028 in a source file is invisible in every diff it appears in, and
    // this tree has already lost a measurement to two invisible bytes nobody
    // could grep for.
    const line = formatManagedPolicyCaveat({
      field: 'deniedMcpServers[0]',
      entry: `https://a.example.com/\u2028[managed-settings] forged\nline ${'x'.repeat(400)}`,
      disposition: 'retained-widened',
    })
    // Either separator would otherwise forge a second summary line on the
    // operator's terminal.
    expect(line).not.toContain('\u2028')
    expect(line).not.toContain('\n')
    // And the cap keeps a 2048-character entry from burying the effect.
    expect(line).toContain('\u2026')
    expect(line).toContain('blocks MORE than the text describes')
  })
})

describe('P2.398 — the enforced composition is what carries it', () => {
  // Surfacing, not just collecting. Before this the caveat had no producer any
  // reader could reach, which is the whole of the row.
  const NO_FILE = () => ({ policy: DEFAULT_MANAGED_PI_POLICY, drops: [] })

  test('a DELIVERED payload earns caveats too', () => {
    const enforced = resolveEnforcedManagedPolicy({
      file: NO_FILE,
      delivered: () => lists({ deniedMcpServers: [{ serverUrl: 'https://${HOST}/*' }] }),
    })
    expect(enforced.winner).toBe('delivered')
    expect(enforced.caveats).toEqual([{
      field: 'deniedMcpServers[0]',
      entry: 'https://${HOST}/*',
      disposition: 'retained-widened',
    }])
    // And it is NOT filed as a drop. Every drop disposition means *not
    // applied*; this entry is applied, more broadly than it was written.
    expect(enforced.drops).toEqual([])
  })

  test('an entry the composition did not enforce earns nothing', () => {
    // Composition is winner-takes-all. Reporting the file's entries while a
    // delivered payload holds the tier would describe a policy that is not
    // running — the same class of lie the row exists to remove.
    const enforced = resolveEnforcedManagedPolicy({
      file: () => ({
        policy: lists({ deniedMcpServers: [{ serverUrl: 'https://${HOST}/*' }] }),
        drops: [],
      }),
      delivered: () => lists({ deniedMcpServers: [{ serverUrl: 'https://blocked.example.com/*' }] }),
    })
    expect(enforced.winner).toBe('delivered')
    expect(enforced.caveats).toEqual([])
  })

  test('a FILE-only policy earns them on the same path', () => {
    const enforced = resolveEnforcedManagedPolicy({
      file: () => ({
        policy: lists({ allowedMcpServers: [{ serverUrl: 'https://${HOST}/*' }] }),
        drops: [],
      }),
      delivered: () => undefined,
    })
    expect(enforced.winner).toBe('file')
    expect(enforced.caveats.map(caveat => caveat.disposition)).toEqual(['retained-admitting-nothing'])
  })
})
