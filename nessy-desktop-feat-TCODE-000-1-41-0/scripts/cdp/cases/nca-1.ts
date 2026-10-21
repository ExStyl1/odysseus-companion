/**
 * NCA-1 — a live turn on `/api/v2/code-agent/a2a`: text back, plus ONE local
 * tool executed and its result accepted.
 *
 * Three claims, and the third is the one the row is really about: a remote agent
 * asked for a local tool, the tool ran on THIS machine, and the model then used
 * what it returned. Two of the three are cheap; the third is where every wrong
 * detector lives.
 *
 * ## What would make this pass vacuously, and what stops it
 *
 * | Vacuous world | What stops it |
 * | --- | --- |
 * | The model invents the answer, no tool ever runs | The answer is a 20-hex token that exists ONLY inside a file this case wrote seconds ago. Nothing on the machine, in the repo, or in the model's weights can produce it. |
 * | The token rides in on the prompt, so the model echoes it | The prompt names the FILE, never the token, and the case asserts that afterwards — against the user message the app actually stored, not against the string it meant to send. |
 * | A tool row exists but ran somewhere else / returned nothing | The tool row must carry the token in its own `toolResult`. A remote-side tool cannot: `server_tool_invocation` is decoded as a read-only card and never as an executable `tool_call` (`nestor-cloud/event-adapter.ts`), and the token is on this disk only. |
 * | The turn answers from a previous conversation | The session is CREATED for this run on the cloud connection and its transcript is asserted empty before the prompt. |
 * | Some other runtime answered | `composerCapabilities.connection.activeRuntime` is read back and must be `nestor-cloud-agent`. |
 *
 * ## Why the session is created, not switched
 *
 * `switchSessionRuntime` refuses a `nestor-cloud-agent` target with
 * `CONNECTION_NOT_SWITCHABLE` — see `lib/nestor-cloud.ts` fact 1. `q6-live.ts`
 * paid for that discovery with a deterministic FAIL.
 *
 * ## Why the permission approver runs
 *
 * The remote agent's own Act mode says it plainly — "Nessy still asks before
 * local tool execution" (`backend/composer-capabilities.ts`) — and
 * `bypassPermissions` is NOT one of the modes this runtime offers
 * (`resolveNestorCloudPermissions` yields plan/default only). So the card is
 * expected, and answering it is part of driving the case rather than a
 * concession. AGT-3 owns the claim ABOUT the card; this case only clears it.
 */

import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { approvePermissionsWhile, requireApproverSaw } from '../lib/ask-user.ts'
import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi } from '../lib/state.ts'
import {
  CLOUD_PROVIDER_TYPE,
  cloudTranscript,
  composerCapabilities,
  createSessionOn,
  currentWorkspaceId,
  openSessionInUi,
  probeToken,
  requireCloudConnection,
  workingDirectoryOf,
} from '../lib/nestor-cloud.ts'

const ID = 'NCA-1'
const TITLE = 'A live A2A 1.0 turn on the Nestor Cloud remote agent: text back, one local tool executed, and its result used in the reply'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const cloud = await requireCloudConnection(session, {
    pinnedSlug: process.env.NESSY_CDP_CLOUD_SLUG,
    purpose: 'NCA-1',
  })
  run.observe('cloud connection', { slug: cloud.slug, name: cloud.name, baseUrl: cloud.baseUrl ?? '(built-in)' })

  const workspaceId = await currentWorkspaceId(session)
  const key = await createSessionOn(run, session, { workspaceId, slug: cloud.slug, label: 'turn', caseId: ID })
  if (!key) blocked('could not create a session on the remote-agent connection; nothing below could be measured')

  run.check('the pane followed the new session', await openSessionInUi(session, key), key.sessionId)

  const caps = await composerCapabilities(session, key.sessionId)
  run.observe('composer capabilities', caps)
  run.require(
    'the session reports the remote agent as its active runtime',
    caps.activeRuntime === CLOUD_PROVIDER_TYPE,
    `activeRuntime=${String(caps.activeRuntime)}`,
  )

  const before = await cloudTranscript(session, key)
  run.require(
    'the session starts with no history of its own',
    before.length === 0,
    `${before.length} messages already present — this run would be measuring someone else's conversation`,
  )

  // --- the probe file ------------------------------------------------------
  const workingDirectory = await workingDirectoryOf(session, key.sessionId)
  if (!workingDirectory) {
    blocked(
      'the session reports no working directory, so there is nowhere on this machine a local tool could read from. '
      + 'Bind the workspace to a project in the app and re-run.',
    )
  }
  const token = probeToken()
  // **The file name and the token are two DIFFERENT random values, and that is
  // load-bearing.** The prompt has to name the file, so anything in the name is
  // in the prompt — a name built from the token would put the answer in the
  // question and void the whole case. `probeToken()` twice, never once.
  const probeName = `nca-1-probe-${probeToken()}.txt`
  const probePath = join(workingDirectory, probeName)
  // The body is the token and nothing else: a reply that carries it can only
  // have come through the file.
  writeFileSync(probePath, `${token}\n`, 'utf8')
  run.observe('probe file', { path: probePath, tokenLength: token.length })
  run.require(
    'the probe file name does not contain the token',
    !probeName.includes(token),
    `${probeName} vs ${token}`,
  )

  const approver = approvePermissionsWhile(session, key.sessionId)
  try {
    // Phrased POSITIVELY. A prompt that names a tool and forbids using it trips
    // a guardian as prompt injection (AGENTS.md trap register), and the wreckage
    // reads like a dispatch bug.
    const prompt = `Read the file ${probeName} in the working directory and reply with exactly the one line it contains, and nothing else.`
    run.require(
      'the prompt this case is about to send does not contain the token',
      !prompt.includes(token),
      prompt,
    )
    const turn = await sendPrompt(session, key, prompt, 600_000)
    run.observe('messages added by the turn', turn.added.length)

    const after = await cloudTranscript(session, key)
    const userMessages = after.filter(m => m.role === 'user')
    run.observe('user messages', userMessages.map(m => m.content.slice(0, 200)))

    // --- claim 1: text came back ----------------------------------------
    const answer = lastAssistantText(turn.added)
    run.observe('final assistant text', answer.slice(0, 400))
    run.check('the remote agent answered with text', answer.trim().length > 0, `${answer.length} chars`)

    const errors = after.filter(m => m.role === 'error')
    run.check(
      'the turn produced no error row',
      errors.length === 0,
      errors.map(m => m.content.slice(0, 200)).join(' | ') || 'none',
    )

    // --- claim 2: a local tool RAN, and it is the one that saw the token --
    const toolRows = after.filter(m => m.role === 'tool' || Boolean(m.toolName))
    run.observe('tool rows', toolRows.map(m => ({ name: m.toolName, status: m.toolStatus, result: (m.toolResult ?? '').slice(0, 120) })))
    const carrier = toolRows.find(m => (m.toolResult ?? '').includes(token))
    run.check(
      'a local tool executed and its own result carries the token',
      Boolean(carrier),
      carrier
        ? `${carrier.toolName ?? 'unnamed'} (${carrier.toolStatus ?? 'no status'})`
        : `${toolRows.length} tool rows, none carrying the token — a remote-side tool cannot have read this file`,
    )

    // --- claim 3: the model ACCEPTED the result --------------------------
    // The token is the whole point: the file was written seconds ago with a
    // per-run 20-hex value, so an answer carrying it came back through the
    // tool-result round trip (`client.sendToolResultsStream`), not from the
    // prompt and not from the model.
    run.check(
      "the model's own reply carries the token the tool returned",
      answer.includes(token),
      answer.includes(token) ? token : `answer did not contain ${token}`,
    )

    // --- the control that makes claim 3 mean anything --------------------
    const promptedWithToken = userMessages.some(m => m.content.includes(token))
    run.check(
      'the token was never in the prompt, so the reply could not echo it',
      !promptedWithToken,
      promptedWithToken
        ? 'a user message carries the token — this run cannot distinguish a tool result from an echo'
        : 'no user message carries the token',
    )
  } finally {
    const approved = await approver.stop()
    run.observe('permission cards approved', approved)
    rmSync(probePath, { force: true })
  }
  // D1.356 — this case's reading is "the reply carries the file's line", and a
  // permission card the approver could not see wedges the turn that produces it.
  // Outside the `finally` on purpose: a block thrown from there would replace a
  // real failure with a sentence about the approver.
  requireApproverSaw(run, approver, 'the probe turn')
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
