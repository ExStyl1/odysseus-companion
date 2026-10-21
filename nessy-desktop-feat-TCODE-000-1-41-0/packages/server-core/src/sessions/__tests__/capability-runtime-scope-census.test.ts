/**
 * F1.126 (origin WI-ca P-WI-ca-2) — which callers take an agent OUT of
 * `withCapabilityRuntime` and use it after the scope?
 *
 * ## The shape that bit D1.435
 *
 * `withCapabilityRuntime`'s `finally` clears the turn runtime the callback ran
 * under. A callback whose whole body is the START —
 * `runtime => this.getOrCreateAgent(managed, runtime)` — hands the caller an agent
 * whose turn is already over, and `getSideChannelAgent` returned exactly that to
 * `askSideQuestion`, so Pi's `spawnSubprocess` threw "Pi capability runtime
 * manifest is required before subprocess spawn" on every cold `/btw` (SIT-9).
 *
 * ## The instrument, and why it keys on ESCAPE rather than on the start alone
 *
 * A start-only callback is harmless when its value is DISCARDED: the agent-view
 * recovery in `controlPiAgentView` starts the agent that way and then lets
 * `resumeQueue` reach it through the ordinary send, which takes its own turn. It
 * is only dangerous when the value ESCAPES the scope — returned, or assigned — so
 * that is the violation: a start-only callback AND an escaping result.
 *
 * So the row's premise is corrected by its own census: at D1.435's launch HEAD
 * TWO sites had the start-only callback (`controlPiAgentView` and
 * `getSideChannelAgent`) and exactly ONE of them let the agent escape. The
 * fixture below is that one site's text at `d05d95b13^`, embedded rather than
 * read from history, because a history read goes red on CI the day the commit is
 * no longer reachable from what the runner fetched (AGENTS.md, squash-merge trap).
 *
 * ## What a green means
 *
 * Every `this.withCapabilityRuntime(` call site in tracked source is found by
 * `git grep` (tracked blobs, `-a`, no `**` pathspec), classified, and matched
 * against the reviewed census below by its enclosing method. A NEW site fails
 * until it is classified here — which is the review the row asked for.
 */
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')
const CALL = 'this.withCapabilityRuntime('

type Shape = 'start-only, result discarded' | 'start-only, result ESCAPES' | 'scoped body'

interface Site {
  readonly file: string
  readonly method: string
  readonly shape: Shape
}

/** The text of the callback argument: from the first `,` after the call to its matching `)`. */
function callbackText(source: string, callIndex: number): string {
  const open = callIndex + CALL.length - 1
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) {
        const args = source.slice(open + 1, i)
        const comma = args.indexOf(',')
        return comma === -1 ? '' : args.slice(comma + 1).trim()
      }
    }
  }
  return ''
}

const START_ONLY_EXPRESSION = /^(?:async\s+)?\(?\s*\w+\s*\)?\s*=>\s*(?:await\s+)?this\.getOrCreateAgent\([^)]*\)\s*$/
const START_ONLY_BLOCK = /^(?:async\s+)?\(?\s*\w+\s*\)?\s*=>\s*\{\s*return\s+(?:await\s+)?this\.getOrCreateAgent\([^)]*\);?\s*\}\s*$/

function classifyCapabilityRuntimeCall(source: string, callIndex: number): Shape {
  const callback = callbackText(source, callIndex)
  const startOnly = START_ONLY_EXPRESSION.test(callback) || START_ONLY_BLOCK.test(callback)
  if (!startOnly) return 'scoped body'
  const lineStart = source.lastIndexOf('\n', callIndex) + 1
  const lead = source.slice(lineStart, callIndex)
  const escapes = /\breturn\b/.test(lead) || /(?:^|[^=!<>])=(?!=)/.test(lead)
  return escapes ? 'start-only, result ESCAPES' : 'start-only, result discarded'
}

function enclosingMethod(source: string, callIndex: number): string {
  const before = source.slice(0, callIndex).split('\n')
  for (let i = before.length - 1; i >= 0; i--) {
    const match = /^ {2}(?:private |public |protected )?(?:static )?(?:async )?([A-Za-z_]\w*)\s*[<(]/.exec(before[i]!)
    if (match) return match[1]!
  }
  return '<module>'
}

function censusOf(file: string, source: string): Site[] {
  const sites: Site[] = []
  for (let at = source.indexOf(CALL); at !== -1; at = source.indexOf(CALL, at + CALL.length)) {
    sites.push({ file, method: enclosingMethod(source, at), shape: classifyCapabilityRuntimeCall(source, at) })
  }
  return sites
}

function trackedSourcesCalling(): string[] {
  const out = spawnSync('git', ['grep', '-alF', CALL, '--', 'packages', 'apps'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  expect(out.status === 0 || out.status === 1).toBe(true)
  return out.stdout.split('\n').filter(path => path && !/(__tests__\/|\.test\.)/.test(path))
}

/**
 * The reviewed census at HEAD (2026-09-23). A site is named by file and
 * enclosing method, never by line — the file moves by hundreds of lines a day.
 */
const REVIEWED: readonly Site[] = [
  { file: 'packages/server-core/src/sessions/SessionManager.ts', method: 'controlPiAgentView', shape: 'start-only, result discarded' },
  { file: 'packages/server-core/src/sessions/SessionManager.ts', method: 'withPinnedConfigChange', shape: 'scoped body' },
  { file: 'packages/server-core/src/sessions/SessionManager.ts', method: 'reloadSessionSources', shape: 'scoped body' },
  { file: 'packages/server-core/src/sessions/SessionManager.ts', method: 'refreshContextUsage', shape: 'scoped body' },
  { file: 'packages/server-core/src/sessions/SessionManager.ts', method: 'createSession', shape: 'scoped body' },
  { file: 'packages/server-core/src/sessions/SessionManager.ts', method: 'withSideChannelAgent', shape: 'scoped body' },
]

/** `getSideChannelAgent` at `d05d95b13^` — D1.435's defect, verbatim. */
const D1435_LAUNCH_HEAD_SITE = `
  private async getSideChannelAgent(managed: ManagedSession): Promise<AgentInstance | null> {
    if (managed.agent) return managed.agent
    try {
      return await this.withCapabilityRuntime(managed, runtime => this.getOrCreateAgent(managed, runtime))
    } catch (error) {
      sessionLog.warn(\`Session \${managed.id}: side-channel agent start failed: \${String(error)}\`)
      return null
    }
  }
`

/** The agent-view recovery's shape at the same HEAD — start-only, discarded. */
const DISCARDED_START_SITE = `
  async controlPiAgentView(
    request: X,
  ): Promise<Y> {
    try {
      await this.ensureMessagesLoaded(managed)
      await this.withCapabilityRuntime(managed, runtime => this.getOrCreateAgent(managed, runtime))
      if (managed.queuePaused) await this.resumeQueue(managed.id, managed.workspace.id)
    } finally {}
  }
`

describe('F1.126 — no caller takes an agent out of withCapabilityRuntime', () => {
  it('POSITIVE CONTROL: the instrument flags D1.435’s launch-HEAD site', () => {
    expect(censusOf('fixture', D1435_LAUNCH_HEAD_SITE)).toEqual([
      { file: 'fixture', method: 'getSideChannelAgent', shape: 'start-only, result ESCAPES' },
    ])
  })

  it('NEGATIVE CONTROL: a start-only callback whose value is discarded is not a violation', () => {
    expect(censusOf('fixture', DISCARDED_START_SITE)).toEqual([
      { file: 'fixture', method: 'controlPiAgentView', shape: 'start-only, result discarded' },
    ])
  })

  it('at HEAD: every call site is classified, none lets the agent escape, and the census is the reviewed one', () => {
    const files = trackedSourcesCalling()
    // Non-vacuity: the scan found the file that defines the method.
    expect(files).toContain('packages/server-core/src/sessions/SessionManager.ts')
    const census = files.flatMap(file => censusOf(file, readFileSync(join(REPO_ROOT, file), 'utf8')))
    expect(census.filter(site => site.shape === 'start-only, result ESCAPES')).toEqual([])
    const key = (site: Site): string => `${site.file}#${site.method}#${site.shape}`
    expect(census.map(key).sort()).toEqual(REVIEWED.map(key).sort())
  })
})
