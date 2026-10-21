/**
 * UB14.15 (R2-10) — the transcript's "Run in background" runner, the value of ChatDisplay's
 * `RunCommandProvider`.
 *
 * Upstream v0.15.1 `ChatDisplay.tsx` writes it inline: `RunCommandProvider value={session ?
 * handleRunCommand : null}` with `handleRunCommand = command => onSendMessage(runCommandMessage(command))`.
 * It lives here, as one pure decision, so the rule is DRIVEN by a test instead of read off a 3000-line
 * file that a bare bun process cannot import.
 *
 * Ours adds TWO arms; each returns `null`, so a code block offers no Run:
 * - the `/btw` side-question panel. Its compact ChatDisplay renders over a synthetic session
 *   (`side-question-composer.ts`) whose sends become `askSideQuestion`, answered on the live agent's
 *   TOOL-LESS `queryLlm` route (`SessionManager.askSideQuestion`) — a "run this in the background"
 *   message there would reach a model that cannot run anything. Upstream has no `/btw`.
 * - UB12.91: a session whose runtime cannot start a background shell with its own tool
 *   (`ComposerCapabilities.backgroundShell` absent). The composer's pasted-snippet offer reads the same
 *   field (`pastedCommandRunner`, UB14.34), so the two Run surfaces answer alike. The field is resolved
 *   server-side (`resolveComposerCapabilities`): present on Claude and Pi, absent on codex (unmeasured
 *   until UB14.19), on the remote agent, under the background-task off switch
 *   (`NESSY_DISABLE_BACKGROUND_TASKS`), and from an older server that reports no capabilities. Upstream
 *   offers Run on every session; the divergence is the advertised-and-unavailable shape this field exists
 *   to avoid.
 *
 * Native-first: nothing new runs here. The runner SENDS AN ORDINARY USER MESSAGE (UB14.16's text) asking
 * the agent to start the command as a background task, so each runtime's own tool and the session's
 * permission mode decide it — Claude's `Bash` `run_in_background`, Pi's bash `run_in_background`.
 */
import type { RunCommandHandler } from '@nessy-agent/ui'
import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import { runCommandMessage } from '@/lib/run-command-message'
import { isSideQuestionSessionId } from '../side-question-composer'

/** The runner for the transcript of `sessionId`, or `null` where a code block must offer no Run. */
export function transcriptRunCommand(
  sessionId: string | null | undefined,
  capabilities: Pick<ComposerCapabilities, 'backgroundShell'> | undefined,
  sendMessage: (message: string) => void,
): RunCommandHandler | null {
  if (!sessionId || isSideQuestionSessionId(sessionId)) return null
  if (!capabilities?.backgroundShell) return null
  return (command: string) => sendMessage(runCommandMessage(command))
}
