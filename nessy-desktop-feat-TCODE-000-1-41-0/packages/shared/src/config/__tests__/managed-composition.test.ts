import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_MANAGED_PI_POLICY,
  parseManagedPiPolicyTolerantV1,
  parseManagedPiPolicyV1,
  type ManagedPiPolicyV1,
} from '../../agent/pi-harness/managed-policy.ts'
import { composeManagedPolicySources } from '../managed-composition.ts'
import { EMPTY_MANAGED_ENV_COMPOSITION } from '../managed-env.ts'

function policy(document: Record<string, unknown>): ManagedPiPolicyV1 {
  return parseManagedPiPolicyV1({ schemaVersion: 1, disabledPermissionModes: [], ...document })
}

describe('composeManagedPolicySources — precedence (server-managed-settings.md#settings-precedence)', () => {
  it('lets a delivered payload that carries any setting replace the file policy wholesale', () => {
    // The rule that is NOT the intuitive one. `#settings-precedence`, the
    // page's sentence on the day this was converted (2026-09-11): "Within the
    // managed tier, Claude Code by default uses the first source that delivers
    // at least one policy key, checking server-managed settings first and then
    // endpoint-managed settings, apart from the exception keys covered next."
    // So two deny lists do NOT union: the file's is gone.
    //
    // P6.656 — converted from a line-numbered citation to the section anchor,
    // and the OLD quote is deliberately not carried across: it is on none of the
    // successor pages (the disposition's §4c measured it, with two positive
    // controls), so copying it beside the new anchor would leave a sentence in
    // this tree that no Claude page contains. "by default" in today's sentence
    // is `managedSourcesBehavior`, whose refusal is argued in the module.
    const composed = composeManagedPolicySources({
      delivered: policy({ deniedMcpServers: ['from-server'], cleanupPeriodDays: 7 }),
      file: policy({ deniedMcpServers: ['from-file'], cleanupPeriodDays: 30, channelsEnabled: false }),
    })

    expect(composed.winner).toBe('delivered')
    expect(composed.policy.deniedMcpServers).toEqual([{ serverName: 'from-server' }])
    // Scalars take the winner's value, not the smaller or the larger one.
    expect(composed.policy.cleanupPeriodDays).toBe(7)
    // A non-cross-source security switch follows `:139` like everything else,
    // even at its enforcing pole: `channelsEnabled: false` is the file's and the
    // file is ignored.
    expect(composed.policy.channelsEnabled).toBeUndefined()
  })

  it('falls back to the file policy when the delivered payload carries no setting', () => {
    for (const delivered of [undefined, DEFAULT_MANAGED_PI_POLICY, policy({})]) {
      const composed = composeManagedPolicySources({
        delivered,
        file: policy({ deniedMcpServers: ['from-file'] }),
      })
      expect(composed.winner).toBe('file')
      expect(composed.policy.deniedMcpServers).toEqual([{ serverName: 'from-file' }])
    }
  })

  it('reports no winner and enforces the built-in policy when neither source carries a setting', () => {
    expect(composeManagedPolicySources({})).toEqual({
      policy: DEFAULT_MANAGED_PI_POLICY,
      winner: 'none',
      envComposition: EMPTY_MANAGED_ENV_COMPOSITION,
    })
  })

  it('leaves an absent key absent — "no constraint", never "empty"', () => {
    // R25a's distinction, unchanged: an INVALID allowlist is enforced as empty
    // (admit nothing), an ABSENT one imposes no narrowing. The losing source
    // having written one does not make it present in the winner.
    const composed = composeManagedPolicySources({
      delivered: policy({ deniedMcpServers: ['from-server'] }),
      file: policy({ allowedMcpServers: ['only-this-one'] }),
    })

    expect(composed.policy.allowedMcpServers).toBeUndefined()
  })
})

describe('composeManagedPolicySources — cross-source lock keys (managed-settings.md#keys-read-from-every-admin-source)', () => {
  it('honours forceRemoteSettingsRefresh from either source, in both directions', () => {
    // The set is `managed-settings.md#keys-read-from-every-admin-source` in the
    // describe name; THIS key's own rule is
    // `server-managed-settings.md#per-key-exceptions-across-managed-sources`,
    // whose sentence on the day of the conversion (2026-09-11) is: "Claude Code
    // honors them when any admin-controlled managed source sets them; the
    // user-writable HKCU registry tier is excluded" — and, of this key by name,
    // "which Claude Code reads from the admin sources directly at startup".
    //
    // P6.656 — this comment carried two line-numbered citations and the sentence
    // they were cited for is on no page now. Both are converted to section
    // anchors rather than renumbered, and the bare line shorthand is dropped
    // rather than re-derived (P6.966): an anchor is part of the page's published
    // link contract, a line number has a measured half-life of about two days.
    // What the fail-closed behaviour of this key IS lives one section down, at
    // `server-managed-settings.md#enforce-fail-closed-startup`.
    const fileOnly = composeManagedPolicySources({
      delivered: policy({ deniedMcpServers: ['a'] }),
      file: policy({ forceRemoteSettingsRefresh: true }),
    })
    const deliveredOnly = composeManagedPolicySources({
      delivered: policy({ forceRemoteSettingsRefresh: true }),
      file: policy({ deniedMcpServers: ['b'] }),
    })

    expect(fileOnly.policy.forceRemoteSettingsRefresh).toBe(true)
    expect(deliveredOnly.policy.forceRemoteSettingsRefresh).toBe(true)
  })

  it('does not invent the key when neither source sets it', () => {
    const composed = composeManagedPolicySources({
      delivered: policy({ deniedMcpServers: ['a'] }),
      file: policy({ forceRemoteSettingsRefresh: false }),
    })

    // The winner said nothing and the loser said `false`: nothing is enforced,
    // and `false` is not fabricated onto the winner either.
    expect(composed.policy.forceRemoteSettingsRefresh).toBeUndefined()
  })

  it('honours the sandbox domain lock from the losing source and unions its allowlist', () => {
    // `:670` — the lock keys are honoured cross-source "with their associated
    // allowlists". Honouring the lock while ignoring the list that goes with it
    // would deny traffic no administrator denied.
    const composed = composeManagedPolicySources({
      delivered: policy({ sandbox: { network: { allowedDomains: ['server.example'] } } }),
      file: policy({
        sandbox: { network: { allowManagedDomainsOnly: true, allowedDomains: ['file.example'] } },
      }),
    })

    expect(composed.winner).toBe('delivered')
    expect(composed.policy.sandbox?.network?.allowManagedDomainsOnly).toBe(true)
    expect(composed.policy.sandbox?.network?.allowedDomains)
      .toEqual(['server.example', 'file.example'])
  })

  it('leaves the winner sandbox section untouched when no source locks', () => {
    const composed = composeManagedPolicySources({
      delivered: policy({ sandbox: { network: { allowedDomains: ['server.example'] } } }),
      file: policy({ sandbox: { network: { allowedDomains: ['file.example'] } } }),
    })

    // Unlocked, the allowlist is inert — composing it would widen nothing and
    // would misreport what the winning source declared.
    expect(composed.policy.sandbox?.network?.allowedDomains).toEqual(['server.example'])
    expect(composed.policy.sandbox?.network?.allowManagedDomainsOnly).toBeUndefined()
  })

  // P6.2 — the FILESYSTEM twin of the domain lock, and the direction is the
  // whole point. The page states one rule for both keys: "a `true` in any admin
  // source turns the lock on. While a lock is on, Claude Code unions the
  // allowlist it locks … or `sandbox.filesystem.allowRead`, across every admin
  // source." Before this fix only the network half was composed, so the STRICTER
  // admin value lost to the laxer winner — and unlike the network case, losing
  // this lock fails OPEN: `resolveSandboxSettings` goes back to merging
  // `filesystem.allowRead` from the user, project and local layers.
  it('honours the sandbox read-path lock from the LOSING source and unions its allowlist', () => {
    const composed = composeManagedPolicySources({
      delivered: policy({ sandbox: { filesystem: { allowRead: ['/opt/server-read'] } } }),
      file: policy({
        sandbox: { filesystem: { allowManagedReadPathsOnly: true, allowRead: ['/opt/file-read'] } },
      }),
    })

    expect(composed.winner).toBe('delivered')
    expect(composed.policy.sandbox?.filesystem?.allowManagedReadPathsOnly).toBe(true)
    expect(composed.policy.sandbox?.filesystem?.allowRead)
      .toEqual(['/opt/server-read', '/opt/file-read'])
  })

  it('honours the sandbox read-path lock from the WINNING source too', () => {
    // The other direction of the same rule: a managed value that is stricter
    // still wins, whichever source carries it.
    const composed = composeManagedPolicySources({
      delivered: policy({
        sandbox: { filesystem: { allowManagedReadPathsOnly: true, allowRead: ['/opt/server-read'] } },
      }),
      file: policy({ sandbox: { filesystem: { allowRead: ['/opt/file-read'] } } }),
    })

    expect(composed.policy.sandbox?.filesystem?.allowManagedReadPathsOnly).toBe(true)
    expect(composed.policy.sandbox?.filesystem?.allowRead)
      .toEqual(['/opt/server-read', '/opt/file-read'])
  })

  it('never fabricates the read-path lock when neither source sets it', () => {
    // The laxer side must not win by invention either. An unlocked `allowRead`
    // is the winner's own list, and a fabricated
    // `allowManagedReadPathsOnly: false` would read as an administrator decision
    // nobody made.
    const composed = composeManagedPolicySources({
      delivered: policy({ sandbox: { filesystem: { allowRead: ['/opt/server-read'] } } }),
      file: policy({
        sandbox: { filesystem: { allowManagedReadPathsOnly: false, allowRead: ['/opt/file-read'] } },
      }),
    })

    expect(composed.policy.sandbox?.filesystem?.allowManagedReadPathsOnly).toBeUndefined()
    expect(composed.policy.sandbox?.filesystem?.allowRead).toEqual(['/opt/server-read'])
  })

  it('composes both sandbox locks into ONE section, and keeps the winner other filesystem keys', () => {
    // The mechanical trap: two independent `{ sandbox: ... }` spreads would have
    // the later one erase the earlier one's section, so a lock that IS composed
    // still fails to reach the policy. `denyRead` rides along to prove the
    // winner's non-lock keys survive the rebuild.
    const composed = composeManagedPolicySources({
      delivered: policy({
        sandbox: { filesystem: { denyRead: ['/opt/secrets'] }, network: { deniedDomains: ['bad.example'] } },
      }),
      file: policy({
        sandbox: {
          filesystem: { allowManagedReadPathsOnly: true, allowRead: ['/opt/file-read'] },
          network: { allowManagedDomainsOnly: true, allowedDomains: ['file.example'] },
        },
      }),
    })

    expect(composed.policy.sandbox?.filesystem?.allowManagedReadPathsOnly).toBe(true)
    expect(composed.policy.sandbox?.filesystem?.allowRead).toEqual(['/opt/file-read'])
    expect(composed.policy.sandbox?.filesystem?.denyRead).toEqual(['/opt/secrets'])
    expect(composed.policy.sandbox?.network?.allowManagedDomainsOnly).toBe(true)
    expect(composed.policy.sandbox?.network?.allowedDomains).toEqual(['file.example'])
    expect(composed.policy.sandbox?.network?.deniedDomains).toEqual(['bad.example'])
  })

  it('keeps the winner TOP-LEVEL sandbox keys when a lock composes', () => {
    // The mutant that survived the first pass of this file: dropping
    // `...winner.sandbox` from the rebuilt section leaves both lock sub-sections
    // intact — each spreads its own winner half — while silently erasing every
    // top-level key. `enabled: true` and `allowUnsandboxedCommands: false` are
    // the two whose loss is a widening, and the seeded credential denies ride
    // `deniedReadRoots`, so all three are asserted rather than sampled.
    const composed = composeManagedPolicySources({
      delivered: policy({
        sandbox: {
          enabled: true,
          allowUnsandboxedCommands: false,
          deniedReadRoots: ['/opt/creds'],
        },
      }),
      file: policy({
        sandbox: { filesystem: { allowManagedReadPathsOnly: true, allowRead: ['/opt/file-read'] } },
      }),
    })

    expect(composed.policy.sandbox?.filesystem?.allowManagedReadPathsOnly).toBe(true)
    expect(composed.policy.sandbox?.enabled).toBe(true)
    expect(composed.policy.sandbox?.allowUnsandboxedCommands).toBe(false)
    expect(composed.policy.sandbox?.deniedReadRoots).toEqual(['/opt/creds'])
  })

  it('builds the sandbox section even when the winning source has none at all', () => {
    const composed = composeManagedPolicySources({
      delivered: policy({ deniedMcpServers: ['from-server'] }),
      file: policy({ sandbox: { filesystem: { allowManagedReadPathsOnly: true, allowRead: ['/opt/file-read'] } } }),
    })

    expect(composed.winner).toBe('delivered')
    expect(composed.policy.sandbox?.filesystem?.allowManagedReadPathsOnly).toBe(true)
    expect(composed.policy.sandbox?.filesystem?.allowRead).toEqual(['/opt/file-read'])
  })
})

describe('composeManagedPolicySources — env merges per variable (managed-settings.md#keys-read-from-every-admin-source)', () => {
  it('fills in variables the delivered payload leaves unset, and never lets the file override one it sets', () => {
    // "each variable comes from the highest-priority source that defines it, so
    // lower sources fill in variables the higher ones leave unset."
    const composed = composeManagedPolicySources({
      delivered: policy({ env: { ANTHROPIC_MODEL: 'from-server', HTTPS_PROXY: 'http://corp:8080' } }),
      file: policy({ env: { ANTHROPIC_MODEL: 'from-file', NODE_EXTRA_CA_CERTS: '/etc/nessy/ca.pem' } }),
    })

    expect(composed.winner).toBe('delivered')
    // The higher source keeps every variable it sets — a per-variable merge that
    // let the file win here would invert the point of the tier.
    expect(composed.policy.env).toEqual({
      ANTHROPIC_MODEL: 'from-server',
      HTTPS_PROXY: 'http://corp:8080',
      NODE_EXTRA_CA_CERTS: '/etc/nessy/ca.pem',
    })
    expect(composed.envComposition.origins).toEqual({
      ANTHROPIC_MODEL: 'delivered',
      HTTPS_PROXY: 'delivered',
      NODE_EXTRA_CA_CERTS: 'file',
    })
    // The file's losing value is kept as the stand-in for the window in which
    // the delivered value is withheld (`server-managed-settings.md#per-key-exceptions-across-managed-sources`).
    expect(composed.envComposition.standby).toEqual({ ANTHROPIC_MODEL: 'from-file' })
  })

  it('merges env even though the delivered payload wins every other key wholesale', () => {
    // The negative half of the same rule: `env` is the exception, and nothing
    // else composes. The file's deny list is still discarded.
    const composed = composeManagedPolicySources({
      delivered: policy({ deniedMcpServers: ['from-server'], env: { A: '1' } }),
      file: policy({ deniedMcpServers: ['from-file'], env: { B: '2' } }),
    })

    expect(composed.policy.deniedMcpServers).toEqual([{ serverName: 'from-server' }])
    expect(composed.policy.env).toEqual({ A: '1', B: '2' })
  })

  it('leaves env absent when neither source sets one, rather than fabricating an empty block', () => {
    const composed = composeManagedPolicySources({
      delivered: policy({ deniedMcpServers: ['a'] }),
      file: policy({ channelsEnabled: false }),
    })

    expect(composed.policy.env).toBeUndefined()
    expect(composed.envComposition).toBe(EMPTY_MANAGED_ENV_COMPOSITION)
  })
})

describe('P3.290 — managedSourcesBehavior is refused BY NAME, not honoured', () => {
  /**
   * `settings-reference.md#managedsourcesbehavior` makes this a real key with a
   * documented `"merge"` value under which every admin source contributes. This
   * module implements the `"first-wins"` default and nothing else, so the key
   * has to be refused in a way an administrator can act on — the register entry
   * in `pi-harness/managed-policy.ts` carries the whole argument.
   */
  it('drops the key with the unimplemented sentence, never the typo sentence', () => {
    const parsed = parseManagedPiPolicyTolerantV1(
      { schemaVersion: 1, disabledPermissionModes: [], managedSourcesBehavior: 'merge', channelsEnabled: false },
      { source: 'managed-policy.json' },
    )

    const drop = parsed.drops.find(entry => entry.field === 'managedSourcesBehavior')
    expect(drop).toBeDefined()
    // MUTATION KILLED: removing the register entry. The default sentence sends
    // an administrator looking for a misspelling that is not there.
    expect(drop?.reason).not.toContain('invalid managed Pi policy key')
    // The two facts the message has to carry: the key is real, and what this
    // build does instead — so "merge was ignored" is reachable from the
    // diagnostic alone.
    expect(drop?.reason).toContain('real Claude Code managed setting')
    expect(drop?.reason).toContain('first-wins')
    expect(drop?.disposition).toBe('stripped')

    // POSITIVE CONTROL on the same parse: a genuine typo still gets the typo
    // sentence, so the register did not swallow the default.
    const typo = parseManagedPiPolicyTolerantV1(
      { schemaVersion: 1, disabledPermissionModes: [], managedSourceBehaviour: 'merge' },
      { source: 'managed-policy.json' },
    )
    expect(typo.drops.find(entry => entry.field === 'managedSourceBehaviour')?.reason)
      .toContain('invalid managed Pi policy key')
  })

  it('keeps the key OUT of the policy-key count, so a control-key-only payload is not a delivery', () => {
    // The page defines a "policy key" as any key other than the two control
    // keys, and says a source carrying only those "doesn't count, and Claude
    // Code moves on to the next source". Refusing the key at parse is what makes
    // that true here: were it a schema field, `carriesManagedSettings` would
    // count it and the payload below would erase a valid file policy.
    const composed = composeManagedPolicySources({
      delivered: parseManagedPiPolicyTolerantV1(
        { schemaVersion: 1, disabledPermissionModes: [], managedSourcesBehavior: 'merge' },
        { source: 'delivered' },
      ).policy,
      file: policy({ deniedMcpServers: ['from-file'] }),
    })

    expect(composed.winner).toBe('file')
    expect(composed.policy.deniedMcpServers).toEqual([{ serverName: 'from-file' }])
  })

  it('CONTROL: "merge" changes nothing — the composition stays first-wins in both directions', () => {
    // The refusal is only honest if the behaviour it names is the behaviour that
    // happens. A delivered payload asking to merge still wins wholesale, and the
    // file's non-cross-source keys are still dropped.
    const composed = composeManagedPolicySources({
      delivered: parseManagedPiPolicyTolerantV1(
        {
          schemaVersion: 1,
          disabledPermissionModes: [],
          managedSourcesBehavior: 'merge',
          deniedMcpServers: ['from-server'],
        },
        { source: 'delivered' },
      ).policy,
      file: policy({ deniedMcpServers: ['from-file'], channelsEnabled: false }),
    })

    expect(composed.winner).toBe('delivered')
    expect(composed.policy.deniedMcpServers).toEqual([{ serverName: 'from-server' }])
    expect(composed.policy.channelsEnabled).toBeUndefined()
  })
})

describe('P6.242 — allowedChannelPlugins is refused BY NAME, with the unit difference stated', () => {
  /**
   * `settings-reference.md#allowedchannelplugins` is a real Managed-scope key
   * whose unit is a `{marketplace, plugin}` pair. This host gates channels by
   * MCP SERVER name, so the two lists cannot be translated; the register entry
   * in `pi-harness/managed-policy.ts` carries the measurement.
   *
   * The direction is what makes the sentence matter: an unenforced allowlist
   * fails OPEN, so "invalid key" would read as "fix your JSON" while every
   * channel plugin kept pushing.
   */
  it('names the key, our twin, and the fact that nothing is restricting channels', () => {
    const parsed = parseManagedPiPolicyTolerantV1(
      {
        schemaVersion: 1,
        disabledPermissionModes: [],
        channelsEnabled: true,
        allowedChannelPlugins: [{ marketplace: 'claude-plugins-official', plugin: 'telegram' }],
      },
      { source: 'managed-policy.json' },
    )

    const drop = parsed.drops.find(entry => entry.field === 'allowedChannelPlugins')
    expect(drop).toBeDefined()
    expect(drop?.reason).not.toContain('invalid managed Pi policy key')
    expect(drop?.reason).toContain('real Claude Code managed setting')
    // Our twin BY NAME, so the remedy is reachable from the diagnostic alone.
    expect(drop?.reason).toContain('allowedChannelServers')
    expect(drop?.reason).toContain('channelsEnabled: false')
    expect(drop?.disposition).toBe('stripped')
  })

  it('CONTROL: the twin under its own name still parses and is untouched', () => {
    const parsed = parseManagedPiPolicyTolerantV1(
      {
        schemaVersion: 1,
        disabledPermissionModes: [],
        channelsEnabled: true,
        allowedChannelServers: ['telegram-bridge'],
      },
      { source: 'managed-policy.json' },
    )
    expect(parsed.policy.allowedChannelServers).toEqual(['telegram-bridge'])
    expect(parsed.drops.find(entry => entry.field === 'allowedChannelServers')).toBeUndefined()
  })
})
