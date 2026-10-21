/**
 * AGT-10 — a blocked tool must not end the turn.
 *
 * Upstream v0.11.4 reported this as an SDK regression ("since the v0.11.3 SDK
 * uplift, the first blocked tool ended the turn before the agent could
 * respond"). It is not the SDK. Measured on claude-runtime against the real
 * gateway, the turn died identically on 0.3.215 and on 0.3.218, and what killed
 * it was our own PreToolUse payload: `blockWithReason` returned
 * `{ continue: false, decision: 'block', reason }`, and `hooks.md` says
 * `continue: false` "stops processing entirely … Takes precedence over any
 * event-specific decision fields" while its message is "Not shown to Claude".
 * The user asked for something, the tool was refused, and nothing came back.
 *
 * Fixed by returning the shape the same page's § PreToolUse decision control
 * specifies — `permissionDecision: "deny"` inside `hookSpecificOutput`, whose
 * `permissionDecisionReason` is "shown to Claude" — so the agent can say what
 * happened. This case is the guard on that.
 *
 * ## Three detectors were wrong before this one
 *
 * Written down because each looked reasonable and each would have scored a
 * broken product as working, or the reverse:
 *
 *   1. **"the agent produced some text"** — it declined in PROSE without ever
 *      calling the tool, so nothing was blocked and there was nothing to
 *      measure. A read-only mode (Explore then, Plan since F1.1054) tells the
 *      model through the system prompt that writes are restricted, so a plainly-forbidden target measures
 *      the model's obedience rather than the SDK's behaviour after a block.
 *   2. **`lastAssistantText`** — picked up the PREAMBLE ("let me attempt the
 *      write to show you the refusal") the model wrote BEFORE calling the tool.
 *      Text existed; a response to the block did not.
 *   3. **a fixed sleep after switching mode** — one run wrote the file
 *      successfully because the prompt went out before the mode took effect,
 *      which scores a working guard as "nothing was blocked".
 *
 * What survives: the reply must quote a phrase that appears only in the tool's
 * failure text, which the model cannot produce before the block happens.
 *
 * F1.1054 (2026-09-29): the case drives Plan. Explore, the mode it used to set,
 * is retired (F1.1050) and a stored `explore` is read as `plan`, so a probe that
 * asked for `explore` would read back `plan` and fail its own mode check. Plan
 * keeps the intent: a Write outside the plans and data folders is refused with
 * `getBlockReasonWithConfig`'s "File modifications are blocked in Plan", pinned
 * by `mode-block-reason.test.ts`. The old phrase "not in allowed folders" was
 * Explore's detailed write-target refusal, which F1.1050 retired with it.
 */

import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, listSessions, setPermissionMode, transcript, waitFor } from '../lib/state.ts'

const ID = 'AGT-10'
const TITLE = 'A blocked tool denies the call, not the turn — the agent still answers'

/** Appears only in the guard's refusal text, so quoting it proves the model saw it. */
const REFUSAL_PHRASE = 'File modifications are blocked in Plan'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // The Claude runtime is the surface under test; on a host whose only cards are
  // Pi or Nestor Cloud this would pass vacuously through a different code path.
  const providers = await session.call<string[]>(`
    const conns = await window.electronAPI.listLlmConnectionsWithStatus()
    return (conns ?? []).map(c => c.providerType).filter(Boolean)
  `)
  run.observe('provider-types', providers)
  if (!providers.includes('claude-runtime')) {
    blocked('this case needs a claude-runtime connection (the "Claude Code (Nessy Gateway)" card); the host has none')
  }

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)

  // Wait for the mode to be IN EFFECT, not merely requested — see detector 3.
  await setPermissionMode(session, key.sessionId, 'plan')
  const mode = await waitFor(
    async () => (await listSessions(session)).find(s => s.id === key.sessionId)?.permissionMode,
    value => value === 'plan',
    { timeoutMs: 30_000, label: 'plan mode to take effect' },
  )
  run.check('the session is in Plan mode before the probe', mode === 'plan', `mode=${String(mode)}`)

  await sendPrompt(
    session,
    key,
    'Write the word hello to /tmp/u1-block-probe.txt using your file-writing tool. '
    + 'Issue the tool call as your first action — do not ask permission and do not explain beforehand. '
    + `If the tool reports a failure, quote the failure verbatim in your reply, including the exact phrase "${REFUSAL_PHRASE}".`,
    240_000,
  ).catch(() => undefined)

  const all = await transcript(session, key)
  const blockedTool = all.find(m => m.toolName
    && new RegExp(REFUSAL_PHRASE, 'i').test((m as { toolResult?: string }).toolResult ?? ''))
  run.observe('tools', all.filter(m => m.toolName).map(m => ({ tool: m.toolName, status: (m as { toolStatus?: string }).toolStatus })))

  // Without a real block there is nothing to measure, and scoring that as a pass
  // is exactly detector 1's mistake.
  run.check('a tool call was actually attempted and refused', Boolean(blockedTool),
    blockedTool ? undefined : 'no tool result carried the refusal — the model declined in prose instead of calling the tool')
  if (!blockedTool) return

  const answered = all.some(m => m.role === 'assistant' && m.content.includes(REFUSAL_PHRASE))
  run.observe('assistant-texts', all.filter(m => m.role === 'assistant').map(m => m.content.slice(0, 160)))
  run.check(
    'the agent answered after the block, quoting what the refusal said',
    answered,
    answered ? undefined : 'the turn ended at the blocked tool — the user got nothing back',
  )
}

// T21's audit found this file (and agt-10/agt-9) lacked the guard every other
// case carries: importing it would RUN the sitting.
if (import.meta.main) await main(ID, TITLE, drive)
