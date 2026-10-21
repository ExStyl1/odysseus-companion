/**
 * RS-17 (P6.265) — what a compaction CARRIES on each runtime: which files come
 * back, in what form, and whether the summary request inherits the session's
 * thinking budget.
 *
 * Two denominator cells (E7, E9) closed by ONE rig, which is why the row insists
 * they are one lane: the same `/compact` on the same three sessions answers both,
 * and separating them triples a setup that is most of the cost.
 *
 * ## Why nothing here can be read from our source
 *
 * The row's native-mechanism clause for E7, verbatim: *"compaction is NATIVE on
 * all three (the Pi SDK, the Claude binary, codex's `thread/compact/start`), so
 * each runtime's own compactor may or may not re-read. Reading host source
 * cannot answer it."* And for E9: *"the SDK does it itself per the page — 'As of
 * v2.1.198, the summarization request inherits your session's extended thinking
 * configuration, so it reasons with thinking enabled when your session has it
 * enabled and stays off otherwise' — so nothing to build IF our session config
 * reaches it."* Both halves are claims about three closed compactors; only a run
 * settles them.
 *
 * ## The one clause a careless rig gets wrong
 *
 * The row spells it: *"at least one of them over 5 000 tokens (the boundary
 * clause — a rig of small files reports a false `covered`)"*. A compactor that
 * carries five small files back verbatim and degrades a large one to a path
 * reference looks identical to a compactor that always carries content — unless
 * one file crosses the boundary. Six files of DIFFERING MTIME, one of them large,
 * is not decoration; it is the whole experiment.
 *
 * ## The residue this rig must not misread
 *
 * `createSummaryAgent` passes no effort/thinking key — and that call site is the
 * runtime-TRANSFER summary (`summarySessionKey.sessionId` ends
 * `-remote-transfer-summary`), NOT the compactor. **No compaction verdict may be
 * read from it.** A sitting that quotes that absence as the E9 answer would be
 * quoting the wrong function; the row records the trap explicitly.
 *
 * ## The detector: the runtime's own session file
 *
 * A packaged build writes no application log, so a `[session] …` line is not
 * available and its absence is not evidence. What IS written is the runtime's own
 * transcript — `<session>/.pi-sessions/*.jsonl` for Pi, the SDK's
 * `<workspace>/claude-config/projects/…/*.jsonl` for claude — and
 * `scripts/cdp/lib/runtime-session-log.ts` reads both. That is where the
 * post-compaction entry lives, where the file references live, and where a
 * thinking block on the summary turn either is or is not.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { approvePermissionsWhile, requireApproverSaw } from '../lib/ask-user.ts'
import { resolveAppUnderTest } from '../lib/bundle.ts'
import { sendPrompt, sendSlashCommand } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  bindProject, listConnections, runtimeOf, switchRuntime, trustScratchProject, waitForConnection,
} from '../lib/runtime-switch.ts'
import { readCodexSessionLog } from '../lib/codex-session-log.ts'
import {
  readClaudeSessionLog, readPiSessionLog, type RuntimeSessionEntry,
} from '../lib/runtime-session-log.ts'
import {
  assertElectronApi, freshSession, sessionCommand, transcript, type SessionKey,
} from '../lib/state.ts'

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-17'
const TITLE = 'what a compaction carries per runtime — which files return, in what form, and whether the summary request inherits the thinking budget'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.265',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'owner: one card per runtime. The card is named in the run notes; no key is read.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. Build the fixture project OUTSIDE any config dir — six text files in one directory, written one at a time so their mtimes differ, and at least ONE of them over 5 000 tokens (roughly 20 KB of prose; check it rather than assuming). Give every file a distinct marker line so a returned file can be told from a paraphrase of it.',
    '2. PACKAGED build, dark theme, one content panel. New session on the runtime under test, working directory set to the fixture project.',
    '3. Set the session thinking level to a level that reasons (`sessionCommand(id, { type: "setThinkingLevel", level: "high" })`). Record it.',
    '4. Ask the agent to read all six files, one turn, naming them explicitly: "Read these six files and summarise each in one sentence: <the six absolute paths>." Confirm six read-tool entries in the transcript — a rig where only four were read cannot answer "which files come back".',
    '5. Note the byte offset / entry count of the runtime session file BEFORE compacting (`readPiSessionLog` / `readClaudeSessionLog` in `scripts/cdp/lib/runtime-session-log.ts`), so everything scored afterwards is what THIS compaction added.',
    '6. Fire `/compact` from the palette — typed one character at a time, selected with the arrow keys and Enter, `submitOnSelect: true` (it acts on selection and leaves the composer empty). Wait for the compaction to settle.',
    '7. Read the runtime session file again. Record, for this runtime: how many of the six paths appear after the boundary; and for each, in what FORM — the file\'s own marker line (content carried) or a bare path / "Referenced file" style reference (a pointer carried). The two are different answers and the row asks for both.',
    '8. E9: in the same post-boundary window, record whether the SUMMARY turn reasons — a thinking/reasoning block on the summarisation request. On claude this is visible in the SDK transcript; on Pi and codex record what their own session file carries and say plainly if it carries nothing (a null is a finding, not a gap in the run).',
    '9. CONTROL A — a session that compacts with ZERO files read: same runtime, new session, one prose turn, `/compact`. No path may come back. Without it, a path appearing after the boundary cannot be attributed to the compactor rather than to the session\'s ordinary context.',
    '10. CONTROL B — the same rig with thinking OFF (`setThinkingLevel` to `off`), compacted the same way. The summary turn must NOT reason. Without it, "the summary reasoned" is indistinguishable from "this runtime always reasons".',
    '11. Repeat 2–10 per runtime. Three runtimes, two controls each.',
  ],
  expected: 'Per runtime: a count of how many of the six files return and the FORM each returns in (content vs path reference), plus a yes/no on the summary request reasoning. Control A returns zero paths; control B does not reason.',
  detector: 'the runtime\'s own session file — `<session>/.pi-sessions/*.jsonl` (Pi) and `<workspace>/claude-config/projects/…/*.jsonl` (claude), both read by `scripts/cdp/lib/runtime-session-log.ts` — compared BEFORE and AFTER the boundary so only this compaction is scored. Never the app log: a packaged build writes none, and an empty one is not evidence.',
  positiveControl: 'A: a session compacted with zero files read, where no path may return. B: the same session with thinking off, where the summary must not reason. And the boundary clause is itself a control — one of the six files must exceed 5 000 tokens or a compactor that degrades large files reports a false `covered`.',
  doneMeans: 'one rig reads six files of differing mtime, at least one of them over 5 000 tokens (the boundary clause — a rig of small files reports a false `covered`), fires `/compact` on each runtime, and records per runtime how many paths return and in what FORM (content vs `Referenced file` path reference), plus whether the summary turn reasons when the session has thinking enabled; controls — a session that compacts with 0 files read, and the same session with thinking off.',
  doNotRead: 'Do NOT read the E9 answer off `createSummaryAgent`\'s argument list: that call site is the runtime-TRANSFER summary (`…-remote-transfer-summary`), not the compactor. The row records this trap because the absence there is real and irrelevant.',
} as const satisfies SittingRecipe

/**
 * The six fixture files, built OUTSIDE any config dir, one at a time so their
 * mtimes differ, and ONE of them over the row's 5 000-token boundary.
 *
 * The boundary is not decoration: *"a rig of small files reports a false
 * `covered`"*. A compactor that carries five small files back verbatim and
 * degrades a large one to a path reference is indistinguishable from one that
 * always carries content unless a file crosses it. `BIG_WORDS` is sized in
 * WORDS and the byte size is asserted at build time rather than assumed, because
 * "roughly 20 KB of prose" is the recipe's own estimate and an estimate is not a
 * reading.
 */
interface FixtureFile { path: string; marker: string; bytes: number }

function buildFixture(root: string): FixtureFile[] {
  const files: FixtureFile[] = []
  for (let index = 1; index <= 6; index += 1) {
    const marker = `RS17-MARKER-${index}-${Math.random().toString(16).slice(2, 10).toUpperCase()}`
    const big = index === 3
    const body = big
      // ~6 500 words of deterministic prose: comfortably past 5 000 tokens, and
      // distinct enough per line that a paraphrase cannot be mistaken for the file.
      ? Array.from({ length: 650 }, (_, line) =>
        `line ${line} of the large fixture file: quantities of prose exist here only so that this file `
        + 'crosses the boundary the row names, and each line differs so a paraphrase cannot pass for it.')
        .join('\n')
      : `a small fixture file, number ${index}, whose whole content is one paragraph.`
    const path = join(root, big ? `large-${index}.txt` : `small-${index}.txt`)
    writeFileSync(path, `${marker}\n${body}\n`, 'utf8')
    files.push({ path, marker, bytes: Buffer.byteLength(`${marker}\n${body}\n`) })
  }
  return files
}

/**
 * FILLER files, which exist for one reason: to push a session PAST Pi's own
 * compaction floor without touching any of the six the row is about.
 *
 * The lever has to be sized against the mechanism, and the mechanism was read
 * out of the shipped bundle rather than guessed at (2026-09-12, W19-r, Pi
 * **0.84.3**, both in `node_modules/@earendil-works/pi-coding-agent/dist/core/
 * compaction/compaction.js` and in the packaged
 * `Contents/Resources/app/resources/pi-agent-server/index.js`, where
 * `keepRecentTokens ?? 20000` and `Nothing to compact (session too small)` each
 * occur — instrument `grep -ao … | wc -l`):
 *
 * - `prepareCompaction` returns `undefined` — and `compact()` then throws
 *   `Nothing to compact (session too small)` — when `messagesToSummarize` AND
 *   `turnPrefixMessages` are both empty;
 * - that happens when `findCutPoint`'s backward walk never accumulates
 *   `keepRecentTokens` (20 000), because `cutIndex` then stays at `cutPoints[0]`
 *   — the FIRST context message — leaving nothing in front of the cut;
 * - `estimateTokens` counts CHARACTERS / 4 over `user`, `assistant`,
 *   `toolResult`, `custom` and `bashExecution` messages. **A `toolResult`
 *   counts**, which is what makes a file read the cheapest lever there is.
 *
 * So the floor is ~**80 000 characters of transcript**, and the single biggest
 * unit a turn can add is one Read tool result, capped by `DEFAULT_MAX_BYTES`
 * (50 KB, `core/tools/truncate.js`; the minified `51200` occurs 8 times in the
 * packaged bundle). One 48 KB read is ~12 000 estimated tokens, so two or three
 * of them cross it while one does not.
 *
 * **Why a filler and not a re-read of `large-3`.** Measured twice (R1 and R7,
 * 2026-09-12): eight fill turns of *"read it again and quote line N"* left the
 * session at 6 % full and `/compact` refused for the fourth time. A model that
 * has the file in context answers from context — the turn costs a sentence, not
 * a tool result. A file the session has NEVER seen cannot be answered from
 * context, so the read really happens and the 48 KB really lands in the
 * transcript. They live in their own subdirectory so `formOf` can never confuse
 * one with the six the row asks about.
 *
 * ## HOW MANY FILLERS — measured 2026-09-12 (W19-r relaunch), and the obvious
 * ## arithmetic is WRONG
 *
 * *"Each fill adds a 48.5 KB tool result, so N fills add N x 48.5 KB"* is the
 * premise this lever was written on, and it holds for the FIRST read only. A run
 * with the six fixture files read AND three fillers read — every one of the nine
 * confirmed present, `RS17-FILL-1..3` and `RS17-MARKER-1..6` each occurring twice
 * in the thread, across 7 `read` and 3 `bash` tool calls — left Pi's own thread at
 * **70 789 characters over 26 entries**, of which exactly **ONE** line is 48 511
 * bytes and the next longest is **2 528**. So only one full-size tool result is
 * retained; the rest are present by marker and not by body.
 *
 * 70 789 / 4 = **17 697 estimated tokens against the 20 000 floor** — short by
 * ~2 300 tokens, i.e. ~9 200 characters, which is why that run was still answered
 * `Nothing to compact (session too small)` with the UI reading `7% full`. Two
 * fills gave the same refusal; the predecessor's apparent crossing at three fills
 * was an AUTO-compaction notice (*"Compacted context to fit within limits"*),
 * which is a DIFFERENT gate from the manual `/compact` floor and must not be read
 * as one.
 *
 * **So size the fill by the thread, not by the file.** The instrument is the
 * runtime's own session file, not the percentage the UI shows and not the byte
 * size of the fixtures:
 *
 * ```sh
 * wc -c < "<session>/.pi-sessions/<newest>.jsonl"   # needs to exceed ~80 000
 * ```
 *
 * A re-drive should raise `NESSY_CDP_COMPACT_FILL_TURNS` until that number passes
 * 80 000 and say what it measured, rather than trusting a count of turns.
 */
function buildFillers(root: string, count: number): FixtureFile[] {
  if (count <= 0) return []
  const dir = join(root, 'fill')
  mkdirSync(dir, { recursive: true })
  const fillers: FixtureFile[] = []
  for (let index = 1; index <= count; index += 1) {
    const marker = `RS17-FILL-${index}-${Math.random().toString(16).slice(2, 10).toUpperCase()}`
    // ~48 KB: under the 50 KB read cap, so the whole file lands in the tool
    // result and the size is a reading rather than a post-truncation guess.
    const body = Array.from({ length: 340 }, (_, line) =>
      `filler ${index} line ${line}: this file exists only to carry characters into the transcript so the `
      + 'session crosses the compaction floor, and every line differs so nothing here can be paraphrased.')
      .join('\n')
    const path = join(dir, `filler-${index}.txt`)
    writeFileSync(path, `${marker}\n${body}\n`, 'utf8')
    fillers.push({ path, marker, bytes: Buffer.byteLength(`${marker}\n${body}\n`) })
  }
  return fillers
}

/**
 * The runtime's own session file, read through the reader that knows that shape —
 * and each of the three needs a KEY the case has to supply.
 *
 * Both corrections here were measured on this case, on the packaged 1.36.0 (HEAD
 * `70d269e46`), 2026-09-12 (R6a), and both of them read as a product absence:
 *
 * - **claude.** This case sets a working directory, so the SDK slugifies THAT
 *   and not the session storage path, and a session-id-keyed read matched
 *   nothing: `no-claude-transcript-for-session` about a 297 KB transcript on
 *   disk. `cwd` is now passed, which `readClaudeSessionLog` tries only after the
 *   session-id key comes up empty.
 * - **codex.** The fall-through sent the codex arm to `readPiSessionLog`, which
 *   correctly found no `.pi-sessions` (no Pi turn ran) and answered
 *   `no-pi-sidecar`. Codex writes a rollout under its per-session `CODEX_HOME`
 *   and {@link readCodexSessionLog} reads it, keyed by the SESSION ID with the
 *   `cwd` as the secondary — the home is `mkdtemp`ed, so its name attributes it
 *   to nobody and two or three packaged instances share this rig's temp dir.
 *   (The key was the `cwd` ALONE until C3.367 collapsed two readers written from
 *   one measurement into one: the app-server's cwd is the WORKSPACE root, shared
 *   by every session in it, so it cannot tell two of this app's own sessions
 *   apart.)
 *
 * What each miss COST is the thing to carry away: every reading downstream came
 * back 0, and CONTROL A ("a compaction with zero files read returns no path")
 * PASSED, because no path can leak out of an empty log. A control whose two arms
 * agree is a deleted test that still runs green.
 */
function runtimeLog(
  runtime: string,
  key: SessionKey,
  cwd: string,
): { entries: RuntimeSessionEntry[]; file?: string; reason?: string } {
  if (runtime === 'claude') return readClaudeSessionLog(key.workspaceId, undefined, key.sessionId, cwd)
  if (runtime === 'codex') return readCodexSessionLog(key, { cwd })
  return readPiSessionLog(key)
}

/**
 * What a file's return LOOKS like, in the two forms the row asks to be told apart.
 *
 * `content` is the file's own marker line coming back — the compactor carried the
 * text. `reference` is the path without the marker — the compactor carried a
 * pointer. Neither is scored as better; the row asks which it is.
 */
type ReturnForm = 'content' | 'reference' | 'absent'

function formOf(window: string, file: FixtureFile): ReturnForm {
  if (window.includes(file.marker)) return 'content'
  if (window.includes(file.path)) return 'reference'
  return 'absent'
}

/** Does this window carry a reasoning/thinking block at all? */
function reasoningIn(entries: RuntimeSessionEntry[]): { found: boolean; kinds: string[] } {
  const kinds = new Set<string>()
  for (const entry of entries) {
    const raw = JSON.stringify(entry.raw)
    for (const needle of ['"thinking"', '"reasoning"', '"redacted_thinking"', '"thinkingSignature"', '"encrypted_content"']) {
      if (raw.includes(needle)) kinds.add(needle.replaceAll('"', ''))
    }
  }
  return { found: kinds.size > 0, kinds: [...kinds] }
}

/**
 * Did the runtime DECLINE the compaction, and say so?
 *
 * `added: 0` in the runtime's own session file is ambiguous between *"the
 * compactor carried nothing back"* and *"no compaction happened"*, and the two
 * are different answers to E7. Measured 2026-09-12 (R1) on the packaged build:
 * Pi answers a manual `/compact` below its own floor with a transcript `error`
 * row reading `Nothing to compact (session too small)` — a string that lives in
 * the Pi SDK and in no file of this repo, so it is the SDK's own floor and not
 * ours. Reading it is what turns a silent zero into a named verdict.
 */
async function declineNotice(session: CdpSession, key: SessionKey, since: number): Promise<string | undefined> {
  // F1.562 — the rows since THIS /compact (`since` is the count taken just before it),
  // not the session's last six, which a filler turn's reply could reach.
  const added = (await transcript(session, key)).slice(since)
  for (const message of added.reverse()) {
    const text = String(message.content ?? '')
    if (/nothing to compact|too small|cannot compact|no compaction/i.test(text)) return text.slice(0, 200)
  }
  return undefined
}

async function compact(session: CdpSession, key: SessionKey, run: CaseRun, label: string): Promise<string> {
  try {
    // `/compact` acts on SELECTION and leaves the composer empty —
    // `slash-command-actions.ts` splits the prefill commands from the immediate
    // ones and only `subtask` prefills. `sendSlashCommand` is the helper that
    // knows both halves, and `noWait` is deliberate: a compaction adds no
    // assistant message, so waiting for a turn waits for something that never
    // comes. The instrument is the runtime's own file below.
    const sent = await sendSlashCommand(session, key, {
      token: 'compact', match: /compact/i, expectComposer: '', submitOnSelect: true, noWait: true,
    })
    run.observe(`${label}: /compact selected from the palette`, sent.selection.chosenText)
  } catch (error) {
    return `refused: ${String(error)}`
  }
  // The compaction is not a turn: it does not add an assistant message and the
  // composer is already empty, so there is nothing to wait for on the screen.
  // The instrument is the runtime's own file, and the wait is for it to GROW.
  return 'fired'
}

const RUNTIME_WANTED = (process.env.NESSY_CDP_COMPACT_RUNTIMES ?? 'pi,claude,codex')
  .split(',').map(name => name.trim()).filter(Boolean)

/**
 * Push a session past the runtime's compaction floor, one unseen 48 KB file per
 * turn, and say how far it got.
 *
 * Default OFF (`NESSY_CDP_COMPACT_FILL_TURNS` unset), because claude and codex
 * crossed their own floors on the six fixture files alone (R6a, 2026-09-12,
 * PASS on both) and a fill they do not need would change an arm that already
 * answered. It is the Pi arm that needs it.
 *
 * **Both CONTROLS get the same fill, and that is the point rather than a
 * convenience.** Control A compacts a session that has read none of the six;
 * control B compacts the same rig with thinking off. On Pi a session that small
 * is ALWAYS under the floor, so before this both controls could only ever be
 * refused — and R7 measured exactly that, twice, with both of them scoring
 * green against their own declined compactions. A control that cannot reach the
 * behaviour it controls is not a weak control; it is an absent one.
 */
async function fillToFloor(
  session: CdpSession,
  key: SessionKey,
  run: CaseRun,
  label: string,
  fillers: FixtureFile[],
): Promise<void> {
  if (fillers.length === 0) return
  for (const [index, filler] of fillers.entries()) {
    const filled = await sendPrompt(session, key,
      `Please read ${filler.path} and reply with only its first line.`, 300_000)
      .then(result => result.messages.length).catch(error => `failed: ${String(error)}`)
    run.observe(`${label}: fill turn ${index + 1} of ${fillers.length} (${filler.bytes} bytes)`, filled)
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const app = resolveAppUnderTest(session)
  run.observe('app under test', { kind: app.kind, via: app.via })
  run.check('the artefact under test is the PACKAGED app', app.kind === 'packaged',
    app.kind === 'packaged' ? undefined : `kind=${app.kind} — a dev build is not the shipped artefact`)

  const connections = await listConnections(session)
  const cards: Array<[string, string | undefined]> = [
    ['pi', connections.find(row => runtimeOf(row.providerType) === 'pi')?.slug],
    ['claude', connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug],
    ['codex', connections.find(row => runtimeOf(row.providerType) === 'codex-runtime')?.slug],
  ]
  run.observe('cards', Object.fromEntries(cards))
  const selected = cards.filter(([name]) => RUNTIME_WANTED.includes(name))
  if (selected.length === 0) blocked(`NESSY_CDP_COMPACT_RUNTIMES=${RUNTIME_WANTED.join(',')} names no runtime family`)

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-rs17-')))
  const files = buildFixture(root)
  const fillTurns = Number(process.env.NESSY_CDP_COMPACT_FILL_TURNS ?? '0')
  const fillers = buildFillers(root, Number.isFinite(fillTurns) ? fillTurns : 0)
  if (fillers.length > 0) {
    run.observe('fill files (unseen, one read per turn, subject AND both controls)',
      fillers.map(file => ({ path: file.path, bytes: file.bytes })))
  }
  const big = files.find(file => file.bytes > 20_000)
  run.observe('fixture', files.map(file => ({ path: file.path, bytes: file.bytes })))
  run.check('THE BOUNDARY CLAUSE — one fixture file is over 5 000 tokens',
    big !== undefined,
    'every file is small, and a compactor that degrades large files to a path reference would report a '
    + 'false `covered` on this rig. The row names this as the clause a careless rig gets wrong.')

  try {
    for (const [runtime, card] of selected) {
      if (!card) {
        run.observe(`${runtime}: no card on this host`, 'arm skipped — recorded as unmeasured, never as a pass')
        continue
      }

      // ---------- THE SUBJECT: six files read, thinking ON, then /compact -----
      const key = await freshSession(session, `CDP RS-17 ${runtime} ${new Date().toISOString().slice(11, 19)}`)
      run.check(`${runtime}: ran in a session it created`, key.fresh,
        key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
      await switchRuntime(session, key.sessionId, card)
      run.require(`${runtime}: the session runs on ${card}`,
        (await waitForConnection(session, key.sessionId, card)) === card, card)
      await bindProject(run, session, key.sessionId, root, {
        label: runtime, gate: () => trustScratchProject(session, root),
      })
      const thinking = await sessionCommand(session, key.sessionId, { type: 'setThinkingLevel', level: 'high' })
        .then(() => 'high').catch(error => `refused: ${String(error)}`)
      run.observe(`${runtime}: thinking level`, thinking)

      const approver = approvePermissionsWhile(session, key.sessionId)
      let readTurn = ''
      try {
        // ONE LINE, and the reason is measured: a newline typed into the composer
        // SUBMITS. `lib/keys.ts` dispatches real key events, Enter is Enter, and a
        // six-line prompt went out as its first line — the run died with
        // `composer-mismatch` naming the whole text it meant to send (R1,
        // 2026-09-12). Every multi-path prompt in this harness has to be one line.
        readTurn = await sendPrompt(session, key,
          'Please read these six files and summarise each in one sentence: '
          + files.map(file => file.path).join(' , '), 300_000)
          .then(turn => `${turn.messages.length} messages`).catch(error => `failed: ${String(error)}`)
      } finally {
        run.observe(`${runtime}: approvals during the read turn`, await approver.stop())
      }
      // D1.356 — the subject arm is "six files were read, then the compaction
      // summarised them"; a card this approver could not see stops the reads and
      // the summary window then carries nothing, which this case would score as
      // the runtime not reasoning.
      requireApproverSaw(run, approver, `${runtime}: the read turn`)
      run.observe(`${runtime}: the read turn`, readTurn)

      // The row's six files are not necessarily ENOUGH, and that is a reading
      // rather than a guess: measured 2026-09-12 (R1), six files with one of
      // ~91 KB left a Pi session at **5 % full** and `/compact` answered
      // `Nothing to compact (session too small)` twice. The README's AGT-9 lever
      // (`NESSY_AUTO_COMPACT_WINDOW=90000`) did not move that percentage either,
      // because it narrows the AUTO threshold and the manual floor is the SDK's
      // own. So the fill is a knob, default off: a run that needs to cross a
      // runtime's floor re-reads the LARGE file N more times and says it did.
      //
      // WHAT PI'S FLOOR ACTUALLY IS, read out of the vendored SDK 2026-09-12
      // (R7) rather than guessed at, because the number decides how many fill
      // turns are enough. `agent-session.js` `compact()` throws
      // `Nothing to compact (session too small)` exactly when `prepareCompaction`
      // returns `undefined`, and that happens when `findCutPoint` — walking the
      // entries BACKWARDS and accumulating until it reaches
      // `settings.keepRecentTokens` — never gets past the first cut point, so
      // there is nothing left in front of the cut to summarise.
      // `DEFAULT_COMPACTION_SETTINGS` is `{ enabled: true, reserveTokens: 16384,
      // keepRecentTokens: 20000 }` and `settings-manager.js` reads
      // `compaction?.keepRecentTokens ?? 20000`.
      //
      // The trap inside that number: `estimateTokens` counts CHARACTERS of the
      // messages (`Math.ceil(chars / 4)`) and nothing else, while the app's own
      // "N % full" is the PROVIDER's usage — which carries the base context, the
      // tool schemas and the system prompt. The two are not the same quantity,
      // and that is why a session reading 5 % of a 524 000-token window was
      // still "too small": its MESSAGES were nowhere near 20 000 estimated
      // tokens. So size a fill in transcript CHARACTERS (~80 KB per 20 000
      // tokens, tool results included), never in the percentage the UI shows.
      //
      // The fill is now a read of a file the session has NEVER seen (see
      // {@link buildFillers}); re-reading `large-3` was the lever that failed
      // four times across two lanes because a model answers from context.
      await fillToFloor(session, key, run, runtime, fillers)

      const beforeLog = runtimeLog(runtime, key, root)
      const beforeCount = beforeLog.entries.length
      run.observe(`${runtime}: the runtime's own session file BEFORE`, {
        file: beforeLog.file, entries: beforeCount, reason: beforeLog.reason,
      })
      const readsSeen = files.filter(file => beforeLog.entries.some(entry =>
        entry.text.includes(file.path) || JSON.stringify(entry.raw).includes(file.path))).length
      run.check(`${runtime}: the rig actually read all six files`, readsSeen === 6,
        `${readsSeen} of 6 paths appear in the session file before compaction — a rig where only some were `
        + 'read cannot answer "which files come back"')

      const rowsBeforeCompact = (await transcript(session, key)).length
      run.observe(`${runtime}: /compact`, await compact(session, key, run, runtime))
      await Bun.sleep(30_000)
      const afterLog = runtimeLog(runtime, key, root)
      const added = afterLog.entries.slice(beforeCount)
      const window = added.map(entry => `${entry.text}\n${JSON.stringify(entry.raw)}`).join('\n')
      run.observe(`${runtime}: the session file AFTER`, {
        entries: afterLog.entries.length, added: added.length,
      })

      const forms = Object.fromEntries(files.map(file => [file.path.split('/').pop(), formOf(window, file)]))
      const returned = Object.values(forms).filter(form => form !== 'absent').length
      run.observe(`${runtime}: E7 — how many of the six came back, and in what FORM`, { returned, forms })

      const reasoning = reasoningIn(added)
      run.observe(`${runtime}: E9 — does the post-compaction window reason (thinking ON)`, reasoning)

      const declined = await declineNotice(session, key, rowsBeforeCompact)
      if (declined) {
        run.observe(`${runtime}: THE COMPACTION WAS DECLINED`, declined)
      }
      run.check(`${runtime}: a compaction actually happened, so E7/E9 read a compaction`,
        declined === undefined && added.length > 0,
        declined
          ? `the runtime refused: ${declined} — E7's zero above is "no compaction", not "nothing came back", `
            + 'and the two are different answers. Raise NESSY_CDP_COMPACT_FILL_TURNS until the session '
            + 'crosses this runtime\u2019s own floor.'
          : 'the runtime session file gained no entry and the transcript names no refusal, so what happened '
            + 'is not established either way')

      // ---------- CONTROL A: a session that compacts with ZERO files read -----
      const controlKey = await freshSession(session,
        `CDP RS-17 ${runtime} controlA ${new Date().toISOString().slice(11, 19)}`)
      await switchRuntime(session, controlKey.sessionId, card)
      await waitForConnection(session, controlKey.sessionId, card)
      await bindProject(run, session, controlKey.sessionId, root, {
        label: `${runtime}/control`, gate: () => trustScratchProject(session, root),
      })
      await sendPrompt(session, controlKey, 'Reply with the single word ready.', 180_000).catch(() => undefined)
      // The fill reads the FILLERS, never one of the six — so this session still
      // has "zero files read" in the sense the control means, while being large
      // enough for a compaction to actually run in it.
      const controlApprover = approvePermissionsWhile(session, controlKey.sessionId)
      try {
        await fillToFloor(session, controlKey, run, `${runtime}/controlA`, fillers)
      } finally {
        run.observe(`${runtime}: approvals during control A's fill`, await controlApprover.stop())
      }
      // D1.356 — control A's fill has to actually REACH the floor, or its
      // `/compact` is refused and its silence is "nothing ran" rather than "the
      // summary did not reason".
      requireApproverSaw(run, controlApprover, `${runtime}: control A's fill`)
      const controlBefore = runtimeLog(runtime, controlKey, root).entries.length
      const controlRowsBefore = (await transcript(session, controlKey)).length
      run.observe(`${runtime}: control A /compact`, await compact(session, controlKey, run, `${runtime}/controlA`))
      await Bun.sleep(30_000)
      const controlWindow = runtimeLog(runtime, controlKey, root).entries.slice(controlBefore)
        .map(entry => `${entry.text}\n${JSON.stringify(entry.raw)}`).join('\n')
      const leaked = files.filter(file => formOf(controlWindow, file) !== 'absent').map(file => file.path)
      // A CONTROL THAT WAS ITSELF DECLINED PROVES NOTHING, and it passes.
      // Measured 2026-09-12 (R7) on the pi arm: both controls scored ok against
      // sessions whose `/compact` had answered `Nothing to compact (session too
      // small)`, so "no path came back" and "no compaction ran" were recorded as
      // the same green. Read the refusal first and say so.
      const controlADeclined = await declineNotice(session, controlKey, controlRowsBefore)
      run.check(`${runtime}: CONTROL A — a compaction with zero files read returns no path`,
        leaked.length === 0 && controlADeclined === undefined,
        controlADeclined
          ? `the control's OWN compaction was refused (${controlADeclined}), so its zero is "nothing ran" `
            + 'rather than "nothing came back" and it cannot control the subject arm'
          : `${leaked.length} fixture path(s) appeared after a compaction that read none of them, so a path in `
            + 'the subject window cannot be attributed to the compactor')

      // ---------- CONTROL B: the same subject rig with thinking OFF ----------
      const offKey = await freshSession(session,
        `CDP RS-17 ${runtime} controlB ${new Date().toISOString().slice(11, 19)}`)
      await switchRuntime(session, offKey.sessionId, card)
      await waitForConnection(session, offKey.sessionId, card)
      await bindProject(run, session, offKey.sessionId, root, {
        label: `${runtime}/thinking-off`, gate: () => trustScratchProject(session, root),
      })
      const offLevel = await sessionCommand(session, offKey.sessionId, { type: 'setThinkingLevel', level: 'off' })
        .then(() => 'off').catch(error => `refused: ${String(error)}`)
      run.observe(`${runtime}: control B thinking level`, offLevel)
      const offApprover = approvePermissionsWhile(session, offKey.sessionId)
      try {
        await sendPrompt(session, offKey,
          `Please read this file and summarise it in one sentence: ${files[0]!.path}`, 300_000).catch(() => undefined)
        await fillToFloor(session, offKey, run, `${runtime}/controlB`, fillers)
      } finally {
        await offApprover.stop()
      }
      // D1.356 — control B's `!offReasoning.found` is an ABSENCE, and this is the
      // arm where a blind approver and the intended finding read identically.
      requireApproverSaw(run, offApprover, `${runtime}: control B's turn and fill`)
      const offBefore = runtimeLog(runtime, offKey, root).entries.length
      const offRowsBefore = (await transcript(session, offKey)).length
      run.observe(`${runtime}: control B /compact`, await compact(session, offKey, run, `${runtime}/controlB`))
      await Bun.sleep(30_000)
      const offReasoning = reasoningIn(runtimeLog(runtime, offKey, root).entries.slice(offBefore))
      const controlBDeclined = await declineNotice(session, offKey, offRowsBefore)
      run.check(`${runtime}: CONTROL B — with thinking OFF the summary window does not reason`,
        !offReasoning.found && controlBDeclined === undefined,
        controlBDeclined
          ? `the control's OWN compaction was refused (${controlBDeclined}), so its silence is "no summary ran" `
            + 'rather than "the summary did not reason"'
          : `the window carries ${offReasoning.kinds.join(', ')} with thinking off, so "the summary reasoned" in `
            + 'the subject arm is indistinguishable from "this runtime always reasons"')

      run.observe(`${runtime} VERDICT`, {
        E7: `${returned} of 6 files return; forms ${JSON.stringify(forms)}`,
        E9: reasoning.found
          ? `the post-compaction window reasons (${reasoning.kinds.join(', ')}) with thinking on`
          : 'the post-compaction window carries no reasoning block at all — a null recorded as a finding',
        controls: {
          A: controlADeclined ? `VACUOUS — refused: ${controlADeclined}` : leaked.length === 0 ? 'clean' : `LEAKED ${leaked.join(', ')}`,
          B: controlBDeclined ? `VACUOUS — refused: ${controlBDeclined}` : offReasoning.found ? 'REASONED' : 'clean',
        },
      })
      void transcript
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    run.observe('fixture removed', root)
  }
}

if (import.meta.main) await main(ID, TITLE, drive)
