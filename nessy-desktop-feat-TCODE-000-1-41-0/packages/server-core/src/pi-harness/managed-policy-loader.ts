import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs'
import { dirname, join, resolve, win32 } from 'node:path'
import {
  DEFAULT_MANAGED_PI_POLICY,
  parseManagedPiPolicyTolerantV1,
  type ManagedPiPolicyV1,
  type ManagedPolicyDropV1,
} from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import {
  legacyManagedSystemDirForPlatform,
  managedSystemDirForPlatform,
} from '@nessy-agent/shared/config/managed-system-paths'

const MAX_MANAGED_POLICY_BYTES = 262_144

/** One managed policy load: what is enforced, and every entry that was refused. */
export interface ManagedPiPolicyLoadV1 {
  readonly policy: ManagedPiPolicyV1
  readonly drops: readonly ManagedPolicyDropV1[]
}

export interface ManagedPiPolicyLoaderDependencies {
  platform?: NodeJS.Platform
  /** win32 only — `%ProgramFiles%`, the documented admin-ACL root (P6.235). */
  programFiles?: string
  /** win32 only — `%ProgramData%`, read for the migration diagnostic ONLY. */
  programData?: string
  lstatSync?: typeof lstatSync
  realpathSync?: typeof realpathSync
  openSync?: typeof openSync
  fstatSync?: typeof fstatSync
  readFileSync?: typeof readFileSync
  closeSync?: typeof closeSync
  readdirSync?: (path: string) => readonly string[]
}

function invalid(): never {
  throw new Error('managed-pi-policy-invalid')
}

/**
 * A managed policy source must be a JSON OBJECT. `null` is excluded because
 * `typeof null === 'object'`, and an array because it merges as one — see the
 * P6.246(b) note at the call site for what a non-object used to cost.
 */
function isPolicyObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The system directory is resolved ONCE, in
 * `@nessy-agent/shared/config/managed-system-paths`, because the managed
 * CLAUDE.md tier (`memory.md:279`-`:281`) reads from the same directory. Spelt
 * twice, an org that deploys both files to the location its policy demonstrably
 * reaches would find only one of them read.
 */
export function managedPiPolicyPathForPlatform(
  platform: NodeJS.Platform = process.platform,
  programFiles = process.env.ProgramFiles,
): string {
  const directory = managedSystemDirForPlatform(platform, programFiles)
  if (!directory) return invalid()
  return (platform === 'win32' ? win32 : { join }).join(directory, 'managed-policy.json')
}

/**
 * The drop-in directory. `managed-settings.md#split-a-file-based-policy-across-teams`:
 * "If several teams own parts of one policy, put each part in its own file in
 * `managed-settings.d/`, next to `managed-settings.json` in the same system
 * directory, instead of editing one shared file." Our base file is
 * `managed-policy.json`, so the directory is `managed-policy.d/`.
 *
 * (Re-anchored by P6.251. The sentence this used to quote sat at line 112 of
 * the pre-split `settings.md` — named in WORDS, because spelling a dead anchor
 * in its `path:line` form makes every citation guard report the correction as
 * the very finding it repairs. That page split and the drop-in material moved
 * here whole.)
 */
export function managedPiPolicyDropInDirForPlatform(
  platform: NodeJS.Platform = process.platform,
  programFiles = process.env.ProgramFiles,
): string {
  return managedPiPolicyPathForPlatform(platform, programFiles).replace(/\.json$/, '.d')
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}

function safeNode(stat: Stats, kind: 'file' | 'directory'): boolean {
  return !stat.isSymbolicLink() && (kind === 'file' ? stat.isFile() : stat.isDirectory())
}

/**
 * The POSIX ownership/mode regime. win32 has NONE, and that is decided before
 * this function is reached rather than here (P3.331, amended by P6.235).
 *
 * The early return below is not "Windows is fine": it is "there is no check to
 * run", and until P3.331 that answer was indistinguishable from a pass, at four
 * call sites, for the file that carries `permissions.*`, `sandbox.enabled`,
 * `disableAllHooks`, forced `enabledPlugins` and the `env` block for all three
 * runtimes. **P3.331's answer was to refuse the whole win32 tier here; P6.235's
 * is to check something else instead** — {@link win32AdminLocationRefusal} runs
 * first in {@link loadManagedPiPolicyWithDiagnostics} and admits only a policy
 * inside the documented administrator-ACL directory whose canonical path is
 * still inside it. So this branch IS reached on win32 now, and it still runs no
 * ownership test; what stands between an unprivileged account and this tier on
 * that platform is the directory's ACL and the junction check, never a `mode`.
 *
 * It is left as an early return rather than an `invalid()` on purpose. Node
 * derives the win32 `mode` from the read-only attribute, so `(mode & 0o022)` is
 * non-zero for essentially every ordinary Windows file and `uid` is 0 for all
 * of them: running the POSIX rule there would refuse every legitimate policy
 * for a reason that has nothing to do with its permissions, and darwin CI
 * cannot see the difference. The real check is ACL- or registry-shaped and
 * needs the Windows host P3.7 is parked on.
 */
function assertPosixOwnerAndMode(stat: Stats, platform: NodeJS.Platform): void {
  if (platform === 'win32') return
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) invalid()
}

/** Path equality, case-insensitive on win32 and exact everywhere else. */
function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Whether `candidate` is `root` itself or sits under it, by win32 rules. */
function containedInWin32(root: string, candidate: string): boolean {
  const base = win32.resolve(root).replace(/[\\/]+$/, '').toLowerCase()
  const target = win32.resolve(candidate).toLowerCase()
  return target === base || target.startsWith(`${base}\\`)
}

/**
 * The win32 admission check — P6.235. Returns the REASON the tier is refused,
 * naming which check failed, or `undefined` when the location is admissible.
 *
 * **This is a LOCATION check, not an ACL read**, and the distinction is stated
 * rather than blurred: nothing here asks Windows who owns the directory. The
 * control is that `%ProgramFiles%` is administrator-writable by default, which
 * is the same control `managed-settings.md#where-each-mechanism-stores-the-policy`
 * itself rests on when it names `C:\Program Files\ClaudeCode\` and refuses the
 * `%ProgramData%` path this product used to read. A real ACL check (`icacls`)
 * or the `HKLM\SOFTWARE\Policies\…` route remains the stronger answer and
 * stays parked with the Windows evidence day, P3.7.
 *
 * The three checks, in the order they can fail:
 *
 *  1. `%ProgramFiles%` must be set and absolute. Unset, there is no
 *     administrator-ACL directory to resolve against and the tier is refused —
 *     it is not an excuse to read whatever `win32.join` produced.
 *  2. The policy path must be inside it. It is by construction today; the check
 *     exists because construction is one refactor away from not being true.
 *  3. The canonical path must still be inside it. This is the check that has
 *     teeth: it is what a directory junction planted over `…\Nessy` fails, and
 *     a junction is the win32 shape of the symlink redirect the POSIX arm
 *     already refuses. An ABSENT file is not a failure — that is the ordinary
 *     unmanaged machine, and the read below finds nothing.
 */
function win32AdminLocationRefusal(
  policyPath: string,
  programFiles: string | undefined,
  io: LoaderIo,
): string | undefined {
  if (!programFiles || !win32.isAbsolute(programFiles)) {
    return 'the ProgramFiles environment variable is unset or is not an absolute path, so the '
      + 'administrator-ACL directory a managed policy must live in cannot be located'
  }
  const root = win32.join(win32.resolve(programFiles), 'Nessy')
  if (!containedInWin32(root, policyPath)) {
    return `the managed policy path is outside ${root}, the administrator-ACL directory`
  }
  let canonical: string
  try {
    canonical = io.realpath(policyPath)
  } catch (error) {
    // Absent is the normal case on an unmanaged machine; anything else is a
    // path we could not canonicalise, which fails closed like every other
    // per-file check in this file.
    return isMissing(error)
      ? undefined
      : 'the managed policy path could not be canonicalised, so a junction redirecting it out of '
        + 'the administrator-ACL directory cannot be ruled out'
  }
  return containedInWin32(root, canonical)
    ? undefined
    : `the managed policy path resolves to ${canonical}, outside ${root}: a junction or link `
      + 'redirects it out of the administrator-ACL directory'
}

function sameNode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.uid === right.uid && left.mode === right.mode
}

interface ManagedPolicySource {
  readonly path: string
  readonly value: unknown
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Keys the merge must never write through. See the comment at the write site:
 * assigning these reaches an inherited accessor instead of creating an own
 * property, which both hides the key from the parser's unknown-key refusal and
 * lets a later `root.<field>` read inherit an attacker-chosen value.
 */
const UNSAFE_MERGE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Field paths whose combination rule is REPLACE-BY-NAME, not the list union.
 * `managed-settings.md#split-a-file-based-policy-across-teams`:
 * "**`extraKnownMarketplaces`**: a later entry with the same name replaces the
 * earlier one whole".
 *
 * Union is the wrong rule here and it fails SILENTLY, which is why this is a
 * fix and not a tidy-up. Two fragments naming the same marketplace with
 * different sources are structurally distinct, so the union arm keeps BOTH, and
 * `parseDeliveredMarketplaceEntries` then de-duplicates by name with the FIRST
 * one winning ("the FIRST name wins so the outcome does not depend on object
 * key order", `managed-marketplace-entries.ts`) — so `20-security.json`'s
 * correction of `10-base.json`'s entry was discarded, which is the exact
 * inversion of the documented rule.
 *
 * `fallbackModel` and `modelPicker` carry the same *whole-replacement* wording
 * on that page and are deliberately NOT here: neither is a key of
 * `ManagedPiPolicyV1`, so both are stripped before any reader sees them and
 * there is nothing for a rule to govern. See {@link mergeManagedPolicyValue}.
 */
const MERGE_REPLACE_BY_NAME_KEYS: ReadonlySet<string> = new Set(['extraKnownMarketplaces', 'managedMcpServers']) // F1.593: an object keyed by name

/** The `name` a delivered entry declares, when it declares a readable one. */
function entryName(value: unknown): string | undefined {
  const name = plainObject(value)?.name
  return typeof name === 'string' ? name : undefined
}

/**
 * The array spelling of a replace-by-name key. A later entry whose name the
 * earlier list already carries replaces it IN PLACE — position is the parser's
 * tie-breaker, so replacing in place keeps a fragment from also reordering the
 * list. A nameless entry has no identity to replace on, so it falls back to the
 * union arm's structural de-duplication; the parser drops it either way.
 */
function mergeByName(
  base: readonly unknown[],
  next: readonly unknown[],
  path: string,
  source: string,
  provenance: Map<string, string>,
): readonly unknown[] {
  const merged = [...base]
  for (const entry of next) {
    const name = entryName(entry)
    const at = name === undefined ? -1 : merged.findIndex(existing => entryName(existing) === name)
    if (at >= 0) {
      merged[at] = entry
      claim(entry, `${path}[${at}]`, source, provenance)
      continue
    }
    if (name === undefined && merged.some(existing => sameEntry(existing, entry))) continue
    claim(entry, `${path}[${merged.length}]`, source, provenance)
    merged.push(entry)
  }
  return merged
}

/** Identity for de-duplication. Strings compare directly; rules by structure. */
function sameEntry(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Record which file a value and everything under it came from. */
function claim(
  value: unknown,
  path: string,
  source: string,
  provenance: Map<string, string>,
): void {
  provenance.set(path, source)
  if (Array.isArray(value)) {
    value.forEach((_, index) => provenance.set(`${path}[${index}]`, source))
    return
  }
  const object = plainObject(value)
  if (!object) return
  for (const [key, child] of Object.entries(object)) {
    claim(child, path === '' ? key : `${path}.${key}`, source, provenance)
  }
}

/**
 * The per-kind combination rules of
 * `managed-settings.md#split-a-file-based-policy-across-teams`, which is where
 * the material this file used to cite at line 114 of the pre-split
 * `settings.md` lives now — named in WORDS, because that page split and a
 * line-numbered anchor into it is dead at the PAGE level, while spelling the
 * old anchor here would make every citation guard report this correction as a
 * finding. Quoted rule by rule, because P6.251 pins them one at a time:
 *
 *  - "**Single values**, such as `"model": "opus"` or `"cleanupPeriodDays": 7`:
 *    the later file's value replaces the earlier one"
 *  - "**Lists**, such as `permissions.deny` or `sandbox.network.allowedDomains`:
 *    the two lists combine, with duplicates removed"
 *  - "**Nested blocks**, such as `env` or `sandbox`: the two blocks merge key by
 *    key, and each key inside follows these same rules"
 *  - "**`extraKnownMarketplaces`** and **`managedMcpServers`**: a later entry
 *    with the same name replaces the earlier one whole" —
 *    {@link MERGE_REPLACE_BY_NAME_KEYS}. (`managedMcpServers` joined that bullet
 *    after P6.251 pinned it; re-read 2026-09-10.)
 *  - "**`fallbackModel`**: the later chain replaces the earlier one whole" and
 *    "**`modelPicker`**: the later lineup replaces the earlier one whole" —
 *    NEITHER is a key of `ManagedPiPolicyV1`, so the parser strips both and
 *    their combination rule is unobservable here. Recorded as a null rather
 *    than implemented: adding a replace rule for a key nothing reads would be a
 *    control this repo states and does not have. The pin asserts the strip, so
 *    the day either key enters the schema its rule is one red test away.
 *
 * Arrays UNION. The natural implementation replaces, and replacing is what
 * would defeat the whole point of the drop-in directory — two teams deploying
 * independent fragments would silently delete each other's rules.
 */
function mergeManagedPolicyValue(
  base: unknown,
  next: unknown,
  path: string,
  source: string,
  provenance: Map<string, string>,
): unknown {
  const baseObject = plainObject(base)
  const nextObject = plainObject(next)
  if (baseObject && nextObject) {
    const merged: Record<string, unknown> = { ...baseObject }
    for (const [key, value] of Object.entries(nextObject)) {
      // `merged[key] = …` for `__proto__` hits the INHERITED accessor, not a
      // data write: the key never becomes an own property, so the parser's
      // `Object.keys` unknown-key refusal cannot see it and records no drop —
      // while the parser reads fields as `root.allowPluginHooks`, which
      // resolves up the chain. A fragment of `{"__proto__":{"allowPluginHooks":
      // true,"channelsEnabled":true}}` therefore turned both locks off,
      // invisibly. `JSON.parse` makes the key an OWN property, so the
      // single-file path always refused it; only this merge could smuggle it.
      if (UNSAFE_MERGE_KEYS.has(key)) continue
      const child = path === '' ? key : `${path}.${key}`
      // The object spelling of a replace-by-name key: the object's own keys ARE
      // the names, so "replaces the earlier one whole" means this block is not
      // deep-merged. Without this a later fragment correcting one field of an
      // entry would inherit the rest of the earlier entry's fields.
      if (MERGE_REPLACE_BY_NAME_KEYS.has(path)) {
        merged[key] = value
        claim(value, child, source, provenance)
        continue
      }
      merged[key] = mergeManagedPolicyValue(baseObject[key], value, child, source, provenance)
    }
    return merged
  }
  if (Array.isArray(base) && Array.isArray(next)) {
    if (MERGE_REPLACE_BY_NAME_KEYS.has(path)) return mergeByName(base, next, path, source, provenance)
    const merged = [...base]
    for (const entry of next) {
      if (merged.some(existing => sameEntry(existing, entry))) continue
      provenance.set(`${path}[${merged.length}]`, source)
      merged.push(entry)
    }
    return merged
  }
  claim(next, path, source, provenance)
  return next
}

export function mergeManagedPolicySources(sources: readonly ManagedPolicySource[]): {
  merged: unknown
  provenance: ReadonlyMap<string, string>
} {
  const provenance = new Map<string, string>()
  let merged: unknown
  sources.forEach((source, index) => {
    if (index === 0) {
      claim(source.value, '', source.path, provenance)
      merged = source.value
      return
    }
    merged = mergeManagedPolicyValue(merged, source.value, '', source.path, provenance)
  })
  return { merged, provenance }
}

/**
 * Which file a dropped entry came from. Walks the field path outwards, so
 * `sandbox.network.allowedDomains[1]` is attributed to whichever fragment
 * contributed that exact entry, then that list, then that block.
 */
function resolveDropSource(field: string, provenance: ReadonlyMap<string, string>): string | undefined {
  let path = field
  for (;;) {
    const hit = provenance.get(path)
    if (hit !== undefined) return hit
    if (path.length === 0) return undefined
    const cut = Math.max(path.lastIndexOf('.'), path.lastIndexOf('['))
    path = cut <= 0 ? '' : path.slice(0, cut)
  }
}

interface LoaderIo {
  lstat: typeof lstatSync
  realpath: typeof realpathSync
  open: typeof openSync
  fstat: typeof fstatSync
  read: typeof readFileSync
  close: typeof closeSync
  readdir: (path: string) => readonly string[]
}

/**
 * Read ONE host-owned JSON file under the full ownership/symlink/size regime.
 * Returns `undefined` when the file is absent; anything else that fails is
 * fatal for this file.
 */
function readHostOwnedJson(
  path: string,
  containingDirectory: string,
  platform: NodeJS.Platform,
  io: LoaderIo,
): unknown {
  let descriptor: number | undefined
  try {
    let fileStat: Stats
    try {
      fileStat = io.lstat(path)
    } catch (error) {
      if (isMissing(error)) return undefined
      return invalid()
    }
    const directoryStat = io.lstat(containingDirectory)
    if (!safeNode(fileStat, 'file') || !safeNode(directoryStat, 'directory')) invalid()
    assertPosixOwnerAndMode(fileStat, platform)
    assertPosixOwnerAndMode(directoryStat, platform)
    // The canonical path must be the path we asked for, so a junction or a
    // symlink cannot redirect the read. Compared case-INSENSITIVELY on win32:
    // that filesystem is case-preserving but case-insensitive, and
    // `realpathSync` answers with the casing on disk, which need not match the
    // casing `%ProgramFiles%` carries. A case-sensitive compare there would
    // refuse a legitimate policy for a reason that has nothing to do with its
    // provenance — the same shape as running the POSIX mode rule on Windows
    // (see {@link assertPosixOwnerAndMode}), and darwin CI cannot see either.
    if (!samePath(io.realpath(path), path, platform)) invalid()

    descriptor = io.open(path, constants.O_RDONLY | (platform === 'win32' ? 0 : constants.O_NOFOLLOW))
    const openedStat = io.fstat(descriptor)
    if (!safeNode(openedStat, 'file') || !sameNode(fileStat, openedStat) || openedStat.size > MAX_MANAGED_POLICY_BYTES) invalid()
    assertPosixOwnerAndMode(openedStat, platform)
    const raw = io.read(descriptor, 'utf8')
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_MANAGED_POLICY_BYTES) invalid()
    return JSON.parse(raw)
  } catch {
    return invalid()
  } finally {
    if (descriptor !== undefined) {
      try { io.close(descriptor) } catch { invalid() }
    }
  }
}

/**
 * The fragment list, in merge order: `*.json` sorted ALPHABETICALLY, with
 * hidden files ignored. `managed-settings.md#split-a-file-based-policy-across-teams`
 * carries both halves in one sentence: "Claude Code merges
 * `managed-settings.json` first, then every `*.json` file in the directory in
 * alphabetical order. Name the files with numeric prefixes to control the
 * order, such as `10-telemetry.json` and `20-security.json`. Claude Code
 * ignores hidden files and files that don't end in `.json`.".
 *
 * An absent directory is the normal case. A directory that is not a directory,
 * or that the host does not exclusively own, is skipped WHOLE with a drop
 * rather than aborting: refusing to start is the failure mode this whole slice
 * exists to remove, and a silent skip would be the other half of the bug.
 */
function listDropInFragments(
  dropInPath: string,
  platform: NodeJS.Platform,
  io: LoaderIo,
  drops: ManagedPolicyDropV1[],
  joinPath: (directory: string, name: string) => string,
): readonly string[] {
  let names: readonly string[]
  try {
    const stat = io.lstat(dropInPath)
    if (!safeNode(stat, 'directory')) {
      drops.push(Object.freeze({
        source: dropInPath,
        field: '',
        reason: 'managed policy drop-in path is not a directory',
        disposition: 'stripped',
      }))
      return []
    }
    assertPosixOwnerAndMode(stat, platform)
    names = io.readdir(dropInPath)
  } catch (error) {
    if (isMissing(error)) return []
    drops.push(Object.freeze({
      source: dropInPath,
      field: '',
      reason: 'managed policy drop-in directory is not readable or not host-owned',
      disposition: 'stripped',
    }))
    return []
  }
  return names
    .filter(name => name.endsWith('.json') && !name.startsWith('.'))
    .sort()
    .map(name => joinPath(dropInPath, name))
}

/**
 * Production policy API: it reads exactly the host-owned path for the current
 * platform, plus the `managed-policy.d/` drop-in directory beside it. The
 * optional argument exists only for filesystem/platform test seams.
 *
 * On **win32** it reads `%ProgramFiles%\Nessy`, the documented
 * administrator-ACL location, and refuses by NAME when that location cannot be
 * trusted — see the guard below (P6.235, superseding P3.331's blanket refusal).
 * Every ownership check in this file is still a no-op on that platform; what
 * replaces them is the directory's own default ACL plus a canonical-path check
 * that a junction fails. **No Windows rig exists (P3.7 ⬜), so that arm is
 * unit-tested through the injected seams and is not a live measurement.**
 *
 * Schema-invalid ENTRIES no longer abort — they are stripped and reported
 * through {@link ManagedPiPolicyLoadV1.drops}
 * (`managed-settings.md#find-entries-claude-code-dropped`: Claude Code "first
 * skips the individual entries it can repair, such as one invalid permission
 * rule, with a warning for each, then drops any top-level key whose value still
 * fails and keeps enforcing every remaining valid key"). Per-file
 * checks (ownership, mode, symlink, size, JSON syntax) still fail closed for
 * the BASE file: those are not typos in a policy, and a file the host does not
 * own is not a policy at all. A fragment is an independent contribution
 * (`managed-settings.md#split-a-file-based-policy-across-teams`), so one team's
 * unreadable file is recorded and skipped
 * instead of taking the base policy and every other team's fragment down.
 */
export function loadManagedPiPolicyWithDiagnostics(
  deps: ManagedPiPolicyLoaderDependencies = {},
): ManagedPiPolicyLoadV1 {
  const platform = deps.platform ?? process.platform
  const pathOps = platform === 'win32' ? win32 : { dirname, resolve, join }
  const programFiles = deps.programFiles ?? process.env.ProgramFiles
  // BEFORE the path is derived, because deriving it THROWS when the variable is
  // missing and this function's contract on win32 is a drop, never an exception
  // — the invariant `the win32 refusal is a drop, never an exception` pins.
  if (platform === 'win32' && (!programFiles || !win32.isAbsolute(programFiles))) {
    return Object.freeze({
      policy: DEFAULT_MANAGED_PI_POLICY,
      drops: Object.freeze([Object.freeze({
        source: 'ProgramFiles',
        field: '',
        reason: 'managed policy is not honoured: the ProgramFiles environment variable is unset or '
          + 'is not an absolute path, so the administrator-ACL directory a managed policy must live '
          + 'in cannot be located (P6.235)',
        disposition: 'stripped' as const,
      })]),
    })
  }
  const configuredPath = managedPiPolicyPathForPlatform(platform, programFiles)
  const policyPath = pathOps.resolve(configuredPath)
  const directoryPath = pathOps.dirname(policyPath)
  const dropInPath = pathOps.resolve(managedPiPolicyDropInDirForPlatform(platform, programFiles))
  const io: LoaderIo = {
    lstat: deps.lstatSync ?? lstatSync,
    realpath: deps.realpathSync ?? realpathSync,
    open: deps.openSync ?? openSync,
    fstat: deps.fstatSync ?? fstatSync,
    read: deps.readFileSync ?? readFileSync,
    close: deps.closeSync ?? closeSync,
    readdir: deps.readdirSync ?? readdirSync,
  }

  const drops: ManagedPolicyDropV1[] = []

  // P6.235 — win32 is READ, from the documented administrator-ACL location, and
  // refused by NAME when the location cannot be trusted.
  //
  // P3.331 refused the whole tier here, for a reason that was true of the
  // directory it was reading: `%ProgramData%\Nessy`, which
  // `managed-settings.md#where-each-mechanism-stores-the-policy` calls the
  // legacy Windows path ("Claude Code doesn't read the legacy Windows path
  // `C:\ProgramData\ClaudeCode\managed-settings.json`") and which ordinary
  // accounts can write by default. That refusal was the right answer to the
  // wrong location. The directory is now `%ProgramFiles%\Nessy`, and the
  // control is the one the page itself relies on: an administrator-only ACL by
  // default. {@link win32AdminLocationRefusal} states exactly what is and is not
  // checked, and the refusal it returns NAMES the failed check rather than
  // saying "not honoured on Windows".
  //
  // NOT MEASURED ON A WINDOWS HOST. There is none on any rig (P3.7 ⬜), so every
  // claim here is unit-tested through this function's injected platform and
  // filesystem seams and the Windows evidence day stays parked. The code lands;
  // the green does not.
  if (platform === 'win32') {
    const refusal = win32AdminLocationRefusal(policyPath, programFiles, io)
    if (refusal !== undefined) {
      drops.push(Object.freeze({
        source: policyPath,
        field: '',
        reason: `managed policy is not honoured: ${refusal} (P6.235)`,
        disposition: 'stripped',
      }))
      return Object.freeze({ policy: DEFAULT_MANAGED_PI_POLICY, drops: Object.freeze(drops) })
    }
    // A policy still sitting where this product used to read is reported, not
    // read. Silence here is the whole failure mode: an administrator who
    // deployed to the old path would otherwise see a machine with no managed
    // tier and nothing saying why.
    const legacyDirectory = legacyManagedSystemDirForPlatform(platform, deps.programData ?? process.env.ProgramData)
    if (legacyDirectory !== undefined) {
      const legacyPath = win32.join(legacyDirectory, 'managed-policy.json')
      let legacyPresent = false
      try {
        legacyPresent = io.lstat(legacyPath).isFile()
      } catch {
        legacyPresent = false
      }
      if (legacyPresent) {
        drops.push(Object.freeze({
          source: legacyPath,
          field: '',
          reason: 'a managed policy at the former Windows location is IGNORED: that directory is '
            + `writable by ordinary accounts. Redeploy it to ${policyPath} (P6.235)`,
          disposition: 'stripped',
        }))
      }
    }
  }

  const sources: ManagedPolicySource[] = []
  const base = readHostOwnedJson(policyPath, directoryPath, platform, io)
  // P6.246(b) — a valid-JSON NON-OBJECT base file used to fail OPEN, and that
  // was the only shape of broken policy that did.
  //
  // Measured THEN (P6.246(b)): `parseManagedPiPolicyTolerantV1([])` returned
  // `DEFAULT_MANAGED_PI_POLICY` — `{schemaVersion: 1, disabledPermissionModes: []}`,
  // i.e. NO restrictions at all — with one `stripped` drop, and the boot
  // continued. Re-measured 2026-09-11 after C3.39 (owner answer QB6 = A) closed
  // that branch: the same call now THROWS `invalid managed Pi policy` on both
  // tiers. This guard is therefore no longer the only thing standing between an
  // administrator's typo and an ungoverned fleet, and it stays for the reason
  // the paragraph below already gives — the shape check belongs beside the read,
  // where the diagnostic can name the FILE and the fragment arm can strip one
  // drop-in without losing the base policy. So `[]`, `42`, `"x"`, `true` and `null` in the administrator's
  // policy file each removed the whole policy silently, while an unparsable file
  // one character away threw `managed-pi-policy-invalid` and composition failed
  // CLOSED. An administrator cannot be expected to know which of those two a
  // typo produced, and the difference decided whether their fleet was governed.
  //
  // The tolerant parser is right to be tolerant: it exists so ONE unknown key in
  // a policy the next version understands does not brick a fleet. But a value
  // that is not an object carries no keys to tolerate — there is nothing to
  // salvage, only a whole policy to lose — so the shape check belongs here,
  // beside the read, and not in the parser.
  if (base !== undefined) {
    if (!isPolicyObject(base)) invalid()
    sources.push({ path: policyPath, value: base })
  }

  for (const fragmentPath of listDropInFragments(dropInPath, platform, io, drops, pathOps.join)) {
    let fragment: unknown
    try {
      fragment = readHostOwnedJson(fragmentPath, dropInPath, platform, io)
    } catch {
      drops.push(Object.freeze({
        source: fragmentPath,
        field: '',
        reason: 'managed policy fragment is unreadable or not host-owned',
        disposition: 'stripped',
      }))
      continue
    }
    if (fragment === undefined) continue
    // A FRAGMENT is stripped rather than fatal, which is the asymmetry the
    // unreadable-fragment arm above already establishes: one bad drop-in must
    // not delete the administrator's base policy, and the drop says which file
    // it was. The base file has no such fallback — losing it loses everything.
    if (!isPolicyObject(fragment)) {
      drops.push(Object.freeze({
        source: fragmentPath,
        field: '',
        reason: 'managed policy fragment is not a JSON object',
        disposition: 'stripped',
      }))
      continue
    }
    sources.push({ path: fragmentPath, value: fragment })
  }

  if (sources.length === 0) {
    return Object.freeze({ policy: DEFAULT_MANAGED_PI_POLICY, drops: Object.freeze(drops) })
  }
  const { merged, provenance } = mergeManagedPolicySources(sources)
  const parsed = parseManagedPiPolicyTolerantV1(merged, { source: policyPath })
  for (const drop of parsed.drops) {
    const source = resolveDropSource(drop.field, provenance) ?? drop.source
    drops.push(source === drop.source ? drop : Object.freeze({ ...drop, source }))
  }
  return Object.freeze({ policy: parsed.policy, drops: Object.freeze(drops) })
}

/**
 * The policy alone, for call sites that enforce it and have nowhere to show a
 * diagnostic. Drops are DISCARDED here — read them through
 * {@link loadManagedPiPolicyWithDiagnostics} instead.
 */
export function loadManagedPiPolicy(deps: ManagedPiPolicyLoaderDependencies = {}): ManagedPiPolicyV1 {
  return loadManagedPiPolicyWithDiagnostics(deps).policy
}
