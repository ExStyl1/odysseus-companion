/**
 * The two things `command-corpus.ts` must be right about, and neither is
 * provable from its own output.
 *
 * P2.389.
 *
 * 1. **The scrub is wired.** The one copy came back with ZERO redactions over
 *    19 617 distinct commands. An absence finding needs a positive control on
 *    the same rig, or a scanner that was never called looks exactly like a clean
 *    corpus. {@link harvestCommands} is the whole transformation, so driving it
 *    with a synthetic transcript line carrying a fake token proves the scan runs
 *    — and that the token does not survive into the stored text.
 * 2. **It skips cleanly off the copy's machine.** `NESSY_COMMAND_CORPUS` unset,
 *    or naming a directory that does not exist, must be `null` and exit 0, so a
 *    checkout without the corpus behaves exactly as it does today.
 *
 * No test here reads the real corpus: it lives outside the repository by
 * design, and a test that needs it would be red on every other machine.
 */

import { describe, expect, test } from 'bun:test'

import { bashCommandsInLine, harvestCommands, loadCommandCorpus } from './command-corpus.ts'

/** One transcript line in the shape the JSONL actually carries. */
function transcriptLine(commands: readonly string[]): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: commands.map((command, i) => ({
        type: 'tool_use',
        id: `toolu_${i}`,
        name: 'Bash',
        input: { command, description: 'x' },
      })),
    },
  })
}

describe('command corpus harvest', () => {
  test('extracts Bash commands and ignores every other block', () => {
    expect(bashCommandsInLine(transcriptLine(['ls -la', 'git status']))).toEqual(['ls -la', 'git status'])
    // A tool that is not Bash, a text block, a non-JSON line, and a line with
    // no message at all: all of them contribute nothing.
    const otherTool = JSON.stringify({
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }, { type: 'text', text: 'hi' }] },
    })
    expect(bashCommandsInLine(otherTool)).toEqual([])
    expect(bashCommandsInLine('{not json')).toEqual([])
    expect(bashCommandsInLine(JSON.stringify({ type: 'queue-operation' }))).toEqual([])
  })

  test('POSITIVE CONTROL: a credential-shaped value is scrubbed out of the stored text', () => {
    // Not a real token: a documented GitLab PAT prefix plus filler, which is
    // what the named rule recognises. The point is that the scanner is reached.
    const fake = `glpat-${'A1b2C3d4E5f6G7h8'}`
    const harvest = harvestCommands([transcriptLine([`curl -H "PRIVATE-TOKEN: ${fake}" https://example.invalid`])])

    expect(harvest.bashCalls).toBe(1)
    expect(harvest.commandsRedacted).toBe(1)
    expect(harvest.redacted).toEqual([{ rule: 'gitlab-pat', count: 1 }])
    expect(harvest.commands).toHaveLength(1)
    expect(harvest.commands[0]).toContain('[REDACTED:gitlab-pat]')
    expect(harvest.commands[0]).not.toContain(fake)
  })

  test('NEGATIVE: an ordinary corpus command is stored unchanged and de-duplicated', () => {
    const harvest = harvestCommands([
      transcriptLine(['rm -rf ./build', 'rm -rf ./build']),
      transcriptLine(["cat <<'PY'\nprint(1)\nPY"]),
    ])
    expect(harvest.bashCalls).toBe(3)
    expect(harvest.commandsRedacted).toBe(0)
    expect(harvest.redacted).toEqual([])
    // Three calls, two distinct commands — and the heredoc's newlines survive.
    expect(harvest.commands).toEqual(["cat <<'PY'\nprint(1)\nPY", 'rm -rf ./build'])
  })
})

describe('command corpus load', () => {
  test('skips cleanly when the corpus is absent — unset and non-existent both', () => {
    const original = process.env.NESSY_COMMAND_CORPUS
    try {
      // `delete` before assigning: assigning to a name Bun pre-creates a slot
      // for leaves it invisible to a spread, and the delete-first form is the
      // one that behaves the same for every name (AGENTS.md §Traps).
      delete process.env.NESSY_COMMAND_CORPUS
      expect(loadCommandCorpus()).toBeNull()

      delete process.env.NESSY_COMMAND_CORPUS
      process.env.NESSY_COMMAND_CORPUS = '/nonexistent/nessy-command-corpus-probe'
      expect(loadCommandCorpus()).toBeNull()
    } finally {
      delete process.env.NESSY_COMMAND_CORPUS
      if (original !== undefined) process.env.NESSY_COMMAND_CORPUS = original
    }
  })
})
