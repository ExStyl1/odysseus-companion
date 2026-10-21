/**
 * RTS-12 — the context meter belongs to the runtime the session is on NOW.
 *
 * Added by T11, whose evidence is host-side only: a unit test can assert that
 * `clearRuntimeScopedSessionState` nulls three fields, but it cannot show what
 * the meter reads afterwards on a real build talking to a real gateway.
 *
 * The failure it guards against is mixed units. Pi reports a 262 144-token
 * window; Codex's is different. If Pi's window survived a switch it would become
 * the DIVISOR for Codex's token counts, and the meter would read plausibly and
 * wrongly — the worst shape a number can have, because nobody checks a
 * percentage that looks reasonable.
 *
 * ## Three readings, and the middle one is the point
 *
 * 1. On Pi, after a turn: `contextUsage.contextWindow` is Pi's.
 * 2. Immediately after the switch, BEFORE any turn on the target: `contextUsage`
 *    must be gone entirely, and `tokenUsage.contextWindow` with it. This is the
 *    reading that catches a surviving Pi window, because it is the only moment
 *    when the old value would still be the only value present.
 * 3. After one turn on Codex: whatever window is reported must not be Pi's.
 *
 * ## Read the reading, never `lastCompaction`
 *
 * `ContextUsageSnapshot.lastCompaction` is declared and never filled on the Pi
 * path — it reported "never compacted" through twenty-seven real compactions.
 * Nothing here touches it. Every number below comes from the session DTO the
 * renderer itself renders.
 *
 * ## What this case does NOT do
 *
 * The plan says "fill a Pi session to roughly half its window". It does not,
 * and the reason is a trap this repo has already paid for: a narrowing knob
 * sized against zero rather than against the system's resting state manufactures
 * its own failure. A session's BASE context here is ~37 000 tokens of system
 * prompt, tools and skills before a word is typed. Reaching ~130 000 honestly
 * would take a very long conversation, and reaching it by shrinking the window
 * would put the threshold below the floor the session can ever occupy — which
 * reads exactly like "compaction is broken". The claim does not need it: the
 * DIVISOR is unambiguous at any occupancy, and the divisor is what mixed units
 * corrupt.
 */

import type { CdpSession } from '../lib/connect.ts'
import { main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, visibleElements } from '../lib/state.ts'
import { sendPrompt } from '../lib/chat.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { requireRuntimeTrio, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'

const ID = 'RTS-12'
const TITLE = 'After a switch the context meter shows the new runtime’s window, not the old one’s'

interface UsageRead {
  contextUsage?: { contextWindow?: number; inputTokens?: number; modelId?: string; autoCompactionThreshold?: number }
  tokenUsage?: { contextWindow?: number; inputTokens?: number; contextTokens?: number }
}

async function usage(session: CdpSession, sessionId: string): Promise<UsageRead> {
  return session.call<UsageRead>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(x => x.id === ${JSON.stringify(sessionId)})
    if (!s) return {}
    return { contextUsage: s.contextUsage, tokenUsage: s.tokenUsage }
  `)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)

  const key = await freshSession(session, `${ID} context meter across a switch`)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')
  await switchRuntime(session, key.sessionId, trio.pi)
  run.require(
    'the session starts on Pi',
    (await waitForConnection(session, key.sessionId, trio.pi)) === trio.pi,
    trio.pi,
  )

  // --- reading 1: Pi has a window and an occupancy ------------------------
  await sendPrompt(session, key, 'Reply with exactly: CTX-PI', 300_000)
  const onPi = await usage(session, key.sessionId)
  run.observe('pi contextUsage', onPi.contextUsage)
  const piWindow = onPi.contextUsage?.contextWindow
  run.require(
    'Pi reported a context window — the premise of the comparison',
    typeof piWindow === 'number' && piWindow > 0,
    String(piWindow),
  )
  run.observe('pi window', piWindow)

  // --- reading 2: the moment after the switch, before any target turn -----
  const outcome = await switchRuntime(session, key.sessionId, trio.codex)
  run.observe('switch pi → codex', outcome)
  run.require('the switch was accepted', outcome.ok, outcome.error ?? '')
  run.require(
    'the session reports the codex card',
    (await waitForConnection(session, key.sessionId, trio.codex)) === trio.codex,
    trio.codex,
  )

  const afterSwitch = await usage(session, key.sessionId)
  run.observe('usage immediately after the switch', afterSwitch)
  run.check(
    'the Pi snapshot is gone — nothing is left to divide the new runtime’s tokens by',
    afterSwitch.contextUsage === undefined || afterSwitch.contextUsage === null,
    JSON.stringify(afterSwitch.contextUsage ?? null),
  )
  run.check(
    'the Pi window is gone from tokenUsage too — the field the meter falls back to',
    afterSwitch.tokenUsage?.contextWindow === undefined,
    String(afterSwitch.tokenUsage?.contextWindow),
  )

  // --- reading 3: one turn on codex ---------------------------------------
  await sendPrompt(session, key, 'Reply with exactly: CTX-CODEX', 300_000)
  const onCodex = await usage(session, key.sessionId)
  run.observe('usage after the codex turn', onCodex)
  const codexWindow = onCodex.tokenUsage?.contextWindow ?? onCodex.contextUsage?.contextWindow
  run.observe('codex window', codexWindow)
  run.check(
    'the window reported on Codex is NOT Pi’s',
    codexWindow !== piWindow,
    `pi=${piWindow} codex=${codexWindow}`,
  )
  run.check(
    'the occupancy reported on Codex is the codex turn’s, not the Pi span’s',
    onCodex.tokenUsage?.inputTokens !== undefined && onCodex.tokenUsage.inputTokens !== onPi.tokenUsage?.inputTokens,
    `pi=${onPi.tokenUsage?.inputTokens} codex=${onCodex.tokenUsage?.inputTokens}`,
  )

  // --- the threshold half --------------------------------------------------
  // Codex's `thresholdKind` is `none`, so the composer must show no capacity
  // warning. Read as VISIBLE elements: a zero-sized leftover in the tree is not
  // a warning the user can see, and counting nodes would report one.
  const warnings = await visibleElements(session, '[data-context-warning], [data-testid*="context-warning"]')
  run.observe('visible context warnings on codex', warnings.map(w => w.text))
  run.check(
    'no threshold warning is shown on a runtime whose thresholdKind is none',
    warnings.length === 0,
    warnings.map(w => w.text).join(' | ') || 'none',
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
