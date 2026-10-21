/**
 * F1.974 — the folder-trust prompt belongs to the chat that raised it.
 *
 * `ChatPage` is ONE instance across chats: `MainContentPanel` renders
 * `<ChatPage sessionId={…} />` with no key, and the `PanelSlot` around it is
 * keyed by the panel entry's id, which `updateFocusedPanelRouteAtom` keeps when
 * the focused panel navigates to another chat. So the page's `useState` survives
 * a switch from chat A to chat B. The trust dialog is a DOM modal, but the native
 * File → New Chat menu (and a notification or a deep link) navigates the window
 * regardless of it. At HEAD three rules followed from that, and this file
 * measured each of them before the fix:
 *
 *  1. A's pending prompt stayed on screen over chat B.
 *  2. Its answer bound the chat open NOW: `handleProjectTrustDecision` called
 *     `applySessionProject(project)`, which addresses the current `session`. The
 *     handle is workspace-scoped with a 24 h lifetime and `setSessionProject`
 *     resolves it by workspace alone, so B would be moved into A's folder.
 *  3. B's own re-prompt was suppressed behind A's (`prev ?? project`).
 *
 * RED at HEAD: with HEAD's rules transcribed into the two helpers
 * (`projectTrustPromptFor` returning the pending prompt for any open chat,
 * `offerProjectTrustPrompt` = `prev ?? next`) and `ChatPage` untouched, the
 * three cases below failed. The source pin is the wiring half: this repo has no
 * DOM under `bun test` (see `lib/project-trust-gate.ts`'s header), so the
 * page's own hooks are unreachable here and the pin guards the CALLS that route
 * them through the helpers.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'
import {
  offerProjectTrustPrompt,
  projectTrustPromptFor,
  type PendingProjectTrust,
} from '../../lib/project-trust-gate'

function handle(id: string, displayPath: string): IssuedProjectHandle {
  return { id, workspaceId: 'ws-1', displayPath, trustState: 'unknown', expiresAt: Date.now() + 60_000 }
}

function raised(sessionId: string, project: IssuedProjectHandle): PendingProjectTrust {
  return { session: { id: sessionId, workspaceId: 'ws-1' }, project }
}

const FOLDER_A = handle('handle-a', '/projects/a')
const FOLDER_B = handle('handle-b', '/projects/b')

describe('F1.974 — a trust prompt belongs to the chat that raised it', () => {
  it('is hidden while another chat is open, comes back with its own chat, and answers for that chat', () => {
    const pending = offerProjectTrustPrompt(null, raised('session-a', FOLDER_A))

    // The user switched to chat B while A's dialog was up.
    expect(projectTrustPromptFor(pending, 'session-b')).toBeNull()
    // Back on chat A, its unanswered prompt is still there to answer.
    const shown = projectTrustPromptFor(pending, 'session-a')
    expect(shown?.project.id).toBe('handle-a')
    // The answer binds the chat the prompt was raised for — the stamp, not the open chat.
    expect(shown?.session).toEqual({ id: 'session-a', workspaceId: 'ws-1' })
  })

  it("lets chat B's own prompt replace A's stale one", () => {
    const staleA = offerProjectTrustPrompt(null, raised('session-a', FOLDER_A))
    const next = offerProjectTrustPrompt(staleA, raised('session-b', FOLDER_B))

    expect(projectTrustPromptFor(next, 'session-b')?.project.id).toBe('handle-b')
    expect(next.session.id).toBe('session-b')
  })

  it("never replaces the open chat's own dialog with a re-prompt for the same chat (the directory-pick flow)", () => {
    const picked = raised('session-a', FOLDER_B)
    const rePrompt = raised('session-a', FOLDER_A)

    expect(offerProjectTrustPrompt(picked, rePrompt)).toBe(picked)
  })
})

describe('F1.974 — ChatPage routes its trust dialog through the helpers', () => {
  const source = readFileSync(fileURLToPath(new URL('../ChatPage.tsx', import.meta.url)), 'utf8')

  it('shows only the open chat’s prompt, binds the stamped chat, and offers re-prompts through the helper', () => {
    expect(source).toMatch(/projectTrustPromptFor\(pendingProjectTrust, sessionId\)/)
    expect(source).toMatch(/project=\{projectTrustPrompt\?\.project \?\? null\}/)
    expect(source).toMatch(/applySessionProject\(project, pendingProjectTrust\?\.session \?\? null\)/)
    expect(source).toMatch(/setPendingProjectTrust\(\(prev\) => offerProjectTrustPrompt\(prev, /)
    // HEAD's rules, which must not come back.
    expect(source).not.toMatch(/prev \?\? project/)
    expect(source).not.toMatch(/open=\{pendingProjectTrust !== null\}/)
  })
})
