// R37 (f228) — getPendingDirectShellContext in BOTH respondToBashCommands
// directions. No production edit was made to the fold; these pins verify
// rather than assume the interaction with the new respond-by-default path:
//
// - ON: the response turn ends with a final assistant message AFTER the shell
//   transcript, so `lastFinalAssistantIndex` moves past it and the fold is
//   empty — the transcript must NOT be prepended a second time to the user's
//   next prompt.
// - OFF (and any not-yet-answered transcript): the fold still carries it to
//   the next prompt — the documented context-only branch
//   (interactive-mode.md:321).
//
// No prior tests for this helper existed anywhere in the repo (grep -a over
// packages for getPendingDirectShellContext test files: none), so this file
// sits beside sessions.shell-command.test.ts per the R37 plan.
import { describe, expect, it } from 'bun:test'
import { createTestSessionManager } from '../../sessions/__tests__/test-session-manager.ts'

const SHELL_BADGES = [{ type: 'command', label: '!', rawText: '!', start: 0, end: 1 }]

function shellTranscriptMessage(id: string, command: string) {
  return {
    id,
    role: 'user',
    content: `! ${command}\n\ncwd: /tmp/ws\nexit: 0\n\nstdout:\n\`\`\`text\nhello\n\`\`\``,
    badges: SHELL_BADGES,
  }
}

function foldFor(messages: unknown[], currentUserMessageId: string): string | null {
  const manager = createTestSessionManager() as any
  return manager.getPendingDirectShellContext({ messages }, currentUserMessageId)
}

describe('getPendingDirectShellContext across respondToBashCommands directions', () => {
  it('OFF: an unanswered shell transcript still rides the next prompt', () => {
    const messages = [
      shellTranscriptMessage('shell-1', 'echo hello'),
      { id: 'prompt-1', role: 'user', content: 'what did that print?' },
    ]

    const fold = foldFor(messages, 'prompt-1')

    expect(fold).toContain('shell commands from composer ! mode')
    expect(fold).toContain('! echo hello')
  })

  it('ON: once the response turn lands, the next prompt does not carry the transcript again', () => {
    const messages = [
      shellTranscriptMessage('shell-1', 'echo hello'),
      // The respond-by-default turn's final assistant reply.
      { id: 'reply-1', role: 'assistant', content: 'The command printed hello.' },
      { id: 'prompt-1', role: 'user', content: 'next prompt' },
    ]

    expect(foldFor(messages, 'prompt-1')).toBeNull()
  })

  it('the response turn itself does not re-prepend its own transcript', () => {
    // During the dispatched turn the transcript IS the current user message;
    // the fold looks strictly before it (currentIndex 0 short-circuits).
    const messages = [shellTranscriptMessage('shell-1', 'echo hello')]

    expect(foldFor(messages, 'shell-1')).toBeNull()
  })

  it('an intermediate assistant entry does not count as the response', () => {
    // Only a FINAL assistant message closes the fold window; a streamed
    // intermediate entry between transcript and prompt must not swallow it.
    const messages = [
      shellTranscriptMessage('shell-1', 'echo hello'),
      { id: 'stream-1', role: 'assistant', content: 'thinking…', isIntermediate: true },
      { id: 'prompt-1', role: 'user', content: 'next prompt' },
    ]

    const fold = foldFor(messages, 'prompt-1')

    expect(fold).toContain('! echo hello')
  })
})
