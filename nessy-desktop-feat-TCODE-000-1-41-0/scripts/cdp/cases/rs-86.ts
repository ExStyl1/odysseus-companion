/**
 * RS-86 (D1.43, source `P6.298`) — the three hook fields the row names, driven
 * on the packaged build against a Pi card, each with its own detector and its
 * own positive control.
 *
 * ## The row
 *
 * *"three hook OUTPUT fields are enforced host-side and driven on Pi alone —
 * terminalSequence, async/asyncRewake, and the effort input"*. Three sittings
 * have nulled it (sitting 3: *"the row's line anchor has moved (content
 * unchanged) — re-anchor in words when re-taken"*; sitting 5d: *"needs three
 * hook OUTPUT fields exercised from a real hook … a fixture sitting"*). The
 * fixture is `scripts/cdp/fixtures/hook-output-fields.ts`; this is that sitting.
 *
 * **Re-anchored in words, as sitting 3 asked.** The effort clause lives in
 * `packages/shared/src/automations/hook-command.ts` symbol
 * `buildHookCommandEnv`, whose last two `setSanitized` calls are `NESSY_EFFORT`
 * and `CLAUDE_EFFORT` from `input.effort?.level`, quoting hooks.md: *"The level
 * is also available to hook commands and the Bash tool as the `$CLAUDE_EFFORT`
 * environment variable."* The `terminalSequence` clause is the same file's
 * symbol `parseUniversalHookOutput` and its OSC allowlist. `async` is declared
 * on the action schema in `packages/shared/src/automations/schemas.ts`.
 *
 * ## Why every detector is a file or a transcript row, never a screen
 *
 * Each of the three is written by the FEATURE: the env dump by the hook child
 * itself, the `info` row by `pi-agent.ts` symbol
 * `surfaceSessionStartHookMessage`, the two epoch stamps by the async hook's
 * own shell. Nothing here is read off a rendered pixel, so a run against a
 * hidden window reads the same answer.
 *
 * ## The three controls, and what each rules out
 *
 *  - **effort.** `NESSY_EVENT` is set unconditionally at the top of
 *    `buildHookCommandEnv`, so it rides the same dump as `CLAUDE_EFFORT`. A
 *    dump with `NESSY_EVENT` and no `CLAUDE_EFFORT` is an ABSENCE; a dump with
 *    neither is a hook that did not run and the case says so rather than
 *    scoring the silence. The session is put at a NAMED level first and the
 *    level is read back, so "no effort was set" is ruled out before the dump is
 *    read at all.
 *  - **terminalSequence.** Its own sibling `systemMessage` rides the SAME JSON
 *    document from the SAME hook. If the `info` row carrying the system marker
 *    arrives, that document was produced, parsed and consumed — so an OSC
 *    marker found nowhere is the field going nowhere, not a hook that never
 *    fired. One document, so no second hook can be blamed for either half.
 *  - **async.** The hook writes `start` before its sleep and `end` after it, so
 *    "the hook ran" is a fact on disk independent of the timing question. The
 *    subject is then `turnEnd < hookEnd` on the PRODUCT's own message
 *    timestamp, and the case reports UNAVAILABLE rather than a verdict when the
 *    hook left fewer than two lines.
 *
 * ## A rig fact this case's FIRST drive paid for, and it is not D1.43's
 *
 * The first drive wedged: the Bash tool sat at `executing` and the turn never
 * ended (185 436 ms, `processing: true`, four messages). The cause is a named
 * and already-repaired row — **D1.333**, whose fix `5ba002ae6` is NOT an
 * ancestor of the commit this artefact was built from. `SessionManager` symbol
 * `pluginCommandHookRunner` puts every command hook through the permission
 * gate; two of this fixture's three hooks carry a `>>`, which the gate scores
 * `ask`, and before that repair the wait settled only on a click. So the case
 * runs `approvePermissionsWhile` underneath the turn and REPORTS the count it
 * answered, rather than dodging the gate with a hook spelling chosen to slip
 * past it. On a build carrying the repair the count should fall to zero and the
 * hook should end with `hookApprovalTimeoutNotice` instead.
 *
 * The `terminalSequence` hook is the control for that too: it is a bare
 * `printf` with no redirect, it was never gated, and its `info` row arrived on
 * the wedged drive — so "hooks do not run here" was ruled out before the
 * approver was added.
 *
 * **And the ordinary approver cannot answer that card.**
 * `lib/ask-user.ts`'s `approvePermissionsWhile` gates every click on
 * `Session.awaitingApprovalCount >= 1`, and a command hook's card is not
 * counted there: measured twice on this artefact, with the card on screen and
 * its `Allow once` button clickable, all four sessions read
 * `awaitingApprovalCount: 0`. Clicked by hand at the same moment, the hook ran
 * and wrote its dump within seconds. {@link answerHookCardsWhile} is therefore
 * count-independent and polls the BUTTON — the surface the user has — and the
 * gap is written up as a proposed row rather than worked around silently.
 *
 * ## What this case deliberately does not answer
 *
 * `asyncRewake`'s exit-2 wake is the one clause of D1.43 not driven here. It
 * needs a hook that exits 2 from the background and a detector for an assistant
 * turn that no user prompt asked for, which is a second rig shape (a wake is
 * only distinguishable from a slow answer by the absence of a `user` row before
 * it) and would put two questions on one turn. Recorded as this case's own
 * residue rather than folded into a verdict.
 *
 * ## Safety
 *
 * A fresh `NESSY_CONFIG_DIR` and the fixture's own hooks, all of them `printf`,
 * `env`, `date`, `grep` and `sleep`. No credential is read, nothing egresses,
 * and the only files written are under the config dir the fixture was pointed
 * at. The case itself writes nothing into the config dir — it only reads what
 * the hooks wrote.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readAppEnvContamination, appEnvBlockReason } from '../lib/app-env.ts'
import { clickAt } from '../lib/viewport.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import {
  assertElectronApi, freshSession, setThinkingLevel, transcript, waitForTurn,
  type SessionKey, type TranscriptMessage,
} from '../lib/state.ts'
import type { CaseMeta } from '../lib/sitting.ts'
import { ASYNC_FILE, ASYNC_SLEEP_S, HOOK_MARKER, HOOK_OUTPUT_DIR, PRE_TOOL_USE_ENV_FILE } from '../fixtures/hook-output-fields.ts'

const ID = 'RS-86'
const TITLE = 'the three hook fields D1.43 names — the effort input, terminalSequence and async — on a Pi card'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.43',
  runtimes: ['pi'],
  credentials:
    'owner: the machine holds the shared dp sign-in the one-click Pi card uses (`~/.nessy/dp_auth_creds.json`, outside '
    + 'the config dir) — this case never reads, prints or writes it. Launch the PACKAGED build with NESSY_CONFIG_DIR '
    + 'pointing at a directory `bun run scripts/cdp/fixtures/hook-output-fields.ts --config-dir <dir>` has seeded, and '
    + 'export the two markers that fixture prints.',
} as const satisfies CaseMeta

/**
 * The level the session is put at before the turn. NAMED rather than
 * "whatever it was": the absence this case measures is only a reading once
 * something was there to be forwarded.
 */
const SESSION_LEVEL = 'high'

/** A turn that must use a tool, so PreToolUse and PostToolUse both fire. */
const PROMPT =
  'Use your Bash tool to run exactly this command: echo D143-PROBE-OK. Then reply with the single word done.'

/** How long to wait after the turn for an 8 s background hook to land its second line. */
const ASYNC_GRACE_MS = (ASYNC_SLEEP_S + 12) * 1_000

interface EnvDump {
  /** Every `NAME=` seen across every invocation, so one missing call cannot hide a present name. */
  names: string[]
  invocations: number
  raw: string
}

function readEnvDump(path: string): EnvDump | undefined {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return undefined }
  const names = [...new Set(
    raw.split('\n').map(line => /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1]).filter((n): n is string => n !== undefined),
  )].sort()
  return { names, invocations: raw.split('\n').filter(line => line.startsWith(`--- ${HOOK_MARKER}`)).length, raw }
}

interface AsyncStamps {
  startedAt?: number
  endedAt?: number
  lines: number
}

function readAsyncStamps(path: string): AsyncStamps {
  let raw = ''
  try { raw = readFileSync(path, 'utf8') } catch { return { lines: 0 } }
  const lines = raw.split('\n').filter(Boolean)
  const last = (kind: 'start' | 'end'): number | undefined => {
    const hits = lines.filter(line => line.startsWith(`${HOOK_MARKER} ${kind} `))
    const value = hits.at(-1)?.split(' ').at(-1)
    const parsed = value !== undefined ? Number(value) : Number.NaN
    return Number.isFinite(parsed) ? parsed * 1_000 : undefined
  }
  return { startedAt: last('start'), endedAt: last('end'), lines: lines.length }
}

/** The product's own clock for the turn: the last message's timestamp. */
function lastTimestamp(messages: readonly TranscriptMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const stamp = messages[index]?.timestamp
    if (typeof stamp === 'number' && Number.isFinite(stamp)) return stamp
    if (typeof stamp === 'string') {
      const parsed = Date.parse(stamp)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/** Whatever the session has recorded, as one searchable string — rows, tool results and all. */
function transcriptText(messages: readonly TranscriptMessage[]): string {
  return JSON.stringify(messages)
}

async function sessionThinkingLevel(session: CdpSession, key: SessionKey): Promise<string | undefined> {
  return session.call<string | undefined>(`
    const list = await window.electronAPI.getSessions()
    const s = (list ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
    return s ? s.thinkingLevel : undefined
  `).catch(() => undefined)
}

/**
 * Answer the permission cards a COMMAND HOOK raises, without consulting
 * `awaitingApprovalCount`.
 *
 * `lib/ask-user.ts`'s `approvePermissionsWhile` is the ordinary instrument and
 * it cannot serve here. It gates every click on
 * `Session.awaitingApprovalCount >= 1`, and on this artefact a command hook's
 * card is NOT counted there: measured twice, with the card on screen and its
 * `Allow once` button clickable, all four sessions read `awaitingApprovalCount:
 * 0`, the approver never clicked, and the turn wedged for 180 s and again for
 * 300 s. Clicked by hand at the same moment, the hook ran and wrote its dump
 * within seconds.
 *
 * So this one polls the BUTTON, which is the surface the user has. It matches
 * the card's own words — `Allow once` first, then a bare `Allow` — and never
 * `Always Allow` (which would write a durable rule into the rig's settings) and
 * never anything inside the ask-user banner (which is a question for the user,
 * not a permission).
 */
function answerHookCardsWhile(session: CdpSession): { stop: () => Promise<number> } {
  let answered = 0
  let running = true
  const loop = (async () => {
    while (running) {
      await Bun.sleep(2_000)
      const hit = await session.call<{ x: number; y: number; text: string } | undefined>(`
        const wanted = /^(allow once|allow)$/i
        const banner = document.querySelector('[data-tutorial="ask-user-banner"]')
        const button = Array.from(document.querySelectorAll('button')).find(el => {
          if (banner && banner.contains(el)) return false
          const t = (el.innerText || '').replace(/\\s+/g, ' ').trim()
          if (!wanted.test(t)) return false
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        })
        if (!button) return undefined
        const r = button.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (button.innerText || '').trim() }
      `).catch(() => undefined)
      if (!hit) continue
      await clickAt(session, { x: hit.x, y: hit.y }, `the hook card's ${hit.text}`).catch(() => undefined)
      answered += 1
    }
  })()
  return { stop: async () => { running = false; await loop; return answered } }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const contamination = await readAppEnvContamination()
  run.observe('the app’s own environment', { pids: contamination.pids.length, present: contamination.present, controlSeen: contamination.controlSeen })
  const envReason = appEnvBlockReason(contamination, 'D1.43 — a hook child\u2019s own environment')
  if (envReason) blocked(envReason)
  // `CLAUDE_EFFORT` is one of the thirteen names the launcher deletes, and this
  // case's whole subject is whether the HOST puts it into a hook child. An app
  // that inherited it from the lane's shell would hand the hook a value the
  // product never resolved, and the reading would be about a shell.
  run.check(
    'THE CONTROL — the app did NOT inherit `CLAUDE_EFFORT` from the launching shell',
    contamination.controlSeen && contamination.present.CLAUDE_EFFORT === undefined,
    'either the app carries the name (so a hook child would see the LANE\'s value, not the session\'s) or the read '
    + 'returned nothing at all, which is not the same as clean',
  )

  run.observe('load at the start', execFileSync('uptime', { encoding: 'utf8' }).trim())

  const outputDir = join(configDir(), HOOK_OUTPUT_DIR)
  const systemMarker = process.env.NESSY_CDP_D143_SYSTEM_MARKER?.trim()
  const oscMarker = process.env.NESSY_CDP_D143_OSC_MARKER?.trim()
  if (!systemMarker || !oscMarker) {
    blocked(
      'NESSY_CDP_D143_SYSTEM_MARKER and NESSY_CDP_D143_OSC_MARKER name the two halves of the ONE JSON document the '
      + 'SessionStart hook prints, and without them the terminalSequence clause has no control. Seed the rig first: '
      + '`bun run scripts/cdp/fixtures/hook-output-fields.ts --config-dir <the app\'s NESSY_CONFIG_DIR>` prints both.',
    )
  }

  const cards = await listConnections(session)
  const pi = cards.find(card => runtimeOf(card.providerType) === 'pi')
  run.observe('the cards this profile has', cards.map(card => ({ slug: card.slug, providerType: card.providerType })))
  if (!pi) {
    blocked(
      'this profile lists no Pi card, and D1.43 is the Pi row by its own words ("driven on Pi alone"). Run RS-32 '
      + 'first — it presses the onboarding\'s own one-click button.',
    )
  }

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.check('the case ran in a session it created', key.fresh, key.reason ?? '')
  const outcome = await switchRuntime(session, key.sessionId, pi.slug)
  const bound = await waitForConnection(session, key.sessionId, pi.slug, outcome.ok ? 30_000 : 60_000)
  run.require(
    `the session is bound to \`${pi.slug}\``,
    bound === pi.slug,
    `the session reports \`${String(bound)}\`, so the turn below would be another runtime's: `
    + String(outcome.errorDetail?.message ?? outcome.error ?? 'the app reported no error'),
  )

  // ---- the effort the hook is supposed to receive, SET and READ BACK -------
  await setThinkingLevel(session, key.sessionId, SESSION_LEVEL)
  const level = await sessionThinkingLevel(session, key)
  run.require(
    `THE CONTROL — the session really sits at \`${SESSION_LEVEL}\``,
    level === SESSION_LEVEL,
    `the session reports \`${String(level)}\`; with no level set, \`setSanitized\` no-ops and an absent CLAUDE_EFFORT `
    + 'in the hook child would say nothing about whether the host forwards one',
  )

  // ---- D1.333: on THIS artefact a command hook that redirects raises a card --
  //
  // The first drive of this case wedged for ever, and the cause is already a
  // named and FIXED row: D1.333, whose repair `5ba002ae6` is NOT an ancestor of
  // the commit this artefact was built from. `SessionManager` symbol
  // `pluginCommandHookRunner` puts every command hook through the permission
  // gate; the fixture's env-dump and async hooks both carry a `>>`, which the
  // gate scores `ask`, and before that repair the wait settled only on a click.
  // So an approver runs underneath the turn — and the COUNT it answers is itself
  // a reading, recorded rather than swallowed, because on a build carrying the
  // repair an unattended hook would end with a notice instead of a card.
  const approver = answerHookCardsWhile(session)
  const before = (await transcript(session, key)).length
  const sentAt = Date.now()
  await sendPrompt(session, key, PROMPT).catch(() => undefined)
  const messages = await waitForTurn(session, key, before, 300_000).catch(async () => transcript(session, key))
  const turnEnd = lastTimestamp(messages) ?? Date.now()
  run.observe('the turn', {
    messages: messages.length,
    roles: [...new Set(messages.map(m => m.role))],
    toolsCalled: [...new Set(messages.map(m => m.toolName).filter(Boolean))],
    toolStatuses: [...new Set(messages.map(m => m.toolStatus).filter(Boolean))],
    wallMs: Date.now() - sentAt,
  })

  const approvals = await approver.stop()
  run.observe('D1.333 — the permission cards this turn raised for its own hooks', {
    answered: approvals,
    why: 'a command hook whose body redirects is scored `ask` by the host\'s own permission gate, and the artefact '
      + 'under test predates `5ba002ae6`, which bounds that wait. A non-zero count here is the rig paying for a known '
      + 'and already-repaired defect, not a reading about D1.43',
    andTheCardIsUNCOUNTED:
      'measured on this artefact: with that card ON SCREEN and its Allow button clickable, every session\'s '
      + '`awaitingApprovalCount` read 0, so `lib/ask-user.ts`\'s `approvePermissionsWhile` — which gates on that '
      + 'count — never clicked and the turn wedged twice. This approver is deliberately count-independent for that '
      + 'reason, and the gap is a proposed row',
  })

  // ---- clause 1: the effort input ------------------------------------------
  const dump = readEnvDump(join(outputDir, PRE_TOOL_USE_ENV_FILE))
  run.observe('clause 1 — the PreToolUse hook child’s own env dump', {
    file: join(outputDir, PRE_TOOL_USE_ENV_FILE),
    invocations: dump?.invocations,
    names: dump?.names,
  })
  const hookRan = (dump?.invocations ?? 0) > 0
  run.check(
    'clause 1, THE CONTROL — the PreToolUse hook ran at all and its env dump carries `NESSY_EVENT`',
    hookRan && (dump?.names.includes('NESSY_EVENT') ?? false),
    `invocations=${dump?.invocations ?? 0}, names=${JSON.stringify(dump?.names ?? [])} — with no dump, an absent `
    + 'CLAUDE_EFFORT is a hook that never fired rather than a field the host does not forward, and the two must '
    + 'not share a verdict',
  )
  if (hookRan) {
    const claude = dump!.names.includes('CLAUDE_EFFORT')
    const nessy = dump!.names.includes('NESSY_EFFORT')
    run.check(
      'clause 1 — THE READING: a hook child on a session at a named effort level receives `CLAUDE_EFFORT`',
      claude,
      `the dump carries ${JSON.stringify(dump!.names)} — \`NESSY_EVENT\` is there, so the hook ran and the env was `
      + `built, and neither effort spelling reached it (CLAUDE_EFFORT=${claude}, NESSY_EFFORT=${nessy}) while the `
      + `session sat at \`${SESSION_LEVEL}\``,
    )
    run.check(
      'clause 1 — the fork\'s own `NESSY_EFFORT` spelling rides beside it',
      nessy === claude,
      `CLAUDE_EFFORT=${claude} and NESSY_EFFORT=${nessy}: the two spellings are written by adjacent lines of one `
      + 'function, so they disagreeing is a finding of its own',
    )
  }

  // ---- clause 2: terminalSequence, against its own sibling ------------------
  const text = transcriptText(messages)
  const systemSeen = text.includes(systemMarker)
  const oscSeen = text.includes(oscMarker)
  run.observe('clause 2 — the one SessionStart document, both halves', {
    systemMessageMarker: systemMarker,
    terminalSequenceMarker: oscMarker,
    systemMessageInTranscript: systemSeen,
    terminalSequenceInTranscript: oscSeen,
    infoRows: messages.filter(m => m.role === 'info').map(m => m.content.slice(0, 160)),
  })
  run.check(
    'clause 2, THE CONTROL — the hook’s `systemMessage` half reached the session as an `info` row',
    systemSeen,
    'the SessionStart hook prints ONE JSON document carrying both fields; with its systemMessage nowhere in the '
    + 'transcript the document was never produced or never parsed, and the terminalSequence half below would be '
    + 'an absence about the rig rather than about the product',
  )
  if (systemSeen) {
    run.check(
      'clause 2 — THE READING: the `terminalSequence` the same document carried reaches a session surface',
      oscSeen,
      `the systemMessage half of the same document is in the transcript and the terminalSequence half is not. The `
      + 'field passed the OSC allowlist by construction (OSC 9, which `allowlistedTerminalSequence` admits) and was '
      + 'merged into `universal`, so this is the host parsing a documented field and dropping it on the Pi path — '
      + 'which is what "enforced host-side and driven on Pi alone" asks about',
    )
  }

  // ---- clause 3: async ------------------------------------------------------
  const deadline = Date.now() + ASYNC_GRACE_MS
  let stamps = readAsyncStamps(join(outputDir, ASYNC_FILE))
  while (stamps.endedAt === undefined && Date.now() < deadline) {
    await Bun.sleep(1_000)
    stamps = readAsyncStamps(join(outputDir, ASYNC_FILE))
  }
  run.observe('clause 3 — the async hook’s own two stamps', {
    file: join(outputDir, ASYNC_FILE),
    lines: stamps.lines,
    startedAt: stamps.startedAt !== undefined ? new Date(stamps.startedAt).toISOString() : undefined,
    endedAt: stamps.endedAt !== undefined ? new Date(stamps.endedAt).toISOString() : undefined,
    turnEndedAt: new Date(turnEnd).toISOString(),
    sleepS: ASYNC_SLEEP_S,
  })
  run.check(
    'clause 3, THE CONTROL — the async hook ran and left BOTH stamps',
    stamps.startedAt !== undefined && stamps.endedAt !== undefined,
    `the file holds ${stamps.lines} line(s); with fewer than two the timing question has no subject and this case `
    + 'reports that rather than a verdict',
  )
  if (stamps.startedAt !== undefined && stamps.endedAt !== undefined) {
    run.check(
      'clause 3 — THE READING: an `async: true` hook does not block the turn (the turn ended before the hook did)',
      turnEnd < stamps.endedAt,
      `the turn's last message is ${new Date(turnEnd).toISOString()} and the hook finished at `
      + `${new Date(stamps.endedAt).toISOString()} — the turn ended AFTER the ${ASYNC_SLEEP_S} s hook, so on this `
      + 'build the flag did not take the hook off the turn\'s path',
    )
  }

  run.observe('THE ANSWER — D1.43\'s three clauses', {
    effortInput: hookRan ? (dump!.names.includes('CLAUDE_EFFORT') ? 'reaches the hook child' : 'does NOT reach the hook child') : 'unavailable — the hook left no dump',
    terminalSequence: systemSeen ? (oscSeen ? 'reaches a session surface' : 'parsed and dropped — nowhere in the session') : 'unavailable — the document was never produced',
    async: stamps.endedAt !== undefined ? (turnEnd < stamps.endedAt ? 'does not block the turn' : 'the turn waited for it') : 'unavailable — the hook left fewer than two stamps',
    asyncRewake: 'NOT driven here — see the header; a wake needs its own rig shape',
  })
  run.observe('load at the end', execFileSync('uptime', { encoding: 'utf8' }).trim())
}

if (import.meta.main) await main(ID, TITLE, drive)
