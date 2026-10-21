/**
 * RS-79 (D1.65) — the memory-index over-limit and near-limit write notices, on
 * all three runtimes, read off what the MODEL was handed.
 *
 * ## The row
 *
 * D1.65, carried from P6.402: *"on each runtime, one write that leaves
 * `MEMORY.md` over the 200-line / 25 KB limit and one that lands just under it;
 * observable = the over-limit branch returns an error naming the overflow and
 * the near-limit branch returns the reminder, both visible to the MODEL (not
 * only in the tool result envelope) — the codex arm is the one that can fail,
 * because `isError: true` does not survive the Responses path, which is the
 * module's own stated reason for making the message self-describing. Control =
 * a small write producing neither branch."*
 *
 * Ledger L55 is `have` on all three and every one of the three is a PROPAGATED
 * claim: `memoryIndexWriteNotice` is one host function
 * (`packages/session-tools-core/src/memory-index.ts`) and the propagation
 * assumes its text reaches the model identically through three different
 * transports. The module's own docblock says why that is not assumable —
 * *"`response.ts` records that `isError: true` is invisible on the
 * Codex/Responses path, so the text has to carry the fact that the write
 * succeeded on its own"*.
 *
 * ## One ARM per run, and why the case cannot walk the three levels itself
 *
 * The notice level is a function of the file the write LEFT BEHIND, and a write
 * only ever grows the index, so `ok` → `near` → `over` is one-way. Each level
 * is therefore its own seed and its own run:
 *
 *     bun run scripts/cdp/fixtures/memory-index-limits.ts --config-dir <dir> --arm over
 *     NESSY_CDP_MEMORY_ARM=over bun run scripts/cdp/cases/rs-79.ts
 *
 * The fixture owns the write, per `scripts/cdp/README.md`'s rule that a case
 * never writes configuration and a fixture may.
 *
 * ## The detector, and the two places it reads
 *
 * `remember` is a session tool, so the notice arrives as a TOOL RESULT. The case
 * reads it twice, because the row's *"not only in the tool result envelope"* is
 * exactly the difference between the two:
 *
 *  1. **the host's own transcript record** — `getSessionMessages(...)`'s
 *     `toolResult` for the `remember` call. This is the envelope.
 *  2. **the session's own runtime file** — whatever the runtime wrote under
 *     `<config>/sessions/<workspace>/<sessionId>/`. That file is the
 *     conversation as the RUNTIME carried it, so the notice appearing there is
 *     the row's stronger clause.
 *
 * The needle is a fragment of the product's own wording, not a paraphrase:
 * `over its` + `read limit` for the over branch, `is near its read limit` for
 * the near branch. Both branches also carry `The write succeeded` / the remedy
 * sentence, which is the self-describing property the codex arm depends on, and
 * that is asserted separately.
 *
 * ## The controls
 *
 *  1. **the tool actually ran** — a `remember` tool call in the turn, with a
 *     result. "No notice" over a turn where the model never called the tool is
 *     not the row's answer, and it is the likeliest way this case goes wrong.
 *  2. **the runtime file reader sees this conversation** — the same file must
 *     name the tool. Without it, "the notice is not in the runtime file" is
 *     equally true of a file this reader never found.
 *  3. **the `ok` arm** — the row's own control, run as its own arm: a small
 *     write must produce NEITHER branch. Without it, a host that appends the
 *     reminder to every save would pass the `near` arm.
 *
 * ## What it creates
 *
 * One session per runtime family, named by the case, and the memory entries
 * those sessions write into the config dir's own `MEMORY.md` — the file the
 * fixture seeded. Nothing outside the config dir the run was launched with.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, transcript } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { BYTE_LIMIT, impliedLevel, LINE_LIMIT, type MemoryIndexArm } from '../fixtures/memory-index-limits.ts'

const ID = 'RS-79'
const TITLE = 'the memory-index over-limit and near-limit write notices, on all three runtimes'

const ARM = (process.env.NESSY_CDP_MEMORY_ARM ?? '') as MemoryIndexArm | ''

/** Fragments of the product's OWN wording, never a paraphrase. */
const OVER_NEEDLE = 'read limit. The write succeeded'
const NEAR_NEEDLE = 'is near its read limit'
/** The shared remedy sentence — present in both branches, absent from a bare save. */
const REMEDY_NEEDLE = 'keep one line per entry'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.65',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: one card per family (pi, claude-runtime, codex-runtime). No key is read and no credential file is '
    + 'touched; the only file written is the config dir\'s own MEMORY.md, by the model through the `remember` tool.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, launched with the `env -u` launcher.',
    '2. `bun run scripts/cdp/fixtures/memory-index-limits.ts --config-dir <that dir> --arm over` — it REPLACES <dir>/MEMORY.md and prints the size it left.',
    '3. `NESSY_CDP_MEMORY_ARM=over bun run scripts/cdp/cases/rs-79.ts` — it drives one user-scope `remember` per runtime family.',
    '4. Repeat for `--arm near` and `--arm ok`. The levels are one-way, so they cannot share a run.',
    '5. Read the notice out of the `remember` tool RESULT and out of the session\'s own runtime file.',
  ],
  expected:
    'over — an error naming the overflow, carrying `The write succeeded` so a transport that drops `isError` still '
    + 'tells the model the save happened. near — the reminder with the same remedy sentence, on a successful '
    + 'result. ok — neither, and no remedy sentence anywhere.',
  detector:
    'the `remember` tool RESULT in `getSessionMessages`, and the same text in the session\'s own runtime session '
    + 'file under `<config>/sessions/<workspace>/<sessionId>/` — the row\'s "not only in the tool result envelope" '
    + 'is the difference between those two reads.',
  positiveControl:
    'a `remember` tool call with a result in the turn, and the same runtime file naming that tool. A turn where '
    + 'the model never called `remember` produces no notice for a reason that is not the product\'s, and a runtime '
    + 'file this reader never found produces the same zero as a notice that never arrived. The row\'s own control '
    + 'is the `ok` arm: a small write must produce neither branch.',
  doneMeans:
    'L55 records, per runtime, whether both branches reach the model and whether the text is self-describing — '
    + 'or refutes the propagated `have` on whichever arm drops it.',
  doNotConflate:
    'The `over` branch is an ERROR result whose write SUCCEEDED (`memory.md:386`). A case that scored the error as '
    + 'a failed save would report the documented behaviour as a defect.',
} as const satisfies SittingRecipe

/** Measure `<config>/MEMORY.md` the way `measureMemoryIndex` does. */
function measureIndex(path: string): { lines: number; bytes: number; exists: boolean } {
  if (!existsSync(path)) return { lines: 0, bytes: 0, exists: false }
  const text = readFileSync(path, 'utf8')
  const lines = text.split(/\r?\n/)
  return { lines: lines.length, bytes: Buffer.byteLength(lines.join('\n'), 'utf-8'), exists: true }
}

function jsonlUnder(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const entry of entries) {
    const path = join(dir, entry)
    let stat
    try { stat = statSync(path) } catch { continue }
    if (stat.isDirectory()) jsonlUnder(path, out)
    else if (entry.endsWith('.jsonl')) out.push(path)
  }
  return out
}

/** What the session's OWN runtime file carries — the row's "visible to the model" read. */
function runtimeFileRead(root: string, workspaceId: string, sessionId: string): {
  files: number
  bytes: number
  over: number
  near: number
  remedy: number
  toolNamed: number
} {
  const files = jsonlUnder(join(root, 'sessions', workspaceId, sessionId))
  let bytes = 0
  let over = 0
  let near = 0
  let remedy = 0
  let toolNamed = 0
  for (const file of files) {
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { continue }
    bytes += text.length
    over += text.split(OVER_NEEDLE).length - 1
    near += text.split(NEAR_NEEDLE).length - 1
    remedy += text.split(REMEDY_NEEDLE).length - 1
    toolNamed += text.split('remember').length - 1
  }
  return { files: files.length, bytes, over, near, remedy, toolNamed }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const root = configDir()

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the memory index a `remember` call measures')
  if (contaminated !== undefined) blocked(contaminated)

  if (ARM !== 'over' && ARM !== 'near' && ARM !== 'ok') {
    blocked(
      'set NESSY_CDP_MEMORY_ARM to over, near or ok, and seed the matching index first with '
      + '`scripts/cdp/fixtures/memory-index-limits.ts --arm <the same word>`. The notice level is decided by the '
      + 'file the write leaves behind, so an arm the profile was not seeded for measures the wrong branch',
    )
  }

  const indexPath = join(root, 'MEMORY.md')
  const before = measureIndex(indexPath)
  run.observe('the memory index this arm starts from', { path: indexPath, ...before, impliedLevel: impliedLevel(before.lines, before.bytes) })
  run.require(
    'THE CONTROL — the profile is seeded for the arm this run was told to measure',
    before.exists && impliedLevel(before.lines, before.bytes) === ARM,
    `NESSY_CDP_MEMORY_ARM=${ARM} but ${indexPath} measures ${before.lines} lines / ${before.bytes} bytes, which is `
    + `the \`${before.exists ? impliedLevel(before.lines, before.bytes) : 'missing'}\` arm against the ${LINE_LIMIT}-line `
    + `and ${BYTE_LIMIT}-byte limits. Re-run the fixture with --arm ${ARM} before this case`,
  )

  const cards = await listConnections(session)
  const byFamily = new Map<string, typeof cards[number]>()
  for (const card of cards) {
    const raw = runtimeOf(card.providerType)
    const family = raw === 'anthropic' ? 'claude' : raw === 'codex-runtime' ? 'codex' : raw
    if ((family === 'pi' || family === 'claude' || family === 'codex') && !byFamily.has(family)) byFamily.set(family, card)
  }
  run.observe('the cards this profile offers', [...byFamily].map(([family, card]) => ({ family, slug: card.slug })))
  if (byFamily.size === 0) blocked('this profile lists no pi, claude-runtime or codex-runtime card')

  for (const [family, card] of byFamily) {
    // `freshSession` FALLS BACK to the open session rather than throwing, and on
    // a profile that has already run a dozen sessions it sometimes does. One
    // retry, because the fallback is a rig state and not the row's answer.
    let key = await freshSession(session, `CDP ${ID} ${family} ${new Date().toISOString().slice(11, 19)}`)
    if (!key.fresh) key = await freshSession(session, `CDP ${ID} ${family} retry ${new Date().toISOString().slice(11, 19)}`)
    if (!key.fresh) { run.check(`[${family}] the arm ran in a session it created`, false, `inherited ${key.inheritedMessages} after a retry`); continue }
    const bind = await switchRuntime(session, key.sessionId, card.slug)
    if (!bind.ok) { run.check(`[${family}] bound to ${card.slug}`, false, bind.error); continue }

    const marker = `CDP-${ID}-${family}-${Date.now().toString(36)}`
    // Deliberately narrow. An open-ended "then report it" prompt let one arm run
    // eight messages and 420 s without settling; the row needs ONE tool call and
    // its result text, and the result is read off the transcript rather than off
    // the model's retelling of it.
    const turn = await sendPrompt(
      session,
      key,
      `Call the \`remember\` tool exactly once, with scope "user" and memory "${marker}". `
      + 'Then reply with one short sentence saying you did. Call no other tool and do nothing else.',
      240_000,
    ).catch(error => {
      run.check(
        `[${family}] the turn settled`,
        false,
        `the turn did not settle: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    })
    if (!turn) {
      // THE CONTROL for a turn that never settled. "The remember call hangs on
      // this runtime" and "this runtime's session tools do not answer at all"
      // are different findings with different owners, and the second one would
      // make the first meaningless. So drive a DIFFERENT session tool on the
      // SAME card and record what it did.
      const hung = (await transcript(session, key))
        .filter(message => message.role === 'tool')
        .map(message => ({ tool: message.toolName, status: message.toolStatus, result: (message.toolResult ?? '').slice(0, 80) }))
      const controlKey = await freshSession(session, `CDP ${ID} ${family} tool-control ${new Date().toISOString().slice(11, 19)}`)
      const controlBind = await switchRuntime(session, controlKey.sessionId, card.slug)
      const startedAt = Date.now()
      const controlTurn = await sendPrompt(
        session,
        controlKey,
        'Call the `get_session_info` tool once — it takes no arguments — then say DONE. Call nothing else.',
        150_000,
      ).catch(() => undefined)
      const controlTools = (await transcript(session, controlKey))
        .filter(message => message.role === 'tool')
        .map(message => ({ tool: message.toolName, status: message.toolStatus, chars: (message.toolResult ?? '').length }))
      run.observe(`[${family}] the hung call, and a DIFFERENT session tool on the same card`, {
        hungCall: hung,
        control: { bound: controlBind.ok, settled: controlTurn !== undefined, ms: Date.now() - startedAt, tools: controlTools },
      })
      run.check(
        `[${family}] THE CONTROL — another session tool on the same card DOES return`,
        controlTools.some(entry => entry.status === 'completed' && entry.chars > 0),
        `the control tool answered ${JSON.stringify(controlTools)} in ${Date.now() - startedAt} ms. If it also `
        + 'hangs, the finding is the session tool TRANSPORT on this runtime and not `remember`',
      )
      continue
    }
    const messages = await transcript(session, key)
    const calls = messages.filter(message => message.role === 'tool' && /remember/i.test(message.toolName ?? ''))
    const resultText = calls.map(call => call.toolResult ?? '').join('\n')
    const statuses = calls.map(call => call.toolStatus ?? '?')
    const after = measureIndex(indexPath)
    const file = runtimeFileRead(root, key.workspaceId, key.sessionId)

    run.observe(`[${family}] the remember call`, {
      card: card.slug,
      calls: calls.length,
      statuses,
      resultText: resultText.slice(0, 400),
      indexAfter: { lines: after.lines, bytes: after.bytes, impliedLevel: impliedLevel(after.lines, after.bytes) },
      runtimeFile: file,
    })

    run.require(
      `[${family}] THE CONTROL — the model called \`remember\` and a result came back`,
      calls.length > 0 && resultText.trim().length > 0,
      `${calls.length} remember tool call(s) in the turn with ${resultText.length} chars of result. A turn where `
      + 'the tool never ran cannot answer what its notice says, and that is not a product fact',
    )
    run.require(
      `[${family}] THE CONTROL — the runtime file reader found this conversation`,
      file.files > 0 && file.toolNamed > 0,
      `${file.files} jsonl file(s), ${file.bytes} bytes, ${file.toolNamed} mention(s) of the tool under `
      + `${join(root, 'sessions', key.workspaceId, key.sessionId)}. Without this, a zero for the notice below is `
      + 'an unread file rather than an absent notice',
    )

    if (ARM === 'over') {
      run.check(
        `[${family}] D1.65 — the OVER branch reaches the model's tool result, naming the overflow`,
        resultText.includes(OVER_NEEDLE),
        `the result does not carry ${JSON.stringify(OVER_NEEDLE)}: ${JSON.stringify(resultText.slice(0, 300))}`,
      )
      run.check(
        `[${family}] D1.65 — and it is SELF-DESCRIBING, so a transport that drops \`isError\` still says the write succeeded`,
        /the write succeeded/i.test(resultText) && resultText.includes(REMEDY_NEEDLE),
        'the over-limit text must say the write succeeded and carry the remedy on its own — `isError: true` is '
        + 'invisible on the Codex/Responses path, which is the module\'s stated reason for the wording',
      )
      run.check(
        `[${family}] D1.65 — the notice is in the conversation the RUNTIME carried, not only the envelope`,
        file.over > 0,
        `the session's own runtime file carries ${file.over} occurrence(s) of the over-limit wording over `
        + `${file.bytes} bytes, while the tool named there ${file.toolNamed} time(s)`,
      )
    } else if (ARM === 'near') {
      run.check(
        `[${family}] D1.65 — the NEAR branch reaches the model's tool result`,
        resultText.includes(NEAR_NEEDLE),
        `the result does not carry ${JSON.stringify(NEAR_NEEDLE)}: ${JSON.stringify(resultText.slice(0, 300))}`,
      )
      run.check(
        `[${family}] D1.65 — the near-limit reminder carries the remedy`,
        resultText.includes(REMEDY_NEEDLE),
        'the reminder must name what to do about it; `memory.md:386` states the remedy as part of the reminder',
      )
      run.check(
        `[${family}] D1.65 — the reminder is in the conversation the RUNTIME carried`,
        file.near > 0,
        `the session's own runtime file carries ${file.near} occurrence(s) of the near-limit wording`,
      )
    } else {
      run.check(
        `[${family}] THE ROW'S CONTROL — a small write produces NEITHER branch`,
        !resultText.includes(OVER_NEEDLE) && !resultText.includes(NEAR_NEEDLE) && !resultText.includes(REMEDY_NEEDLE),
        `a save against a ${before.lines}-line index still produced ${JSON.stringify(resultText.slice(0, 300))}. If `
        + 'the notice rides every save, the two arms above measured nothing',
      )
    }
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
