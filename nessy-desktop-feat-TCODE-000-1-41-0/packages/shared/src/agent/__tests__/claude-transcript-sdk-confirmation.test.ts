/**
 * C3.313 — the rebuild's confirmation through the runtime's own reader.
 *
 * The decision is C3.282's READ row, split: `getSessionMessages` adopted,
 * `getSessionInfo` declined. The reason for the split is measured, and the
 * decisive arm is in this file — the same transcript read IN FULL by one verb
 * and as ABSENT by the other.
 *
 * **Drives the REAL reader against the REAL writer.** `getSessionMessages` is
 * filesystem work, so no child and no native binary is needed and this is a
 * committed gate rather than an `NESSY_CLAUDE_SDK_E2E` recording. The transcript
 * on every arm is produced by `writeClaudeTranscript` from a projected history,
 * which is the whole point: a pin written against a hand-rolled file would agree
 * with itself and prove nothing about the rebuild.
 *
 * This is the AGREEMENT pin P3.269 asked for, now with a production consumer
 * behind it: if a bundle bump changes the project-key hash, the sanitizer, the
 * length ceiling, the NFC gate or the record layout, the first test here goes
 * red — and in production the veto arm turns that same divergence into a text
 * handoff instead of a silently empty resume.
 */
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { confirmClaudeTranscriptThroughSdk } from '../claude-session-persistence.ts'
import {
  buildClaudeTranscriptRecords,
  claudeProjectKeyForCwd,
  claudeTranscriptPath,
  mintClaudeSdkSessionId,
  readClaudeCliVersion,
  writeClaudeTranscript,
  type ClaudeTranscriptRecord,
} from '../claude-transcript-rebuild.ts'
import type { RuntimeHandoffHistoryItem } from '../backend/types.ts'

const HISTORY: RuntimeHandoffHistoryItem[] = [
  { kind: 'message', role: 'user', content: 'the first prompt, C3313-MARKER' },
  { kind: 'message', role: 'assistant', content: 'the first answer' },
  { kind: 'tool', callId: 'c3313-call-1', name: 'Read', input: { file_path: '/tmp/c3313' }, output: 'file body' },
  { kind: 'message', role: 'user', content: 'the second prompt' },
  { kind: 'message', role: 'assistant', content: 'the second answer' },
]

/** A rebuild exactly as `SessionManager.rebuildClaudeTranscriptForSwitch` performs one. */
function rebuild(history: RuntimeHandoffHistoryItem[] = HISTORY) {
  const configDir = join(mkdtempSync(join(tmpdir(), 'c3313-')), 'claude-config')
  const cwd = mkdtempSync(join(tmpdir(), 'c3313-cwd-'))
  const sdkSessionId = mintClaudeSdkSessionId()
  const records: ClaudeTranscriptRecord[] = buildClaudeTranscriptRecords({
    history,
    cwd,
    sdkSessionId,
    model: 'claude-opus-4-6',
    version: readClaudeCliVersion(),
  })
  const filePath = claudeTranscriptPath({ configDir, cwd, sdkSessionId })
  const written = writeClaudeTranscript(filePath, records)
  return { configDir, cwd, sdkSessionId, records, filePath, written }
}

describe('C3.313 · the runtime\'s own reader confirms the rebuild', () => {
  it('reads back every record the writer wrote, in order', async () => {
    const built = rebuild()

    const confirmation = await confirmClaudeTranscriptThroughSdk({
      configDir: built.configDir,
      sdkSessionId: built.sdkSessionId,
      expectedUuids: built.records.map(record => record.uuid),
    })

    // `agreed` is an EXACT comparison — same count, same uuids, same order. It
    // is what makes the veto below safe to act on.
    expect(confirmation).toEqual({ verdict: 'agreed', read: built.written.records })
    expect(built.written.records).toBeGreaterThan(1)
  })

  it('sees nothing when the file is not where the runtime looks — the one vetoable verdict', async () => {
    const built = rebuild()
    // A DIFFERENT workspace's config dir: the file exists, at a path this root
    // does not reach. That is the production failure — a transcript written
    // somewhere the SDK never opens — reproduced without corrupting anything.
    const elsewhere = join(mkdtempSync(join(tmpdir(), 'c3313-other-')), 'claude-config')

    const confirmation = await confirmClaudeTranscriptThroughSdk({
      configDir: elsewhere,
      sdkSessionId: built.sdkSessionId,
      expectedUuids: built.records.map(record => record.uuid),
    })

    // An empty ARRAY, not a throw and not `undefined` — measured, and the whole
    // basis of `length === 0` as the signal.
    expect(confirmation).toEqual({ verdict: 'unreadable', read: 0 })
  })

  it('reports a disagreement as `partial` rather than vetoing it', async () => {
    const built = rebuild()
    // Claim one more record than was written. A partially-read native transcript
    // still puts real turns on the wire, and the alternative — the host's text
    // carry — is lossy by construction, so this must NOT read as `unreadable`.
    const confirmation = await confirmClaudeTranscriptThroughSdk({
      configDir: built.configDir,
      sdkSessionId: built.sdkSessionId,
      expectedUuids: [...built.records.map(record => record.uuid), mintClaudeSdkSessionId()],
    })

    expect(confirmation).toEqual({ verdict: 'partial', read: built.written.records })
  })

  it('answers `no-verdict` rather than vetoing when there is nothing to ask about', async () => {
    const built = rebuild()
    for (const input of [
      { configDir: null, sdkSessionId: built.sdkSessionId, expectedUuids: ['x'] },
      { configDir: built.configDir, sdkSessionId: null, expectedUuids: ['x'] },
      { configDir: built.configDir, sdkSessionId: built.sdkSessionId, expectedUuids: [] },
    ]) {
      expect(await confirmClaudeTranscriptThroughSdk(input)).toEqual({
        verdict: 'no-verdict',
        reason: 'nothing to confirm',
      })
    }
  })

  it('restores CLAUDE_CONFIG_DIR to exactly its prior state', async () => {
    const before = {
      had: Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CONFIG_DIR'),
      value: process.env.CLAUDE_CONFIG_DIR,
    }
    const built = rebuild()
    await confirmClaudeTranscriptThroughSdk({
      configDir: built.configDir,
      sdkSessionId: built.sdkSessionId,
      expectedUuids: built.records.map(record => record.uuid),
    })
    expect({
      had: Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CONFIG_DIR'),
      value: process.env.CLAUDE_CONFIG_DIR,
    }).toEqual(before)
  })

  it('the SDK reader is LENIENT where our own verifier is strict', async () => {
    // The arm that refutes "swap the verifier for the reader". Two lines, one of
    // them not JSON and the other carrying an unusable uuid: our verifier throws
    // on either, and the SDK reader returns what it could parse.
    const configDir = join(mkdtempSync(join(tmpdir(), 'c3313-lenient-')), 'claude-config')
    const cwd = mkdtempSync(join(tmpdir(), 'c3313-lenient-cwd-'))
    const sdkSessionId = mintClaudeSdkSessionId()
    const filePath = claudeTranscriptPath({ configDir, cwd, sdkSessionId })
    mkdirSync(join(configDir, 'projects', claudeProjectKeyForCwd(cwd)), { recursive: true })
    writeFileSync(filePath, '{"type":"user","uuid":"not-a-uuid","message":{"role":"user","content":"x"}}\nnot-json-at-all\n')

    const confirmation = await confirmClaudeTranscriptThroughSdk({
      configDir,
      sdkSessionId,
      expectedUuids: ['not-a-uuid', 'second'],
    })

    // Not `unreadable`: something came back. Not `agreed`: it is not what we
    // asked about. So the reader answers a DIFFERENT question from
    // `verifyClaudeTranscript`, and neither can be deleted in favour of the other.
    expect(confirmation).toEqual({ verdict: 'partial', read: 1 })
  })
})

describe('C3.313 · why `getSessionInfo` stays declined', () => {
  it('answers `undefined` for a transcript `getSessionMessages` reads in full', async () => {
    // P3.269 named this and declined the switch on it; this is the reading.
    // A history whose entries carry no prompt text still produces a well-formed,
    // fully readable transcript — and no summary for `getSessionInfo` to extract.
    const built = rebuild([
      { kind: 'message', role: 'user', content: '' },
      { kind: 'message', role: 'assistant', content: '' },
    ])

    const messages = await confirmClaudeTranscriptThroughSdk({
      configDir: built.configDir,
      sdkSessionId: built.sdkSessionId,
      expectedUuids: built.records.map(record => record.uuid),
    })

    const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk')
    const had = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CONFIG_DIR')
    const previous = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = built.configDir
    let info: unknown
    try {
      info = await getSessionInfo(built.sdkSessionId)
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR
      if (had && previous !== undefined) process.env.CLAUDE_CONFIG_DIR = previous
    }

    // The two verbs disagree about the SAME file in the SAME process. A summary
    // reader cannot gate a resume, which is why only one of them was adopted.
    expect({
      messagesVerdict: messages.verdict,
      infoIsUndefined: info === undefined,
    }).toEqual({ messagesVerdict: 'agreed', infoIsUndefined: true })
  })
})
