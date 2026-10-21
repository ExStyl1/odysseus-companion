/**
 * RS-98 (D1.135) — the forwarded subagent fields, measured as DIFFERENCES: a
 * `maxTurns` cap against no cap (H25), and `background: true` against no flag
 * (H26).
 *
 * ## The row, and which of its four arms this is
 *
 * D1.135 has four: (a) capture an `agentId` and continue it, with a fabricated
 * id, a stopped agent and a re-taken name each refused; (b) a child at
 * `maxTurns: 1` and the Agent result read for a partial marker, control the cap
 * unset; (c) `background: true` and whether the turn returns before the child,
 * control the same definition without it; (d) a codex spawned agent calling
 * `list_sessions` and `send_agent_message`, with `list_mcp_resources` as the
 * negative.
 *
 * **This case is (b) and (c).** They share one rig — two pairs of agent
 * definitions differing in one frontmatter field each — and both are readable
 * from outside the runtime, which (a) and (d) are not on a packaged build:
 * measure sitting 5e measured that only Pi mints a child SESSION, while claude
 * delegates through the SDK's `Agent` tool and codex through
 * `spawn_agent`/`wait_agent`, so there is no child transcript on two of three
 * runtimes and an `agentId` is not a thing this rig can capture and re-address.
 * (a) and (d) are named as owed rather than driven badly.
 *
 * ## The detector, and why it is a FILE the CHILD writes
 *
 * Both arms are questions about how far a child got and when. Neither is legible
 * in a parent transcript: a capped child that was cut off and one that finished
 * both come back as one Agent tool result, and a backgrounded child that is
 * still running is invisible from the parent's side by construction. So each
 * probe agent appends one line per step to `<dir>/<name>.log`:
 *
 *  - **H25** is the LINE COUNT. Three steps, a cap of one turn: a cap that is
 *    forwarded cuts the child off short of three.
 *  - **H26** is the line's TIMESTAMP against the moment the parent turn settled.
 *    A forwarded `background: true` lets the parent return while the child is
 *    still appending, so the last line lands AFTER the settle. The control's
 *    last line lands before it.
 *
 * ## The controls
 *
 *  1. **Each arm is a PAIR.** `cdp-uncapped` and `cdp-foreground` carry the same
 *    body and differ in one frontmatter line. A single number here would be a
 *    reading about the model's compliance; a difference is a reading about the
 *    field.
 *  2. **The child ran at all.** A zero-line log is a child that never started —
 *    a refused definition, a subagent the runtime does not offer, a Bash tool it
 *    was not granted — and that is not `maxTurns` working. The case says so
 *    rather than scoring the zero.
 *  3. **The definitions are on disk and offered.** The four files are read back
 *    before the drive, so "the field did nothing" cannot be a fixture that never
 *    wrote.
 *
 * ## What this case must NOT claim
 *
 * A child that stops at one line has not proved the cap was FORWARDED — it may
 * have decided to stop. That is why the uncapped control runs the same body in
 * the same session: only the difference is evidence, and the case reports the
 * pair rather than the arm.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, transcript } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { FIXTURE_NAMES } from '../fixtures/agent-surfaces.ts'

const ID = 'RS-98'
const TITLE = 'the forwarded subagent fields — a maxTurns cap and a background flag, each against its own control'

/** Where `--subagent-probes` was pointed. The case reads it and never writes it. */
const PROBES = process.env.NESSY_CDP_SUBAGENT_PROBE_DIR

/** Which card to drive. One card at a time is the sitting's own rule. */
const RUNTIME = (process.env.NESSY_CDP_RS98_RUNTIME ?? 'claude').trim()

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.135',
  runtimes: ['claude', 'pi'],
  credentials:
    'owner: one gateway card, named by NESSY_CDP_RS98_RUNTIME (claude or pi). No key is read; the only '
    + 'config write is the fixture\'s four agent definitions, in a config dir created for the run.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, seeded with `bun run scripts/cdp/fixtures/agent-surfaces.ts --config-dir <dir> --subagent-probes <probe dir>`.',
    '2. Launch with the `env -u` launcher; export NESSY_CDP_SUBAGENT_PROBE_DIR=<probe dir>.',
    '3. The case runs each of the four probe agents once from its own session and reads the log each child wrote.',
    '4. H25 is cdp-capped\'s line count against cdp-uncapped\'s; H26 is cdp-background\'s last line timestamp against the moment the parent turn settled, with cdp-foreground as the control.',
  ],
  expected:
    'A forwarded `maxTurns: 1` cuts the child off short of its three steps while the uncapped twin reaches '
    + 'them; a forwarded `background: true` lets the parent turn settle while the child is still appending, '
    + 'where the foreground twin finishes first.',
  detector:
    'a file each CHILD appends to, one line per step — LINE COUNT for the cap, line TIMESTAMP against the '
    + 'parent\'s settle time for the background flag. Neither is legible in the parent\'s transcript.',
  positiveControl:
    'each arm is a PAIR differing in one frontmatter line with an identical body, so a single number is never '
    + 'the evidence; plus the four definitions read back off disk before the drive, so "the field did nothing" '
    + 'cannot be a fixture that never wrote; plus a non-empty log, because a child that never started is not a '
    + 'cap working.',
  doneMeans:
    'H25 and H26 carry a measured verdict with the control that produced it, and the arms this rig cannot '
    + 'reach — H22\'s agentId continuation and H8/codex\'s inherited session tools — are named as owed with '
    + 'the reason, rather than scored off the forwarding code.',
  doNotConflate:
    'A child that stopped early has not proved a cap was forwarded — it may have decided to stop. Only the '
    + 'difference between the pair is evidence. And a zero-line log is a child that never ran, which is a '
    + 'third state and not a cap of zero.',
} as const satisfies SittingRecipe

interface ProbeRead {
  lines: number
  last?: number
  text: string[]
}

/** What the child wrote, with each line's own unix timestamp. */
function readProbe(dir: string, agent: string): ProbeRead {
  const path = join(dir, `${agent}.log`)
  if (!existsSync(path)) return { lines: 0, text: [] }
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return { lines: 0, text: [] } }
  const text = raw.split('\n').filter(Boolean)
  // The body writes `<name> step <n> <unix seconds>`; the timestamp is the child
  // process's own clock, not this case's, which is what makes the H26 comparison
  // a reading about the child rather than about when the case got round to
  // looking.
  const stamps = text.map(line => Number.parseInt(line.trim().split(/\s+/).pop() ?? '', 10)).filter(Number.isFinite)
  const last = stamps.length > 0 ? Math.max(...stamps) : undefined
  return { lines: text.length, ...(last === undefined ? {} : { last }), text }
}

interface ArmResult {
  agent: string
  settledAtUnix: number
  elapsedMs: number
  /**
   * What the child had written AT THE MOMENT the parent turn settled.
   *
   * This is H26's reading and it has to be taken then, not later: on Pi the
   * spawner returns *"Started background subagent task"* and the parent settles
   * while the child is still appending (measured 2026-09-18 — parent settled at
   * 107 170 ms, the child's three lines are stamped 25 and 32 seconds after
   * that). A single read taken afterwards cannot tell a backgrounded child from
   * a fast one.
   */
  probeAtSettle: ProbeRead
  /** What the child had written once it STOPPED growing — H25's reading. */
  probe: ProbeRead
  toolResults: string[]
  /**
   * The turn did not settle inside its budget.
   *
   * A TIMEOUT IS A READING, not a reason to abandon the run: measured
   * 2026-09-18 on the packaged 1.40.0, the first arm sat at one message with
   * `isProcessing: true` for fifteen minutes on `claude-gateway` — no assistant
   * token at all — while the same card had completed ordinary turns minutes
   * earlier. Throwing there would have cost the other three arms AND the
   * comparison that makes any of them mean something, so the arm is recorded and
   * the run continues; the pair's verdict then says which of the two timed out,
   * which is itself the difference the row is asking about.
   */
  timedOut: boolean
  error?: string
}

/** Run one probe agent from its own session and read what the child wrote. */
async function runProbeAgent(
  run: CaseRun,
  session: CdpSession,
  card: { slug: string },
  agent: string,
  probeDir: string,
): Promise<ArmResult> {
  const key = await freshSession(session, `CDP ${ID} ${agent} ${new Date().toISOString().slice(11, 19)}`)
  const bind = await switchRuntime(session, key.sessionId, card.slug)
  run.check(`${agent}: the session is bound to ${card.slug}`, bind.ok, bind.ok ? undefined : bind.error)
  const startedAt = Date.now()
  let timedOut = false
  let error: string | undefined
  // F1.562 — the turn's rows are the ones after this count: nothing checks this session is fresh.
  const beforeTurn = (await transcript(session, key)).length
  // Positively phrased: naming a tool and forbidding it trips Pi's Guardian as
  // prompt injection, and the wreckage reads like a dispatch bug (AGENTS.md).
  try {
    await sendPrompt(
      session,
      key,
      `Use the ${agent} subagent to do its probe steps. Report what it told you.`,
      900_000,
    )
  } catch (thrown) {
    timedOut = true
    error = thrown instanceof Error ? thrown.message : String(thrown)
    run.observe(`${agent}: the turn did NOT settle`, { error: error.slice(0, 300) })
  }
  const settledAt = Date.now()
  const probeAtSettle = readProbe(probeDir, agent)
  // Then WAIT for the child, bounded, because H25 is a question about how far it
  // got and a read taken at the settle would answer it about a background task
  // that had not started writing yet. Stability, not a fixed sleep: two
  // consecutive equal reads twelve seconds apart, or the ceiling.
  let stable = probeAtSettle
  const childDeadline = Date.now() + 240_000
  for (;;) {
    await Bun.sleep(6_000)
    const now = readProbe(probeDir, agent)
    if (now.lines === stable.lines && Date.now() > settledAt + 12_000) { stable = now; break }
    stable = now
    if (Date.now() >= childDeadline) break
  }
  const messages = (await transcript(session, key)).slice(beforeTurn)
  const toolResults = messages
    .filter(row => row.role === 'tool')
    .map(row => `${row.toolName ?? '?'}:${row.toolStatus ?? '?'}:${(row.toolResult ?? '').slice(0, 300)}`)
  return {
    agent,
    settledAtUnix: Math.floor(settledAt / 1_000),
    elapsedMs: settledAt - startedAt,
    probeAtSettle,
    probe: stable,
    toolResults,
    timedOut,
    ...(error === undefined ? {} : { error }),
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const root = configDir()

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the forwarded subagent fields')
  if (contaminated !== undefined) blocked(contaminated)

  if (!PROBES) {
    blocked(
      'NESSY_CDP_SUBAGENT_PROBE_DIR is unset. Seed with `bun run scripts/cdp/fixtures/agent-surfaces.ts '
      + '--config-dir <dir> --subagent-probes <probe dir>` and export it; without it every child\'s log would '
      + 'read as empty for want of a directory to read.',
    )
  }
  const probeDir = PROBES

  // THE THIRD CONTROL — the definitions are on disk, and each carries its field.
  const definitions = ([
    ['capped', FIXTURE_NAMES.cappedAgent, /^maxTurns:/m],
    ['uncapped', FIXTURE_NAMES.uncappedAgent, undefined],
    ['background', FIXTURE_NAMES.backgroundAgent, /^background:/m],
    ['foreground', FIXTURE_NAMES.foregroundAgent, undefined],
  ] as const).map(([role, name, field]) => {
    const path = join(root, 'agents', `${name}.md`)
    const body = existsSync(path) ? readFileSync(path, 'utf8') : ''
    return {
      role, name, present: body.length > 0,
      declares: field ? field.test(body) : !/^(maxTurns|background):/m.test(body),
    }
  })
  run.observe('the four definitions on disk', definitions)
  run.require(
    'THE CONTROL — all four probe definitions are on disk and each carries (or lacks) its own field',
    definitions.every(entry => entry.present && entry.declares),
    `read from ${join(root, 'agents')}: ${JSON.stringify(definitions)}. A missing file or a missing frontmatter `
    + 'line makes every reading below a statement about the fixture rather than about the product',
  )

  const cards = await listConnections(session)
  const wanted = RUNTIME === 'pi' ? 'pi' : 'anthropic'
  const card = cards.find(row => runtimeOf(row.providerType) === wanted)
  if (!card) {
    blocked(
      `NESSY_CDP_RS98_RUNTIME=${RUNTIME} asks for a ${wanted} card and this profile lists `
      + `${cards.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}`,
    )
  }
  run.observe('the card under test', { slug: card.slug, providerType: card.providerType, runtime: wanted })

  // ---- H25: the cap, and its control ------------------------------------
  const capped = await runProbeAgent(run, session, card, FIXTURE_NAMES.cappedAgent, probeDir)
  run.observe('H25 — the CAPPED child (maxTurns: 1)', {
    linesAtSettle: capped.probeAtSettle.lines, lines: capped.probe.lines, elapsedMs: capped.elapsedMs,
    wrote: capped.probe.text, tools: capped.toolResults.length, timedOut: capped.timedOut,
  })
  const uncapped = await runProbeAgent(run, session, card, FIXTURE_NAMES.uncappedAgent, probeDir)
  run.observe('H25 CONTROL — the UNCAPPED child, same body', {
    linesAtSettle: uncapped.probeAtSettle.lines, lines: uncapped.probe.lines, elapsedMs: uncapped.elapsedMs,
    wrote: uncapped.probe.text, timedOut: uncapped.timedOut,
  })

  run.require(
    'THE CONTROL — at least one of the pair ran at all',
    capped.probe.lines > 0 || uncapped.probe.lines > 0,
    'neither child wrote a line. A child that never started is not a cap working — the subagent may not be '
    + 'offered on this runtime, the definition may have been refused, or the Bash grant may be absent. '
    + `Tool results seen on the capped arm: ${JSON.stringify(capped.toolResults.slice(0, 3))}`,
  )
  run.check(
    'D1.135 H25 — the declared `maxTurns: 1` cuts the child off short of its uncapped twin',
    capped.probe.lines < uncapped.probe.lines,
    `capped wrote ${capped.probe.lines} line(s), uncapped ${uncapped.probe.lines}, from the SAME three-step body. `
    + 'Equal counts mean the cap did not reach the child (or that both stopped for their own reasons, which is '
    + 'why the pair is the reading and neither arm is)',
  )

  // ---- H26: the background flag, and its control ------------------------
  const background = await runProbeAgent(run, session, card, FIXTURE_NAMES.backgroundAgent, probeDir)
  const backgroundLate = background.probe.lines > background.probeAtSettle.lines
    || (background.probe.last !== undefined && background.probe.last > background.settledAtUnix)
  run.observe('H26 — the BACKGROUND child (background: true)', {
    linesAtSettle: background.probeAtSettle.lines, lines: background.probe.lines, elapsedMs: background.elapsedMs,
    parentSettledAtUnix: background.settledAtUnix, childLastLineUnix: background.probe.last,
    childStillWritingAfterTheParentSettled: backgroundLate, timedOut: background.timedOut,
  })
  const foreground = await runProbeAgent(run, session, card, FIXTURE_NAMES.foregroundAgent, probeDir)
  const foregroundLate = foreground.probe.lines > foreground.probeAtSettle.lines
    || (foreground.probe.last !== undefined && foreground.probe.last > foreground.settledAtUnix)
  run.observe('H26 CONTROL — the FOREGROUND child, same body', {
    linesAtSettle: foreground.probeAtSettle.lines, lines: foreground.probe.lines, elapsedMs: foreground.elapsedMs,
    parentSettledAtUnix: foreground.settledAtUnix, childLastLineUnix: foreground.probe.last,
    childStillWritingAfterTheParentSettled: foregroundLate, timedOut: foreground.timedOut,
  })

  run.check(
    'D1.135 H26 — a declared `background: true` returns the parent turn before the child has finished',
    backgroundLate && !foregroundLate,
    `background: the parent settled at ${background.settledAtUnix} and the child's last line is `
    + `${background.probe.last ?? 'none'} (${background.probe.lines} line(s), ${background.elapsedMs} ms). `
    + `foreground CONTROL: settled ${foreground.settledAtUnix}, last line ${foreground.probe.last ?? 'none'} `
    + `(${foreground.probe.lines} line(s), ${foreground.elapsedMs} ms). Both arms answering the same way means `
    + 'the flag is not acted on here; the control answering LATE too would mean the instrument cannot separate '
    + 'them on this runtime',
  )

  // The two arms this rig cannot reach, named rather than scored.
  run.observe('owed, with the reason', {
    'H22 — an agentId captured and continued':
      'not reachable from outside: claude delegates through the SDK Agent tool and codex through '
      + 'spawn_agent/wait_agent, neither of which mints a host session this rig can re-address, and the '
      + 'product offers no surface that hands back an agent id to continue.',
    'H8/codex — a spawned agent calling list_sessions and send_agent_message':
      'needs the codex card and a spawned agent that can be given tool calls of its own; this case drives one '
      + 'card at a time by the sitting\'s own rule and its probe bodies are Bash-only by design.',
  })
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
