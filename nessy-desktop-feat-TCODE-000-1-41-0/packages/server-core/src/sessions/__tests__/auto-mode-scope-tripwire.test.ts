import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolveAutoMode } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { loadManagedPiPolicyWithDiagnostics } from '../../pi-harness/managed-policy-loader.ts'

/**
 * P6.206 — `autoMode` reaches the judge from the ADMIN scopes only, and that is
 * a DECISION rather than an accident.
 *
 * Both the judge-prose resolver and the band control say so at their sites
 * (`SessionManager.ts` — "Resolved from the MANAGED scope only … so a checked-in
 * repo or a build step cannot inject its own allow rules into the judge"), and
 * `resolveAutoMode` takes a `project` parameter it discards so the exclusion is
 * legible. None of that was pinned: nothing failed if a fourth call site were
 * added tomorrow passing a project-scoped block, and nothing failed if the
 * managed loader started reading a settings file inside the repository.
 *
 * Driven against the REAL resolvers — the real managed loader over a virtual
 * filesystem, and the real source of the real call sites — rather than a
 * fixture, because a fixture can only restate the rule it was written from.
 *
 * ## The ruled scope set, not "managed only"
 *
 * {@link RULED_SCOPES} is the assertion's subject and its single edit point.
 * The owner question *"may a developer widen the judge's trust boundary"* is
 * open (`docs/superpowers/specs/2026-09-05-denominator-owner-questions.md`); if
 * it is answered by admitting another scope, this constant grows by that scope's
 * name and the tripwire keeps its meaning. What it refuses is a scope arriving
 * without anyone choosing it.
 */
const RULED_SCOPES = Object.freeze(['managed'] as const)

/** The two exported entry points every `autoMode` consumer goes through. */
const RESOLVERS = Object.freeze(['resolveAutoMode', 'resolveAutoModeClassifyAllShell'] as const)

const ORG_RULE = 'the organization allows deploying to staging'

const managedDocument = JSON.stringify({
  schemaVersion: 1,
  autoMode: { allow: [ORG_RULE] },
})

const MANAGED_PATH = '/etc/nessy/managed-policy.json'
const MANAGED_DIR = '/etc/nessy'
const DROP_IN = '/etc/nessy/managed-policy.d'

/**
 * A repository checkout that carries the SAME document the administrator wrote.
 *
 * This is the subject: a project settings file is a file a repository can
 * commit, so the question is whether any part of the resolution chain would
 * read one. The virtual filesystem below happily serves it — the loader simply
 * never asks for it.
 */
const PROJECT_PATH = '/home/dev/repo/.claude/settings.json'

/**
 * A virtual host filesystem holding BOTH files, so the subject and the control
 * differ only in which path the loader chooses to read.
 */
function deps(present: readonly string[]): Record<string, unknown> {
  const descriptors = new Map<number, string>()
  let next = 10
  const node = (kind: 'file' | 'directory', size: number) => ({
    size,
    uid: 0,
    mode: kind === 'file' ? 0o100644 : 0o40755,
    dev: 1,
    ino: kind === 'file' ? 2 : 1,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => false,
  })
  return {
    platform: 'linux',
    lstatSync: (candidate: string) => {
      if (candidate === MANAGED_DIR || candidate === DROP_IN) return node('directory', 0)
      if (!present.includes(candidate)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return node('file', managedDocument.length)
    },
    realpathSync: (candidate: string) => candidate,
    readdirSync: () => [],
    openSync: (candidate: string) => {
      const descriptor = next++
      descriptors.set(descriptor, candidate)
      return descriptor
    },
    fstatSync: (descriptor: number) => node('file', managedDocument.length),
    readFileSync: (descriptor: number) => {
      const path = descriptors.get(descriptor)
      // Serving the project file too, on purpose: the assertion is that the
      // loader never opens it, not that it could not be parsed.
      return path === MANAGED_PATH || path === PROJECT_PATH ? managedDocument : ''
    },
    closeSync: () => undefined,
  }
}

describe('the autoMode trust boundary is the ruled scope set (P6.206)', () => {
  test('positive control — the same document in the ADMIN path reaches the judge', () => {
    const loaded = loadManagedPiPolicyWithDiagnostics(deps([MANAGED_PATH, PROJECT_PATH]))
    expect(loaded.policy.autoMode?.allow).toEqual([ORG_RULE])
    expect(resolveAutoMode({ managed: loaded.policy.autoMode }).allow).toContain(ORG_RULE)
  })

  test('subject — the same document inside the repository is never read', () => {
    const loaded = loadManagedPiPolicyWithDiagnostics(deps([PROJECT_PATH]))
    expect(loaded.policy.autoMode).toBeUndefined()
    expect(resolveAutoMode({ managed: loaded.policy.autoMode }).allow).not.toContain(ORG_RULE)
  })

  test('every call site passes a scope from the ruled set and nothing else', () => {
    const sites = callSites()
    // The reader is alive at all: an empty sweep would pass every assertion
    // below while proving nothing.
    expect(sites.length).toBeGreaterThan(0)
    for (const site of sites) {
      expect({ site: site.where, scopes: site.scopes })
        .toEqual({ site: site.where, scopes: site.scopes.filter(s => (RULED_SCOPES as readonly string[]).includes(s)) })
    }
  })
})

/**
 * The real call sites, read from the real source.
 *
 * `git grep` is the enumerator so a new file cannot escape by not being listed
 * here; the definitions and the tests are excluded because a resolver declaring
 * its own parameters is not a caller.
 */
function callSites(): readonly { where: string; scopes: readonly string[] }[] {
  const pattern = RESOLVERS.map(name => `${name}(`).join('\\|')
  const proc = Bun.spawnSync([
    'git', 'grep', '-an', pattern,
    '--', ':(glob)packages/**/*.ts', ':(glob)apps/**/*.ts',
  ], { cwd: repoRoot() })
  const lines = new TextDecoder().decode(proc.stdout).split('\n').filter(Boolean)
  const out: { where: string; scopes: readonly string[] }[] = []
  for (const line of lines) {
    const [file, lineNo] = line.split(':')
    if (!file || !lineNo) continue
    if (file.includes('.test.ts') || file.includes('__tests__')) continue
    // The two definitions themselves.
    if (file.endsWith('pi-harness/managed-policy.ts')) continue
    const source = readFileSync(`${repoRoot()}/${file}`, 'utf8')
    const text = source.split('\n')[Number(lineNo) - 1] ?? ''
    // A comment quoting a call is prose, not a call.
    if (/^\s*(\*|\/\/)/.test(text)) continue
    for (const name of RESOLVERS) {
      const at = text.indexOf(`${name}({`)
      if (at < 0) continue
      const literal = text.slice(at + name.length + 1)
      out.push({ where: `${file}:${lineNo}`, scopes: objectKeys(literal) })
    }
  }
  return out
}

/** Top-level keys of the `{ … }` literal starting at position 0 of `text`. */
function objectKeys(text: string): readonly string[] {
  const keys: string[] = []
  let depth = 0
  let atTopLevelStart = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1
      if (depth === 1) atTopLevelStart = true
      continue
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1
      if (depth === 0) break
      continue
    }
    if (depth !== 1) continue
    if (ch === ',') { atTopLevelStart = true; continue }
    if (!atTopLevelStart || ch === undefined || /\s/.test(ch)) continue
    const rest = text.slice(i)
    const match = /^([A-Za-z_$][\w$]*)\s*:/.exec(rest)
    if (match?.[1]) keys.push(match[1])
    atTopLevelStart = false
  }
  return keys
}

function repoRoot(): string {
  const proc = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd: import.meta.dir })
  return new TextDecoder().decode(proc.stdout).trim()
}
