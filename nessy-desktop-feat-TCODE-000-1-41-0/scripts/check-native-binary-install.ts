/**
 * D1.166 — after a pin bump of a package that ships a NATIVE BINARY, prove the
 * install actually landed it.
 *
 * ## The measurement this gate exists for (W19-z, 2026-09-13; AGENTS.md §Traps)
 *
 * Lifting `@anthropic-ai/claude-agent-sdk` 0.3.247 → 0.3.251, `bun install`
 * printed `+ …@0.3.251` and `2 packages installed` and exited **0** — while the
 * eight `@anthropic-ai/claude-agent-sdk-<platform>` entries went **8 → 0** in
 * `bun.lock` and `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64`
 * stayed at **0.3.247**. A CI `--frozen-lockfile` would then have pinned no
 * native binary at all. The only thing in the tree that could see it was a hand
 * reading of the two self-reports, and nothing ran that hand reading.
 *
 * Neither `bun install` again, nor `bun install --force`, nor removing the
 * stale directory repaired it, and two isolated rigs at the same registry
 * refused to reproduce it. The cause is **not named**; this is the instrument,
 * which is what transfers.
 *
 * ## Three rules, all derived from the lockfile's OWN data
 *
 * A guard that names packages ages the day a lift adds one, so the family is
 * read out of `bun.lock` rather than listed here: a package is in the family
 * when its own entry declares `optionalDependencies` whose keys are prefixed
 * with its own name — which is exactly how npm publishes platform packages, and
 * exactly the list that went to zero.
 *
 * 1. **Every declared platform dependency has a lockfile entry.** This is the
 *    incident, verbatim. Green at HEAD: 7 families, 72 platform dependencies,
 *    0 missing (2026-09-17).
 * 2. **Its entry resolves the version the parent declares.** A lock that still
 *    lists the platform package at the version BEFORE the bump is the same
 *    defect arriving by another route, and rule 1 cannot see it.
 * 3. **An installed copy matches the lockfile.** The other half of the
 *    incident: the directory on disk stayed a version behind what the lock
 *    said. Only platform packages that are actually installed are checked — a
 *    darwin host holds no `linux-x64` copy and that is not a finding.
 *
 * ## And the named self-report pair, because a version is read two ways
 *
 * AGENTS.md's rule for the Claude SDK is that the version governing behaviour
 * is the one the runtime reports about ITSELF, and that there are two such
 * reports: `claudeCodeVersion` in the SDK package's manifest, and the vendored
 * binary's own `--version`. They agreed on 2026-09-07 and 2026-09-10 and they
 * PARTED on 2026-09-13 — `claudeCodeVersion` 2.1.251 against `claude --version`
 * 2.1.247 — and the parting is the signal. That pair is named rather than
 * derived because no other package in this tree publishes a mapping from its
 * npm version to a second, differently-numbered runtime version; when one does,
 * it gets a row of its own here rather than a clever rule.
 *
 * It SKIPS, loudly and with exit 0, when the SDK package or the platform binary
 * is absent — a fresh checkout before `bun install`, or CI on a platform whose
 * binary this lockfile does not install here. A skip that reads as a pass is
 * how the 2026-09-13 ripgrep absence presented as a denied-path regression, so
 * every skip is printed with its reason.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export interface PlatformDependency {
  /** The package that declares it, e.g. `@anthropic-ai/claude-agent-sdk`. */
  parent: string
  /** The platform package, e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64`. */
  name: string
  /** The version the parent's manifest declares for it. */
  declared: string
  /** The version its own lockfile entry resolves to, or null when absent. */
  locked: string | null
  /** The version the installed copy reports, or null when not installed. */
  installed: string | null
}

export type NativeBinaryFindingReason =
  | 'platform-entry-missing'
  | 'locked-version-disagrees'
  | 'installed-version-disagrees'

export interface NativeBinaryFinding extends PlatformDependency {
  reason: NativeBinaryFindingReason
}

export interface SelfReportPair {
  /** What the package manifest says the runtime version is. */
  manifest: string | null
  /** What the binary says when asked. */
  binary: string | null
  /** Set when the pair could not be read; the pair is then neither agreed nor parted. */
  skipped: string | null
}

export interface NativeBinaryReport {
  families: string[]
  dependencies: PlatformDependency[]
  findings: NativeBinaryFinding[]
  selfReport: SelfReportPair
}

/**
 * `bun.lock` is JSONC: it carries trailing commas, so `JSON.parse` refuses it
 * and `Bun.file().json()` refuses it too (measured 2026-09-17). Stripped with a
 * scanner rather than a regex because the file is full of URLs and base64
 * signatures, and a regex that does not know where a string ends will eventually
 * edit one.
 */
export function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; out += char; continue }
    if (char === ',') {
      // Look ahead past whitespace: a comma whose next non-space character
      // closes a container is the trailing comma bun writes.
      let ahead = index + 1
      while (ahead < text.length && /\s/.test(text[ahead]!)) ahead += 1
      const next = text[ahead]
      if (next === '}' || next === ']') continue
    }
    out += char
  }
  return JSON.parse(out)
}

function entryMetadata(entry: unknown): Record<string, unknown> | null {
  if (!Array.isArray(entry)) return null
  for (const part of entry) {
    if (part && typeof part === 'object' && !Array.isArray(part)) return part as Record<string, unknown>
  }
  return null
}

/** The version an entry resolves to, read from its `name@version` first element. */
function entryVersion(name: string, entry: unknown): string | null {
  if (!Array.isArray(entry) || typeof entry[0] !== 'string') return null
  const spec = entry[0]
  if (!spec.startsWith(`${name}@`)) return null
  return spec.slice(name.length + 1)
}

export function readInstalledVersion(repoRoot: string, name: string): string | null {
  const manifest = join(repoRoot, 'node_modules', ...name.split('/'), 'package.json')
  if (!existsSync(manifest)) return null
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

export function collectPlatformDependencies(
  lock: unknown,
  repoRoot: string,
): { families: string[]; dependencies: PlatformDependency[] } {
  const packages = (lock as { packages?: Record<string, unknown> } | null)?.packages
  if (!packages || typeof packages !== 'object') return { families: [], dependencies: [] }

  const families: string[] = []
  const dependencies: PlatformDependency[] = []
  for (const [parent, entry] of Object.entries(packages)) {
    const optional = entryMetadata(entry)?.optionalDependencies
    if (!optional || typeof optional !== 'object') continue
    const platformKeys = Object.keys(optional as Record<string, string>)
      .filter(key => key.startsWith(`${parent}-`))
      .sort()
    if (platformKeys.length === 0) continue
    families.push(parent)
    for (const name of platformKeys) {
      dependencies.push({
        parent,
        name,
        declared: String((optional as Record<string, string>)[name]),
        locked: entryVersion(name, packages[name]),
        installed: readInstalledVersion(repoRoot, name),
      })
    }
  }
  return { families: families.sort(), dependencies }
}

export function findNativeBinaryFindings(dependencies: readonly PlatformDependency[]): NativeBinaryFinding[] {
  const findings: NativeBinaryFinding[] = []
  for (const dependency of dependencies) {
    if (dependency.locked === null) {
      findings.push({ ...dependency, reason: 'platform-entry-missing' })
      continue
    }
    if (dependency.locked !== dependency.declared) {
      findings.push({ ...dependency, reason: 'locked-version-disagrees' })
      continue
    }
    if (dependency.installed !== null && dependency.installed !== dependency.locked) {
      findings.push({ ...dependency, reason: 'installed-version-disagrees' })
    }
  }
  return findings
}

/** The package whose two self-reports AGENTS.md names, and the binary it ships. */
export const CLAUDE_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'

export function readClaudeSelfReports(
  repoRoot: string,
  runBinary: (path: string) => string | null = defaultRunBinary,
): SelfReportPair {
  const manifestPath = join(repoRoot, 'node_modules', ...CLAUDE_SDK_PACKAGE.split('/'), 'package.json')
  if (!existsSync(manifestPath)) {
    return { manifest: null, binary: null, skipped: `${CLAUDE_SDK_PACKAGE} is not installed` }
  }
  let manifest: string | null = null
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { claudeCodeVersion?: unknown }
    manifest = typeof parsed.claudeCodeVersion === 'string' ? parsed.claudeCodeVersion : null
  } catch {
    manifest = null
  }
  if (manifest === null) {
    return { manifest: null, binary: null, skipped: `${CLAUDE_SDK_PACKAGE} declares no claudeCodeVersion` }
  }
  const platform = `${CLAUDE_SDK_PACKAGE}-${process.platform}-${process.arch}`
  const binaryPath = join(repoRoot, 'node_modules', ...platform.split('/'), 'claude')
  if (!existsSync(binaryPath)) {
    return { manifest, binary: null, skipped: `${platform} ships no \`claude\` binary on this host` }
  }
  const reported = runBinary(binaryPath)
  if (reported === null) return { manifest, binary: null, skipped: `${binaryPath} did not answer --version` }
  return { manifest, binary: reported, skipped: null }
}

function defaultRunBinary(path: string): string | null {
  const result = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 60_000 })
  if (result.status !== 0 || typeof result.stdout !== 'string') return null
  // `2.1.251 (Claude Code)` — the number is the first token.
  const first = result.stdout.trim().split(/\s+/)[0]
  return first && /^\d+\.\d+\.\d+/.test(first) ? first : null
}

export function checkNativeBinaryInstall(repoRoot: string, lockText?: string): NativeBinaryReport {
  const text = lockText ?? readFileSync(join(repoRoot, 'bun.lock'), 'utf8')
  const lock = parseJsonc(text)
  const { families, dependencies } = collectPlatformDependencies(lock, repoRoot)
  return {
    families,
    dependencies,
    findings: findNativeBinaryFindings(dependencies),
    selfReport: readClaudeSelfReports(repoRoot),
  }
}

if (import.meta.main) {
  const repoRoot = resolve(process.argv[2] ?? join(import.meta.dir, '..'))
  const report = checkNativeBinaryInstall(repoRoot)
  const installed = report.dependencies.filter(dependency => dependency.installed !== null).length
  const pair = report.selfReport
  const parted = pair.skipped === null && pair.manifest !== pair.binary

  if (report.findings.length === 0 && !parted) {
    console.log(
      `native binary install: ${report.dependencies.length} platform packages across `
      + `${report.families.length} families, all present in bun.lock at the version their parent declares; `
      + `${installed} installed here and all matching.`,
    )
    if (pair.skipped !== null) console.log(`  self-report pair SKIPPED: ${pair.skipped}`)
    else console.log(`  self-report pair agrees: claudeCodeVersion ${pair.manifest} = claude --version ${pair.binary}`)
    process.exit(0)
  }

  if (report.findings.length > 0) {
    console.error(`native binary install: ${report.findings.length} of ${report.dependencies.length} platform packages are wrong.\n`)
    for (const finding of report.findings) {
      console.error(
        `  ${finding.name}  (${finding.reason})\n`
        + `      ${finding.parent} declares: ${finding.declared}\n`
        + `      bun.lock resolves:  ${finding.locked ?? 'NO ENTRY AT ALL'}\n`
        + `      installed here:     ${finding.installed ?? 'not installed on this platform'}`,
      )
    }
  }
  if (parted) {
    console.error(
      `\nThe two self-reports of ${CLAUDE_SDK_PACKAGE} DISAGREE:\n`
      + `      claudeCodeVersion: ${pair.manifest}\n`
      + `      claude --version:  ${pair.binary}\n`
      + '  The manifest is a packaging artefact; the binary is what answers a query.',
    )
  }
  console.error(
    '\nMeasured cause (AGENTS.md §Traps, 2026-09-13): a pin bump of a package shipping a native\n'
    + 'binary can leave `bun install` reporting success while the lockfile loses every platform\n'
    + 'entry and the old binary stays on disk. `bun install` again, `bun install --force` and\n'
    + 'removing the stale directory all failed to repair it; what did was reverting the pins,\n'
    + 'installing, re-bumping and installing again. Do that, then re-run this check.',
  )
  process.exit(1)
}
