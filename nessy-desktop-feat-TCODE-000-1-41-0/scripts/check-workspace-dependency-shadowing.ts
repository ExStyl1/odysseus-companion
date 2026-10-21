/**
 * D1.106 — resolve every workspace's own declared dependencies FROM THAT
 * WORKSPACE, and fail when what resolves is not what the workspace asked for.
 *
 * ## The measurement this gate exists for (W11-pi, 2026-09-11; AGENTS.md §Traps)
 *
 * After a workspace lift, `bun install` can leave stale workspace-nested copies
 * of a lifted package that SHADOW the hoisted root install: three
 * `@earendil-works` copies at **0.84.2** shadowed **0.84.3**, the first Pi
 * bundle built against the old version, `bun.lock` said the new one and
 * described none of the copies. Nothing in the tree could see it, because every
 * instrument read the lockfile or the repo root — and resolution does not start
 * at the repo root. It starts at the importer:
 *
 *     cd packages/pi-agent-server
 *     bun -e 'console.log(require("@earendil-works/pi-coding-agent/package.json").version)'
 *
 * ## Why the rule is "satisfies the workspace's own range" and not "equals the root"
 *
 * A version comparison against the root install is the obvious gate and it
 * CRIES WOLF: measured on this tree, **nine** workspace-nested copies sit at a
 * version the root does not carry — `@types/node` 22 under five server-side
 * packages against 25 at the root, and four of `apps/viewer`'s React-era pins —
 * and every one of them is deliberate, declared by that workspace's own
 * `package.json`. A gate that reports nine correct nests is a gate people stop
 * running (AGENTS.md says so in as many words).
 *
 * The stale shadow is different in a way that is machine-checkable: it VIOLATES
 * the range the workspace itself declares. `packages/pi-agent-server` pins
 * `@earendil-works/pi-coding-agent` at an exact version, so a 0.84.2 copy under
 * its own `node_modules` fails that range while the deliberate `@types/node`
 * nest satisfies `^22.0.0` exactly as intended. One rule, no allowlist to age,
 * and it catches the wider family too: a HOISTED copy that violates a
 * workspace's declared range is the same defect arriving by another route.
 *
 * Resolution is modelled the way Node and Bun perform it for a package ROOT —
 * walk up from the importer, first `node_modules/<name>/package.json` wins —
 * rather than through `Bun.resolveSync`, whose subpath form is refused by any
 * package whose exports map does not publish `./package.json`.
 *
 * Not failures, reported as notes: a dependency with no resolvable copy at all
 * (an install that has not run), a non-semver range (`workspace:`, `file:`,
 * `link:`, `npm:`, a git URL) and a duplicate nested copy at the SAME version
 * the root carries — wasteful, not wrong.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export interface ResolvedDependency {
  workspace: string
  name: string
  declared: string
  version: string | null
  path: string | null
  /** True when the copy that answered is NOT the repo-root install. */
  nested: boolean
}

export interface ShadowFinding extends ResolvedDependency {
  version: string
  path: string
  reason: 'violates-declared-range' | 'undeclared-copy-shadows-root'
}

export interface ShadowNote extends ResolvedDependency {
  reason:
    | 'unresolved'
    | 'non-semver-range'
    | 'duplicate-same-version'
    | 'undeclared-duplicate'
    | 'workspace-only-copy'
}

export interface ShadowReport {
  workspaces: string[]
  checked: number
  findings: ShadowFinding[]
  notes: ShadowNote[]
}

function readJson(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
  } catch {
    return null
  }
}

/** The workspace directories, from the root manifest's own globs. */
export function workspaceDirectories(repoRoot: string): string[] {
  const manifest = readJson(join(repoRoot, 'package.json'))
  const globs: string[] = Array.isArray(manifest?.workspaces) ? manifest!.workspaces : []
  const dirs: string[] = []
  for (const pattern of globs) {
    // The globs this repo uses are one level deep (`packages/*`, `apps/*`).
    // Anything more exotic is reported rather than guessed at.
    const [parent, leaf] = pattern.split('/')
    if (!parent || leaf !== '*') continue
    const parentPath = join(repoRoot, parent)
    if (!existsSync(parentPath)) continue
    for (const entry of readdirSync(parentPath)) {
      const candidate = join(parentPath, entry)
      if (!existsSync(join(candidate, 'package.json'))) continue
      dirs.push(candidate)
    }
  }
  return dirs.sort()
}

/**
 * Node's own package-root resolution: the first `node_modules/<name>` walking
 * up from `fromDir`. This is what the importer gets, which is the whole point.
 */
export function resolvePackageFrom(fromDir: string, name: string): { path: string; version: string | null } | null {
  let dir = resolve(fromDir)
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, 'node_modules', name)
    const manifestPath = join(candidate, 'package.json')
    if (existsSync(manifestPath) && statSync(candidate).isDirectory()) {
      return { path: candidate, version: (readJson(manifestPath)?.version as string) ?? null }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Every package directory physically present under `<workspace>/node_modules`,
 * scoped names included. Symlinks (bun's workspace links) are skipped: they are
 * the workspace itself, not a copy of a published package.
 */
export function nestedPackages(workspaceDir: string): { name: string; path: string }[] {
  const root = join(workspaceDir, 'node_modules')
  if (!existsSync(root)) return []
  const found: { name: string; path: string }[] = []
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue
      const path = join(dir, entry)
      // `lstat`, never `stat`: a workspace link is a symlink whose TARGET has a
      // package.json, so `stat` reports the link as the package it points at and
      // every internal `@nessy-agent/*` link would be read as a nested copy.
      if (lstatSync(path).isSymbolicLink()) continue
      if (!existsSync(join(path, 'package.json'))) {
        // A scope directory (`@types`) carries the packages one level down.
        if (entry.startsWith('@') && !prefix && statSync(path).isDirectory()) visit(path, `${entry}/`)
        continue
      }
      found.push({ name: `${prefix}${entry}`, path })
    }
  }
  visit(root, '')
  return found
}

/** A range this gate can judge. `workspace:`/`file:`/`link:`/`npm:`/git are not. */
function isSemverRange(range: string): boolean {
  if (!range) return false
  if (/^(workspace|file|link|npm|git|github|http|https|portal|catalog):/.test(range)) return false
  if (range === '*' || range === 'latest') return false
  return true
}

export function checkWorkspaceDependencyShadowing(repoRoot: string): ShadowReport {
  const workspaces = workspaceDirectories(repoRoot)
  const findings: ShadowFinding[] = []
  const notes: ShadowNote[] = []
  let checked = 0

  for (const workspaceDir of workspaces) {
    const manifest = readJson(join(workspaceDir, 'package.json'))
    if (!manifest) continue
    const declared: Record<string, string> = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    }
    const workspace = relative(repoRoot, workspaceDir) || '.'
    for (const [name, range] of Object.entries(declared)) {
      const resolved = resolvePackageFrom(workspaceDir, name)
      const rootCopy = resolvePackageFrom(repoRoot, name)
      const nested = resolved !== null && resolved.path !== rootCopy?.path
      const base: ResolvedDependency = {
        workspace,
        name,
        declared: range,
        version: resolved?.version ?? null,
        path: resolved ? relative(repoRoot, resolved.path) : null,
        nested,
      }
      if (!isSemverRange(range)) {
        notes.push({ ...base, reason: 'non-semver-range' })
        continue
      }
      if (!resolved || !resolved.version) {
        notes.push({ ...base, reason: 'unresolved' })
        continue
      }
      checked += 1
      if (!Bun.semver.satisfies(resolved.version, range)) {
        findings.push({
          ...base,
          version: resolved.version,
          path: base.path!,
          reason: 'violates-declared-range',
        })
        continue
      }
      if (nested && rootCopy?.version === resolved.version) {
        notes.push({ ...base, reason: 'duplicate-same-version' })
      }
    }

    // The second half, and the reason it exists: a nested copy of a package the
    // workspace does NOT declare has no range to be judged against, and is
    // invisible to everything above. This tree carries two today — the electron
    // build stages `@anthropic-ai/claude-agent-sdk` and its native binary under
    // `apps/electron/node_modules` — so the rule cannot be "no undeclared
    // nesting". With no declared range, the ROOT install is the only contract
    // there is: same version is a note, a different version is the shadow.
    for (const { name, path } of nestedPackages(workspaceDir)) {
      if (declared[name] !== undefined) continue
      const version = (readJson(join(path, 'package.json'))?.version as string) ?? null
      const rootCopy = resolvePackageFrom(repoRoot, name)
      const base: ResolvedDependency = {
        workspace,
        name,
        declared: '(not declared by this workspace)',
        version,
        path: relative(repoRoot, path),
        nested: true,
      }
      if (!version || !rootCopy?.version) {
        notes.push({ ...base, reason: 'workspace-only-copy' })
        continue
      }
      checked += 1
      if (version === rootCopy.version) {
        notes.push({ ...base, reason: 'undeclared-duplicate' })
        continue
      }
      findings.push({ ...base, version, path: base.path!, reason: 'undeclared-copy-shadows-root' })
    }
  }

  return { workspaces: workspaces.map(dir => relative(repoRoot, dir)), checked, findings, notes }
}

if (import.meta.main) {
  const repoRoot = resolve(process.argv[2] ?? join(import.meta.dir, '..'))
  const report = checkWorkspaceDependencyShadowing(repoRoot)
  const duplicates = report.notes.filter(note => note.reason === 'duplicate-same-version')
  const unresolved = report.notes.filter(note => note.reason === 'unresolved')

  if (report.findings.length === 0) {
    console.log(
      `workspace dependency resolution: ${report.checked} declared dependencies resolved from `
      + `${report.workspaces.length} workspaces, all satisfying their own declared range.`,
    )
    if (duplicates.length > 0) {
      console.log(
        `  ${duplicates.length} nested copies at the SAME version as the root install (wasteful, not wrong): `
        + duplicates.map(note => `${note.workspace} → ${note.name}@${note.version}`).join(', '),
      )
    }
    if (unresolved.length > 0) {
      console.log(
        `  ${unresolved.length} declared dependencies resolve to nothing — run \`bun install --frozen-lockfile\`: `
        + unresolved.slice(0, 5).map(note => `${note.workspace} → ${note.name}`).join(', '),
      )
    }
    process.exit(0)
  }

  console.error(
    `workspace dependency shadowing: ${report.findings.length} of ${report.checked} declared dependencies `
    + 'resolve to a version their own workspace does not accept.\n',
  )
  for (const finding of report.findings) {
    console.error(
      `  ${finding.workspace} → ${finding.name}\n`
      + `      declared: ${finding.declared}\n`
      + `      resolved: ${finding.version} at ${finding.path}${finding.nested ? '  (workspace-nested copy)' : '  (root install)'}`,
    )
  }
  console.error(
    '\nA workspace-nested copy left behind by a lift is the measured cause (AGENTS.md §Traps,\n'
    + '2026-09-13): `bun install` reported success, `bun.lock` described none of the copies, and\n'
    + 'the bundle built against the old version. Remove the nested copy and re-install; if the\n'
    + 'version is meant, change the range that workspace declares.',
  )
  process.exit(1)
}
