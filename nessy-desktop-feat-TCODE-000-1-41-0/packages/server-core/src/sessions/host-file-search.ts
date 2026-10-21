/**
 * P6.689 — one host-side file search, so the `@` picker is not a codex feature.
 *
 * `SessionManager.fuzzyFileSearch` returned files only when the live agent
 * implemented `fuzzyFileSearch`, and `codex-agent.ts` was the only implementer
 * (`git grep fuzzyFileSearch` over `base-agent.ts`, `pi-agent.ts`,
 * `claude-agent.ts` and `agent/backend/**` → nothing). So on a Pi or claude
 * session the `@` menu was MCP resources alone, and switching runtimes lost file
 * mentions with nothing saying so — the silent divergence this fork keeps
 * finding, on a surface the user touches every day.
 *
 * NATIVE-FIRST, asked and answered. codex has one: its app-server's own
 * `fuzzyFileSearch`. Claude's picker is inside the CLI and is not reachable from
 * the host; Pi has none. That is case (2) — the host can supply it uniformly,
 * because the host already has the workspace on disk — so it is built once here
 * and codex keeps its native one, which is the smaller change of the two the row
 * offered.
 *
 * ## The candidate list, and why `git ls-files` is the first answer
 *
 * The row asks for `.gitignore` to be respected "as all three existing searches
 * do". Rather than parse ignore files — a well-known source of subtle
 * disagreement with the tool everyone else uses — the repository is asked:
 * `git ls-files --cached --others --exclude-standard` IS the ignore rules,
 * applied by the implementation that owns them, and it covers tracked files and
 * new untracked ones alike.
 *
 * A directory that is not a repository falls back to a bounded walk with a fixed
 * skip list. Stated plainly because it is a real difference: that arm does NOT
 * read ignore files, so a non-repository project with a `.gitignore` may show a
 * build artefact. The alternative was a hand-written ignore matcher, which is
 * exactly the invented mechanism the read-don't-invent rule exists to stop, for
 * a case (a project directory outside version control) where the skip list
 * already removes everything heavy.
 *
 * ## Bounds, because this runs on a keystroke
 *
 * The candidate list is capped, the result list is capped, and the listing is
 * memoised per root for a couple of seconds so a burst of keystrokes costs ONE
 * `git ls-files`. The memo is deliberately short-lived rather than invalidated:
 * a file created seconds ago appearing in the picker a moment late is a smaller
 * cost than a watcher on every workspace, and Electron does not inherit the
 * shell's `ulimit -n` — an fd-hungry design here fails in the packaged app while
 * every shell probe succeeds.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, type Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { FuzzyFileSearchResult } from '@nessy-agent/shared/protocol'

/** How many paths are considered. A repository larger than this ranks its first slice. */
const MAX_CANDIDATES = 20_000

/** How many rows the picker is handed. The menu itself shows far fewer. */
const MAX_RESULTS = 50

/** How long one root's listing is reused. Short enough that a new file appears quickly. */
const LISTING_TTL_MS = 2_000

/**
 * Directories the non-repository walk never descends into.
 *
 * Not an ignore-file substitute and not presented as one: it is the set that
 * would otherwise dominate both the time and the results in any project big
 * enough for the picker to matter.
 */
const SKIPPED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.turbo', '.cache', '.venv', 'venv', '__pycache__',
  '.DS_Store', 'coverage', '.gradle', '.idea',
])

interface CachedListing { paths: string[]; readAt: number }

const listings = new Map<string, CachedListing>()

function listRepositoryPaths(root: string): string[] | undefined {
  const result = spawnSync(
    'git',
    ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 5_000 },
  )
  // A non-repository, a missing git, or a timeout all land here, and all mean
  // the same thing to the caller: ask the filesystem instead.
  if (result.error || result.status !== 0 || !result.stdout) return undefined
  return result.stdout.toString('utf8').split('\0').filter(Boolean).slice(0, MAX_CANDIDATES)
}

function walkPaths(root: string): string[] {
  const paths: string[] = []
  const queue: string[] = [root]
  while (queue.length > 0 && paths.length < MAX_CANDIDATES) {
    const dir = queue.shift()!
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (paths.length >= MAX_CANDIDATES) break
      if (entry.name.startsWith('.') && entry.name !== '.env') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        queue.push(full)
        continue
      }
      if (!entry.isFile()) continue
      paths.push(relative(root, full))
    }
  }
  return paths
}

function candidatePaths(root: string, now: number): string[] {
  const cached = listings.get(root)
  if (cached && now - cached.readAt < LISTING_TTL_MS) return cached.paths
  const paths = listRepositoryPaths(root) ?? walkPaths(root)
  listings.set(root, { paths, readAt: now })
  return paths
}

/**
 * Subsequence match, scored so the obvious answer wins.
 *
 * The query's characters must appear in order; a match inside the FILE NAME
 * outranks one that only appears in a directory component, contiguity outranks
 * scatter, and a shorter path breaks the remaining ties. Returns the matched
 * character positions so a surface can highlight them — the same `indices`
 * field codex's own results carry.
 */
function scorePath(path: string, query: string): { score: number; indices: number[] } | undefined {
  const haystack = path.toLowerCase()
  const needle = query.toLowerCase()
  const indices: number[] = []
  let at = 0
  for (const character of needle) {
    const found = haystack.indexOf(character, at)
    if (found === -1) return undefined
    indices.push(found)
    at = found + 1
  }
  const nameStart = path.lastIndexOf(sep) + 1
  let score = 1000 - path.length
  if (indices[0]! >= nameStart) score += 500
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i] === indices[i - 1]! + 1) score += 10
  }
  return { score, indices }
}

/**
 * Rank one root's files against a query.
 *
 * An empty query returns nothing rather than the whole repository: the picker
 * asks on every keystroke, and "everything" is not an answer a person scrolls.
 */
export function hostFuzzyFileSearch(
  root: string,
  query: string,
  now: number = Date.now(),
): FuzzyFileSearchResult[] {
  const trimmed = query.trim()
  if (!root || trimmed === '') return []

  const scored: FuzzyFileSearchResult[] = []
  for (const path of candidatePaths(root, now)) {
    const hit = scorePath(path, trimmed)
    if (!hit) continue
    scored.push({
      root,
      path,
      match_type: 'file',
      file_name: path.slice(path.lastIndexOf(sep) + 1),
      score: hit.score,
      indices: hit.indices,
    })
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return scored.slice(0, MAX_RESULTS)
}

/** Drop the memoised listings — for tests, and for a root that has gone away. */
export function clearHostFileSearchCache(): void {
  listings.clear()
}
