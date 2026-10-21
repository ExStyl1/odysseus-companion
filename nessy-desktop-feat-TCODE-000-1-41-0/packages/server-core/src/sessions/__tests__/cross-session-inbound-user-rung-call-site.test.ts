/**
 * P6.182 clause (i) + P6.866 — the CALL SITE, which is what both rows were
 * missing.
 *
 * The resolver already took `userMode`, `operatorExplicit` and
 * `userUnrecognized` (`cross-session-inbound.test.ts` pins all three), and
 * `SessionManager.resolveInboundModeFor` supplied none of them. So the user rung
 * the page describes — *"Claude Code reads managed settings first, then the
 * `--settings` flag, then user settings, and applies the first value found"* —
 * had nowhere to arrive, and a typo in a user's own file did nothing at all
 * where the page WARNS AND HOLDS:
 *
 * *"Claude Code warns when you set a value it doesn't recognize. While that
 * value is present in a user, project, local, or `--settings` file, Claude Code
 * holds inbound messages, even when a source that takes precedence sets
 * `accept`. […] Fix or remove the value to clear the hold."*
 *
 * `console.warn` is the capture point on `cd-refusal-names-rule.test.ts`'s
 * reasoning: `sessionLog` is this module's console-backed fallback until a
 * platform is installed, and installing one is process-wide.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { saveConfig } from '@nessy-agent/shared/config/storage'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const ENV = 'NESSY_CROSS_SESSION_INBOUND'
const managers: SessionManager[] = []

/**
 * `delete` first, then assign — Bun 1.3.14 leaves a plain assignment readable by
 * property and INVISIBLE to a spread (AGENTS.md §Traps).
 */
function setEnv(value: string | undefined): void {
  delete process.env[ENV]
  if (value !== undefined) process.env[ENV] = value
}

/**
 * Write the user rung directly, including values the setter refuses: a typo
 * reaches `config.json` by hand or by another tool, never through
 * `setCrossSessionInbound`, so writing it past the setter is the only honest
 * way to reproduce the state the page is about.
 */
function seedUserRung(value: unknown): void {
  saveConfig({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  } as never)
  const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>
  if (value === undefined) delete raw.crossSessionInbound
  else raw.crossSessionInbound = value
  writeFileSync(CONFIG_FILE, JSON.stringify(raw))
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  setEnv(undefined)
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE)
})

let seq = 0

function resolveFor(): { mode: string; warnings: string[] } {
  const manager = createTestSessionManager()
  managers.push(manager)
  seq += 1
  const make = (suffix: string) => createManagedSession({ id: `xsi-${seq}-${suffix}` }, {
    id: `ws-xsi-${seq}`,
    name: 'Workspace XSI',
    rootPath: '/tmp/nessy-xsi-call-site',
    createdAt: 1,
  }, { messagesLoaded: true, ephemeral: true })
  const receiver = make('receiver')
  const sender = make('sender')
  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    const resolved = (manager as unknown as {
      resolveInboundModeFor(r: unknown, f: unknown): { mode: string }
    }).resolveInboundModeFor(receiver, sender)
    // Called TWICE on purpose: the warning is latched per manager, so a second
    // arrival must not repeat it.
    ;(manager as unknown as {
      resolveInboundModeFor(r: unknown, f: unknown): { mode: string }
    }).resolveInboundModeFor(receiver, sender)
    return { mode: resolved.mode, warnings }
  } finally {
    console.warn = realWarn
  }
}

describe('the user rung reaches the resolver (P6.182 clause i)', () => {
  test('a user value applies when the operator claimed nothing', () => {
    // POSITIVE. With no operator value the base is the per-message default; the
    // user's `refuse` replaces it, which is the whole of "applies the first
    // value found" for the rung this host actually writes.
    setEnv(undefined)
    // The CONTROL first, so "refuse" below cannot be the per-message default
    // wearing the rung's clothes.
    seedUserRung(undefined)
    const withoutUserValue = resolveFor().mode
    expect(withoutUserValue).not.toBe('refuse')

    seedUserRung('refuse')
    expect(resolveFor().mode).toBe('refuse')
  })

  test('an explicit operator value still outranks it', () => {
    // NEGATIVE, and the one direction this key must never move.
    setEnv('accept')
    seedUserRung('refuse')
    expect(resolveFor().mode).toBe('accept')
  })
})

describe('an unreadable user value warns and holds at the call site (P6.866)', () => {
  test('a typo holds inbound messages and is named exactly once', () => {
    // POSITIVE. Before this, the typo was dropped in silence and the session
    // fell through to whatever the next rung said — LOOSER than the page, on a
    // control whose failure mode is delivering unasked.
    setEnv(undefined)
    seedUserRung('reject')
    const { mode, warnings } = resolveFor()
    expect(mode).toBe('hold')
    const named = warnings.filter(line => line.includes('"reject"'))
    // The user cannot fix what nobody names — and a line per arriving message
    // would repeat itself at the rate peers write, so it is latched.
    expect(named).toHaveLength(1)
  })

  test('a value the host CAN read says nothing at all', () => {
    // NEGATIVE, the control: the warning belongs to the unreadable value, not to
    // the rung being consulted.
    setEnv(undefined)
    seedUserRung('hold')
    const { mode, warnings } = resolveFor()
    expect(mode).toBe('hold')
    expect(warnings.filter(line => line.includes('crossSessionInbound'))).toEqual([])
  })
})
