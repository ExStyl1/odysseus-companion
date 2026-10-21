/**
 * UB14.34 (R4-14) — the composer's paste-a-console-snippet offer, as pure decisions.
 *
 * Source: v0.15.0:apps/electron/src/renderer/components/app-shell/input/ChatInputZone.tsx (the `pastedSnippet`
 * state, its "seen in the draft" effect, `handleSnippetPaste`, `handleRunPasted`; unchanged in v0.15.1),
 * craft-agents-oss, Apache-2.0. Upstream writes them inline in the zone; they live here so a bare bun test can
 * DRIVE them (the zone's module graph reaches Vite-only imports, see `composer-hint-line.test.tsx`).
 *
 * Ours adds ONE decision, {@link pastedCommandRunner}: upstream offers the chip wherever its caller passes
 * `onRunCommand`; ours also needs the session's runtime to start a background shell with its own tool
 * (`ComposerCapabilities.backgroundShell`, resolved server-side: claude and Pi, codex unmeasured until UB14.19).
 * Native-first: nothing runs here — the runner sends `runCommandMessage` (UB14.16) as an ordinary user message,
 * so the runtime's tool and the session's permission mode decide it. Our host `!cmd` runner is a different
 * thing (a foreground shell the HOST runs) and is untouched.
 */
import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'

/** A pasted console snippet: the command it stands for and the text that was pasted. */
export interface PastedSnippet {
  command: string
  text: string
}

export type RunCommand = (command: string) => void

/**
 * The runner the composer may offer a pasted snippet to, or `undefined` (no chip: the composer gets no
 * `onConsoleSnippetPaste`). Both halves are needed: a caller that can send (`onRunCommand`; ChatDisplay passes none
 * on the `/btw` side-question panel) AND a runtime whose own tool backgrounds a command.
 */
export function pastedCommandRunner(
  onRunCommand: RunCommand | undefined,
  capabilities: Pick<ComposerCapabilities, 'backgroundShell'> | undefined,
): RunCommand | undefined {
  return onRunCommand && capabilities?.backgroundShell ? onRunCommand : undefined
}

/**
 * Upstream's effect over the draft: the paste lands AFTER the paste event, so the offer first waits until the
 * snippet's first line is in the draft (`seen`), and once seen it is withdrawn when that line leaves the draft.
 * Returns the next `seen` and whether the offer stays.
 */
export function trackPastedSnippet(
  snippet: PastedSnippet,
  draft: string,
  seen: boolean,
): { seen: boolean; keep: boolean } {
  const marker = snippet.text.trim().split('\n')[0] ?? ''
  if (draft.includes(marker)) return { seen: true, keep: true }
  return { seen, keep: !seen }
}

/**
 * "Run in background": hand the COMMAND (prompts removed) to the runner, and report whether the draft is the
 * snippet itself — then it is cleared, as upstream does; a draft with other text around the snippet is kept.
 */
export function runPastedSnippet(snippet: PastedSnippet, draft: string, run: RunCommand): { clearDraft: boolean } {
  run(snippet.command)
  return { clearDraft: draft.trim() === snippet.text.trim() }
}
