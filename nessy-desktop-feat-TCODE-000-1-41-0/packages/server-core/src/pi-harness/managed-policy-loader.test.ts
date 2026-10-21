import { describe, expect, test } from 'bun:test'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { managedSystemDirForPlatform } from '@nessy-agent/shared/config/managed-system-paths'
import {
  loadManagedPiPolicy,
  loadManagedPiPolicyWithDiagnostics,
  managedPiPolicyPathForPlatform,
} from './managed-policy-loader.ts'

type FakeStats = {
  size: number
  uid: number
  mode: number
  dev: number
  ino: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

const policyJson = JSON.stringify({ schemaVersion: 1, disabledPermissionModes: ['auto'] })

function node(kind: 'file' | 'directory', overrides: Partial<FakeStats> = {}): FakeStats {
  return {
    size: policyJson.length,
    uid: 0,
    mode: kind === 'file' ? 0o100644 : 0o40755,
    dev: 1,
    ino: kind === 'file' ? 2 : 1,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => false,
    ...overrides,
  }
}

function loaderDeps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const path = '/etc/nessy/managed-policy.json'
  const file = node('file')
  const directory = node('directory')
  return {
    platform: 'linux',
    lstatSync: (candidate: string) => candidate === path ? file : directory,
    realpathSync: (candidate: string) => candidate,
    openSync: () => 42,
    fstatSync: () => file,
    readFileSync: () => policyJson,
    closeSync: () => undefined,
    readdirSync: () => [],
    ...overrides,
  }
}

const BASE = '/etc/nessy/managed-policy.json'
const DROP_IN = '/etc/nessy/managed-policy.d'

/**
 * A virtual host filesystem: the base policy plus a `managed-policy.d/`
 * listing, so merge order and per-fragment attribution can be asserted without
 * touching a real root-owned directory.
 */
function dropInDeps(
  files: Record<string, unknown>,
  options: { unreadable?: readonly string[] } = {},
): Record<string, unknown> {
  const content = (path: string): string => {
    const value = files[path]
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
  const descriptors = new Map<number, string>()
  let nextDescriptor = 10
  return {
    platform: 'linux',
    lstatSync: (candidate: string) => {
      if (candidate === DROP_IN || candidate === '/etc/nessy') return node('directory')
      if (files[candidate] === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return node('file', { size: content(candidate).length, ino: 2 })
    },
    realpathSync: (candidate: string) => candidate,
    readdirSync: (candidate: string) => candidate === DROP_IN
      ? Object.keys(files).filter(path => path.startsWith(`${DROP_IN}/`)).map(path => path.slice(DROP_IN.length + 1))
      : [],
    openSync: (candidate: string) => {
      if (options.unreadable?.includes(candidate)) throw new Error('permission denied')
      const descriptor = nextDescriptor++
      descriptors.set(descriptor, candidate)
      return descriptor
    },
    fstatSync: (descriptor: number) => node('file', {
      size: content(descriptors.get(descriptor)!).length,
      ino: 2,
    }),
    readFileSync: (descriptor: number) => content(descriptors.get(descriptor)!),
    closeSync: () => undefined,
  }
}

describe('managed Pi policy loader', () => {
  test('derives only the three host-owned platform paths', () => {
    expect(managedPiPolicyPathForPlatform('darwin')).toBe('/Library/Application Support/Nessy/managed-policy.json')
    expect(managedPiPolicyPathForPlatform('linux')).toBe('/etc/nessy/managed-policy.json')
    // P6.235 — the documented administrator-ACL location, not the legacy
    // `%ProgramData%` one the upstream stopped reading.
    expect(managedPiPolicyPathForPlatform('win32', 'C:\\Program Files'))
      .toBe('C:\\Program Files\\Nessy\\managed-policy.json')
    expect(() => managedPiPolicyPathForPlatform('freebsd')).toThrow('managed-pi-policy-invalid')
  })

  /**
   * R65. The managed CLAUDE.md tier (`memory.md:279`-`:281`) reads from this
   * same directory. An org deploys both files to the location its policy
   * demonstrably reaches, so the two must never be spelt separately.
   */
  test('shares its directory with the managed instruction tier', () => {
    for (const [platform, programFiles] of [
      ['darwin', undefined],
      ['linux', undefined],
      ['win32', 'C:\\Program Files'],
    ] as const) {
      const directory = managedSystemDirForPlatform(platform, programFiles)
      expect(directory).toBeDefined()
      expect(managedPiPolicyPathForPlatform(platform, programFiles).startsWith(directory!)).toBe(true)
    }
    expect(managedSystemDirForPlatform('freebsd')).toBeUndefined()
  })

  /**
   * P6.235 — win32 is READ now, from the documented administrator-ACL location,
   * and P3.331's blanket refusal is gone. **NOT MEASURED ON A WINDOWS HOST:**
   * none exists on any rig (P3.7 ⬜), so every arm below drives the loader's
   * injected platform and filesystem seams. That is a unit test of the decision
   * logic, not evidence that Windows behaves this way.
   *
   * The `linux` arm on identical deps is the positive control throughout: it
   * proves the fixture serves a well-formed policy, so a win32 refusal is the
   * platform's and not the fixture's.
   */
  describe('win32 — the documented administrator-ACL location', () => {
    const WIN_ROOT = 'C:\\Program Files'
    const WIN_DIR = 'C:\\Program Files\\Nessy'
    const WIN_PATH = 'C:\\Program Files\\Nessy\\managed-policy.json'

    const winDeps = (overrides: Record<string, unknown> = {}) => loaderDeps({
      platform: 'win32',
      programFiles: WIN_ROOT,
      lstatSync: (candidate: string) => candidate === WIN_PATH ? node('file') : node('directory'),
      realpathSync: (candidate: string) => candidate,
      ...overrides,
    })

    test('a policy inside it is READ and enforced', () => {
      const win = loadManagedPiPolicyWithDiagnostics(winDeps() as never)
      expect(win.policy.disabledPermissionModes).toEqual(['auto'])
      expect(win.drops).toHaveLength(0)

      // Positive control on the same fixture.
      const linux = loadManagedPiPolicyWithDiagnostics(loaderDeps({
        platform: 'linux',
        lstatSync: (candidate: string) => candidate === BASE ? node('file') : node('directory'),
      }) as never)
      expect(linux.policy.disabledPermissionModes).toEqual(['auto'])
    })

    test('the POSIX mode rule is NOT what admits it — a win32 file with world-writable bits still loads', () => {
      // The recorded trap: Node derives the win32 `mode` from the read-only
      // attribute, so `mode & 0o022` is set for essentially every ordinary
      // Windows file. A loader that ran the POSIX rule there would refuse every
      // legitimate policy, and darwin CI could not see it.
      const win = loadManagedPiPolicyWithDiagnostics(winDeps({
        lstatSync: (candidate: string) => candidate === WIN_PATH
          ? node('file', { mode: 0o100666, uid: 1000 })
          : node('directory', { mode: 0o40777, uid: 1000 }),
        fstatSync: () => node('file', { mode: 0o100666, uid: 1000 }),
      }) as never)
      expect(win.policy.disabledPermissionModes).toEqual(['auto'])
      expect(win.drops).toHaveLength(0)
    })

    test('an unset ProgramFiles refuses the tier and NAMES that check', () => {
      const win = loadManagedPiPolicyWithDiagnostics(winDeps({ programFiles: undefined }) as never)
      expect(win.policy).toEqual(DEFAULT_MANAGED_PI_POLICY)
      expect(win.drops).toHaveLength(1)
      expect(win.drops[0]?.reason).toContain('ProgramFiles environment variable is unset')
      expect(win.drops[0]?.disposition).toBe('stripped')
    })

    test('a relative ProgramFiles is refused too — it names no administrator-ACL directory', () => {
      const win = loadManagedPiPolicyWithDiagnostics(winDeps({ programFiles: 'Program Files' }) as never)
      expect(win.policy).toEqual(DEFAULT_MANAGED_PI_POLICY)
      expect(win.drops[0]?.reason).toContain('not an absolute path')
    })

    test('a junction redirecting the path OUT of the directory is refused, naming where it went', () => {
      const win = loadManagedPiPolicyWithDiagnostics(winDeps({
        realpathSync: (candidate: string) => candidate === WIN_PATH
          ? 'C:\\Users\\mallory\\managed-policy.json'
          : candidate,
      }) as never)
      expect(win.policy).toEqual(DEFAULT_MANAGED_PI_POLICY)
      expect(win.drops).toHaveLength(1)
      expect(win.drops[0]?.reason).toContain('C:\\Users\\mallory\\managed-policy.json')
      expect(win.drops[0]?.reason).toContain('junction or link')
    })

    test('a DIFFERENT CASE from the environment is not a redirect — the compare is case-insensitive', () => {
      // `realpathSync` answers with the casing on disk. A case-sensitive
      // compare would refuse a legitimate policy for a reason that has nothing
      // to do with its provenance.
      const win = loadManagedPiPolicyWithDiagnostics(winDeps({
        realpathSync: (candidate: string) => candidate === WIN_PATH
          ? WIN_PATH.toUpperCase()
          : candidate,
      }) as never)
      expect(win.policy.disabledPermissionModes).toEqual(['auto'])
      expect(win.drops).toHaveLength(0)
    })

    test('a policy left at the FORMER location is reported, not read, and the notice names the new path', () => {
      const legacyPath = 'C:\\ProgramData\\Nessy\\managed-policy.json'
      const win = loadManagedPiPolicyWithDiagnostics(winDeps({
        programData: 'C:\\ProgramData',
        lstatSync: (candidate: string) => candidate === WIN_PATH || candidate === legacyPath
          ? node('file')
          : node('directory'),
      }) as never)
      // The new location still loads …
      expect(win.policy.disabledPermissionModes).toEqual(['auto'])
      // … and the old one is named rather than silently ignored.
      const legacy = win.drops.find(drop => drop.source === legacyPath)
      expect(legacy?.reason).toContain('IGNORED')
      expect(legacy?.reason).toContain(WIN_PATH)
    })

    test('an absent policy is not a refusal — the ordinary unmanaged machine', () => {
      const win = loadManagedPiPolicyWithDiagnostics(winDeps({
        lstatSync: () => {
          const error = new Error('missing') as NodeJS.ErrnoException
          error.code = 'ENOENT'
          throw error
        },
        realpathSync: () => {
          const error = new Error('missing') as NodeJS.ErrnoException
          error.code = 'ENOENT'
          throw error
        },
      }) as never)
      expect(win.policy).toEqual(DEFAULT_MANAGED_PI_POLICY)
      expect(win.drops).toHaveLength(0)
    })

    test('every win32 refusal is a DROP, never an exception', () => {
      // Refusing to start is the failure mode this whole slice exists to remove.
      for (const overrides of [{}, { programFiles: undefined }, { programFiles: 'relative' }]) {
        expect(() => loadManagedPiPolicy(winDeps(overrides) as never)).not.toThrow()
      }
    })

    test('the directory the policy is read from is the one the instruction tier uses', () => {
      expect(managedSystemDirForPlatform('win32', WIN_ROOT)).toBe(WIN_DIR)
    })
  })

  test('returns the frozen built-in policy only when the fixed file is absent', () => {
    const policy = loadManagedPiPolicy(loaderDeps({
      lstatSync: () => {
        const error = new Error('missing') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      },
    }) as never)

    expect(policy).toEqual({ schemaVersion: 1, disabledPermissionModes: [] })
    expect(Object.isFrozen(policy)).toBe(true)
  })

  test('rejects malformed, oversized, nonregular, symlink, owner/mode, and replacement attacks', () => {
    expect(() => loadManagedPiPolicy(loaderDeps({ readFileSync: () => '{' }) as never)).toThrow('managed-pi-policy-invalid')
    expect(() => loadManagedPiPolicy(loaderDeps({ fstatSync: () => node('file', { size: 262145 }) }) as never)).toThrow('managed-pi-policy-invalid')
    expect(() => loadManagedPiPolicy(loaderDeps({ lstatSync: () => node('directory') }) as never)).toThrow('managed-pi-policy-invalid')
    expect(() => loadManagedPiPolicy(loaderDeps({ lstatSync: (path: string) => path.endsWith('.json')
      ? node('file', { isSymbolicLink: () => true })
      : node('directory') }) as never)).toThrow('managed-pi-policy-invalid')
    expect(() => loadManagedPiPolicy(loaderDeps({ fstatSync: () => node('file', { uid: 501 }) }) as never)).toThrow('managed-pi-policy-invalid')
    expect(() => loadManagedPiPolicy(loaderDeps({ fstatSync: () => node('file', { mode: 0o100666 }) }) as never)).toThrow('managed-pi-policy-invalid')
    expect(() => loadManagedPiPolicy(loaderDeps({ fstatSync: () => node('file', { ino: 99 }) }) as never)).toThrow('managed-pi-policy-invalid')
    expect(() => loadManagedPiPolicy(loaderDeps({ closeSync: () => { throw new Error('close failed') } }) as never)).toThrow('managed-pi-policy-invalid')
  })

  test('parses a verified fixed file and closes its no-follow descriptor', () => {
    let closed = 0
    const policy = loadManagedPiPolicy(loaderDeps({ closeSync: () => { closed++ } }) as never)

    expect(policy.disabledPermissionModes).toEqual(['auto'])
    expect(closed).toBe(1)
  })

  test('claudeRules compile at load', () => {
    const withRules = JSON.stringify({
      schemaVersion: 1,
      disabledPermissionModes: [],
      claudeRules: { deny: ['Read(//etc/secrets/**)'] },
    })
    const policy = loadManagedPiPolicy(loaderDeps({ readFileSync: () => withRules }) as never)
    expect(policy.permissionDsl?.rules.map(rule => rule.id)).toEqual(['claude-deny-0'])
  })

  test('a misspelled key no longer bricks startup, and the drop names its source', () => {
    // `managed-settings.md#find-entries-claude-code-dropped` (also reachable as
    // `#invalid-entries-in-managed-settings`, an explicit anchor the rename left
    // behind) — "Claude Code first skips the individual entries it can repair,
    // such as one invalid permission rule, with a warning for each, then drops
    // any top-level key whose value still fails and keeps enforcing every
    // remaining valid key." The reassurance this comment used to quote — that a
    // single misspelling cannot disable the rest of your settings — is on NO
    // Claude page any more (checked 2026-09-10: the word it turned on occurs
    // zero times across settings.md, settings-reference.md, managed-settings.md
    // and server-managed-settings.md, while the control terms "tolerance" and
    // "validation" both hit); the per-key fallback above states the same
    // property without the reassurance. Before R25a this file threw
    // `managed-pi-policy-invalid` out of bootstrap, so one misspelling in a
    // fleet-wide push stopped every client from starting.
    const typo = JSON.stringify({
      schemaVersion: 1,
      disabledPermissionModes: ['auto'],
      deniedMcpServrs: ['dangerous'],
    })
    const { policy, drops } = loadManagedPiPolicyWithDiagnostics(
      loaderDeps({ readFileSync: () => typo }) as never,
    )
    expect(policy.disabledPermissionModes).toEqual(['auto'])
    expect(drops).toEqual([{
      source: '/etc/nessy/managed-policy.json',
      field: 'deniedMcpServrs',
      reason: 'invalid managed Pi policy key: deniedMcpServrs',
      disposition: 'stripped',
    }])
  })

  test('an absent file reports no drops', () => {
    const load = loadManagedPiPolicyWithDiagnostics(loaderDeps({
      lstatSync: () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
    }) as never)
    expect(load.policy).toBe(DEFAULT_MANAGED_PI_POLICY)
    expect(load.drops).toEqual([])
  })

  test('a policy stamped for another schema keeps every entry that still parses', () => {
    // `managed-settings.md#find-entries-claude-code-dropped` — the fail-open
    // rule: Claude Code "drops any top-level key whose value still fails and
    // keeps enforcing every remaining valid key". Before R25a this threw out of
    // bootstrap; then it stripped the whole document, which is exactly what
    // that rule forbids. REWRITTEN: the stamp is one entry, so the deny list
    // and the retention window survive it.
    const future = JSON.stringify({
      schemaVersion: 2,
      disabledPermissionModes: ['auto'],
      cleanupPeriodDays: 45,
    })
    const { policy, drops } = loadManagedPiPolicyWithDiagnostics(
      loaderDeps({ readFileSync: () => future }) as never,
    )
    expect(drops.map(drop => drop.field)).toEqual(['schemaVersion'])
    expect(policy.disabledPermissionModes).toEqual(['auto'])
    expect(policy.cleanupPeriodDays).toBe(45)
  })

  test('file-level defects still fail closed — a typo is not a broken owner or broken JSON', () => {
    // The `managed-settings.md#find-entries-claude-code-dropped` tolerance is
    // about schema validation of ENTRIES. A file the host does not own, or that
    // is not JSON at all, has no entries to salvage and stays fail-closed —
    // that section's own second half: "When a managed settings file, drop-in
    // file, MDM plist, or HKLM registry value is present but can't be parsed as
    // a JSON object, Claude Code refuses to start and prints an error naming
    // the source, even when another admin source delivers a valid policy."
    expect(() => loadManagedPiPolicyWithDiagnostics(loaderDeps({ readFileSync: () => '{' }) as never))
      .toThrow('managed-pi-policy-invalid')
    expect(() => loadManagedPiPolicyWithDiagnostics(
      loaderDeps({ fstatSync: () => node('file', { uid: 501 }) }) as never,
    )).toThrow('managed-pi-policy-invalid')
  })
})

describe('managed policy drop-in fragments (managed-settings.md#split-a-file-based-policy-across-teams)', () => {
  test('arrays CONCATENATE and DE-DUPLICATE across fragments', () => {
    // The whole point of that section — "If several teams own parts of one
    // policy, put each part in its own file in `managed-settings.d/`, next to
    // `managed-settings.json` in the same system directory, instead of editing
    // one shared file" — plus its list rule, "the two lists combine, with
    // duplicates removed". The natural
    // implementation REPLACES the array, which would silently delete the other
    // team's rule. Two fragments each contribute one deny entry; both survive,
    // and the entry both name appears once.
    const { policy } = loadManagedPiPolicyWithDiagnostics(dropInDeps({
      [BASE]: { schemaVersion: 1, disabledPermissionModes: [], deniedMcpServers: ['shared'] },
      [`${DROP_IN}/10-telemetry.json`]: { deniedMcpServers: ['telemetry-server', 'shared'] },
      [`${DROP_IN}/20-security.json`]: { deniedMcpServers: ['risky-server', 'shared'] },
    }) as never)

    expect(policy.deniedMcpServers).toEqual([
      { serverName: 'shared' },
      { serverName: 'telemetry-server' },
      { serverName: 'risky-server' },
    ])
  })

  test('later files win for scalars, objects deep-merge, and `.` files are ignored', () => {
    const { policy } = loadManagedPiPolicyWithDiagnostics(dropInDeps({
      [BASE]: {
        schemaVersion: 1,
        disabledPermissionModes: [],
        channelsEnabled: true,
        sandbox: { excludedCommands: ['docker *'], allowUnsandboxedCommands: true },
      },
      // Alphabetical order decides the scalar conflict: 20- wins over 10-.
      [`${DROP_IN}/20-security.json`]: {
        channelsEnabled: false,
        sandbox: { allowUnsandboxedCommands: false },
      },
      [`${DROP_IN}/10-telemetry.json`]: { channelsEnabled: true },
      [`${DROP_IN}/.hidden.json`]: { channelsEnabled: true, deniedMcpServers: ['ignored'] },
      [`${DROP_IN}/notes.md`]: 'not json',
    }) as never)

    expect(policy.channelsEnabled).toBe(false)
    // Deep merge: the base's own sandbox key survives the fragment's edit.
    expect(policy.sandbox).toEqual({ excludedCommands: ['docker *'], allowUnsandboxedCommands: false })
    // The hidden file and the non-json file contributed nothing.
    expect(policy.deniedMcpServers).toBeUndefined()
  })

  test('a fragment with a bad entry is tolerated, and the drop names THAT fragment', () => {
    const { policy, drops } = loadManagedPiPolicyWithDiagnostics(dropInDeps({
      [BASE]: { schemaVersion: 1, disabledPermissionModes: ['auto'], deniedMcpServers: ['from-base'] },
      // `'*'` is a VALID deny name since S5 (`managed-mcp.md:155` takes any
      // non-empty string there), so the bad entry has to be one with nothing
      // in it to salvage.
      [`${DROP_IN}/30-typo.json`]: { deniedMcpServers: [{}], deniedMcpServrs: ['typo'] },
    }) as never)

    // The base policy and the fragment's valid part both still apply.
    expect(policy.disabledPermissionModes).toEqual(['auto'])
    expect(policy.deniedMcpServers).toEqual([{ serverName: 'from-base' }])
    expect(drops).toEqual([
      {
        source: `${DROP_IN}/30-typo.json`,
        field: 'deniedMcpServrs',
        reason: 'invalid managed Pi policy key: deniedMcpServrs',
        disposition: 'stripped',
      },
      {
        source: `${DROP_IN}/30-typo.json`,
        field: 'deniedMcpServers[1]',
        reason: 'invalid managed MCP denylist entry: no serverUrl, serverCommand or serverName;'
          + ' the server it named is NOT blocked',
        disposition: 'stripped',
      },
    ])
  })

  test('an unreadable fragment is skipped, not a whole-directory abort', () => {
    const { policy, drops } = loadManagedPiPolicyWithDiagnostics(dropInDeps({
      [BASE]: { schemaVersion: 1, disabledPermissionModes: ['auto'] },
      [`${DROP_IN}/10-broken.json`]: { deniedMcpServers: ['never-read'] },
      [`${DROP_IN}/20-good.json`]: { deniedMcpServers: ['applied'] },
    }, { unreadable: [`${DROP_IN}/10-broken.json`] }) as never)

    expect(policy.disabledPermissionModes).toEqual(['auto'])
    expect(policy.deniedMcpServers).toEqual([{ serverName: 'applied' }])
    expect(drops).toEqual([{
      source: `${DROP_IN}/10-broken.json`,
      field: '',
      reason: 'managed policy fragment is unreadable or not host-owned',
      disposition: 'stripped',
    }])
  })

  test('fragments apply with no base file at all', () => {
    const { policy } = loadManagedPiPolicyWithDiagnostics(dropInDeps({
      [`${DROP_IN}/10-security.json`]: { schemaVersion: 1, disabledPermissionModes: ['allow-all'] },
    }) as never)
    expect(policy.disabledPermissionModes).toEqual(['bypassPermissions'])
  })

  /**
   * The drop-in directory exists so separate teams can deploy independent
   * fragments — `managed-settings.md#split-a-file-based-policy-across-teams`,
   * "If several teams own parts of one policy, put each part in its own file in
   * `managed-settings.d/` … instead of editing one shared file." That makes a
   * fragment a policy input from a party who may not own every lock in the base
   * file, so it must not be able to reach one.
   *
   * `merged[key] = value` for `__proto__` reaches the INHERITED accessor rather
   * than creating an own property: the key vanishes from `Object.keys`, so the
   * parser's unknown-key refusal never sees it and records no drop — while the
   * parser reads fields as `root.allowPluginHooks`, which resolves up the
   * prototype chain. Both locks flipped, invisibly. The single-file path was
   * never vulnerable: `JSON.parse` makes `__proto__` an own property, which the
   * unknown-key check refuses.
   */
  test('a drop-in fragment cannot flip a lock through the prototype chain', () => {
    // The base deliberately does NOT declare these keys. An own property would
    // shadow the inherited one and hide the defect; the realistic case is an
    // admin who never set the lock at all and relies on its default.
    const { policy } = loadManagedPiPolicyWithDiagnostics(dropInDeps({
      [BASE]: { schemaVersion: 1, disabledPermissionModes: [] },
      [`${DROP_IN}/99-evil.json`]: '{"__proto__":{"allowPluginHooks":true,"channelsEnabled":true}}',
    }) as never)

    expect(policy.allowPluginHooks).toBeUndefined()
    expect(policy.channelsEnabled).toBeUndefined()
  })
})

/**
 * P6.246(b) — the one shape of broken managed policy that used to fail OPEN.
 *
 * A file that is not JSON at all throws `managed-pi-policy-invalid` and
 * composition fails CLOSED. A file that is valid JSON but not an OBJECT — `[]`,
 * `42`, `"x"`, `true`, `null` — used to reach `parseManagedPiPolicyTolerantV1`,
 * which returned `DEFAULT_MANAGED_PI_POLICY` (no restrictions at all) with one
 * `stripped` drop, and the boot continued. An administrator cannot be expected
 * to know which of those two a typo produced, and the difference decided whether
 * their fleet was governed.
 */
describe('P6.246(b) — a valid-JSON non-object managed policy', () => {
  for (const value of ['[]', '42', '"x"', 'true', 'null'] as const) {
    test(`a base file containing ${value} is INVALID, not an empty policy`, () => {
      expect(() => loadManagedPiPolicyWithDiagnostics(dropInDeps({
        [BASE]: value,
      }) as never)).toThrow('managed-pi-policy-invalid')
    })
  }

  test('the positive control: a well-formed base file still loads', () => {
    // Without this the assertions above could pass on a loader that refused
    // everything.
    const { policy } = loadManagedPiPolicyWithDiagnostics(dropInDeps({
      [BASE]: { schemaVersion: 1, disabledPermissionModes: ['auto'] },
    }) as never)
    expect(policy.disabledPermissionModes).toEqual(['auto'])
  })

  test('a non-object FRAGMENT is stripped and the base policy survives', () => {
    // The asymmetry the unreadable-fragment arm already establishes: one bad
    // drop-in must not delete the administrator's base policy, and the drop
    // names the file so it can be fixed.
    const { policy, drops } = loadManagedPiPolicyWithDiagnostics(dropInDeps({
      [BASE]: { schemaVersion: 1, disabledPermissionModes: ['auto'] },
      [`${DROP_IN}/10-broken.json`]: '[]',
    }) as never)

    expect(policy.disabledPermissionModes).toEqual(['auto'])
    expect(drops.map(drop => drop.reason)).toContain('managed policy fragment is not a JSON object')
    expect(drops.every(drop => drop.disposition === 'stripped')).toBe(true)
  })
})
