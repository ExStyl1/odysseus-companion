/**
 * F1.1188 (DN-291, 2026-09-29) — a deny or ask `toolRules` entry added to the workspace
 * `permissions.json` DURING a turn binds from the next tool call even when the turn's pinned
 * copy of that file already allows the same tool.
 *
 * `toolRules` is read first-match-wins (docs-site permissions.md), and F1.1045's
 * `withLiveTightening` appended the live file's deny/ask half AFTER every pinned layer, so a
 * pinned `allow mcp__linear__*` still matched `mcp__linear__delete_issue` ahead of a new
 * `deny mcp__linear__delete_*` written above it. Red before the fix: the first arm's delete
 * call was allowed.
 *
 * The fix leads the pinned layer's own tool rules with the live copy's deny rules that come
 * before its first allow rule — the ones no allow in the live file can shadow — and its ask
 * rules there too, but only while no pinned layer of the turn holds a deny tool rule (an
 * ask must not outrank the turn's pinned deny; DN-291 follow-up, 2026-10-01). Everything else
 * stays in the appended layer until the next turn (residue in `withLiveTightening`'s docblock).
 * The boundary arms: a live deny that the live file itself shadows with an earlier allow does
 * not deny that allowed tool, a removed deny still stands until the next turn (tightening only),
 * and a mid-turn ask never turns a pinned deny — this file's or another permissions file's — into a card.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionManager } from '../core/permission-manager.ts'
import { permissionsConfigCache } from '../permissions-config.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'f1188-')))
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

type Rule = { pattern: string; action: 'allow' | 'ask' | 'deny' }
let counter = 0

/** The user's edit of the workspace store, and what the config watcher does on it. */
function writeToolRules(ws: string, toolRules: Rule[]): void {
  writeFileSync(join(ws, 'permissions.json'), JSON.stringify({ toolRules }))
  permissionsConfigCache.invalidateWorkspace(ws)
}

/** A turn pinned to `pinned`; then the file is edited to `live` while that turn runs. */
function midTurn(pinned: Rule[], live: Rule[]) {
  counter += 1
  const ws = join(ROOT, `ws-${counter}`)
  mkdirSync(ws, { recursive: true })
  writeToolRules(ws, pinned)
  const key = { workspaceId: `ws-f1188-${counter}`, sessionId: `s-f1188-${counter}` }
  initializeModeState(key, 'default')
  const manager = new PermissionManager({ ...key, workspaceRootPath: ws })
  manager.setCapabilityPermissionLayers([{ content: readFileSync(join(ws, 'permissions.json'), 'utf8'), scope: 'workspace' }], `gen-${counter}`)
  writeToolRules(ws, live)
  const call = (tool: string) => {
    const result = manager.evaluateToolCall(tool, {})
    return { tool, allowed: result.allowed, reason: result.allowed ? '' : String(result.reason ?? '') }
  }
  const asks = (tool: string) => manager.evaluateToolCall(tool, {}).requiresPermission === true
  return { call, asks, done: () => cleanupModeState(key) }
}

describe('F1.1188 — a toolRules deny or ask added mid-turn outranks the pinned allow for the same tool', () => {
  test('a new deny above the existing allow binds from the next call; the tools it does not name keep the allow', () => {
    const turn = midTurn(
      [{ pattern: 'mcp__linear__*', action: 'allow' }],
      [{ pattern: 'mcp__linear__delete_*', action: 'deny' }, { pattern: 'mcp__linear__*', action: 'allow' }],
    )
    const deleted = turn.call('mcp__linear__delete_issue')
    expect(deleted.allowed).toBe(false)
    expect(deleted.reason).toContain('toolRules pattern mcp__linear__delete_*')
    expect(turn.call('mcp__linear__get_issue')).toEqual({ tool: 'mcp__linear__get_issue', allowed: true, reason: '' })
    turn.done()
  })

  test('BOUNDARY: a deny the live file shadows with an earlier allow does not deny that tool, and a removed deny still stands', () => {
    const shadowed = midTurn(
      [{ pattern: 'mcp__linear__*', action: 'allow' }],
      [{ pattern: 'mcp__linear__get_*', action: 'allow' }, { pattern: 'mcp__linear__*', action: 'deny' }],
    )
    expect(shadowed.call('mcp__linear__get_issue')).toEqual({ tool: 'mcp__linear__get_issue', allowed: true, reason: '' })
    shadowed.done()

    // The same edit also adds an ask above the allow, so a lead is built for this layer and must still carry no allow.
    const removed = midTurn(
      [{ pattern: 'mcp__linear__delete_*', action: 'deny' }, { pattern: 'mcp__linear__*', action: 'allow' }],
      [{ pattern: 'mcp__github__*', action: 'ask' }, { pattern: 'mcp__linear__*', action: 'allow' }],
    )
    const stillDenied = removed.call('mcp__linear__delete_issue')
    expect(stillDenied.allowed).toBe(false)
    expect(stillDenied.reason).toContain('toolRules pattern mcp__linear__delete_*')
    removed.done()
  })

  // DN-291 follow-up (2026-10-01): an ask may not outrank the turn's own pinned deny — editing a deny to ask, or
  // adding a broader ask above it, would turn a refusal into an approval card within the same turn.
  test('BOUNDARY: a mid-turn ask never loosens the pinned deny for the same tool', () => {
    const pinned: Rule[] = [{ pattern: 'mcp__linear__delete_*', action: 'deny' }, { pattern: 'mcp__linear__*', action: 'allow' }]
    for (const live of [
      [{ pattern: 'mcp__linear__delete_*', action: 'ask' }, { pattern: 'mcp__linear__*', action: 'allow' }],
      [{ pattern: 'mcp__linear__*', action: 'ask' }, { pattern: 'mcp__linear__delete_*', action: 'deny' }],
    ] satisfies Rule[][]) {
      const turn = midTurn(pinned, live)
      const deleted = turn.call('mcp__linear__delete_issue')
      expect(deleted.allowed).toBe(false)
      expect(deleted.reason).toContain('toolRules pattern mcp__linear__delete_*')
      turn.done()
    }

    // The positive half: with no pinned deny to outrank, a new ask above the pinned allow still asks from the next call.
    const asked = midTurn(
      [{ pattern: 'mcp__linear__*', action: 'allow' }],
      [{ pattern: 'mcp__linear__delete_*', action: 'ask' }, { pattern: 'mcp__linear__*', action: 'allow' }],
    )
    expect(asked.asks('mcp__linear__delete_issue')).toBe(true)
    expect(asked.asks('mcp__linear__get_issue')).toBe(false)
    asked.done()
  })

  // DN-291 follow-up (RF-a, 2026-10-01): the residue the permissions page states. With a pinned deny in the file, the
  // lead stops at the first ask, so a new deny placed below a new ask waits for the next turn; the same deny with no
  // ask above it binds from the next call. If this arm turns red, the page's "any rule placed below an ask" is stale.
  test('BOUNDARY: with a pinned deny, a new deny below a new ask waits for the next turn; without the ask it binds', () => {
    const pinned: Rule[] = [{ pattern: 'mcp__a__*', action: 'deny' }, { pattern: 'mcp__linear__*', action: 'allow' }]
    const belowAsk = midTurn(pinned, [
      { pattern: 'mcp__github__*', action: 'ask' },
      { pattern: 'mcp__linear__delete_*', action: 'deny' },
      { pattern: 'mcp__a__*', action: 'deny' },
      { pattern: 'mcp__linear__*', action: 'allow' },
    ])
    expect(belowAsk.call('mcp__linear__delete_issue')).toEqual({ tool: 'mcp__linear__delete_issue', allowed: true, reason: '' })
    belowAsk.done()

    const noAsk = midTurn(pinned, [
      { pattern: 'mcp__linear__delete_*', action: 'deny' },
      { pattern: 'mcp__a__*', action: 'deny' },
      { pattern: 'mcp__linear__*', action: 'allow' },
    ])
    const denied = noAsk.call('mcp__linear__delete_issue')
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toContain('toolRules pattern mcp__linear__delete_*')
    noAsk.done()
  })

  // The deny an ask may not outrank can sit in a LATER layer. The app pins the layers as native-sources.ts inventories
  // them: default.json, each source file, the workspace permissions.json, the project's .nessy-agent/permissions.json
  // (RF-a follow-up, 2026-10-01: an earlier version of this arm pinned the workspace first, the reverse of the app). So
  // an ask leading source x's layer is read before the workspace layer, and a lead `ask mcp__x__*` would turn the
  // workspace file's pinned deny into a card.
  function sourceThenWorkspace(source: Rule[], workspace: Rule[]) {
    counter += 1
    const ws = join(ROOT, `ws-${counter}`)
    const sourceDir = join(ws, 'sources', 'x')
    mkdirSync(sourceDir, { recursive: true })
    writeToolRules(ws, workspace)
    writeFileSync(join(sourceDir, 'permissions.json'), JSON.stringify({ toolRules: source }))
    permissionsConfigCache.invalidateSource(ws, 'x')
    const key = { workspaceId: `ws-f1188-${counter}`, sessionId: `s-f1188-${counter}` }
    initializeModeState(key, 'default')
    const manager = new PermissionManager({ ...key, workspaceRootPath: ws })
    manager.setCapabilityPermissionLayers([
      { content: readFileSync(join(sourceDir, 'permissions.json'), 'utf8'), scope: 'workspace', sourceSlug: 'x' },
      { content: readFileSync(join(ws, 'permissions.json'), 'utf8'), scope: 'workspace' },
    ], `gen-${counter}`)
    const editSource = (rules: Rule[]) => {
      writeFileSync(join(sourceDir, 'permissions.json'), JSON.stringify({ toolRules: rules }))
      permissionsConfigCache.invalidateSource(ws, 'x')
    }
    const evaluate = (tool: string) => {
      const result = manager.evaluateToolCall(tool, {})
      return { allowed: result.allowed, asks: result.requiresPermission === true, reason: result.allowed ? '' : String(result.reason ?? '') }
    }
    return { editSource, editWorkspace: (rules: Rule[]) => writeToolRules(ws, rules), evaluate, done: () => cleanupModeState(key) }
  }

  test('BOUNDARY: a source file\'s ask added mid-turn never outranks the workspace file\'s pinned deny', () => {
    // Source x starts with no rule: its pinned allow, read first, would already answer before the workspace deny.
    const turn = sourceThenWorkspace([], [{ pattern: 'mcp__x__drop_*', action: 'deny' }])
    turn.editSource([{ pattern: 'mcp__x__*', action: 'ask' }])
    const dropped = turn.evaluate('mcp__x__drop_table')
    expect(dropped.allowed).toBe(false)
    expect(dropped.reason).toContain('toolRules pattern mcp__x__drop_*')
    // The ask still binds mid-turn where no pinned rule matches the tool (the appended layer).
    expect(turn.evaluate('mcp__x__read_table').asks).toBe(true)
    turn.done()
  })

  // RF-a follow-up 2 (2026-10-01): the page's condition is "a toolRules deny in ANY permissions file of the turn",
  // with no read order to know. Red before: asksMayLead scanned only the edited layer and the ones after it, so a
  // workspace ask with an unrelated deny in source x (read BEFORE the workspace file) still asked mid-turn.
  test('BOUNDARY: an unrelated pinned deny in any permissions file makes a new ask wait; with none the ask asks', () => {
    const sourceEdit = sourceThenWorkspace([{ pattern: 'mcp__x__*', action: 'allow' }], [{ pattern: 'mcp__other__*', action: 'deny' }])
    sourceEdit.editSource([{ pattern: 'mcp__x__drop_*', action: 'ask' }, { pattern: 'mcp__x__*', action: 'allow' }])
    expect(sourceEdit.evaluate('mcp__x__drop_table')).toEqual({ allowed: true, asks: false, reason: '' })
    sourceEdit.done()

    const workspaceEdit = sourceThenWorkspace([{ pattern: 'mcp__x__foo_*', action: 'deny' }], [{ pattern: 'mcp__linear__*', action: 'allow' }])
    workspaceEdit.editWorkspace([{ pattern: 'mcp__linear__delete_*', action: 'ask' }, { pattern: 'mcp__linear__*', action: 'allow' }])
    expect(workspaceEdit.evaluate('mcp__linear__delete_issue')).toEqual({ allowed: true, asks: false, reason: '' })
    workspaceEdit.done()

    const noDeny = sourceThenWorkspace([{ pattern: 'mcp__x__*', action: 'allow' }], [{ pattern: 'mcp__linear__*', action: 'allow' }])
    noDeny.editWorkspace([{ pattern: 'mcp__linear__delete_*', action: 'ask' }, { pattern: 'mcp__linear__*', action: 'allow' }])
    expect(noDeny.evaluate('mcp__linear__delete_issue')).toEqual({ allowed: true, asks: true, reason: '' })
    noDeny.done()
  })

  // RF-a follow-up (2026-10-01): the later layer that stops an ask from leading is not only a source file. The
  // project's `.nessy-agent/permissions.json` is pinned after the workspace and source layers (project scope), and
  // ANY toolRules deny there — even one for unrelated tools — makes a new workspace ask wait for the next turn, so
  // the pinned allow still answers. The page names that file; if this arm turns red, its condition is stale.
  test('BOUNDARY: a project permissions file\'s unrelated pinned deny makes a new workspace ask wait; without it the ask asks', () => {
    const run = (withProjectDeny: boolean) => {
      counter += 1
      const ws = join(ROOT, `ws-${counter}`)
      mkdirSync(ws, { recursive: true })
      writeToolRules(ws, [{ pattern: 'mcp__linear__*', action: 'allow' }])
      const key = { workspaceId: `ws-f1188-${counter}`, sessionId: `s-f1188-${counter}` }
      initializeModeState(key, 'default')
      const manager = new PermissionManager({ ...key, workspaceRootPath: ws })
      manager.setCapabilityPermissionLayers([
        { content: readFileSync(join(ws, 'permissions.json'), 'utf8'), scope: 'workspace' },
        ...(withProjectDeny
          ? [{ content: JSON.stringify({ toolRules: [{ pattern: 'mcp__other__*', action: 'deny' }] }), scope: 'project' as const }]
          : []),
      ], `gen-${counter}`)
      writeToolRules(ws, [{ pattern: 'mcp__linear__delete_*', action: 'ask' }, { pattern: 'mcp__linear__*', action: 'allow' }])
      const result = manager.evaluateToolCall('mcp__linear__delete_issue', {})
      cleanupModeState(key)
      return { allowed: result.allowed, asks: result.requiresPermission === true }
    }
    expect(run(true)).toEqual({ allowed: true, asks: false })
    expect(run(false)).toEqual({ allowed: true, asks: true })
  })
})
