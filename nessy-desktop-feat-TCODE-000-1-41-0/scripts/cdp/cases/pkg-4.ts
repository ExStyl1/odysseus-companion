/**
 * PKG-4 — P3.297, MEASUREMENT ONLY: if claude is handed a skill as a DIRECTORY
 * the way its own documentation describes, does its native skill mechanism see
 * it?
 *
 * The row is an owner-visible posture, recorded for a sitting and explicitly
 * not to be built in this wave. W2-j (P3.275) and P6.59 met the same wall from
 * two sides: the host passes `plugins: []` and renders skills into the prompt as
 * text, and `agent-sdk/skills.md` says skills are FILESYSTEM ARTIFACTS with no
 * registration API. So the thin-host reading — hand claude the directories and
 * stop rendering them for that runtime — cannot be evaluated from the source
 * alone. Somebody has to put a directory in front of the shipped binary and look.
 *
 * ## What makes this measurable today, with no code change
 *
 * `buildClaudeTurnShapeOptions` already passes
 * `settingSources: ['user', 'project', 'local']`, and `permissions.md` is
 * explicit that project-scoped skills load through the `project` source. A
 * session whose working directory contains `.claude/skills/<name>/SKILL.md` is
 * therefore ALREADY handing claude a skill directory — nothing in the host has
 * to change for the question to be asked. That is the whole point of asking it
 * before designing anything.
 *
 * ## The detector, and the two ways it could lie
 *
 * The SDK child's own transcript is the instrument: a native skill invocation
 * leaves a `Skill` tool_use in it, and the host cannot fabricate one there.
 *
 *  - **A model that answers the nonce from prose.** The SKILL.md body is not in
 *    the prompt unless something loaded it, so a correct nonce is itself
 *    evidence — but only if the nonce is not ALSO sitting in the transcript for
 *    another reason. So the case records where every occurrence came from.
 *  - **A model that declines to use a skill it can see.** Absence of a `Skill`
 *    call is not absence of the skill, which is why the case also asks the model
 *    to enumerate what it was given, and reports the enumeration verbatim rather
 *    than scoring it.
 *
 * Nothing here is asserted as correct or incorrect: the row's verdict belongs to
 * the owner. The checks are "the measurement was taken", not "the answer is the
 * one we wanted".
 *
 * ## The second half: does `context: fork` dispatch?
 *
 * The row names three native skill features — fork, frontmatter hooks, the
 * `/skill` listing — and fork is the one with an unambiguous, readable answer,
 * because BOTH possible mechanisms leave a distinct trace:
 *
 *  - **the HOST's path.** `base-agent.ts`'s `dispatchForkedSkillInvocations`
 *    writes a literal `<forked-skill …>` block into the composed message for
 *    every skill it resolved with `context: fork`, and when the backend has no
 *    child spawner it says so in words — `status="unavailable"`, "This skill
 *    declares `context: fork` … Its instructions were deliberately NOT loaded".
 *    That block is host-authored, so its presence proves the HOST resolved the
 *    skill.
 *  - **the SDK's own path** would leave a `Skill` tool call in the child's
 *    transcript and no `<forked-skill>` block at all.
 *
 * So the two are separable by reading one transcript, and the interesting
 * outcome for P3.297 is the THIRD one: neither. A skill delivered only as a
 * directory is never resolved by the host — the host renders the skills IT
 * knows about and passes `plugins: []` — so a `<forked-skill>` block cannot
 * appear for it, and whether anything else picks it up is exactly the question
 * the owner is being asked to decide.
 *
 * A second skill directory carries the `context: fork` frontmatter, so the two
 * questions do not share one file and one answer cannot be mistaken for the
 * other.
 *
 * ## Rig notes carried from PKG-6, on this same profile and artefact
 *
 * Three faults cost that case four runs, and all three are structural to this
 * profile rather than to that row:
 *
 *  - `updateWorkingDirectory` throws `Request timeout: sessions:command
 *    (30000ms)` on a mutation that LANDS, and retrying collides with itself —
 *    `acquireSessionMutationBoundary` refuses the second by name
 *    (`session-project-mutation-busy`). Issue once, wait, re-issue only when
 *    nothing is in flight.
 *  - the app's own 30 s RPC budget expires on `sessions:get` under load; that
 *    budget is the APP's, so no harness timeout reaches it. A timed-out read is
 *    UNKNOWN, never an answer.
 *  - this profile holds ~740 sessions, so CREATING one re-renders the sidebar
 *    and can block the renderer past the harness's per-command budget. Hence one
 *    session per question rather than one per turn, and a 600 s command budget.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import { resolveAppUnderTest } from '../lib/bundle.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, exitCodeFor, runCase, type CaseRun } from '../lib/report.ts'
import { configDir, type RuntimeSessionEntry } from '../lib/runtime-session-log.ts'
import {
  listConnections,
  runtimeOf,
  bindProject,
  switchRuntime,
  trustFixtureProject,
  waitForConnection,
} from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, isProcessing, listSessions, waitFor, type SessionKey } from '../lib/state.ts'
import { checkAbsence, positive } from '../lib/turn-evidence.ts'
import { fixturePaths } from '../fixtures/runtime-switch.ts'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'

const ID = 'PKG-4'
const TITLE = 'P3.297 measurement: does claude\'s native skill mechanism see a skill handed to it as a directory'

const TURN_TIMEOUT_MS = 300_000
/** 600 s — see the rig notes in this file's header; 740 sessions is the cost. */
const CDP_COMMAND_TIMEOUT_MS = 600_000

const SKILL_NAME = 'pkg4-probe'
const FORK_SKILL_NAME = 'pkg4-fork'

/* ------------------------------------------------------------------ *
 * Rig hardening — see the header. Kept local: these are facts about the
 * operator profile, not harness-wide policy.
 * ------------------------------------------------------------------ */

let rpcTimeouts = 0

async function tolerant<T>(read: () => Promise<T>, fallback: T, attempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (!/Request timeout|cdp-eval-threw/.test(message)) throw cause
      rpcTimeouts += 1
      if (attempt === attempts) return fallback
      await Bun.sleep(2_000)
    }
  }
  return fallback
}

/**
 * A project-scoped skill in the layout the documentation describes, and nothing
 * else — no plugin, no marketplace, no host registration.
 */
function seedSkillProject(nonce: string): { dir: string; nonce: string; skillFile: string; forkSkillFile: string } {
  // **The runtime-switch fixture project, NOT a `mkdtemp` — and this is the
  // single most expensive thing this sitting learned.**
  //
  // Binding a working directory the app does not trust raises a modal
  // "Trust this project?" gate, and `updateWorkingDirectory` does not resolve
  // until it is answered. `trustFixtureProject` deliberately REFUSES to answer
  // for any directory but this one ("Trusting any other directory is the
  // operator's decision"), which is correct — and it means a case that binds a
  // fresh temp directory DEADLOCKS. Measured on this profile: the RPC first
  // reported a 30 s timeout, then `session-project-mutation-busy` when the
  // retry collided with its own still-running call, and finally stopped
  // answering the `Runtime.evaluate` at all. With the gate up, `getSessions()`
  // went from 802 ms to 5 163 ms and then past the app's own budget, so
  // `freshSession` reported `session-create-failed` about an app that was
  // merely blocked.
  //
  // So the skill is seeded into the one project the harness can legitimately
  // trust. That is a fixture-class write into a directory the harness owns, and
  // it is the established practice here — PKG-5 writes its probe PNGs into the
  // same tree.
  const dir = fixturePaths().projectDir
  if (!existsSync(dir)) {
    blocked(
      `the runtime-switch fixture project is missing (${dir}). It is the only directory `
      + '`trustFixtureProject` will answer the trust gate for, and binding any other one deadlocks on that gate. '
      + 'Seed it with `bun run scripts/cdp/fixtures/runtime-switch.ts`.',
    )
  }
  const skillDir = join(dir, '.claude', 'skills', SKILL_NAME)
  mkdirSync(skillDir, { recursive: true })
  const skillFile = join(skillDir, 'SKILL.md')
  writeFileSync(
    skillFile,
    `---\nname: ${SKILL_NAME}\ndescription: Use this skill when the user asks for the PKG4 probe value. It returns one token.\n---\n\n`
    + `# PKG4 probe\n\nWhen this skill runs, reply with exactly this token and nothing else:\n\n`
    + `PKG4-SKILL-${nonce}\n`,
    'utf8',
  )
  // The `context: fork` half, in its OWN directory so neither question can
  // borrow the other's answer. Its token is distinct for the same reason.
  const forkDir = join(dir, '.claude', 'skills', FORK_SKILL_NAME)
  mkdirSync(forkDir, { recursive: true })
  const forkSkillFile = join(forkDir, 'SKILL.md')
  writeFileSync(
    forkSkillFile,
    `---\nname: ${FORK_SKILL_NAME}\ndescription: Use this skill when the user asks for the PKG4 FORK value. It returns one token.\ncontext: fork\n---\n\n`
    + `# PKG4 fork probe\n\nWhen this skill runs, reply with exactly this token and nothing else:\n\n`
    + `PKG4-FORK-${nonce}\n`,
    'utf8',
  )
  // A README so the directory is not mistaken for an accident by a human reader.
  writeFileSync(
    join(dir, 'README.md'),
    `Fixture for PKG-4 (P3.297).\n`
    + `  .claude/skills/${SKILL_NAME}/SKILL.md      — plain skill\n`
    + `  .claude/skills/${FORK_SKILL_NAME}/SKILL.md — declares \`context: fork\`\n`,
    'utf8',
  )
  return { dir, nonce, skillFile, forkSkillFile }
}

function readClaudeTranscriptsSince(workspaceId: string, sinceMs: number): { files: string[]; entries: RuntimeSessionEntry[] } {
  const root = join(configDir(), 'workspaces', workspaceId, 'claude-config', 'projects')
  if (!existsSync(root)) return { files: [], entries: [] }
  const files: string[] = []
  for (const dir of readdirSync(root)) {
    const child = join(root, dir)
    if (!statSync(child).isDirectory()) continue
    for (const name of readdirSync(child)) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(child, name)
      if (statSync(file).mtimeMs >= sinceMs - 1_000) files.push(file)
    }
  }
  const entries: RuntimeSessionEntry[] = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const raw = JSON.parse(trimmed) as Record<string, unknown>
        entries.push({ type: String(raw.type ?? ''), text: '', raw })
      } catch { /* a partially written line is not evidence */ }
    }
  }
  return { files, entries }
}

/** Tool names used in the transcript, so "which tools exist" is a reading. */
function toolNamesIn(entries: RuntimeSessionEntry[]): string[] {
  const names = new Set<string>()
  for (const entry of entries) {
    const message = entry.raw.message as { content?: unknown } | undefined
    const content = Array.isArray(message?.content) ? message!.content : []
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') names.add(block.name)
    }
  }
  return [...names]
}

async function body(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const app = resolveAppUnderTest(session)
  run.observe('app-under-test', { kind: app.kind, via: app.via })
  if (app.kind !== 'packaged') {
    blocked(`this row is owed on the SHIPPED artefact; the CDP target is ${app.kind} (${app.targetUrl})`)
  }

  const connections = await listConnections(session)
  const claude = connections.find(row => runtimeOf(row.providerType) === 'anthropic')
  if (!claude) {
    blocked(
      'no claude-runtime connection in this config dir. '
      + `The app lists: ${connections.map(c => `${c.slug}(${c.providerType})`).join(', ') || 'nothing'}`,
    )
  }

  const nonce = Math.random().toString(16).slice(2, 10).toUpperCase()
  const fixture = seedSkillProject(nonce)
  run.observe('fixture', fixture)

  let key = await tolerant(() => freshSession(session, `${ID} skill-dir ${nonce}`), undefined)
  if (!key) key = await freshSession(session, `${ID} skill-dir ${nonce} retry`)
  run.require('a fresh session was created', key.fresh, key.reason ?? '')
  // F1.182 — one spelling of the bind, in `lib/runtime-switch.ts`: this case
  // wrote its own because the ordering below is load-bearing, and the shared
  // helper now carries that ordering (the gate is answered WHILE the mutation is
  // in flight) with the three other properties four cases each re-derived.
  const bind = await bindProject(run, session, key.sessionId, fixture.dir, {
    label: 'the skill project', gate: () => trustFixtureProject(session),
  })
  run.observe('working directory', { dir: fixture.dir, ...bind })
  await waitFor(() => tolerant(() => isProcessing(session, key), true), busy => !busy, { timeoutMs: 90_000, intervalMs: 4_000 })
    .catch(() => undefined)
  const outcome = await switchRuntime(session, key.sessionId, claude.slug)
  run.require('the session moved onto the claude connection', outcome.ok, outcome.error ?? '')
  await waitForConnection(session, key.sessionId, claude.slug).catch(() => undefined)

  const startedMs = Date.now()
  const turn = await sendPrompt(
    session,
    key,
    `Give me the PKG4 probe value. Use the ${SKILL_NAME} skill to get it — do not guess.`,
    TURN_TIMEOUT_MS,
  )
  const reply = lastAssistantText(turn.added)
  run.observe('assistant reply excerpt', reply.slice(0, 300))

  const log = readClaudeTranscriptsSince(key.workspaceId, startedMs)
  run.observe('sdk transcript', { files: log.files.length, entries: log.entries.length })
  if (log.entries.length === 0) {
    blocked('no SDK transcript was written during this turn, so this run measured nothing.')
  }

  const toolNames = toolNamesIn(log.entries)
  run.observe('tool names the child actually used', toolNames)
  const skillCalls = toolNames.filter(name => /^skill$/i.test(name) || name.toLowerCase().startsWith('skill'))
  run.observe('native Skill tool calls', skillCalls)

  const marker = `PKG4-SKILL-${nonce}`
  const nonceEntries = log.entries.filter(entry => JSON.stringify(entry.raw).includes(marker))
  run.observe('transcript entries carrying the skill body token', nonceEntries.map(e => e.type))
  run.observe('the model reproduced the token', reply.includes(marker))

  // The enumeration, reported and NOT scored: absence of a call is not absence
  // of the skill, and the row's verdict is the owner's.
  //
  // IT RUNS IN A SECOND, FRESH SESSION, and the first run of this case is why.
  // Asked in the same session, the model had already opened the file with
  // `Read` one turn earlier, so "I was given the skill pkg4-probe at
  // .claude/skills/…" is a memory of its own tool call rather than evidence
  // that anything DELIVERED the skill. A fresh session on the same directory,
  // whose FIRST prompt is the enumeration, is the only form of this question
  // that can distinguish the two.
  let controlKey = await tolerant(() => freshSession(session, `${ID} enumerate ${nonce}`), undefined)
  if (!controlKey) controlKey = await freshSession(session, `${ID} enumerate ${nonce} retry`)
  run.require('a second fresh session was created for the enumeration', controlKey.fresh, controlKey.reason ?? '')
  const controlBind = await bindProject(run, session, controlKey.sessionId, fixture.dir, {
    label: 'the enumeration session', gate: () => trustFixtureProject(session),
  })
  run.observe('enumeration working directory', { dir: fixture.dir, ...controlBind })
  await waitFor(() => tolerant(() => isProcessing(session, controlKey), true), busy => !busy, { timeoutMs: 90_000, intervalMs: 4_000 })
    .catch(() => undefined)
  const controlSwitch = await switchRuntime(session, controlKey.sessionId, claude.slug)
  run.require('the enumeration session moved onto the claude connection', controlSwitch.ok, controlSwitch.error ?? '')
  await waitForConnection(session, controlKey.sessionId, claude.slug).catch(() => undefined)

  const controlStartedMs = Date.now()
  const control = await sendPrompt(
    session,
    controlKey,
    'Without calling ANY tool: list the exact names of any SKILLS you were given for this project, '
    + 'and say whether you have a tool for invoking a skill. If you were given no skills, reply with exactly: NONE',
    TURN_TIMEOUT_MS,
  )
  const controlText = lastAssistantText(control.added)
  run.observe('skill enumeration in a FRESH session (verbatim, unscored)', controlText.slice(0, 900))
  const controlLog = readClaudeTranscriptsSince(controlKey.workspaceId, controlStartedMs)
  const controlTools = toolNamesIn(controlLog.entries)
  run.observe('tools the enumeration turn used', controlTools)
  // F1.504 — "no tool" is also what a turn that never answered, or an SDK
  // transcript that recorded nothing, reads as.
  checkAbsence(
    run,
    'the enumeration answered without reading the skill file itself',
    controlTools.length === 0,
    positive(controlText.trim().length > 0 && controlLog.entries.length > 0, 'enumeration answer and an SDK transcript of the turn',
      `${controlText.trim().length} chars of answer; SDK transcript entries ${controlLog.entries.length}`),
    controlTools.length === 0
      ? 'no tool call — whatever it names, it was handed'
      : `it used ${controlTools.join(', ')}, so the enumeration is not independent evidence`,
  )

  // ---- the `context: fork` half --------------------------------------
  // Run in the ENUMERATION session, which has asked for nothing yet and has
  // used no tool: the plain-skill session already read a SKILL.md, and a model
  // that has seen one skill file is not a clean rig for asking about another.
  const forkStartedMs = Date.now()
  const forkTurn = await sendPrompt(
    session,
    controlKey,
    `Give me the PKG4 FORK value. Use the ${FORK_SKILL_NAME} skill to get it.`,
    TURN_TIMEOUT_MS,
  )
  const forkReply = lastAssistantText(forkTurn.added)
  const forkLog = readClaudeTranscriptsSince(controlKey.workspaceId, forkStartedMs)
  const forkTools = toolNamesIn(forkLog.entries)
  const forkRaw = forkLog.entries.map(entry => JSON.stringify(entry.raw)).join('\n')
  // `<forked-skill` is HOST-authored (`base-agent.ts`
  // `dispatchForkedSkillInvocations`), so its presence proves the host resolved
  // the skill and its `status` says what happened next. Its ABSENCE, with the
  // skill delivered only as a directory, is the P3.297 wall itself.
  const forkedSkillBlocks = forkRaw.match(/<forked-skill[^>]*>/g) ?? []
  const forkMarker = `PKG4-FORK-${nonce}`
  run.observe('context: fork · what the turn produced', {
    hostForkedSkillBlocks: forkedSkillBlocks,
    toolsUsed: forkTools,
    transcriptEntries: forkLog.entries.length,
    modelReproducedTheForkToken: forkReply.includes(forkMarker),
    forkTokenReachedTheTranscript: forkRaw.includes(forkMarker),
    replyExcerpt: forkReply.slice(0, 300),
  })
  run.check(
    'the context: fork turn produced a transcript to read',
    forkLog.entries.length > 0,
    'without one this half measured nothing',
  )

  run.check(
    'the measurement was taken on the packaged artefact',
    log.entries.length > 0 && reply.trim().length > 0,
    'transcript read and a reply produced',
  )
  run.observe('app RPC reads that timed out and were retried', rpcTimeouts)
  run.observe('VERDICT (for the owner sitting)', {
    skillDirectoryHandedOver: `${fixture.dir}/.claude/skills/${SKILL_NAME}/SKILL.md`,
    nativeSkillToolUsed: skillCalls.length > 0,
    toolNamesUsed: toolNames,
    skillBodyTokenReachedTheTranscript: nonceEntries.length > 0,
    modelReproducedTheToken: reply.includes(marker),
    enumerationSaysNone: /(^|\b)NONE(\b|$)/.test(controlText.trim()),
    enumerationUsedNoTools: controlTools.length === 0,
    contextFork: {
      skillDirectoryHandedOver: `${fixture.dir}/.claude/skills/${FORK_SKILL_NAME}/SKILL.md`,
      hostForkedSkillBlocks: forkedSkillBlocks,
      hostResolvedTheSkill: forkedSkillBlocks.length > 0,
      toolsUsed: forkTools,
      modelReproducedTheForkToken: forkReply.includes(forkMarker),
      note:
        'A `<forked-skill …>` block is written by the HOST for every skill it resolved with `context: fork`; '
        + 'none can appear for a skill the host never resolved, which is what delivering it only as a directory '
        + 'means. So an empty list here is the wall this row describes, not a fork that failed.',
    },
    rpcTimeoutsRetried: rpcTimeouts,
  })
}

if (import.meta.main) {
  const result = await runCase(ID, TITLE, body, { timeoutMs: CDP_COMMAND_TIMEOUT_MS })
  process.exit(exitCodeFor(result.status))
}

export { ID, TITLE, body }
