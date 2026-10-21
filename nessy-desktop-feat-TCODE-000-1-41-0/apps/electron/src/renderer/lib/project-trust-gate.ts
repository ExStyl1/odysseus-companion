/**
 * The folder-trust prompt's gate, off the page that raises it.
 *
 * ## Why this module exists (D1.363, half (b))
 *
 * `ChatPage` re-prompts for a project whose `trustState` resolves `'unknown'`,
 * guarded to ONE check per session view so a re-render cannot re-ask. The guard
 * was keyed on the SESSION ID alone while the effect's own dependencies include
 * the WORKING DIRECTORY — so the first directory a session view saw consumed the
 * one check, and every later directory bound to that same session was silently
 * skipped. The prompt was never raised again, whatever the new folder contained.
 *
 * That is measurable from the outside as a profile going quiet: measure sitting
 * 5e recorded the app's trust gate answering `not-shown` for every project after
 * the first, across four sessions of `RS-80` and `RS-84`, and read it as a
 * consequence of the Cancel that cleared a stuck modal. **Cancel is not the
 * cause and persists nothing** — it clears the pending handle and writes no
 * record anywhere — and this is: any first check consumes the session's one
 * chance, INCLUDING one that resolved to "nothing to ask about" (a folder with
 * no entry points) or that failed and was swallowed by the fail-soft catch.
 *
 * The check is therefore claimed per (session, directory) PAIR. A re-render of
 * the same pair still asks nothing, which is the invariant the original guard
 * was written for; a new directory under the same session asks again.
 *
 * The async half lives here too so it can be driven by a test: this repo has no
 * DOM under `bun test` (no happy-dom, no testing-library), so an effect body
 * inside a 1 100-line component is otherwise unreachable.
 */

import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'
import type { ProjectContributionReport } from '@nessy-agent/shared/protocol/capabilities'
import { projectWouldContribute } from '@nessy-agent/shared/protocol/capabilities'

/** The two IPC calls the gate makes, named so a test can stand in for them. */
export interface ProjectTrustGateApi {
  validateProjectDirectory(input: {
    workspaceId: string
    candidatePath: string
  }): Promise<IssuedProjectHandle>
  detectProjectContributions(input: {
    workspaceId: string
    projectHandleId: string
  }): Promise<ProjectContributionReport | null>
}

/**
 * The identity of one check. `JSON.stringify` rather than a separator character,
 * because a path may contain anything a path may contain and this value is only
 * ever compared for equality.
 */
export function projectTrustGateKey(sessionId: string, workingDirectory: string): string {
  return JSON.stringify([sessionId, workingDirectory])
}

/**
 * Claim the one check this (session, directory) pair gets.
 *
 * Returns true exactly once per pair and marks it; a later call for the SAME
 * pair returns false, and a call for a different directory in the same session
 * returns true. The ref is the caller's — a React `useRef`, or a plain object in
 * a test.
 */
export function claimProjectTrustCheck(
  ref: { current: string | null },
  sessionId: string,
  workingDirectory: string,
): boolean {
  const key = projectTrustGateKey(sessionId, workingDirectory)
  if (ref.current === key) return false
  ref.current = key
  return true
}

/**
 * Ask whether this working directory should raise the trust prompt, and return
 * the handle to raise it for.
 *
 * Fail-soft in the two directions the original effect already chose, and the
 * asymmetry is deliberate (see `projectWouldContribute`'s own header):
 *  - a failed `validateProjectDirectory` asks NOTHING — a missing or unusable
 *    directory is not a question the user can answer;
 *  - a failed `detectProjectContributions` still ASKS — only a positive "this
 *    folder contributes nothing" is allowed to suppress the prompt.
 */
export async function resolveProjectTrustPrompt(
  api: ProjectTrustGateApi,
  input: { workspaceId: string; workingDirectory: string },
): Promise<IssuedProjectHandle | null> {
  const project = await api
    .validateProjectDirectory({ workspaceId: input.workspaceId, candidatePath: input.workingDirectory })
    .catch(() => null)
  if (!project || project.trustState !== 'unknown') return null
  const report = await api
    .detectProjectContributions({ workspaceId: project.workspaceId, projectHandleId: project.id })
    .catch(() => null)
  return projectWouldContribute(report) ? project : null
}

/**
 * F1.974 — the chat a trust prompt was raised for.
 *
 * `ChatPage` is ONE instance across chats: `MainContentPanel` mounts it with no
 * key, and the panel slot's key is the panel entry's id, which navigating the
 * focused panel keeps. Its pending prompt therefore outlives a switch to another
 * chat, and the native File → New Chat menu, a notification or a deep link can
 * make that switch while the modal is up. Unstamped, the prompt stayed on screen
 * over the other chat and its answer bound the chat open at the click — moving
 * that chat into this one's folder (the handle is workspace-scoped). So a prompt
 * carries the session it was raised for: it is shown only while that chat is
 * open, and its answer binds THAT chat. The ref is the part of a `Session` the
 * bind reads, so a `Session` can be stamped as it is.
 */
export interface ProjectTrustSession {
  id: string
  workspaceId: string
}

export interface PendingProjectTrust {
  session: ProjectTrustSession
  project: IssuedProjectHandle
}

/**
 * The prompt the open chat shows: only one raised for it. Another chat's prompt
 * is hidden, not dropped, so it is there again when its chat is reopened — after
 * a visit to a chat with no folder the (session, directory) claim above is
 * still that chat's and would not ask a second time.
 */
export function projectTrustPromptFor(
  pending: PendingProjectTrust | null,
  openSessionId: string,
): PendingProjectTrust | null {
  return pending && pending.session.id === openSessionId ? pending : null
}

/**
 * Offer a re-prompt resolved for `next.session`. A dialog already pending for the
 * SAME chat wins (the directory-pick flow opened it, and the user is on it); one
 * pending for ANOTHER chat is replaced, or it would suppress this chat's prompt.
 */
export function offerProjectTrustPrompt(
  prev: PendingProjectTrust | null,
  next: PendingProjectTrust,
): PendingProjectTrust {
  return prev && prev.session.id === next.session.id ? prev : next
}
