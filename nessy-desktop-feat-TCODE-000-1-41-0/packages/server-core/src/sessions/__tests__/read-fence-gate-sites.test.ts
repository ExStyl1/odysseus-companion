/**
 * P6.809 - every permission gate hands the read fence its two arguments.
 *
 * `getReadsOutsideWorkingDirectoriesViolation` (`shared/agent/mode-manager.ts`)
 * declines to answer TWICE: once when `blockReadsOutsideWorkingDirectories` is
 * not `true`, and again when no `workingDirectory` was supplied, because it will
 * not invent a base to measure containment against. So a gate call that omitted
 * them was not enforcing a fence that failed open - it was silently OPTING OUT
 * of one, while `permissions.blockReadsOutsideWorkingDirectories` reads as on
 * everywhere it is shown. P6.202 left that at seven call sites and reached one.
 *
 * ## Why a source scan is the right instrument here and not a shortcut
 *
 * The defect is an ARGUMENT MISSING AT A CALL SITE, which is a property of the
 * text, and its whole danger is that it is invisible behaviourally: five of the
 * seven sites ask about a FIXED tool name (`'Bash'`, `'subagent'`) that the
 * fence's vocabulary - `Read`/`Grep`/`Glob`/`Find`/`Ls` - does not contain, so
 * no behavioural test of those five can distinguish "wired" from "not wired"
 * today. They are wired anyway, as forward compatibility: the day one is changed
 * to pass a variable tool name, it inherits the fence instead of silently
 * opting out of it again - which is exactly how the one site that DOES pass a
 * variable name came to matter.
 *
 * Same shape as `shared/agent/__tests__/claude-memory-scope-call-sites.test.ts`,
 * including its parenthesis-balance reader: a fixed character window is what let
 * that file's own guard report a missing argument sitting three lines past the
 * window's edge.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SESSIONS_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SERVER_CORE_SRC = dirname(SESSIONS_DIR)
const SESSION_MANAGER = readFileSync(join(SESSIONS_DIR, 'SessionManager.ts'), 'utf8')
const PERMISSION_MANAGER = readFileSync(
  join(SERVER_CORE_SRC, '..', '..', 'shared', 'src', 'agent', 'core', 'permission-manager.ts'),
  'utf8',
)

/**
 * Each call's OWN argument list, bounded by balanced parentheses rather than by
 * a character count - the count is what rots as an option object grows comments.
 */
function callArguments(source: string, callee: string): { line: number; text: string }[] {
  const needle = `${callee}(`
  const found: { line: number; text: string }[] = []
  let at = source.indexOf(needle)
  while (at !== -1) {
    let depth = 0
    let end = at + needle.length - 1
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1
      else if (source[end] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    found.push({ line: source.slice(0, at).split('\n').length, text: source.slice(at, end + 1) })
    at = source.indexOf(needle, at + needle.length)
  }
  return found
}

describe('P6.809 · the read fence reaches every gate', () => {
  it('finds the call sites at all, so neither scan can pass vacuously', () => {
    // Six in SessionManager and one in PermissionManager at the time of writing.
    // A seventh in SessionManager is a reason to read this file, not to raise
    // the number: the new site needs the options too.
    expect(callArguments(SESSION_MANAGER, 'shouldAllowToolInMode').length).toBe(6)
    expect(callArguments(PERMISSION_MANAGER, 'shouldAllowToolInMode').length).toBe(1)
  })

  it('SessionManager passes the fence options at every gate', () => {
    const missing = callArguments(SESSION_MANAGER, 'shouldAllowToolInMode')
      .filter(call => !call.text.includes('this.readFenceOptions(managed)'))
      .map(call => `SessionManager.ts:${call.line}`)
    expect(missing).toEqual([])
  })

  it('PermissionManager passes BOTH of them, and the flag is read rather than assumed', () => {
    const [call] = callArguments(PERMISSION_MANAGER, 'shouldAllowToolInMode')
    expect(call).toBeDefined()
    const args = call!.text
    // `workingDirectory` was already on the config; only the reading of it was
    // missing, which is why this row is an S.
    expect(args).toContain('workingDirectory: this.config.workingDirectory')
    // And the flag comes from the setting, not from a literal: a hard-coded
    // `true` would make the fence unconditional and a hard-coded `false` would
    // reproduce the opt-out this row closes.
    expect(args).toContain('blockReadsOutsideWorkingDirectories: getBlockReadsOutsideWorkingDirectories()')
  })

  it('CONTROL — the scan can report a miss', () => {
    // Both assertions above are "this list is empty", which a broken reader
    // satisfies for free. Driving the same function over a token no call site
    // contains must report every site.
    const missing = callArguments(SESSION_MANAGER, 'shouldAllowToolInMode')
      .filter(call => !call.text.includes('a token no gate call contains'))
    expect(missing.length).toBe(6)
  })
})

describe('P6.809 · the fence options are built once, from the session', () => {
  it('the helper falls back to the workspace root and reads the setting', () => {
    // The helper is the reason six call sites carry one spread rather than six
    // pairs of arguments that could drift apart.
    const helper = SESSION_MANAGER.slice(SESSION_MANAGER.indexOf('private readFenceOptions('))
      .slice(0, 600)
    expect(helper).toContain('managed.workingDirectory ?? managed.workspace.rootPath')
    expect(helper).toContain('getBlockReadsOutsideWorkingDirectories()')
    // NEGATIVE: a session with neither passes NO `workingDirectory`, which is
    // the fence's own "the caller cannot say" case — never an empty string,
    // which `getReadsOutsideWorkingDirectoriesViolation` would trim to nothing
    // and treat the same way, but only by accident.
    expect(helper).toContain('...(workingDirectory ? { workingDirectory } : {})')
  })
})
