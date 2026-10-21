/**
 * RS-78 (D1.64, the OUTPUT-STYLE half — L46) — does a FORK inherit the session's
 * output style while a NAMED subagent does not, on all three runtimes, read off
 * each child's OWN composed prompt.
 *
 * ## The row, and which half this is
 *
 * D1.64 carries two halves from P6.401. The L48 half — a shared prompt-cache
 * read across two sessions — was measured to have no subject on this rig by
 * measure sitting 5c (`2026-09-18-measure-sitting-5c.md` §2): the claude path
 * answers `cacheReadTokens: 0` / `warmth: unknown` on a gateway card whatever
 * happens, while a Pi session on the same model answers 8 192. This case takes
 * the OTHER half, which that sitting recorded as drivable and did not reach:
 *
 * > (1) L46 — one subagent and one fork under a named output style on each
 * > runtime; observable = the style's own marker text present in the FORK's
 * > composed prompt and absent from the SUBAGENT's, with the control being a
 * > session under no style; the claude cell moves `partial` → measured.
 *
 * The rule under test is one shared host function,
 * `resolveChildOutputStyleId(childKind, sessionStyleId)`
 * (`packages/shared/src/agent/child-session-scope.ts`), consumed by all three
 * backends — `named` → `undefined`, `fork` and top-level → the session's style.
 * Its docblock cites `sub-agents.md:933` and `output-styles.md:104`. The unit
 * test pins the FUNCTION on all three arms; nothing had driven the ARTEFACT.
 *
 * ## The detector, and why it is the child's own session file
 *
 * A child is a SESSION of its own in this product — spawning one creates a new
 * directory under `<config>/sessions/<workspace>/<sessionId>/`, and the runtime
 * writes that session's own composed prompt into `.pi-sessions/*.jsonl` there.
 * So the composed prompt the row asks about is a fact on disk, written by the
 * feature itself, and the case never has to ask a model what it was told.
 *
 * Two needles, and they are different strengths:
 *
 *  - **the reminder** — `PromptBuilder.buildOutputStyleReminder()` emits
 *    `The '<label>' output style is active.` into the volatile context on every
 *    turn whose `activeOutputStyleLabel` is set, and that label is fed from the
 *    SAME child-kind-guarded resolution (`setActiveOutputStyle`'s docblock says
 *    so in as many words). It is the host's own statement that the style
 *    applies to this child.
 *  - **the style's own marker text** — the fixture style body carries a random
 *    token. Its presence proves the style PROSE reached the prompt, not merely
 *    a label.
 *
 * ## The controls, and there are three
 *
 *  1. **the reader sees a composed prompt at all** — the child's own file must
 *     carry the session preamble (`session_state`). Without it, "no reminder"
 *     and "an empty or unwritten file" are the same reading. This is what turns
 *     the NAMED arm from an absence-by-silence into a discrimination.
 *  2. **the row's own control — a session under NO style.** With the style set
 *     to `default`, a fork's prompt must carry neither needle. Without it, "the
 *     fork carries the reminder" is equally true of a host that puts the
 *     reminder in every prompt.
 *  3. **the child really appeared** — a NEW session directory between two
 *     snapshots. A child that never started writes no prompt, and its absence is
 *     not the row's answer.
 *  4. **the PARENT session's own prompt carries the style.** A top-level session
 *     is `resolveChildOutputStyleId(undefined, id)` → the id, so this is the
 *     positive arm of the discrimination, and it is the only one available on a
 *     runtime this product offers no fork on.
 *
 * ## `/subtask` is a PI-ONLY entry, and that decides the fork half per runtime
 *
 * Measured on this build in the product's own palette, in a session that had
 * already run a turn: pi offers 113 entries INCLUDING
 * `Subtask — Fork this conversation into a background agent that inherits it`;
 * claude and codex offer 111 each and no `subtask` among them (the same read
 * shows `Quota` on pi only and `Approve` on codex only, so the palette really is
 * runtime-scoped rather than mis-read). So the case ASKS the palette before
 * typing: where no fork is offered, the fork clause of L46 is a measured NULL
 * with that reason, and the arm still answers the named-subagent clause against
 * the parent as its positive.
 *
 * ## Why the spawn is detected on DISK and not through `childState.children`
 *
 * The first drive of this case used `lib/fork.ts`'s `startFork`, whose baseline
 * read goes through `getPiHarnessRuntime`. On this packaged build that call
 * throws `pi-harness-runtime-invalid` once a session has run a turn — RS-56
 * (D1.260) is the case that measured it, and `requireReadablePiRuntime` is the
 * guard that correctly refuses to treat the throw as an empty child list. The
 * pi arm had already answered 4/4 when the codex arm reached that guard and
 * BLOCKED the whole case. So the spawn detector here is the appearance of the
 * child's own session directory, which is the same fact one layer down and is
 * not affected by that defect. `piRuntime()` is still read, but only as an
 * observation, and `readFailed` is recorded rather than blocked on.
 *
 * ## What it does NOT do
 *
 * It does not ask whether the model OBEYED the style. The row's observable is
 * the composed prompt; the reply text is a second, weaker fact and is only
 * recorded as an observation. And it drives one fork and one named subagent per
 * runtime — not the cross product with every spawn route.
 *
 * ## What it creates
 *
 * Sessions it names itself, and the children those sessions spawn, all inside
 * the config dir the run was launched with. It SETS the global output style and
 * restores the previous value in a `finally`. It writes no settings file, reads
 * no credential and edits no connection.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { sendPrompt, sendSlashCommand } from '../lib/chat.ts'
import { peekPalette } from '../lib/composer.ts'
import type { CdpSession } from '../lib/connect.ts'
import { seedForkableConversation } from '../lib/fork.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir, readClaudeSessionLog } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, piRuntime, waitFor, type SessionKey } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-78'
const TITLE = 'a fork inherits the session output style and a named subagent does not, read off each child\'s own prompt'

/** The fixture style `scripts/cdp/fixtures/agent-surfaces.ts` writes, and its marker. */
const STYLE_ID = process.env.NESSY_CDP_OUTPUT_STYLE_ID
const STYLE_MARKER = process.env.NESSY_CDP_OUTPUT_STYLE_MARKER
/** A named agent the fixture writes; the CONTROL agent, which declares no skills. */
const NAMED_AGENT = process.env.NESSY_CDP_PLAIN_AGENT ?? 'cdp-plain'

/** The host's own per-turn restatement, `PromptBuilder.buildOutputStyleReminder`. */
const REMINDER = 'output style is active'
/** The session preamble every composed prompt carries — this reader's positive control. */
const PREAMBLE = 'session_state'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.64',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: one card per family (pi, claude-runtime, codex-runtime). No key is read, no credential file is '
    + 'touched, and the only setting written is the global output style, restored at the end.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, launched with the `env -u` launcher.',
    '2. `bun run scripts/cdp/fixtures/agent-surfaces.ts --config-dir <that dir>` — it writes the marker output style and the named agents, and prints both names.',
    '3. Export NESSY_CDP_OUTPUT_STYLE_ID and NESSY_CDP_OUTPUT_STYLE_MARKER from that output; optionally NESSY_CDP_PLAIN_AGENT.',
    '4. Per runtime: bind a session to the card, seed one turn, `/subtask` a fork, then ask the model to delegate the same task to the NAMED agent.',
    '5. Read each child\'s OWN session directory — the one that appeared when it spawned — and count the two needles in its runtime session file.',
    '6. Then set the style to `default` and drive one more fork: neither needle may appear.',
  ],
  expected:
    'The fork\'s composed prompt carries the host\'s own `… output style is active` reminder and the style body\'s '
    + 'marker; the named subagent\'s carries neither, while carrying the session preamble. Under no style, neither '
    + 'child carries either needle.',
  detector:
    'the CHILD session\'s own runtime session file under `<config>/sessions/<workspace>/<child sessionId>/`, '
    + 'written by the runtime itself — never the child\'s reply text, which is the model\'s behaviour rather than '
    + 'the composed prompt the row asks about.',
  positiveControl:
    'the same child file carrying the session preamble (`session_state`). A file with no reminder and no preamble '
    + 'is an unwritten file, not a subagent outside the style\'s scope, and without this control the NAMED arm '
    + 'passes on silence. The row\'s own control — a fork under NO style — is driven as well, so "the fork carries '
    + 'the reminder" cannot be satisfied by a host that reminds unconditionally.',
  doneMeans:
    'L46 records, per runtime, whether the fork\'s prompt carries the session output style and the named '
    + 'subagent\'s does not — the claude cell moving `partial` → measured — with the file each reading came from.',
  doNotConflate:
    'This measures the COMPOSED PROMPT. Whether the model obeyed the style is a different question, recorded as an '
    + 'observation and asserted nowhere. And the L48 prompt-cache half of D1.64 is not taken here: sitting 5c '
    + 'measured that it has no subject on a gateway claude card.',
} as const satisfies SittingRecipe

interface ChildPrompt {
  dir: string | undefined
  files: number
  bytes: number
  reminder: number
  marker: number
  preamble: number
}

/** Every session directory under this profile, as a set — the spawn detector. */
function sessionDirs(root: string, workspaceId: string): Set<string> {
  const base = join(root, 'sessions', workspaceId)
  if (!existsSync(base)) return new Set()
  return new Set(readdirSync(base))
}

/** Recursively collect the `.jsonl` a runtime wrote under one session directory. */
function jsonlUnder(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const entry of entries) {
    const path = join(dir, entry)
    let stat
    try { stat = statSync(path) } catch { continue }
    if (stat.isDirectory()) jsonlUnder(path, out)
    // `session.jsonl` is the HOST's own record of the conversation; the runtime's
    // own file is the one under `.pi-sessions/` (or the runtime's own subtree).
    // Both are read: the needles are counted over whatever the runtime wrote,
    // and the preamble control is what says the read found a composed prompt.
    else if (entry.endsWith('.jsonl')) out.push(path)
  }
  return out
}

/**
 * Count the two needles plus the control over one session's own prompt record.
 *
 * TWO stores, because the runtimes do not share one. Pi writes the composed
 * prompt into `<session>/.pi-sessions/*.jsonl`; a claude session's is in the
 * SDK's own transcript under `<workspace>/claude-config/projects/…`, which
 * `readClaudeSessionLog` keys by session id. Codex writes neither, and that
 * absence is what the preamble count reports rather than a zero for the style.
 */
function readChildPrompt(root: string, workspaceId: string, childSessionId: string | undefined): ChildPrompt {
  if (!childSessionId) return { dir: undefined, files: 0, bytes: 0, reminder: 0, marker: 0, preamble: 0 }
  const dir = join(root, 'sessions', workspaceId, childSessionId)
  const texts: string[] = []
  const files = jsonlUnder(dir)
  for (const file of files) {
    try { texts.push(readFileSync(file, 'utf8')) } catch { /* an unreadable file is a zero, and the control says so */ }
  }
  let claudeFiles = 0
  const claudeLog = readClaudeSessionLog(workspaceId, root, childSessionId)
  if (claudeLog.entries.length > 0) {
    claudeFiles = claudeLog.files?.length ?? (claudeLog.file ? 1 : 0)
    for (const entry of claudeLog.entries) texts.push(`${entry.text}\n${JSON.stringify(entry.raw)}`)
  }
  let bytes = 0
  let reminder = 0
  let marker = 0
  let preamble = 0
  for (const text of texts) {
    bytes += text.length
    reminder += text.split(REMINDER).length - 1
    if (STYLE_MARKER) marker += text.split(STYLE_MARKER).length - 1
    preamble += text.split(PREAMBLE).length - 1
  }
  return { dir: childSessionId, files: files.length + claudeFiles, bytes, reminder, marker, preamble }
}

/** The ONE session directory that appeared between two snapshots, if exactly one did. */
function newDir(before: Set<string>, after: Set<string>): string | undefined {
  const fresh = [...after].filter(name => !before.has(name))
  return fresh.length === 1 ? fresh[0] : undefined
}

/**
 * Wait for the child's own session directory to appear AND to carry a composed
 * prompt — the two are different moments, and reading between them is how a
 * fully inherited prompt reads as an empty one.
 */
async function waitForChildPrompt(
  root: string,
  workspaceId: string,
  before: Set<string>,
  timeoutMs: number,
): Promise<ChildPrompt> {
  return waitFor(
    async () => readChildPrompt(root, workspaceId, newDir(before, sessionDirs(root, workspaceId))),
    read => read.dir !== undefined && read.preamble > 0,
    { timeoutMs, intervalMs: 3_000, label: 'the child\'s own session directory to carry a composed prompt' },
  ).catch(() => readChildPrompt(root, workspaceId, newDir(before, sessionDirs(root, workspaceId))))
}

interface ArmReading {
  runtime: string
  card: string
  parent: ChildPrompt
  forkOffered: boolean
  fork: (ChildPrompt & { answer?: string }) | 'not-offered'
  named: ChildPrompt & { toolCalls: string[] }
  snapshotRead: { available: boolean; readFailed?: boolean; children: number; reason?: string }
}

async function driveArm(
  run: CaseRun,
  session: CdpSession,
  root: string,
  card: { slug: string; providerType: string },
  family: string,
  label: string,
): Promise<ArmReading | undefined> {
  const key = await freshSession(session, `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`)
  if (!key.fresh) {
    run.check(`[${label}] the arm ran in a session it created`, false, `inherited ${key.inheritedMessages} messages`)
    return undefined
  }
  const bind = await switchRuntime(session, key.sessionId, card.slug)
  if (!bind.ok) {
    run.check(`[${label}] the session is bound to ${card.slug}`, false, `switchRuntime refused: ${bind.error}`)
    return undefined
  }
  await seedForkableConversation(session, key)

  // ---- the PARENT, which is the arm every runtime has ----------------------
  // `resolveChildOutputStyleId(undefined, id)` returns the id, so a top-level
  // session under a named style is the POSITIVE arm of the discrimination — and
  // it is the only positive arm on a runtime this product offers no fork on.
  const parent = readChildPrompt(root, key.workspaceId, key.sessionId)

  // ---- the FORK, where the product offers one ------------------------------
  // Read the palette rather than assuming: `/subtask` is a PI-only entry on this
  // build (measured — pi's palette has it, claude's and codex's do not), so
  // typing it blind throws `palette-did-not-open` and takes the whole arm with
  // it. The absence is the row's answer for those runtimes, not a rig failure.
  const offered = await peekPalette(session, 'subtask').catch(() => [] as string[])
  const forkOffered = offered.some(entry => /subtask/i.test(entry))
  let fork: (ChildPrompt & { answer?: string }) | 'not-offered' = 'not-offered'
  if (forkOffered) {
    const beforeFork = sessionDirs(root, key.workspaceId)
    await sendSlashCommand(session, key, {
      token: 'subtask',
      match: /subtask/i,
      expectComposer: '/subtask ',
      argument: 'Reply with the single word ALPHA and stop. Use no tool.',
      noWait: true,
    })
    fork = await waitForChildPrompt(root, key.workspaceId, beforeFork, 300_000)
  }

  // ---- the NAMED subagent --------------------------------------------------
  const beforeNamed = sessionDirs(root, key.workspaceId)
  const delegation = await sendPrompt(
    session,
    key,
    `Delegate this to the named subagent \`${NAMED_AGENT}\` using the agent tool — do not answer it yourself: `
    + '"Reply with the single word BETA and stop." Then report its answer verbatim.',
    420_000,
  ).catch(() => ({ added: [] as { role: string; toolName?: string }[] }))
  const toolCalls = delegation.added.filter(message => message.role === 'tool').map(message => message.toolName ?? '?')
  const named = {
    ...(await waitForChildPrompt(root, key.workspaceId, beforeNamed, 120_000)),
    toolCalls,
  }

  // Read the snapshot for the record only. It THROWS on this packaged build once
  // a session has run a turn (RS-56 / D1.260), so it is an observation and never
  // a control here.
  const snapshot = await piRuntime(session, key)
  const reading: ArmReading = {
    runtime: family,
    card: card.slug,
    parent,
    forkOffered,
    fork,
    named,
    snapshotRead: {
      available: snapshot.available,
      ...(snapshot.readFailed ? { readFailed: true } : {}),
      children: snapshot.children.length,
      ...(snapshot.unavailableReason ? { reason: snapshot.unavailableReason } : {}),
    },
  }
  run.observe(`[${label}] the parent and its children`, reading)

  // ---- the controls, then the subject --------------------------------------
  // THE CONTROL, and it is a GATE rather than a failure. A top-level session is
  // `resolveChildOutputStyleId(undefined, id)` → the id, so a readable prompt
  // store must carry the style here. When the parent's own prompt cannot be read
  // at all — measured on codex, whose only file under the session directory is
  // the HOST's `session.jsonl` and carries no composed prompt — the row's
  // observable has no subject on that runtime, and that is a NULL with a reason
  // rather than a product failure. Scoring it FAIL would file a defect against a
  // runtime for not writing a file the row never asked it to write.
  const promptReadable = parent.preamble > 0 && parent.reminder > 0 && (STYLE_MARKER ? parent.marker > 0 : true)
  if (!promptReadable) {
    run.observe(`[${label}] L46 — the COMPOSED PROMPT is not readable on this runtime`, {
      parent,
      note:
        'the parent session is a top-level session under the named style, so a readable prompt store would have to '
        + 'carry it. This one carries ' + parent.preamble + ' session-preamble hit(s) and ' + parent.reminder
        + ' reminder hit(s) over ' + parent.bytes + ' bytes, so there is no composed prompt on disk to read and '
        + 'the row\'s observable has no subject here. Any style-marker hits (' + parent.marker + ') are the '
        + 'MODEL\'S REPLIES obeying the style, which is a weaker and different fact.',
    })
    return reading
  }
  run.check(
    `[${label}] THE CONTROL — the PARENT session's own prompt carries the style`,
    true,
    undefined,
  )
  if (fork !== 'not-offered') {
    run.require(
      `[${label}] THE CONTROL — the fork got its own session and wrote a composed prompt`,
      fork.dir !== undefined && fork.preamble > 0,
      `the fork's own session dir=${fork.dir ?? '(none appeared)'} with ${fork.files} jsonl file(s), `
      + `${fork.bytes} bytes and ${fork.preamble} preamble hit(s). Without a prompt on disk there is nothing to `
      + 'look for the style in, and a zero below would be an unwritten file rather than a style that did not reach it',
    )
  }
  // THE CONTROL for the NAMED clause, and a GATE for the same reason as the
  // parent's. Measured on this build: a pi named subagent becomes a SESSION of
  // its own with its own prompt on disk, while a claude one runs through the
  // SDK's own `Agent` tool and a codex one through `spawn_agent`/`wait_agent`,
  // neither of which mints a host session. Where no child prompt exists to read,
  // the named clause of L46 has no subject on that runtime — a NULL with that
  // sentence, not a FAIL against a runtime for delegating differently.
  const namedReadable = named.dir !== undefined && named.preamble > 0
  if (!namedReadable) {
    run.observe(`[${label}] L46 — the NAMED subagent's prompt is not readable on this runtime`, {
      named,
      note:
        'the delegation ran (tool calls ' + JSON.stringify(toolCalls) + ') but no child SESSION appeared under '
        + 'this profile, so there is no composed prompt on disk for the subagent. The parent\'s prompt above '
        + 'carries the style, so the reader works; what is missing is a child prompt store, and the row\'s '
        + 'subagent clause is a NULL with that reason on this runtime.',
    })
    return reading
  }
  run.check(
    `[${label}] THE CONTROL — the named subagent got its own session and wrote a composed prompt`,
    true,
    undefined,
  )
  if (fork === 'not-offered') {
    // A MEASURED absence, taken off the product's own palette in this same
    // session, not a rig failure and not an assumption: `/subtask` is a PI-only
    // entry on this build, so the fork half of L46 has no subject here.
    run.observe(`[${label}] L46 — the FORK half has no subject on this runtime`, {
      paletteOfferedSubtask: false,
      note:
        'the product\'s own slash palette, read in this session after its first turn, offers no `subtask` entry on '
        + 'this runtime. There is therefore no fork to inherit a style, and the row\'s fork clause is a NULL with '
        + 'that reason rather than a failure.',
    })
  } else {
    run.check(
      `[${label}] L46 — the FORK's composed prompt carries the session output style`,
      fork.reminder > 0 && (STYLE_MARKER ? fork.marker > 0 : true),
      `the fork's own prompt carries ${fork.reminder} reminder hit(s) and ${fork.marker} style-marker hit(s) over `
      + `${fork.bytes} bytes. \`resolveChildOutputStyleId('fork', id)\` returns the id, so the style prose and the `
      + 'host\'s own per-turn reminder are both expected here',
    )
  }
  run.check(
    `[${label}] L46 — the NAMED subagent's composed prompt does NOT carry it`,
    named.reminder === 0 && named.marker === 0,
    `the named subagent's own prompt carries ${named.reminder} reminder hit(s) and ${named.marker} style-marker `
    + `hit(s). \`sub-agents.md:933\` — "a subagent runs its own system prompt, so your output style doesn't shape `
    + 'its responses, except in a fork" — and `resolveChildOutputStyleId(\'named\', id)` returns `undefined`',
  )
  return reading
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const root = configDir()

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the output style a child\'s prompt is composed with')
  if (contaminated !== undefined) blocked(contaminated)

  if (!STYLE_ID || !STYLE_MARKER) {
    blocked(
      'set NESSY_CDP_OUTPUT_STYLE_ID and NESSY_CDP_OUTPUT_STYLE_MARKER first — `scripts/cdp/fixtures/'
      + 'agent-surfaces.ts` writes the style and prints both. The marker has to be a token nothing else in the '
      + 'profile spells, or "the fork\'s prompt carries it" is not a discrimination',
    )
  }

  const cards = await listConnections(session)
  const byFamily = new Map<string, typeof cards[number]>()
  for (const card of cards) {
    const family = runtimeOf(card.providerType)
    const named = family === 'anthropic' ? 'claude' : family === 'codex-runtime' ? 'codex' : family
    if (named === 'pi' || named === 'claude' || named === 'codex') {
      if (!byFamily.has(named)) byFamily.set(named, card)
    }
  }
  run.observe('the cards this profile offers', [...byFamily].map(([family, card]) => ({ family, slug: card.slug })))
  if (byFamily.size === 0) {
    blocked('this profile lists no pi, claude-runtime or codex-runtime card, so no arm of the row has a subject')
  }

  const previousStyle = await session.call<string>(`return await window.electronAPI.getOutputStyle()`)
  run.observe('the style this profile had before the case', previousStyle)
  try {
    await session.call<unknown>(`return await window.electronAPI.setOutputStyle(${JSON.stringify(STYLE_ID)})`)
    const applied = await session.call<string>(`return await window.electronAPI.getOutputStyle()`)
    run.require(
      'THE CONTROL — the style the case asked for is the style the profile now holds',
      applied === STYLE_ID,
      `setOutputStyle(${STYLE_ID}) left the profile on ${JSON.stringify(applied)}. Every arm below would then `
      + 'measure a style nobody selected',
    )

    for (const [family, card] of byFamily) {
      // One arm's rig failure must not take the arms that worked with it: the
      // first drive of this case lost a passing pi arm to a codex-side snapshot
      // read. A throw here is recorded as this arm's own reading.
      try {
        await driveArm(run, session, root, card, family, family)
      } catch (error) {
        run.check(
          `[${family}] the arm ran to a reading`,
          false,
          `the arm threw before it could answer: ${error instanceof Error ? error.message : String(error)}. This is `
          + 'a rig outcome for THIS family, not the row\'s answer for it',
        )
      }
    }

    // ---- the row's own control: the same fork under NO style ----------------
    await session.call<unknown>(`return await window.electronAPI.setOutputStyle('default')`)
    const cleared = await session.call<string>(`return await window.electronAPI.getOutputStyle()`)
    run.require(
      'THE CONTROL — the profile is back on the default style for the control arm',
      cleared === 'default',
      `setOutputStyle('default') left the profile on ${JSON.stringify(cleared)}, so the control arm below would `
      + 'measure the same style as the subject arms and could not falsify anything',
    )
    const controlCard = byFamily.get('pi') ?? [...byFamily.values()][0]
    if (controlCard) {
      const key = await freshSession(session, `CDP ${ID} control ${new Date().toISOString().slice(11, 19)}`)
      const bind = await switchRuntime(session, key.sessionId, controlCard.slug)
      run.check(`[control] the session is bound to ${controlCard.slug}`, bind.ok, bind.ok ? undefined : bind.error)
      await seedForkableConversation(session, key)
      const before = sessionDirs(root, key.workspaceId)
      await sendSlashCommand(session, key, {
        token: 'subtask',
        match: /subtask/i,
        expectComposer: '/subtask ',
        argument: 'Reply with the single word GAMMA and stop. Use no tool.',
        noWait: true,
      })
      const controlRead = await waitForChildPrompt(root, key.workspaceId, before, 300_000)
      const controlParent = readChildPrompt(root, key.workspaceId, key.sessionId)
      run.observe('[control] the PARENT under no style', controlParent)
      run.observe('[control] a fork under NO style', { card: controlCard.slug, ...controlRead })
      run.require(
        '[control] THE CONTROL — the control fork wrote a composed prompt too',
        controlRead.preamble > 0,
        `the control fork's own dir=${controlRead.dir ?? '(not identified)'} carries ${controlRead.files} jsonl `
        + `file(s) and ${controlRead.preamble} preamble hit(s); a zero below would be an unwritten file`,
      )
      run.check(
        'THE ROW\'S CONTROL — a fork under NO style carries neither needle',
        controlRead.reminder === 0 && controlRead.marker === 0,
        `a fork spawned with the profile on \`default\` carries ${controlRead.reminder} reminder hit(s) and `
        + `${controlRead.marker} style-marker hit(s). If the reminder rides every prompt regardless, then "the `
        + 'fork inherits the style" above measured nothing',
      )
    }
  } finally {
    // Restore whatever the profile held before this case touched it.
    await session.call<unknown>(`return await window.electronAPI.setOutputStyle(${JSON.stringify(previousStyle)})`)
      .catch(() => undefined)
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
