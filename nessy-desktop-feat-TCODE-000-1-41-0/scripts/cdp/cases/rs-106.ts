/**
 * RS-106 - SIT-11 surface B: the seven BUNDLED skills (`resources/skills/`), as
 * a case file instead of a hand drive (F1.148), with the negative control and
 * the seven-of-seven breadth F1.156 found missing.
 *
 * ## Why this case exists
 *
 * SIT-11 (2026-09-20, packaged 1.40.0) PASSED surface B on all three runtimes,
 * by hand, and its critic found two holes a PASS could not see
 * (P-SIT11-B2-CONTROL + P-SIT11-SKILL-BREADTH):
 *
 *  - **No negative control.** B2's evidence on claude and codex was
 *    `mcp__session__ReviewDiff` being called after `/code-review` - and that
 *    tool is on those surfaces WITH OR WITHOUT the skill, so nothing separated
 *    *the skill made the model call it* from *the model calls it for any
 *    review-shaped prompt*.
 *  - **Two of seven.** `loop`, `plugin-creator`, `security-review`, `simplify`
 *    and `skill-creator` were never invoked on any runtime.
 *
 * ## The arms
 *
 * B1. **The roster lists all seven, on every runtime the profile offers.** The
 *     DENOMINATOR is the repository's own `apps/electron/resources/skills/`
 *     (read at run time, never a list written here), and the reader is the slash
 *     palette RS-23 prescribes (`peekPalette`, one real character at a time). The
 *     CONTENT each later arm compares against is the APP's own synced copy under
 *     `<configDir>/skills/<name>/SKILL.md` - SIT-11 read the bundle list there
 *     byte for byte - so an artefact older than this tree is measured against
 *     what it ships, not against HEAD.
 * B2+B3. **One low-cost invocation per skill, each on a FRESH chat**, on the
 *     chosen runtime(s): the skill is SELECTED from the palette (a submit-on-select
 *     entry, measured by SIT-11: the command is sent alone), and a second turn
 *     asks the model to quote the first two sentences of the instructions it
 *     was given. The DETECTOR is a body-unique sentence: any six-word window of the
 *     SKILL.md BODY that occurs in neither its `description` (which the palette
 *     and `<available_skills>` show) nor the probe prompt - text only the loaded
 *     body can have supplied. A reply that paraphrases scores nothing; that is
 *     the price of a detector that cannot be satisfied by anything else.
 * NEG. **The negative control F1.156 asks for, twice.** A fresh chat with the
 *     SAME probe for `/code-review` and NO selection must quote nothing of any
 *     body (`code-review` carries `disable-model-invocation: true`, so the model
 *     cannot load it itself - the cleanest skill to hold the control). And the
 *     review-shaped prompt without the selection is sent on its own, and
 *     whether it calls `ReviewDiff` is RECORDED beside the positive arm's call:
 *     only `called with the skill && not called without it` lets `ReviewDiff`
 *     stand as evidence of the skill; otherwise the body sentence is the only
 *     evidence this case banks, and it says so.
 *
 * ## What it refuses to do
 *
 *  - **Run a skill against real work.** Every arm is bound to a scratch git
 *    repository the case mints (`scratchRepository`, RS-27's) carrying one
 *    two-line uncommitted change, so `/simplify` has only that to rewrite and
 *    `/code-review` and `/security-review` only that to read; the repository is
 *    removed in a `finally`.
 *  - **Leave a schedule behind.** `/loop` with no argument starts the built-in
 *    maintenance prompt through `CronCreate` where the runtime can schedule. Any
 *    arm whose invocation turn called a scheduling tool - the NEG arm's
 *    model-invocable probe too (F1.1201) - has its session DELETED at the end,
 *    and the call is recorded; whether a loop dies with its session is not asserted here.
 *  - **Score a turn that never settled as the skill failing.** A timeout on the
 *    invocation turn is recorded and the probe still runs - the body is loaded
 *    when the command is sent, not when the model finishes acting on it.
 *
 * ## How a probe is read (F1.877, SIT-z 2026-09-25)
 *
 * SIT-z re-scored this case's eight FAILs from the transcripts and found seven
 * were the instrument. Four repairs, each named where it acts:
 *
 *  - **The pane is the arm's.** `freshSession` said fresh while the pane still
 *    showed the previous arm's chat, so `/skill-creator` ran THERE. `openArm`
 *    now requires the selected session to be this arm's before anything is
 *    typed, and an invocation whose command never landed in this session is
 *    reported as that, not as a skill that failed to load.
 *  - **The probe waits for quiet.** A skill's background reviewer ends the
 *    invocation turn early and replies later; the probe is typed only after
 *    {@link PROBE_QUIET_MS} with nothing processing or queued.
 *  - **The probe reply is the rows after the probe's OWN user row**
 *    ({@link probeReplyRows}), read once the session is quiet again — never the
 *    send's `added`, which began before a follow-up turn that slipped in ahead
 *    of the probe.
 *  - **An interview skill holds the turn**, so its probe can never be typed:
 *    then the invocation's own replies are scored instead, and the check says
 *    it used that WEAKER detector ({@link scoredText}).
 *
 * And the widening WJ-crit-yy added: the NEG arm's `/code-review` sets
 * `disable-model-invocation: true`, so it cannot show a body arriving by the
 * model's OWN skill loading (F1.876's class). The same probe for the first
 * model-invocable bundled skill runs beside it and is RECORDED, not scored — a
 * model-side load is by design there, so the rows are the reading. It runs LAST
 * in that session, after the review-shaped prompt (F1.1201).
 *
 * `NESSY_CDP_RS106_FAMILIES` (comma list of `pi`, `claude`, `codex`) chooses the
 * runtime(s) for B2/B3/NEG; absent, the first of claude, codex, pi the profile
 * offers - F1.156 asks for "at least one runtime", and seven skills are fifteen
 * turns per runtime.
 */

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { scratchRepository } from './rs-27.ts'
import { sendPrompt, sendSlashCommand } from '../lib/chat.ts'
import { peekPalette } from '../lib/composer.ts'
import type { CdpSession } from '../lib/connect.ts'
import { waitUntilSettled } from '../lib/mid-stream.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { bindWorkingDirectory, listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import type { CaseMeta } from '../lib/sitting.ts'
import { activeSession, assertElectronApi, freshSession, transcript, type SessionKey, type TranscriptMessage } from '../lib/state.ts'
import { checkAbsence, positive, turnAnswered, turnRowsSince } from '../lib/turn-evidence.ts'
import { clickSelector } from '../lib/viewport.ts'

const ID = 'RS-106'
const TITLE = 'the seven bundled skills: listed on every runtime, and each one\'s BODY reaches the model when it is invoked'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'F1.148',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'owner: at least one card per runtime to be read (pi, claude-runtime, codex-runtime), already signed in. '
    + 'No key is read, printed or written. The only files written are a scratch git repository the case mints and removes.',
} as const satisfies CaseMeta

/** The repository's own bundled-skill directory - the DENOMINATOR, read at run time. */
export const BUNDLED_SKILLS_DIR = new URL('../../../apps/electron/resources/skills/', import.meta.url).pathname

/** Every bundled skill name, from the directory itself; never a list written here. */
export function bundledSkillNames(dir = BUNDLED_SKILLS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => {
      try { return readFileSync(join(dir, name, 'SKILL.md'), 'utf8').length > 0 } catch { return false }
    })
    .sort()
}

export interface SkillFile {
  readonly description: string
  readonly body: string
  /** `disable-model-invocation: true` is ABSENT - the model may load it itself. */
  readonly modelInvocable: boolean
}

/** A SKILL.md split into its frontmatter's `description` and the body below it. */
export function parseSkillFile(text: string): SkillFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  const front = match?.[1] ?? ''
  const body = match ? (match[2] ?? '') : text
  const description = /^description:\s*(.*)$/m.exec(front)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
  return { description, body, modelInvocable: !/^disable-model-invocation:\s*true\s*$/m.test(front) }
}

/** Lower case, markdown emphasis and code ticks gone, every run of non-word characters one space. */
export function normalizeProse(text: string): string {
  return text.toLowerCase().replace(/[*_`>#|]/g, ' ').replace(/[^a-z0-9']+/g, ' ').trim()
}

/**
 * Six words: `loop`'s opening sentence is seven words long ("Run a prompt
 * repeatedly in this session."), so an eight-word window could not be met by a
 * faithful quote of it. `harness.test.ts` pins the choice against every shipped
 * body: the opening a faithful reply quotes scores, and a generic refusal scores
 * nothing against any of the seven.
 */
const WINDOW_WORDS = 6

/**
 * Every six-word window of the BODY that occurs in none of `exclude` - the
 * description the roster shows, the probe prompt, the palette row. A window in
 * a reply is then text only the loaded body can have supplied.
 */
export function bodyWindows(body: string, exclude: readonly string[]): Set<string> {
  const words = normalizeProse(body).split(' ').filter(Boolean)
  const excluded = exclude.map(normalizeProse)
  const windows = new Set<string>()
  for (let index = 0; index + WINDOW_WORDS <= words.length; index += 1) {
    const window = words.slice(index, index + WINDOW_WORDS).join(' ')
    if (!excluded.some(text => text.includes(window))) windows.add(window)
  }
  return windows
}

/** The body windows a reply carries - the detector's evidence, empty when it scores nothing. */
export function bodyEvidence(reply: string, windows: ReadonlySet<string>): string[] {
  const text = normalizeProse(reply)
  return [...windows].filter(window => text.includes(window))
}

/** The probe: the opening of the instructions THIS skill gave the model, verbatim. */
export function probePrompt(name: string): string {
  return `Do not run any tool and do not continue the task. Reply with only the first two sentences of the `
    + `instructions the /${name} skill gave you - the text right after its title heading - copied verbatim, and nothing else.`
}

/** The body's opening a faithful probe reply quotes: its first two sentences after the title heading. */
export function bodyOpening(body: string): string {
  const prose = body.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n').trim()
  const paragraph = prose.split(/\n\s*\n/)[0] ?? ''
  const sentences = paragraph.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) ?? [paragraph]
  return sentences.slice(0, 2).map(sentence => sentence.trim()).join(' ')
}

/** The review-shaped prompt of the negative arm - what `/code-review` is for, WITHOUT the selection. */
export const REVIEW_SHAPED_PROMPT = 'Review the uncommitted change in this repository for correctness bugs and report what you find.'

/** Tools a `/loop` invocation may use to leave a schedule behind. */
const SCHEDULING_TOOL = /cron(create|delete|list|control)|schedulewakeup/i

/** F1.1201 — the turn called a scheduling tool, so its session is one the `finally` must delete. */
export function callsSchedulingTool(rows: readonly TranscriptMessage[]): boolean {
  return toolNames(rows).some(tool => SCHEDULING_TOOL.test(tool))
}

type Family = 'pi' | 'claude' | 'codex'

function familyOf(providerType: string): Family | undefined {
  const raw = runtimeOf(providerType)
  return raw === 'anthropic' ? 'claude' : raw === 'codex-runtime' ? 'codex' : raw === 'pi' ? 'pi' : undefined
}

function toolNames(rows: readonly TranscriptMessage[]): string[] {
  return [...new Set(rows.map(row => row.toolName).filter((name): name is string => typeof name === 'string'))]
}

function assistantText(rows: readonly TranscriptMessage[]): string {
  return rows.filter(row => row.role === 'assistant').map(row => row.content).join('\n')
}

/** Two texts the same once whitespace runs are one space — how a typed prompt reads back as its user row. */
function sameProse(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
}

/** F1.877 — how long the session must sit with nothing processing or queued before the probe is typed (SIT-z's `hand.ts`). */
export const PROBE_QUIET_MS = 10_000

/**
 * F1.877 — the probe's reply: the rows after the probe's OWN user row (the LAST
 * one carrying exactly `prompt`), up to the next user row. SIT-z's `rescore.ts`
 * instrument. `[]` when the probe row is not there — the probe was never typed.
 */
export function probeReplyRows(rows: readonly TranscriptMessage[], prompt: string): TranscriptMessage[] {
  let at = -1
  rows.forEach((row, index) => { if (row.role === 'user' && sameProse(row.content, prompt)) at = index })
  if (at < 0) return []
  const after = rows.slice(at + 1)
  const next = after.findIndex(row => row.role === 'user')
  return next < 0 ? after : after.slice(0, next)
}

/**
 * F1.877 — the text a skill arm is scored on, and which detector it came from.
 * The probe's reply when it has one; otherwise the INVOCATION's own assistant
 * replies — the fallback for a skill whose interview (or unfinished work) held
 * the turn so the probe could never be typed. A user row never counts.
 */
export function scoredText(
  probeRows: readonly TranscriptMessage[],
  invocationRows: readonly TranscriptMessage[],
): { detector: 'probe reply' | 'invocation replies (weaker: the probe was not answered)'; text: string } {
  const probe = assistantText(probeRows)
  if (probe.trim().length > 0) return { detector: 'probe reply', text: probe }
  return { detector: 'invocation replies (weaker: the probe was not answered)', text: assistantText(invocationRows) }
}

/**
 * F1.877 — the reason typing now would land in ANOTHER session, or `undefined`
 * when the selected session is this arm's. One resync click on the arm's own row
 * is allowed, the remedy `freshSession` itself uses.
 */
async function paneIsNot(session: CdpSession, key: SessionKey): Promise<string | undefined> {
  let seen = 'unread'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const active = await activeSession(session).then(
      found => `${found.via}:${found.sessionId}`,
      (cause: unknown) => `threw:${String(cause).slice(0, 120)}`,
    )
    if (active === `dom:${key.sessionId}`) return undefined
    seen = active
    await clickSelector(session, `.session-item[data-session-id="${key.sessionId}"]`).catch(() => undefined)
    await Bun.sleep(1_500)
  }
  return `the selected session reads ${seen}, not this arm's ${key.sessionId}: typing now would land in another `
    + 'conversation (SIT-z\'s pane-follow hazard)'
}

/** A fresh session on `card`, bound to `repo` - or the reason it is not. */
async function openArm(
  session: CdpSession,
  label: string,
  card: string,
  repo: string,
): Promise<{ key: SessionKey } | { reason: string }> {
  let key = await freshSession(session, `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`)
  if (!key.fresh) key = await freshSession(session, `CDP ${ID} ${label} retry ${new Date().toISOString().slice(11, 19)}`)
  if (!key.fresh) return { reason: `no fresh session after a retry (inherited ${key.inheritedMessages} messages)` }
  const bound = await switchRuntime(session, key.sessionId, card)
  if (!bound.ok) return { reason: `the session did not bind to ${card}: ${bound.error ?? 'no reason given'}` }
  const dir = await bindWorkingDirectory(session, key.sessionId, repo)
  if (!dir.bound) return { reason: `the scratch repository did not bind: reported ${JSON.stringify(dir.reported)}` }
  const pane = await paneIsNot(session, key)
  if (pane) return { reason: pane }
  return { key }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // ---- the denominator, and the app's own copy of each skill -------------
  const names = bundledSkillNames()
  run.observe('bundled skills (the denominator, from apps/electron/resources/skills/)', names)
  run.require('the denominator was read at all', names.length > 0, `nothing under ${BUNDLED_SKILLS_DIR}`)
  const skills = new Map<string, SkillFile>()
  for (const name of names) {
    const path = join(configDir(), 'skills', name, 'SKILL.md')
    let text = ''
    try { text = readFileSync(path, 'utf8') } catch { /* the check below says so */ }
    run.check(`the app synced ${name} into the profile`, text.length > 0, `${path} is absent or empty`)
    if (text.length > 0) skills.set(name, parseSkillFile(text))
  }

  // ---- the cards -----------------------------------------------------------
  const cards = new Map<Family, string>()
  for (const card of await listConnections(session)) {
    const family = familyOf(card.providerType)
    if (family && !cards.has(family)) cards.set(family, card.slug)
  }
  run.observe('the cards this profile offers', Object.fromEntries(cards))
  if (cards.size === 0) blocked('this profile lists no pi, claude-runtime or codex-runtime card')
  const wanted = (process.env.NESSY_CDP_RS106_FAMILIES ?? '').split(',').map(entry => entry.trim()).filter(Boolean)
  const chosen: Family[] = wanted.length > 0
    ? wanted.filter((family): family is Family => cards.has(family as Family))
    : (['claude', 'codex', 'pi'] as const).filter(family => cards.has(family)).slice(0, 1)
  run.observe('the runtime(s) the invocation arms run on', chosen)
  if (chosen.length === 0) blocked(`NESSY_CDP_RS106_FAMILIES=${wanted.join(',')} names no family this profile has a card for`)

  const repo = scratchRepository('rs106')
  writeFileSync(join(repo, 'sum.js'), 'export function sum(a, b) {\n  return a + b\n}\n', 'utf8')
  const scheduled: SessionKey[] = []
  try {
    // ---- B1: the roster, on every runtime the profile offers ---------------
    for (const [family, card] of cards) {
      const arm = await openArm(session, `roster ${family}`, card, repo)
      if ('reason' in arm) { run.check(`[${family}] B1 — a session to read the palette in`, false, arm.reason); continue }
      const missing: string[] = []
      for (const name of names) {
        const rows = await peekPalette(session, name).catch(() => [] as string[])
        if (!rows.some(text => new RegExp(`^/${name}(\\s|$)`).test(text.trim()))) missing.push(name)
      }
      run.check(`[${family}] B1 — the palette offers all ${names.length} bundled skills`, missing.length === 0,
        `missing from the palette: ${missing.join(', ')}`)
    }

    // A body-unique sentence the scratch change itself spells would be no detector at all.
    const repoText = readFileSync(join(repo, 'sum.js'), 'utf8')
    for (const family of chosen) {
      const card = cards.get(family)!
      let reviewDiffWithSkill: boolean | undefined

      // ---- B2 + B3: one fresh chat per skill --------------------------------
      for (const name of names) {
        const skill = skills.get(name)
        if (!skill) continue
        const arm = await openArm(session, `${family} ${name}`, card, repo)
        if ('reason' in arm) { run.check(`[${family}] /${name} — a fresh session to invoke it in`, false, arm.reason); continue }
        const { key } = arm
        const invocationBefore = (await transcript(session, key)).length // F1.551: where the invocation's rows start
        const invoked = await sendSlashCommand(session, key, {
          token: name,
          match: new RegExp(`^/${name}(\\s|$)`),
          expectComposer: '',
          submitOnSelect: true,
          timeoutMs: 240_000,
        }).then(result => ({ ok: true as const, result }), (cause: unknown) => ({ ok: false as const, error: String(cause).slice(0, 300) }))
        // F1.551: the invocation turn's OWN rows — its `added` when it settled, the rows
        // since its send when it threw — never the whole transcript.
        const invocationRows = await turnRowsSince(() => transcript(session, key), invoked.ok ? invoked.result.added ?? [] : [], invocationBefore)
        run.observe(`[${family}] /${name}: the invocation turn`, invoked.ok
          ? { chosen: invoked.result.selection.chosenText.slice(0, 80), tools: toolNames(invocationRows) }
          : { error: invoked.error, tools: toolNames(invocationRows) })
        if (!invoked.ok && /palette-(did-not-open|entry-not-found)/.test(invoked.error)) {
          run.check(`[${family}] /${name} — selectable from the palette`, false, invoked.error)
          continue
        }
        // F1.877 — a command that never reached THIS session is not a skill that
        // failed to load: SIT-z's `/skill-creator` ran in the previous arm's chat.
        if (invocationRows.length === 0) {
          run.check(`[${family}] /${name} — the command landed in this arm's own session`, false,
            `${key.sessionId} gained no row after the selection${invoked.ok ? '' : ` (${invoked.error})`}: the arm is `
            + 'INVALID, not a body that did not reach the model')
          continue
        }
        if (callsSchedulingTool(invocationRows)) scheduled.push(key)
        if (name === 'code-review') reviewDiffWithSkill = toolNames(invocationRows).some(tool => /reviewdiff/i.test(tool))

        const prompt = probePrompt(name)
        // F1.877 — quiet first (a background reviewer's follow-up turn must drain),
        // the arm's own pane, then the probe; its reply is the rows after its OWN
        // user row once the session is quiet again, never the send's `added`.
        const quiet = await waitUntilSettled(session, key, { quietMs: PROBE_QUIET_MS, timeoutMs: 120_000 })
        const pane = quiet.timedOut ? undefined : await paneIsNot(session, key)
        let probeRows: TranscriptMessage[] = []
        if (!quiet.timedOut && !pane) {
          await sendPrompt(session, key, prompt, 150_000).catch(() => undefined)
          await waitUntilSettled(session, key, { quietMs: PROBE_QUIET_MS, timeoutMs: 150_000 })
          probeRows = probeReplyRows(await transcript(session, key), prompt)
        }
        // The invocation's own rows as they stand now, cut at the probe's row when there is one.
        const invocationNow = await turnRowsSince(() => transcript(session, key), [], invocationBefore)
        const probeAt = invocationNow.findIndex(row => row.role === 'user' && sameProse(row.content, prompt))
        const scored = scoredText(probeRows, probeAt < 0 ? invocationNow : invocationNow.slice(0, probeAt))
        const windows = bodyWindows(skill.body, [skill.description, prompt, repoText])
        const evidence = bodyEvidence(scored.text, windows)
        run.observe(`[${family}] /${name}: the probe reply`, {
          detector: scored.detector,
          probe: quiet.timedOut ? `not typed: the session was still busy after ${quiet.settledAfterMs} ms` : pane ?? 'typed',
          reply: scored.text.slice(0, 240), bodyWindows: windows.size, evidence: evidence.slice(0, 3),
        })
        run.check(
          `[${family}] /${name} — its BODY reached the model on a fresh chat (a body-unique sentence in the reply)`,
          evidence.length > 0,
          `scored on the ${scored.detector}: it quotes no six-word window of the ${name} body (${windows.size} `
          + `candidate windows): ${JSON.stringify(scored.text.slice(0, 200))} — a paraphrase scores nothing by design; `
          + 'read the reply before reading this as the skill not loading',
        )
      }

      // ---- NEG: the same probe, and the review-shaped prompt, WITHOUT the selection --
      const codeReview = skills.get('code-review')
      if (codeReview) {
        const neg = await openArm(session, `${family} negative`, card, repo)
        if ('reason' in neg) {
          run.check(`[${family}] NEG — a fresh session for the negative control`, false, neg.reason)
        } else {
          const prompt = probePrompt('code-review')
          const probe = await sendPrompt(session, neg.key, prompt, 150_000).catch(() => undefined)
          const reply = probe ? assistantText(probe.added) : ''
          const leaked = [...skills].flatMap(([name, skill]) =>
            bodyEvidence(reply, bodyWindows(skill.body, [skill.description, prompt, repoText])).map(window => `${name}: ${window}`))
          run.observe(`[${family}] NEG: the probe with NO selection`, { reply: reply.slice(0, 240), leaked: leaked.slice(0, 3) })
          // F1.504 — an EMPTY reply quotes nothing too; the probe must have answered.
          checkAbsence(
            run,
            `[${family}] NEG — without the selection the same probe quotes nothing of any bundled body`,
            leaked.length === 0,
            probe === undefined
              ? positive(false, 'answer', 'the negative probe turn did not settle - the control is UNAVAILABLE, not passed')
              : turnAnswered(probe.added),
            `the reply quotes body text with no skill selected: ${leaked.slice(0, 2).join(' | ')} - the detector would then prove nothing`,
          )
          const review = await sendPrompt(session, neg.key, REVIEW_SHAPED_PROMPT, 240_000).catch(() => undefined)
          const reviewDiffWithout = toolNames(review?.added ?? []).some(tool => /reviewdiff/i.test(tool))
          run.observe(`[${family}] NEG: does ReviewDiff separate the skill from any review-shaped prompt`, {
            withSkill: reviewDiffWithSkill ?? 'not measured',
            withoutSkill: review ? reviewDiffWithout : 'the review-shaped turn did not settle',
            verdict: reviewDiffWithSkill === true && review !== undefined && !reviewDiffWithout
              ? 'separates - ReviewDiff may stand as evidence of the skill on this runtime'
              : 'does NOT separate - only the body-unique sentence is evidence of the skill on this runtime',
          })
          // F1.877 (widened) — `code-review` cannot be loaded by the model, so the
          // check above cannot see a body arriving by the model's OWN skill loading
          // (F1.876's class). The first model-invocable skill, the same probe, no
          // selection: RECORDED, because a model-side load is by design for it.
          // F1.1201 — sent AFTER the review-shaped reading (a loaded body or a
          // started loop must not precede it), and a session it scheduled from is
          // deleted in the `finally` like any skill arm's: with today's bundle the
          // first invocable skill is `loop` (sorted names, `code-review` opts out).
          const invocable = [...skills].find(([, entry]) => entry.modelInvocable)
          if (invocable) {
            const [invocableName, invocableSkill] = invocable
            const invocablePrompt = probePrompt(invocableName)
            const invocableBefore = (await transcript(session, neg.key)).length
            const invocableProbe = await sendPrompt(session, neg.key, invocablePrompt, 150_000).catch(() => undefined)
            // F1.1201 — the rows since its own send when it did not settle: a loop it started still counts.
            const invocableRows = await turnRowsSince(() => transcript(session, neg.key), invocableProbe?.added ?? [], invocableBefore)
            run.observe(`[${family}] NEG: the same probe for model-invocable /${invocableName}, no selection (recorded, not scored)`, {
              leaked: bodyEvidence(assistantText(invocableRows), bodyWindows(invocableSkill.body, [invocableSkill.description, invocablePrompt, repoText])).slice(0, 3),
              tools: toolNames(invocableRows),
              answered: invocableProbe === undefined ? 'the turn did not settle' : turnAnswered(invocableRows).ok,
            })
            if (callsSchedulingTool(invocableRows)) scheduled.push(neg.key)
          }
        }
      }
    }
  } finally {
    for (const key of scheduled) {
      run.observe('cleanup — a session whose /loop turn called a scheduling tool, deleted', await session.call(`
        try { await window.electronAPI.deleteSession(${JSON.stringify(key.sessionId)}); return 'deleted' }
        catch (e) { return 'threw: ' + String(e).slice(0, 200) }
      `).catch((cause: unknown) => `threw: ${String(cause).slice(0, 200)}`))
    }
    rmSync(repo, { recursive: true, force: true })
  }
}

if (import.meta.main) await main(ID, TITLE, drive)
