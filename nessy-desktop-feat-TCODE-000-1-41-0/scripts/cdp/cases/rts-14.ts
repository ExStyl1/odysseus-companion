/**
 * RTS-14 — the full switch matrix: pi ↔ claude ↔ codex, all six directed
 * pairs, in ONE conversation, with every leg doing real work first.
 *
 * Owner request 2026-08-21: each runtime sends 2–3 messages, makes tool calls
 * (and, on Pi, spawns a subagent), then hands the conversation to the next
 * runtime — over every possible direction. Six directed pairs exist over three
 * runtimes; an Eulerian circuit over that digraph covers each exactly once:
 *
 *   pi → claude → codex → pi → codex → claude → pi        (7 legs, 6 switches)
 *
 * ## Three carry tiers, and the assertions differ per leg BY DESIGN
 *
 * - **native into Claude** (leg 2): T2 rebuilds the SDK's own transcript, so
 *   the arriving model must know a fact that exists ONLY in a tool result.
 * - **native into Codex** (legs 3 AND 5): Codex is deliberately absent from
 *   `ANCHORED_PROVIDERS`, so EVERY switch into it re-injects the whole history
 *   over `thread/inject_items` — the second arrival is native again, not a
 *   resume, and must know tool facts from legs it never ran.
 * - **anchored returns** (pi legs 4/7, claude leg 6): the runtime resumes its
 *   OWN record and receives only the missed span as the trimmed text tail
 *   (D7). Its own tool facts are still known (they live in its own record);
 *   the OTHER runtimes' tool facts are deliberately NOT asserted on these
 *   legs — the text tail is prose-only, and that limit is the recorded design,
 *   not a defect this case should file.
 *
 * ## Fact taxonomy, one family per leg
 *
 * - `PROSE-k`: a NATO-named label (alpha…foxtrot) planted in conversation text.
 * - `TOOL-k`: the build tag inside `build-info-leg<k>.txt`, written by the CASE
 *   into the fixture repo and read by the model with `cat`. The codeword never
 *   appears in any prompt, so it can only cross inside a carried tool result
 *   (or the runtime's own record). The reply is pinned to "DONE" so it does
 *   not leak into prose.
 * - `FORK-1`: the outcome a /subtask child reports back on leg 1 — the
 *   subagent half of the owner's request. The child's own transcript is out
 *   of carry scope (sidechains — recorded in T2); what carries is the outcome
 *   row in the PARENT transcript, and that is what is asserted.
 *
 * The structural detector (`previewRuntimeSwitch`) runs before every switch and
 * must name the tier the behavioural assertions assume — the AGENTS.md rule
 * that a case's detector is the thing most likely to be wrong.
 *
 * ## Every leg PROVES its own plant before anything is asked to recall it (T22)
 *
 * `workLeg` planted a tool-only fact by asking the model to `cat` a file and
 * asserted NOTHING about the tool row, which made this case able to report a
 * carry regression about a fact that never entered the conversation. Measured
 * on the packaged build twice (2026-08-21): both Claude legs answered `DONE`
 * without running anything — the tag occurs **zero** times in the Claude SDK's
 * own transcript and the app's transcript carries no tool row for stage 2 or
 * stage 6 — and the three downstream recalls went red, reading exactly like a
 * broken carry. The carry was fine in the same run: Pi's stage-1 fact reached
 * codex two legs later and every prose label landed.
 *
 * So a leg now READS ITS OWN TOOL ROWS back out of the app before moving on:
 *
 *   - the plant is verified against `getSessionMessages` — a `role: 'tool'` row
 *     that literally contains this leg's tag, the same detector RTS-15 uses;
 *   - a missing plant is RETRIED ONCE with RTS-15's emphatic wording, which was
 *     written for this exact failure ("Actually execute … running it is the
 *     whole task") after the same model answered `DONE` without running;
 *   - a plant still missing after the retry FAILS THE CASE AT THE PLANT, with
 *     its own message, and the run stops there. It never reaches a carry check.
 *
 * That last rule is the point. A red must say what is broken, and "the model
 * declined to run a command" and "the switch dropped a tool result" are not the
 * same finding — the old shape reported the second when the first had happened.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CdpSession } from '../lib/connect.ts'
import { main, blocked, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, setPermissionMode } from '../lib/state.ts'
import { sendPrompt, lastAssistantText } from '../lib/chat.ts'
import { newCodeword, memoryLeaks } from '../lib/codeword.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { fixturePaths } from '../fixtures/runtime-switch.ts'
import { startFork, waitForForkSettled } from '../lib/fork.ts'
import {
  listConnections,
  requireRuntimeTrio,
  resolveConfigDir,
  runtimeOf,
  bindProject,
  switchRuntime,
  trustFixtureProject,
  waitForConnection,
} from '../lib/runtime-switch.ts'

const ID = 'RTS-14'
const TITLE = 'The full switch matrix: pi ↔ claude ↔ codex carry each runtime’s work over all six directed pairs'

type Role = 'pi' | 'claude' | 'codex'

/** The Eulerian circuit: every directed pair of the three runtimes, once. */
const CIRCUIT: Role[] = ['pi', 'claude', 'codex', 'pi', 'codex', 'claude', 'pi']

/** Which carry tier the PREVIEW must name when switching INTO leg k (k ≥ 2). */
const EXPECTED_TIER: Record<number, 'native' | 'anchor'> = {
  2: 'native', // claude, first arrival — T2 rebuild
  3: 'native', // codex, never anchored — T1a/T1b inject
  4: 'anchor', // pi return — own sidecar + text tail
  5: 'native', // codex AGAIN — still native, by ANCHORED_PROVIDERS design
  6: 'anchor', // claude return — own transcript + text tail
  7: 'anchor', // pi return
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)
  const slugOf: Record<Role, string> = { pi: trio.pi, claude: trio.claude, codex: trio.codex }

  const connections = await listConnections(session)
  for (const role of ['claude', 'codex'] as const) {
    const conn = connections.find(c => c.slug === slugOf[role])
    if (!conn || runtimeOf(conn.providerType) === 'pi') {
      blocked(`no ${role} card at slug ${slugOf[role]}. Seen: `
        + connections.map(c => `${c.slug}(${c.providerType})`).join(', '))
    }
  }

  const { projectDir } = fixturePaths()
  if (!existsSync(join(projectDir, '.git'))) {
    blocked(`no fixture repo at ${projectDir} — run \`bun run scripts/cdp/fixtures/runtime-switch.ts\``)
  }

  const key = await freshSession(session, `${ID} full matrix`)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')
  await bindProject(run, session, key.sessionId, projectDir, { gate: () => trustFixtureProject(session) })
  await switchRuntime(session, key.sessionId, trio.pi)
  run.require(
    'the session starts on Pi',
    (await waitForConnection(session, key.sessionId, trio.pi)) === trio.pi,
    trio.pi,
  )
  // The documented mode that does not ask — this case is about the carry, not
  // permission cards (RTS-5 owns mode enforcement across a switch).
  await setPermissionMode(session, key.sessionId, 'bypassPermissions')

  const PROSE: string[] = ['', ...CIRCUIT.map(() => newCodeword())]
  const TOOL: string[] = ['', ...CIRCUIT.map(() => newCodeword())]
  const FORK = newCodeword()

  /**
   * Plant this leg's facts: a named prose label, a tool-result-only build tag,
   * leg 1 a fork.
   *
   * DELIBERATELY BENIGN, and the first version of this case is why: dotfiles
   * named `.rts14-secret-*` plus "do not repeat the output" plus
   * `bypassPermissions` read to the model as a credential-exfiltration probe —
   * it refused the `cat` outright (so the tool facts never entered the
   * transcript), refused the recalls, and then its REFUSAL REASONING itself
   * crossed every subsequent switch intact, with legs 3–7 citing the verdict
   * leg 2 made on a different runtime. That run proved the carry while failing
   * every recall row. Plain filenames and neutral phrasing keep this case
   * measuring the carry rather than the model's (correct) safety posture.
   */
  const NATO = ['', 'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf']

  /**
   * The app's own account of this session's tool rows, and whether one of them
   * carries `word`.
   *
   * `getSessionMessages` is the same source RTS-15's plant check reads, and it
   * is the app's, not the case's narration: a `role: 'tool'` row exists only
   * because a tool really ran. Scoped to `role: 'tool'` on purpose — the tag in
   * an ASSISTANT message would mean the model quoted it, which is precisely the
   * thing a tool-only fact must not be able to do.
   */
  const toolRowsCarrying = async (word: string): Promise<{ tools: number; carries: boolean }> =>
    session.call<{ tools: number; carries: boolean }>(`
      const s = await window.electronAPI.getSessionMessages(${JSON.stringify(key.sessionId)})
      if (!s) throw new Error('session-not-found: ' + ${JSON.stringify(key.sessionId)})
      const rows = (s.messages ?? []).filter(m => m.role === 'tool')
      return { tools: rows.length, carries: rows.some(m => JSON.stringify(m).includes(${JSON.stringify(word)})) }
    `)

  const workLeg = async (leg: number): Promise<void> => {
    await sendPrompt(
      session,
      key,
      `For this conversation, the ${NATO[leg]} label is ${PROSE[leg]}. `
      + 'Do not write it to memory or to any file — keep it in this conversation. Reply with the single word OK.',
      300_000,
    )
    const infoFile = `build-info-leg${leg}.txt`
    writeFileSync(join(projectDir, infoFile), `build tag for stage ${leg}: ${TOOL[leg]}\n`)
    await sendPrompt(
      session,
      key,
      `Run the shell command \`cat ${infoFile}\` in the current project directory, `
      + 'and to keep the transcript short reply with just the word DONE.',
      300_000,
    )
    // ---- the plant assertion (T22) -----------------------------------------
    // Nothing downstream means anything if this leg's fact never entered the
    // conversation. The retry uses RTS-15's emphatic wording verbatim, which
    // was written for this exact failure on this exact model.
    let planted = await toolRowsCarrying(TOOL[leg]!)
    if (!planted.carries) {
      run.observe(`leg ${leg} plant retried`, `no tool row carried the stage-${leg} tag after the first ask `
        + `(${planted.tools} tool row(s) in the session) — re-asking emphatically`)
      await sendPrompt(
        session,
        key,
        `Actually execute the shell command \`cat ${infoFile}\` with your shell tool, in the current project `
        + 'directory. Do not answer from memory and do not skip the command — running it is the whole task. '
        + 'Then, to keep the transcript short, reply with just the word DONE and nothing else.',
        300_000,
      )
      planted = await toolRowsCarrying(TOOL[leg]!)
    }
    run.observe(`leg ${leg} plant`, { tools: planted.tools, carriesTag: planted.carries })
    // `require`, so a missing plant stops the case HERE. A plant that never
    // happened cannot be carried, and scoring the carry checks against it is
    // how two packaged runs reported a carry regression that had not occurred.
    run.require(
      `leg ${leg} (${CIRCUIT[leg - 1]}): the tool-only fact really entered the conversation`,
      planted.carries,
      // The failure sentence only on failure. `check` prints whatever detail it
      // is given, and "ok … the model did not run it" is a line that argues
      // with itself — the same trap COMPACT-LIFE's cleanup check documents.
      planted.carries
        ? `${planted.tools} tool row(s) in the session`
        : `no role:'tool' row carries ${TOOL[leg]} after two asks — the model did not run \`cat ${infoFile}\`, `
          + 'so nothing downstream is a carry result',
    )
    if (leg === 1) {
      const fork = await startFork(session, key, `Reply with exactly: the build codename is ${FORK}`)
      if (fork.child) {
        const settled = await waitForForkSettled(session, key, fork.child.agentId)
        run.observe('leg 1 fork', { agentId: fork.child.agentId, status: settled?.status })
      } else {
        run.check('leg 1: the /subtask fork registered', false, 'no child registered')
      }
    }
  }

  /** Ask the arriving runtime for named facts; score each by codeword. */
  const recall = async (
    leg: number,
    wants: Array<{ label: string; question: string; word: string }>,
  ): Promise<void> => {
    const numbered = wants.map((w, i) => `(${i + 1}) ${w.question}`).join(' ')
    const reply = await sendPrompt(
      session,
      key,
      'From what has already happened in this conversation (no need to read files or run anything), '
      + `answer as a numbered list: ${numbered}`,
      600_000,
    )
    const answer = lastAssistantText(reply.added)
    run.observe(`leg ${leg} recall answer`, answer.slice(0, 500))
    for (const w of wants) {
      run.check(`leg ${leg} (${CIRCUIT[leg - 1]}): ${w.label}`, answer.includes(w.word), `expected ${w.word}`)
    }
  }

  // --- leg 1: pi does its work ---------------------------------------------
  await workLeg(1)

  // --- the circuit ----------------------------------------------------------
  for (let leg = 2; leg <= CIRCUIT.length; leg += 1) {
    const role = CIRCUIT[leg - 1]!
    const slug = slugOf[role]
    const expectedTier = EXPECTED_TIER[leg]!

    const preview = await session.call<{ kind?: string; historyCarry?: string } | null>(`
      try {
        return await window.electronAPI.sessionCommand(
          ${JSON.stringify(key.sessionId)},
          { type: 'previewRuntimeSwitch', connectionSlug: ${JSON.stringify(slug)} },
        )
      } catch (e) { return { error: String(e && (e.code || e.message) || e) } }
    `)
    run.observe(`leg ${leg} preview → ${role}`, preview)
    run.check(
      `leg ${leg}: the server plans a ${expectedTier.toUpperCase()} carry into ${role}`,
      preview?.historyCarry === expectedTier,
      `${preview?.kind} / ${preview?.historyCarry}`,
    )

    const outcome = await switchRuntime(session, key.sessionId, slug)
    run.observe(`leg ${leg} switch → ${role}`, outcome)
    run.require(
      `leg ${leg}: the switch onto ${slug} was accepted`,
      outcome.ok,
      // The DETAIL, not just the code. The packaged wave saw one bare
      // `HANDLER_ERROR` here — on this very leg family — and had nothing to say
      // about it because the surface carried no cause (`switchRuntime` now
      // captures the wrapper message, `data` and the `cause` chain).
      outcome.ok ? '' : `${outcome.error ?? ''} ${JSON.stringify(outcome.errorDetail ?? {})}`.trim(),
    )
    run.require(
      `leg ${leg}: the session reports ${slug}`,
      (await waitForConnection(session, key.sessionId, slug)) === slug,
      slug,
    )

    // Tier-specific recall. Tool facts are asserted only where the tier
    // carries them: native legs know OTHER runtimes' tool results; anchored
    // returns know their OWN and receive the rest as prose-only tail.
    if (leg === 2) {
      await recall(leg, [
        { label: 'knows the tool-only secret from pi’s leg', question: 'the build tag for stage 1, from the cat of build-info-leg1.txt', word: TOOL[1]! },
        { label: 'knows the first prose label', question: 'the alpha label', word: PROSE[1]! },
        { label: 'knows the subagent’s reported outcome', question: 'the build codename the subtask reported', word: FORK },
      ])
    } else if (leg === 3) {
      await recall(leg, [
        { label: 'knows pi’s tool-only fact (two legs back)', question: 'the build tag for stage 1 (from build-info-leg1.txt)', word: TOOL[1]! },
        { label: 'knows claude’s tool-only fact', question: 'the build tag for stage 2 (from build-info-leg2.txt)', word: TOOL[2]! },
        { label: 'knows claude’s prose label', question: 'the bravo label', word: PROSE[2]! },
      ])
    } else if (leg === 4) {
      await recall(leg, [
        { label: 'still knows its OWN first label (anchored resume)', question: 'the alpha label', word: PROSE[1]! },
        { label: 'received the missed span’s prose (text tail)', question: 'the charlie label', word: PROSE[3]! },
      ])
    } else if (leg === 5) {
      await recall(leg, [
        { label: 'knows pi’s latest tool-only fact (native re-inject)', question: 'the build tag for stage 4 (from build-info-leg4.txt)', word: TOOL[4]! },
        { label: 'still knows claude’s tool-only fact from leg 2', question: 'the build tag for stage 2', word: TOOL[2]! },
        { label: 'knows the latest prose label', question: 'the delta label', word: PROSE[4]! },
      ])
    } else if (leg === 6) {
      await recall(leg, [
        { label: 'knows its OWN tool-only fact from leg 2 (anchored resume)', question: 'the build tag for stage 2', word: TOOL[2]! },
        { label: 'received the missed span’s prose (text tail)', question: 'the echo label', word: PROSE[5]! },
      ])
    } else {
      await recall(leg, [
        { label: 'still knows the very first label after the whole circuit', question: 'the alpha label', word: PROSE[1]! },
        { label: 'received the missed span’s prose (text tail)', question: 'the foxtrot label', word: PROSE[6]! },
      ])
    }

    // The departing leg's own work, planted AFTER the recall so the recall
    // never sees its own leg's facts. The final leg only recalls.
    if (leg < CIRCUIT.length) await workLeg(leg)
  }

  // The load-bearing tool facts must not have leaked into memory files — a
  // leak would let a recall pass without any carry at all.
  for (const word of [TOOL[1]!, TOOL[2]!, TOOL[4]!]) {
    const leaks = await memoryLeaks(word, {
      workspaceId: key.workspaceId,
      sessionId: key.sessionId,
      configDir: resolveConfigDir(),
      workingDirectory: projectDir,
    })
    if (leaks.length > 0) {
      run.check('no tool fact leaked into memory files', false,
        leaks.map(l => `${l.scope}:${l.path}`).join(', '))
      return
    }
  }
  run.check('no tool fact leaked into memory files', true)
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
