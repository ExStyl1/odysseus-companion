/**
 * D1.215 / D1.139 — the notices a pull surface can carry, and the ONE claim
 * that makes them trustworthy: they are the child's own disposition, not a
 * second guess at it.
 *
 * ## Why the auto-memory arm is driven through `buildClaudeSessionMemoryEnv`
 *
 * `applyAutoMemoryOffSwitch` (`agent/options.ts`) writes the child's switch as
 * `buildClaudeSessionMemoryEnv(scope)`. If this module reproduced that rule
 * instead of calling it, the notice and the child could disagree the first time
 * the rule moved — the drift class AGENTS.md calls inventing where the tree
 * already answers. The cases below therefore assert the OUTCOME against the same
 * function rather than against a literal `'1'`, and the negative control is a
 * scope with BOTH axes on, which is the only input that writes nothing.
 *
 * ## The ambient arm is the one a reading would have got wrong
 *
 * `forced-on` is not a state this app can produce — `claude-auto-memory.ts` says
 * it never writes `=0` — so a test that only drove the two states the host
 * writes would report full coverage of a three-state enum while the third, the
 * one an ADMINISTRATOR produces, was unreachable through this path. It is
 * reachable, because the child inherits the environment, and the case below
 * drives it with an injected env rather than by touching `process.env` (which
 * Bun leaves invisible to the spread anyway — AGENTS.md §Traps).
 */

import { describe, expect, it } from 'bun:test'
import {
  buildClaudeSessionMemoryEnv,
  type SessionMemoryScope,
} from '../../agent/memory/session-memory-scope'
import {
  resolveSessionRuntimeNotices,
  type SessionRuntimeNoticeIdV1,
} from '../session-runtime-notices'

const OPEN: SessionMemoryScope = { read: true, write: true }
const CLOSED: SessionMemoryScope = { read: false, write: false }
const CONFIG_DIR = '/tmp/nessy-d1215/workspace-a/claude-config'

const ids = (notices: readonly { id: SessionRuntimeNoticeIdV1 }[]): SessionRuntimeNoticeIdV1[] =>
  notices.map(notice => notice.id)

describe('D1.215 — the session runtime notices', () => {
  it('says the runtime keeps notes, and names the directory it keeps them in', () => {
    const notices = resolveSessionRuntimeNotices({
      provider: 'anthropic',
      memoryScope: OPEN,
      claudeConfigDir: CONFIG_DIR,
      env: {},
    })
    expect(ids(notices)).toEqual([
      'claude-auto-memory-runtime-default',
      'claude-search-results-filtered',
      'claude-worktree-cwd-may-move',
    ])
    // The PARENT of the per-project leaf, never the leaf — the module that owns
    // the disposition refuses to derive the leaf and says why at length.
    expect(notices[0]?.path).toBe(`${CONFIG_DIR}/projects`)
    // The control on the premise this whole arm rests on: an open scope is
    // exactly the input that writes NOTHING into the child's environment, so
    // "the runtime decides" is the honest state here.
    expect(buildClaudeSessionMemoryEnv(OPEN)).toEqual({})
  })

  it('follows the chat into OFF, through the same function the child env is built with', () => {
    const notices = resolveSessionRuntimeNotices({
      provider: 'anthropic',
      memoryScope: CLOSED,
      claudeConfigDir: CONFIG_DIR,
      env: {},
    })
    expect(ids(notices)[0]).toBe('claude-auto-memory-off-by-host')
    expect(notices[0]?.path).toBe(`${CONFIG_DIR}/projects`)
    // Asserted against the writer rather than against a literal: the notice is
    // right because it reads what the child is given, and this is that value.
    expect(buildClaudeSessionMemoryEnv(CLOSED).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeDefined()
  })

  it('reports the state this app never writes, when the environment carries it', () => {
    // An administrator's `=0` forces the runtime's memory on over the user's own
    // setting. The host cannot produce this; the child inherits it.
    const notices = resolveSessionRuntimeNotices({
      provider: 'anthropic',
      memoryScope: OPEN,
      claudeConfigDir: CONFIG_DIR,
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' },
    })
    expect(ids(notices)[0]).toBe('claude-auto-memory-forced-on')
    // BOUNDARY, in the same case: the chat's own OFF wins over the ambient `=0`,
    // because the switch is applied last — which is the order the child gets.
    expect(ids(resolveSessionRuntimeNotices({
      provider: 'anthropic',
      memoryScope: CLOSED,
      claudeConfigDir: CONFIG_DIR,
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' },
    }))[0]).toBe('claude-auto-memory-off-by-host')
  })

  it('carries the restricted-mode posture only when the child will be restricted', () => {
    const restricted = resolveSessionRuntimeNotices({
      provider: 'anthropic',
      memoryScope: OPEN,
      env: { CLAUDE_CODE_RESTRICTED: '1' },
    })
    expect(ids(restricted)).toContain('claude-restricted-mode')
    // The negative on the same instrument: a value the runtime does NOT accept
    // as truthy yields no notice, so this reports the child's state rather than
    // the variable's presence.
    expect(ids(resolveSessionRuntimeNotices({
      provider: 'anthropic',
      memoryScope: OPEN,
      env: { CLAUDE_CODE_RESTRICTED: '0' },
    }))).not.toContain('claude-restricted-mode')
  })

  it('answers NOTHING for the other two runtimes, and no directory is named', () => {
    for (const provider of ['pi', 'codex-runtime', 'nestor-cloud-agent', undefined] as const) {
      expect(resolveSessionRuntimeNotices({
        provider,
        memoryScope: CLOSED,
        claudeConfigDir: CONFIG_DIR,
        env: { CLAUDE_CODE_RESTRICTED: '1' },
      })).toEqual([])
    }
  })

  it('falls back to the runtime\'s own root when no workspace config dir is given', () => {
    // Not a cosmetic case: this is the answer the RENDERER would have had to
    // invent, and inventing it was WI-l's refutation of D1.139's stated zone —
    // a shared `~/.claude` root reported for a per-workspace tree. The host
    // passes the real one; when it genuinely has none, the fallback is the
    // runtime's own default rather than an empty string.
    const [memory] = resolveSessionRuntimeNotices({ provider: 'anthropic', memoryScope: OPEN, env: {} })
    expect(memory?.path).toMatch(/[/\\]\.claude[/\\]projects$/)
    expect(memory?.path).not.toBe(`${CONFIG_DIR}/projects`)
  })
})
