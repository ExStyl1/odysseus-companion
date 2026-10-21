import { describe, expect, test } from 'bun:test'
import {
  isManagedMarketplaceAllowed,
  managedMarketplaceSourceIdentity,
  parseManagedPiPolicyTolerantV1,
  parseManagedPiPolicyV1,
  type ManagedMarketplaceEntryV1,
} from './managed-policy.ts'

const tolerant = (extra: Record<string, unknown>) => parseManagedPiPolicyTolerantV1(
  { schemaVersion: 1, disabledPermissionModes: [], ...extra },
  { source: '/etc/nessy/managed-policy.json' },
)

const strict = (extra: Record<string, unknown>) => parseManagedPiPolicyV1(
  { schemaVersion: 1, disabledPermissionModes: [], ...extra },
)

const allows = (
  entries: readonly ManagedMarketplaceEntryV1[] | undefined,
  source: string,
  refName?: string,
): boolean => isManagedMarketplaceAllowed(entries, managedMarketplaceSourceIdentity(source, refName))

describe('parsing strictKnownMarketplaces', () => {
  test('an absent field and an empty array are different answers', () => {
    // `plugins/org.md#allowlist-with-strictknownmarketplaces` — "Undefined (default) | No
    // restrictions" and "Empty array `[]` | Complete lockdown. Blocks every
    // marketplace source, including the official Anthropic marketplace".
    expect(strict({}).strictKnownMarketplaces).toBeUndefined()
    expect(strict({ strictKnownMarketplaces: [] }).strictKnownMarketplaces).toEqual([])
    expect(allows(undefined, 'acme-corp/plugins')).toBe(true)
    expect(allows([], 'acme-corp/plugins')).toBe(false)
  })

  test('parses the four of the page\'s nine documented entry shapes it carries', () => {
    const policy = strict({
      strictKnownMarketplaces: [
        { source: 'github', repo: 'acme-corp/approved-plugins' },
        { source: 'github', repo: 'acme-corp/security-tools', ref: 'v2.0' },
        { source: 'url', url: 'https://plugins.example.com/marketplace.json' },
        { source: 'hostPattern', hostPattern: '^github\\.example\\.com$' },
        { source: 'pathPattern', pathPattern: '^/opt/approved/' },
      ],
    })

    expect(policy.strictKnownMarketplaces).toHaveLength(5)
  })

  test('strips an individual invalid entry and enforces the valid subset', () => {
    const parsed = tolerant({
      strictKnownMarketplaces: [
        { source: 'github', repo: 'acme-corp/approved-plugins' },
        { source: 'github' },
        { source: 'hostPattern', hostPattern: '^(unclosed' },
        { source: 'skills-dir' },
      ],
    })

    expect(parsed.policy.strictKnownMarketplaces).toEqual([
      { source: 'github', repo: 'acme-corp/approved-plugins' },
    ])
    expect(parsed.drops.map(drop => drop.field)).toEqual([
      'strictKnownMarketplaces[1]',
      'strictKnownMarketplaces[2]',
      'strictKnownMarketplaces[3]',
    ])
  })

  test('a wholly invalid value becomes an empty allowlist, not an absent one', () => {
    // Allowlist polarity (`managed-settings.md#keys-that-fail-closed`, the
    // `allowedMcpServers` row): the defect narrows, never widens.
    const parsed = tolerant({ strictKnownMarketplaces: 'acme-corp/plugins' })

    expect(parsed.policy.strictKnownMarketplaces).toEqual([])
    expect(allows(parsed.policy.strictKnownMarketplaces, 'acme-corp/plugins')).toBe(false)
    expect(parsed.drops[0]?.disposition).toBe('emptied')
  })

  test('the strict parser refuses what the tolerant one records', () => {
    expect(() => strict({ strictKnownMarketplaces: [{ source: 'github' }] })).toThrow()
  })
})

describe('matching a marketplace source against the allowlist', () => {
  test('a github entry matches the shorthand, the https URL and the SSH remote', () => {
    const entries: ManagedMarketplaceEntryV1[] = [
      { source: 'github', repo: 'anthropics/claude-plugins-official' },
    ]

    expect(allows(entries, 'anthropics/claude-plugins-official')).toBe(true)
    expect(allows(entries, 'https://github.com/anthropics/claude-plugins-official')).toBe(true)
    expect(allows(entries, 'https://github.com/anthropics/claude-plugins-official.git')).toBe(true)
    expect(allows(entries, 'git@github.com:anthropics/claude-plugins-official.git')).toBe(true)
    expect(allows(entries, 'anthropics/some-other-repo')).toBe(false)
  })

  test('ref must match exactly or be absent from both', () => {
    // `:766` — "`ref` and `path` must each match exactly or be absent from both
    // the marketplace source and the allowlist entry". `:691` states the
    // consequence: "Matching is exact, so this entry doesn't cover `ref` or
    // `path` variants of the same repository".
    const unpinned: ManagedMarketplaceEntryV1[] = [{ source: 'github', repo: 'acme-corp/plugins' }]
    const pinned: ManagedMarketplaceEntryV1[] = [
      { source: 'github', repo: 'acme-corp/plugins', ref: 'v2.0' },
    ]

    expect(allows(unpinned, 'acme-corp/plugins')).toBe(true)
    expect(allows(unpinned, 'acme-corp/plugins', 'v2.0')).toBe(false)
    expect(allows(pinned, 'acme-corp/plugins', 'v2.0')).toBe(true)
    expect(allows(pinned, 'acme-corp/plugins')).toBe(false)
  })

  test('a url entry is matched without normalization', () => {
    // `:771` — "Exact matching doesn't normalize URLs: a trailing slash, `.git`
    // suffix, or `ssh://` versus `https://` form are treated as different values."
    const entries: ManagedMarketplaceEntryV1[] = [
      { source: 'url', url: 'https://plugins.example.com/marketplace.json' },
    ]

    expect(allows(entries, 'https://plugins.example.com/marketplace.json')).toBe(true)
    expect(allows(entries, 'https://plugins.example.com/marketplace.json/')).toBe(false)
  })

  test('a hostPattern admits every repository on an internal git server', () => {
    // `:728` — "the recommended approach for GitHub Enterprise Server or
    // self-hosted GitLab instances", which is the bank-fork case.
    const entries: ManagedMarketplaceEntryV1[] = [
      { source: 'hostPattern', hostPattern: '^gitlab\\.tcsbank\\.ru$' },
    ]

    expect(allows(entries, 'https://gitlab.tcsbank.ru/team/plugins.git')).toBe(true)
    expect(allows(entries, 'git@gitlab.tcsbank.ru:team/plugins.git')).toBe(true)
    expect(allows(entries, 'https://gitlab.com/team/plugins.git')).toBe(false)
    // A host pattern says nothing about the filesystem.
    expect(allows(entries, '/opt/approved/marketplace')).toBe(false)
  })

  test('a pathPattern admits only filesystem sources under the approved directory', () => {
    const entries: ManagedMarketplaceEntryV1[] = [
      { source: 'pathPattern', pathPattern: '^/opt/approved/' },
    ]

    expect(allows(entries, '/opt/approved/marketplace')).toBe(true)
    expect(allows(entries, '/home/user/marketplace')).toBe(false)
    expect(allows(entries, 'https://gitlab.tcsbank.ru/team/plugins.git')).toBe(false)
  })

  test('a bare host with no scheme proves nothing and is admitted by nothing', () => {
    // `:955` — "A URL must include its scheme. As of Claude Code v2.1.196, a host
    // typed without one, such as `gitlab.example.com/team/plugins`, is rejected
    // as an invalid `owner/repo` shorthand".
    const entries: ManagedMarketplaceEntryV1[] = [
      { source: 'hostPattern', hostPattern: '^gitlab\\.example\\.com$' },
    ]

    expect(allows(entries, 'gitlab.example.com/team/plugins')).toBe(false)
  })
})

describe('a `#ref` pin is part of the source identity', () => {
  // `plugins/cli-reference.md#plugin-marketplace-add` — "To pin to a branch or tag,
  // append `@ref` to the GitHub shorthand or `#ref` to a git URL", and
  // `#how-restrictions-work` — "For single-repository entries, `ref` must match
  // exactly or be absent from both the marketplace source and the allowlist
  // entry, and the same rule applies to `path`".
  //
  // The install resolver honours the pin, so the allowlist has to judge the same
  // thing the resolver clones. Left out, an entry that names NO ref would admit
  // a source fetched at a pinned ref.
  const pinned: ManagedMarketplaceEntryV1[] = [
    { source: 'github', repo: 'acme/plugins', ref: 'v2.0.0' },
  ]
  const unpinned: ManagedMarketplaceEntryV1[] = [
    { source: 'github', repo: 'acme/plugins' },
  ]

  test('a pinned entry admits the matching pin and refuses a different one', () => {
    expect(allows(pinned, 'https://github.com/acme/plugins#v2.0.0')).toBe(true)
    expect(allows(pinned, 'https://github.com/acme/plugins#v3.0.0')).toBe(false)
  })

  test('an unpinned entry no longer admits a pinned source', () => {
    // The anti-widening half: before the pin reached the identity this was
    // `true`, and the resolver then cloned `v2.0.0` under a decision made about
    // the default branch.
    expect(allows(unpinned, 'https://github.com/acme/plugins#v2.0.0')).toBe(false)
    // Positive control on the same rig: the unpinned source is still admitted.
    expect(allows(unpinned, 'https://github.com/acme/plugins')).toBe(true)
  })

  test('the pin outranks a browse-URL ref, exactly as the resolver orders them', () => {
    expect(allows(
      [{ source: 'github', repo: 'acme/plugins', ref: 'v3', path: 'sub' }],
      'https://github.com/acme/plugins/tree/v2/sub#v3',
    )).toBe(true)
    expect(allows(
      [{ source: 'github', repo: 'acme/plugins', ref: 'v2', path: 'sub' }],
      'https://github.com/acme/plugins/tree/v2/sub#v3',
    )).toBe(false)
  })

  test('an empty `#` is not a pin', () => {
    expect(allows(unpinned, 'https://github.com/acme/plugins#')).toBe(true)
  })
})

/**
 * P2.483 — the ALLOWLIST owner wildcard, and the four rules that keep it
 * stricter than the blocklist's.
 *
 * The owner's answer (2026-09-02, §A7) was conditional on the page being
 * SILENT. It is not: `settings-reference.md#owner-wildcards` documents
 * `<owner>/*` for `strictKnownMarketplaces` by name, shows a worked example
 * under that key, and fills in that column of the matching-rules table. The
 * vendored bundle (`claudeCodeVersion 2.1.247`, past the page's stated 2.1.223
 * floor) parses it too. So the drop went, and these cases are the narrowing
 * half that must not go with it.
 *
 * Every case carries its own positive control: a wildcard test that only
 * asserts admissions cannot tell a working wildcard from an allowlist that
 * admits everything.
 */
describe('P2.483 — owner wildcards in strictKnownMarketplaces', () => {
  test('the entry parses instead of being dropped, and the malformed spellings still are', () => {
    const parsed = tolerant({
      strictKnownMarketplaces: [
        { source: 'github', repo: 'acme-corp/*' },
        // The page: "Claude Code compares entries such as a bare star, a star
        // in the owner position, or a prefix followed by a star literally, so
        // they match no repository." Ours refuses them at parse instead, which
        // is visible where a literal never-match is not.
        { source: 'github', repo: '*' },
        { source: 'github', repo: 'acme-corp/tools-*' },
      ],
    })
    expect(parsed.policy.strictKnownMarketplaces).toEqual([
      { source: 'github', repo: 'acme-corp/*' },
    ])
    expect(parsed.drops.map(drop => drop.field)).toEqual([
      'strictKnownMarketplaces[1]',
      'strictKnownMarketplaces[2]',
    ])
  })

  test('it admits every repository under the owner, and only that owner', () => {
    const entries: ManagedMarketplaceEntryV1[] = [{ source: 'github', repo: 'acme-corp/*' }]
    expect(allows(entries, 'acme-corp/plugins')).toBe(true)
    expect(allows(entries, 'acme-corp/security-tools')).toBe(true)
    // POSITIVE CONTROL — the wildcard is scoped to the owner it names, so this
    // suite is not merely observing an allowlist that admits everything.
    expect(allows(entries, 'other-org/plugins')).toBe(false)
  })

  test('row 1 — `owner/repo` form only: a git URL cloning the same repository does NOT match', () => {
    // "Matching source spellings: `owner/repo` form only. A git URL that clones
    // the same repository doesn't match" — the opposite of the blocklist row.
    const entries: ManagedMarketplaceEntryV1[] = [{ source: 'github', repo: 'acme-corp/*' }]
    expect(allows(entries, 'acme-corp/plugins')).toBe(true)
    expect(allows(entries, 'git@github.com:acme-corp/plugins.git')).toBe(false)
  })

  test('row 2 — the owner comparison stays case-SENSITIVE', () => {
    // "Owner case: Case-sensitive, like exact-entry matching" (blocklist:
    // case-insensitive). This is the row that costs real code — the blocklist
    // matcher lowercases both sides and this one must not.
    const entries: ManagedMarketplaceEntryV1[] = [{ source: 'github', repo: 'acme-corp/*' }]
    expect(allows(entries, 'acme-corp/plugins')).toBe(true)
    expect(allows(entries, 'ACME-Corp/plugins')).toBe(false)
  })

  test('row 3 — `ref` follows the exact-entry rules in BOTH directions', () => {
    // "an entry with a `ref` matches only sources with that exact ref, and an
    // entry without one matches only sources that don't specify a ref". The
    // second half is where the blocklist does the opposite, so it is the half a
    // shared implementation would have got wrong.
    const noRef: ManagedMarketplaceEntryV1[] = [{ source: 'github', repo: 'acme-corp/*' }]
    expect(allows(noRef, 'acme-corp/plugins')).toBe(true)
    expect(allows(noRef, 'acme-corp/plugins', 'v2.0')).toBe(false)

    const pinned: ManagedMarketplaceEntryV1[] = [{ source: 'github', repo: 'acme-corp/*', ref: 'v2.0' }]
    expect(allows(pinned, 'acme-corp/plugins', 'v2.0')).toBe(true)
    expect(allows(pinned, 'acme-corp/plugins', 'v3.0')).toBe(false)
    expect(allows(pinned, 'acme-corp/plugins')).toBe(false)
  })

  /**
   * Row 4 is the one place the page's two rows are in TENSION, and the tension
   * is recorded here rather than resolved by inventing a third rule.
   *
   * Row 4 says an entry with a `path` "requires that exact value", and an entry
   * without one "matches any path inside the repository". But the only source
   * spelling that CARRIES a path is the browse URL
   * `https://github.com/owner/repo/tree/<ref>/<path>`, and row 1 excludes every
   * URL spelling from allowlist wildcard matching. So for an owner-wildcard
   * entry the path arm is unreachable in both directions: a path-scoped source
   * never matches, whether or not the entry names a path.
   *
   * That fails CLOSED — an administrator's path-scoped wildcard entry admits
   * nothing rather than admitting too much — so it is asserted as measured, and
   * reported rather than papered over. Relaxing row 1 to reach it would widen a
   * grant on an invented reading, which is the one move P2.483 exists to refuse.
   */
  test('row 4 — a path-carrying source is out of reach of a wildcard entry, in both directions', () => {
    const noPath: ManagedMarketplaceEntryV1[] = [{ source: 'github', repo: 'acme-corp/*' }]
    // Refused by row 1 (a URL spelling), not by the path rule.
    expect(allows(noPath, 'https://github.com/acme-corp/plugins/tree/main/marketplace')).toBe(false)
    // POSITIVE CONTROL on the same entry: the shorthand still matches, so the
    // refusal above is about the spelling and not about the entry being inert.
    expect(allows(noPath, 'acme-corp/plugins')).toBe(true)

    const withPath: ManagedMarketplaceEntryV1[] = [
      { source: 'github', repo: 'acme-corp/*', ref: 'main', path: 'marketplace' },
    ]
    expect(allows(withPath, 'https://github.com/acme-corp/plugins/tree/main/marketplace')).toBe(false)
    expect(allows(withPath, 'https://github.com/acme-corp/plugins/tree/main/other')).toBe(false)
  })

  test('a non-wildcard entry is untouched — exact matching still requires the whole repo', () => {
    // The negative control for the branch itself: adding the wildcard arm must
    // not make an ordinary entry behave like one.
    const entries: ManagedMarketplaceEntryV1[] = [{ source: 'github', repo: 'acme-corp/plugins' }]
    expect(allows(entries, 'acme-corp/plugins')).toBe(true)
    expect(allows(entries, 'acme-corp/other')).toBe(false)
  })
})

/**
 * P6.422 — the two documented aliases.
 *
 * `settings-reference.md#marketplace-key-aliases`: *"On Claude Code v2.1.232 or
 * later, you can write `extraKnownMarketplaces` as `additionalMarketplaces` and
 * `strictKnownMarketplaces` as `allowedMarketplaces`."* We vendor 2.1.247, so a
 * settings file written to the page is one an administrator can have today —
 * and before this row the alias was stripped by name with a message reading
 * "invalid managed Pi policy key".
 */
describe('marketplace key aliases (P6.422)', () => {
  test('`allowedMarketplaces` is read exactly as `strictKnownMarketplaces`', () => {
    const policy = strict({ allowedMarketplaces: [{ source: 'github', repo: 'acme-corp/plugins' }] })
    expect(policy.strictKnownMarketplaces).toEqual([{ source: 'github', repo: 'acme-corp/plugins' }])
    // The absent-vs-empty distinction the canonical key preserves survives the
    // alias, because the alias is folded BEFORE the parser runs.
    expect(strict({ allowedMarketplaces: [] }).strictKnownMarketplaces).toEqual([])
    expect(allows(strict({ allowedMarketplaces: [] }).strictKnownMarketplaces, 'acme-corp/plugins')).toBe(false)
  })

  test('`additionalMarketplaces` is read exactly as `extraKnownMarketplaces`', () => {
    const policy = strict({
      additionalMarketplaces: [{ name: 'acme-tools', source: 'acme-corp/plugins' }],
    })
    expect(policy.extraKnownMarketplaces?.map(entry => entry.name)).toEqual(['acme-tools'])
  })

  test('the alias no longer trips the unknown-key refusal', () => {
    // The pre-fix behaviour, and the reason this row exists: the strict parser
    // THREW on the documented spelling.
    expect(() => strict({ allowedMarketplaces: [] })).not.toThrow()
    const { drops } = tolerant({ additionalMarketplaces: [] })
    expect(drops.some(drop => drop.reason.includes('invalid managed Pi policy key'))).toBe(false)
  })

  test('both spellings in one file: the canonical wins and the alias is named, not thrown on', () => {
    // Page: "If you set both spellings in one file, Claude Code uses the
    // canonical value and ignores the alias." That document is LEGAL, so the
    // strict parser must not reject it.
    const both = {
      strictKnownMarketplaces: [{ source: 'github' as const, repo: 'canonical/wins' }],
      allowedMarketplaces: [{ source: 'github' as const, repo: 'alias/loses' }],
    }
    expect(() => strict(both)).not.toThrow()
    expect(strict(both).strictKnownMarketplaces).toEqual([{ source: 'github', repo: 'canonical/wins' }])
    const { drops } = tolerant(both)
    const collision = drops.find(drop => drop.field === 'allowedMarketplaces')
    expect(collision?.reason).toContain('the canonical strictKnownMarketplaces value is used')
  })

  test('an unrelated unknown key is still refused, so the alias fold did not open the schema', () => {
    expect(() => strict({ notAMarketplaceKey: [] })).toThrow(/invalid managed Pi policy key/)
  })
})

describe('delivered marketplace source types', () => {
  // `settings-reference.md#marketplace-source-types` — "The `source` object
  // takes one of these forms", read 2026-09-11 (P6.1039). `file` is on that
  // list — "a local path to a `marketplace.json` file, with `path`" — and until
  // this row it fell to the unsupported-source branch with no case of its own.
  test('a `file` source flattens to its path, exactly as `directory` does', () => {
    const policy = strict({
      extraKnownMarketplaces: {
        'acme-file': { source: { source: 'file', path: '/opt/acme-corp/plugins/marketplace.json' } },
        'acme-dir': { source: { source: 'directory', path: '/opt/acme-corp/approved-marketplaces' } },
      },
    })
    expect(policy.extraKnownMarketplaces?.map(entry => [entry.name, entry.source])).toEqual([
      ['acme-file', '/opt/acme-corp/plugins/marketplace.json'],
      ['acme-dir', '/opt/acme-corp/approved-marketplaces'],
    ])
  })

  test('a `file` source with no usable path is a recorded drop, not a silent one', () => {
    const { policy, drops } = tolerant({
      extraKnownMarketplaces: { 'acme-file': { source: { source: 'file' } } },
    })
    expect(policy.extraKnownMarketplaces).toEqual([])
    expect(drops.map(drop => drop.reason)).toContain('invalid delivered marketplace file path')
    expect(() => strict({
      extraKnownMarketplaces: { 'acme-file': { source: { source: 'file' } } },
    })).toThrow(/invalid delivered marketplace file path/)
  })

  test('`settings` stays refused, and the reason still says why', () => {
    // The boundary the row above must not move: an inline catalogue is a format
    // with no reader here, so admitting it would register a marketplace whose
    // catalogue can never load.
    const { policy, drops } = tolerant({
      extraKnownMarketplaces: { 'inline': { source: { source: 'settings', name: 'inline', plugins: [] } } },
    })
    expect(policy.extraKnownMarketplaces).toEqual([])
    expect(drops.some(drop => drop.reason.includes('inline settings catalogue'))).toBe(true)
  })
})
