/**
 * C3.311 — the SDK's own `deleteSession`, behind the host's session delete.
 *
 * The decision this implements is C3.282's, recorded on
 * `agent/claude-session-persistence.ts`: `deleteSession` was named there as the
 * ONE genuine gap among the seven store verbs, because deleting a host session
 * left the vendor's `projects/<projectKey>/<sdkSessionId>.jsonl` on disk until
 * the retention sweep's age cutoff reached it — up to `retentionDays` away, and
 * never at all with `sweepEnabled: false`.
 *
 * **This suite drives the REAL verb**, not a stub: `deleteSession` is filesystem
 * work with no model call and no child process, so the vendored bundle can be
 * exercised directly and this is a committed gate rather than an
 * `NESSY_CLAUDE_SDK_E2E`-gated recording. The transcripts are hand-written
 * one-line JSONL files under a `mkdtemp` config dir — the SDK's remover cares
 * about the name and the size, not the contents (its own precondition is
 * `size > 0`, the same one the loader applies).
 *
 * Three things it exists to catch, and each is a way the wiring could be wrong
 * while looking right:
 *
 *  1. **Scope.** The verb aims through `process.env.CLAUDE_CONFIG_DIR`, which
 *     this host never sets for itself. A byte-identical transcript with the SAME
 *     session id and the SAME project key under a SECOND workspace's config dir
 *     must survive — otherwise "delete one session" could reach another
 *     workspace's data.
 *  2. **Classification.** The verb THROWS for an id it cannot find and for an id
 *     that is not a UUID, with two different messages, and the wiring reads those
 *     messages. Pinning both here means a vendor reword surfaces as a red rather
 *     than as a real failure silently reported as `'absent'`.
 *  3. **The global it borrows.** `CLAUDE_CONFIG_DIR` must come back to exactly
 *     the state it was in — absent stays absent — on the success arm AND on both
 *     throwing arms, and two concurrent deletes must not read each other's value.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deleteClaudeVendorSession, retireSupersededClaudeVendorSession } from '../claude-session-persistence.ts'
import { claudeProjectKeyForCwd } from '../claude-transcript-rebuild.ts'

/** One JSONL line, shaped like the vendor's own writer's. Only the size matters to the remover. */
function transcriptLine(sdkSessionId: string): string {
  return `${JSON.stringify({
    type: 'user',
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: sdkSessionId,
    message: { role: 'user', content: 'c3311' },
  })}\n`
}

/**
 * A config dir carrying one transcript for `sdkSessionId`, in the project
 * directory the SDK derives for `cwd` — derived by OUR port of the SDK's own
 * four helpers, which `claude-transcript-rebuild.test.ts` already pins against
 * the real tree. Returns both paths so the sidecar can be asserted too.
 */
function seedVendorTranscript(root: string, name: string, cwd: string, sdkSessionId: string) {
  const configDir = join(root, name, 'claude-config')
  const projectDir = join(configDir, 'projects', claudeProjectKeyForCwd(cwd))
  mkdirSync(projectDir, { recursive: true })
  const transcript = join(projectDir, `${sdkSessionId}.jsonl`)
  writeFileSync(transcript, transcriptLine(sdkSessionId))
  const sidecar = join(projectDir, sdkSessionId)
  mkdirSync(sidecar, { recursive: true })
  writeFileSync(join(sidecar, 'subagent.jsonl'), transcriptLine(sdkSessionId))
  return { configDir, transcript, sidecar }
}

/** The launch state of the variable the verb is aimed with, read the way AGENTS.md requires. */
function ambientConfigDir(): { had: boolean; value: string | undefined } {
  return {
    had: Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CONFIG_DIR'),
    value: process.env.CLAUDE_CONFIG_DIR,
  }
}

describe('C3.311 · the vendor transcript goes with the session', () => {
  it('removes the transcript AND its subagent sidecar under the named config dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'c3311-'))
    const cwd = mkdtempSync(join(tmpdir(), 'c3311-cwd-'))
    const sdkSessionId = randomUUID()
    const mine = seedVendorTranscript(root, 'workspace-a', cwd, sdkSessionId)
    // The control, and it is the whole point of the arm: the SAME id and the SAME
    // project key in a DIFFERENT workspace's config dir.
    const theirs = seedVendorTranscript(root, 'workspace-b', cwd, sdkSessionId)

    const before = ambientConfigDir()
    const outcome = await deleteClaudeVendorSession({ sdkSessionId, configDir: mine.configDir })

    expect({
      outcome,
      mineTranscript: existsSync(mine.transcript),
      mineSidecar: existsSync(mine.sidecar),
      theirsTranscript: existsSync(theirs.transcript),
      theirsSidecar: existsSync(theirs.sidecar),
    }).toEqual({
      outcome: 'deleted',
      mineTranscript: false,
      mineSidecar: false,
      // The other workspace is untouched — the scoping is real.
      theirsTranscript: true,
      theirsSidecar: true,
    })
    expect(ambientConfigDir()).toEqual(before)
  })

  it('answers `absent` for an id the store does not carry, and restores the variable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'c3311-absent-'))
    const cwd = mkdtempSync(join(tmpdir(), 'c3311-absent-cwd-'))
    // A real config dir with a real project directory, so the arm is "this id is
    // not here" rather than "nothing is here".
    const seeded = seedVendorTranscript(root, 'workspace-a', cwd, randomUUID())

    const before = ambientConfigDir()
    const outcome = await deleteClaudeVendorSession({ sdkSessionId: randomUUID(), configDir: seeded.configDir })

    // `absent` and NOT `failed`: the classification reads the vendor's own
    // "not found in …" message. A reword lands here as a red.
    expect(outcome).toBe('absent')
    expect(existsSync(seeded.transcript)).toBe(true)
    expect(ambientConfigDir()).toEqual(before)
  })

  it('answers `skipped` for an id the SDK refuses as malformed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'c3311-invalid-'))
    const cwd = mkdtempSync(join(tmpdir(), 'c3311-invalid-cwd-'))
    const seeded = seedVendorTranscript(root, 'workspace-a', cwd, randomUUID())

    const before = ambientConfigDir()
    // `BaseAgent.getSessionId()` returns OUR session id on some backends, and a
    // legacy anchor can hold one — this is the arm that keeps such a value from
    // being reported as a deletion failure.
    const outcome = await deleteClaudeVendorSession({ sdkSessionId: 'nessy-session-1', configDir: seeded.configDir })

    expect(outcome).toBe('skipped')
    expect(ambientConfigDir()).toEqual(before)
  })

  it('attempts nothing without a claude anchor or without a config dir', async () => {
    const before = ambientConfigDir()
    expect(await deleteClaudeVendorSession({ sdkSessionId: undefined, configDir: '/nowhere' })).toBe('skipped')
    expect(await deleteClaudeVendorSession({ sdkSessionId: randomUUID(), configDir: undefined })).toBe('skipped')
    expect(await deleteClaudeVendorSession({ sdkSessionId: null, configDir: null })).toBe('skipped')
    // Nothing was imported, nothing was set: the cheap arm stays cheap.
    expect(ambientConfigDir()).toEqual(before)
  })

  it('two concurrent deletes against two config dirs each hit their own', async () => {
    const root = mkdtempSync(join(tmpdir(), 'c3311-par-'))
    const cwd = mkdtempSync(join(tmpdir(), 'c3311-par-cwd-'))
    const idA = randomUUID()
    const idB = randomUUID()
    const a = seedVendorTranscript(root, 'workspace-a', cwd, idA)
    const b = seedVendorTranscript(root, 'workspace-b', cwd, idB)
    // Cross-seeded: each workspace also holds the OTHER session's transcript, so
    // an interleaved `CLAUDE_CONFIG_DIR` would delete the wrong file rather than
    // merely failing to find one.
    const aCross = seedVendorTranscript(root, 'workspace-a', cwd, idB)
    const bCross = seedVendorTranscript(root, 'workspace-b', cwd, idA)

    const before = ambientConfigDir()
    const outcomes = await Promise.all([
      deleteClaudeVendorSession({ sdkSessionId: idA, configDir: a.configDir }),
      deleteClaudeVendorSession({ sdkSessionId: idB, configDir: b.configDir }),
    ])

    expect(outcomes).toEqual(['deleted', 'deleted'])
    expect({
      aOwn: existsSync(a.transcript),
      bOwn: existsSync(b.transcript),
      aCross: existsSync(aCross.transcript),
      bCross: existsSync(bCross.transcript),
    }).toEqual({ aOwn: false, bOwn: false, aCross: true, bCross: true })
    expect(ambientConfigDir()).toEqual(before)
  })

  /**
   * C3.333 — THIS CASE IS INVERTED, and the inversion is the row.
   *
   * It used to assert `{ outcome: 'absent', stillThere: true }` and called the
   * leftover a residue recorded on purpose. The residue is now closed: the
   * vendor's finder applies `size > 0`, so a zero-byte transcript produces the
   * SAME "not found" message as an id that never existed, and reporting an
   * absence for a file that is sitting right there is the half-true disclosure
   * this fork keeps finding. `deleteClaudeVendorSession` now asks the zero-byte
   * question on that arm and reports `'deleted'` when it really removed one.
   *
   * The two controls are what keep the sweep from being a `rm` with extra steps:
   * it is scoped by CONFIG DIR (another workspace's identical file survives) and
   * by NAME (a different id's transcript in the same project directory
   * survives). The arm that would have to change for a size-blind sweep to pass
   * is the second one.
   */
  it('removes a ZERO-BYTE transcript the vendor\'s own verb cannot see', async () => {
    const root = mkdtempSync(join(tmpdir(), 'c3333-empty-'))
    const cwd = mkdtempSync(join(tmpdir(), 'c3333-empty-cwd-'))
    const sdkSessionId = randomUUID()
    const projectKey = claudeProjectKeyForCwd(cwd)

    const configDir = join(root, 'workspace-a', 'claude-config')
    const projectDir = join(configDir, 'projects', projectKey)
    mkdirSync(projectDir, { recursive: true })
    const transcript = join(projectDir, `${sdkSessionId}.jsonl`)
    writeFileSync(transcript, '')
    // NAME control: a different session's real transcript, same project dir.
    const neighbourId = randomUUID()
    const neighbour = join(projectDir, `${neighbourId}.jsonl`)
    writeFileSync(neighbour, transcriptLine(neighbourId))

    // CONFIG-DIR control: the same id, the same project key, another workspace.
    const otherConfigDir = join(root, 'workspace-b', 'claude-config')
    const otherProjectDir = join(otherConfigDir, 'projects', projectKey)
    mkdirSync(otherProjectDir, { recursive: true })
    const otherTranscript = join(otherProjectDir, `${sdkSessionId}.jsonl`)
    writeFileSync(otherTranscript, '')

    const before = ambientConfigDir()
    const outcome = await deleteClaudeVendorSession({ sdkSessionId, configDir })

    expect({
      outcome,
      mine: existsSync(transcript),
      neighbour: existsSync(neighbour),
      otherWorkspace: existsSync(otherTranscript),
    }).toEqual({
      outcome: 'deleted',
      mine: false,
      neighbour: true,
      otherWorkspace: true,
    })
    expect(ambientConfigDir()).toEqual(before)
  })

  it('still answers `absent` when the id has no file of ANY size — the boundary', async () => {
    // The arm that separates "the sweep closed the zero-byte hole" from "the
    // sweep reports a deletion whenever the verb throws not-found". A config dir
    // with a real project directory and no file for this id must stay `absent`.
    const root = mkdtempSync(join(tmpdir(), 'c3333-none-'))
    const cwd = mkdtempSync(join(tmpdir(), 'c3333-none-cwd-'))
    const seeded = seedVendorTranscript(root, 'workspace-a', cwd, randomUUID())

    const outcome = await deleteClaudeVendorSession({ sdkSessionId: randomUUID(), configDir: seeded.configDir })

    expect({ outcome, untouched: existsSync(seeded.transcript) }).toEqual({ outcome: 'absent', untouched: true })
  })
})

/**
 * C3.332 — the transcript a RE-MINTED claude anchor leaves behind.
 *
 * `RuntimeAnchorMap` holds one slot per provider, so the instant a session's
 * claude anchor is rewritten the earlier transcript is unreachable from
 * everything the host knows: `deleteClaudeVendorSession` can name the anchor a
 * session carries NOW and not the one it carried before, and the leftover waits
 * for the retention sweep — up to `retentionDays`, and forever with
 * `sweepEnabled: false`.
 *
 * `retireSupersededClaudeVendorSession` closes the SUPERSESSION case only. The
 * posture and its reason live on the function; these cases pin the two guards
 * that make it safe, because both are the kind that would go silently green if
 * they were dropped:
 *
 *  - `previous === next` — a resumed session reporting its own id back — must
 *    not delete the LIVE transcript;
 *  - a CLEAR (no next id: a rewind, a resume recovery, a fork invalidation) is
 *    not a supersession, because nothing replaces the file and it can be the
 *    last copy of what was dropped.
 */
describe('C3.332 · a superseded claude anchor takes its transcript with it', () => {
  it('retires the PREVIOUS transcript and leaves the new one alone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'c3332-'))
    const cwd = mkdtempSync(join(tmpdir(), 'c3332-cwd-'))
    const previousSdkSessionId = randomUUID()
    const nextSdkSessionId = randomUUID()
    const previous = seedVendorTranscript(root, 'workspace-a', cwd, previousSdkSessionId)
    const next = seedVendorTranscript(root, 'workspace-a', cwd, nextSdkSessionId)

    const before = ambientConfigDir()
    const outcome = await retireSupersededClaudeVendorSession({
      previousSdkSessionId,
      nextSdkSessionId,
      configDir: previous.configDir,
    })

    expect({
      outcome,
      previousTranscript: existsSync(previous.transcript),
      previousSidecar: existsSync(previous.sidecar),
      nextTranscript: existsSync(next.transcript),
    }).toEqual({
      outcome: 'deleted',
      previousTranscript: false,
      previousSidecar: false,
      // The anchor the session is about to hold: the one file that must survive.
      nextTranscript: true,
    })
    expect(ambientConfigDir()).toEqual(before)
  })

  it('refuses the two shapes that are not a supersession', async () => {
    const root = mkdtempSync(join(tmpdir(), 'c3332-guard-'))
    const cwd = mkdtempSync(join(tmpdir(), 'c3332-guard-cwd-'))
    const sdkSessionId = randomUUID()
    const seeded = seedVendorTranscript(root, 'workspace-a', cwd, sdkSessionId)

    // The same id written back — a resumed session announcing itself. Deleting
    // here would remove the transcript the session is still using.
    expect(await retireSupersededClaudeVendorSession({
      previousSdkSessionId: sdkSessionId,
      nextSdkSessionId: sdkSessionId,
      configDir: seeded.configDir,
    })).toBe('skipped')
    expect(existsSync(seeded.transcript)).toBe(true)

    // A CLEAR: a rewind or a resume recovery drops the anchor with nothing
    // replacing it, so the vendor file can be the last copy of what was
    // discarded. It stays for the retention sweep, deliberately.
    expect(await retireSupersededClaudeVendorSession({
      previousSdkSessionId: sdkSessionId,
      nextSdkSessionId: undefined,
      configDir: seeded.configDir,
    })).toBe('skipped')
    expect(existsSync(seeded.transcript)).toBe(true)
  })

  it('attempts nothing with no previous anchor and no config dir', async () => {
    const before = ambientConfigDir()
    expect(await retireSupersededClaudeVendorSession({
      previousSdkSessionId: undefined, nextSdkSessionId: randomUUID(), configDir: '/nowhere',
    })).toBe('skipped')
    expect(await retireSupersededClaudeVendorSession({
      previousSdkSessionId: randomUUID(), nextSdkSessionId: randomUUID(), configDir: null,
    })).toBe('skipped')
    expect(ambientConfigDir()).toEqual(before)
  })
})
