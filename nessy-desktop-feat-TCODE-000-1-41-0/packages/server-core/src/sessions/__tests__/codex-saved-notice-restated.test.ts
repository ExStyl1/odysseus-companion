/**
 * F1.1092 (origin DN-050, 2026-09-26) — after an app relaunch a resumed codex session restated, on its first turn,
 * the warnings already saved in its transcript: the codex agent says each of the relaunch-restatement family once
 * per process (F1.734 — the sandbox divergence notice, `codex-sandbox-egress-denied`, codex's model-metadata
 * constant with the host caveat beside it), and a relaunch is a new process.
 *
 * Decided (owner rule 2026-10-08, simplest): on a codex session the host skips a warning identical to one already
 * saved in the transcript — neither a second row nor a second live banner — but ONLY inside that family. Codex
 * re-says everything else per attempt: `UserPromptSubmit hook: <systemMessage>` is yielded on EVERY blocked prompt
 * (the branch is live — `hookBlockEndsTurn('UserPromptSubmit')` is true), and the uncarried-attachment diagnostics
 * are yielded on every prompt that carries one. The first skip matched ANY identical warning and swallowed exactly
 * those — the two BOUNDARY arms pin a repeat of each still saved and shown. Pi is untouched: a repeated warning is
 * a new event the user should see again.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { i18n, setupI18n } from '@nessy-agent/shared/i18n'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

setDefaultTimeout(30_000)

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// The family's and the per-attempt warnings' sentences, spelled as their emitters spell them. The SOURCE pin
// below dies when codex-agent.ts rewords one; the arms above die when the host-side matcher drifts from these.
const DIVERGENCE_OPENING = 'Codex is not running under the sandbox mode this app asked for.'
const EGRESS_DENIED_PREFIX = 'codex-sandbox-egress-denied:'
const MODEL_METADATA_CONSTANT = 'Model metadata for `opus` not found — continuing with fallback metadata.'
const HOOK_BLOCK_WARNING = 'UserPromptSubmit hook: This prompt violates the workspace policy.'
const UNCARRIED_IMAGE_WARNING = 'Image attachment not sent to the model — codex carries an image by file path and no readable file was found: sketch.png.'

/** The host caveat the codex constant drags along — built from the real key, the way `noteCodexModelMetadataConstantOnce` builds it. */
function caveatSentence(): string {
  if (!i18n.isInitialized) setupI18n()
  return i18n.t('chat.codexModelMetadata.constant', { model: 'opus' })
}

function rig(provider: string) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-f1092-'))
  roots.push(stateRoot)
  const workspace = { id: 'ws-f1092', name: 'F1.1092', slug: 'f1092', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })
  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: 'session-f1092' }, workspace as never, { messagesLoaded: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${managed.id}`, managed)
  const sent: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => { sent.push(event) }) as Parameters<typeof manager.setEventSink>[0])
  const internals = manager as unknown as Record<string, unknown>
  internals.persistSession = () => {}
  internals.resolveManagedProvider = () => provider
  const process = (event: AgentEvent) =>
    (internals.processEvent as (m: unknown, e: AgentEvent) => Promise<void>).call(manager, managed, event)
  const warningRows = (message: string) => managed.messages.filter(m => m.role === 'info' && m.infoLevel === 'warning' && m.content === message)
  const banners = (message: string) => sent.filter(e => e.type === 'info' && (e as { message?: string }).message === message)
  // The transcript a relaunch loads: the warning is already saved.
  const resume = (message: string) => managed.messages.push({ id: `m-saved-${managed.messages.length}`, role: 'info', infoLevel: 'warning', content: message, timestamp: 1 } as never)
  return { managed, process, warningRows, banners, resume }
}

describe('F1.1092 · a resumed codex session does not restate a saved warning from the relaunch family', () => {
  it('codex: each family warning identical to a saved one is neither saved again nor shown again', async () => {
    const sentences = [
      `${DIVERGENCE_OPENING} The config written for this session says sandbox_mode = "workspace-write", and codex resolved a sandbox policy of "read-only" instead.`,
      `${EGRESS_DENIED_PREFIX} the sandbox denied the workspace-egress this turn asked for.`,
      MODEL_METADATA_CONSTANT,
      caveatSentence(),
    ]
    for (const message of sentences) {
      const r = rig('codex-runtime')
      r.resume(message)
      await r.process({ type: 'info', level: 'warning', message } as AgentEvent)
      expect([r.warningRows(message).length, r.banners(message).length]).toEqual([1, 0])
    }
  })

  it('CONTROL: codex, first time — saved and shown; Pi — a repeat is saved and shown again', async () => {
    const first = rig('codex-runtime')
    const message = `${DIVERGENCE_OPENING} The config written for this session says sandbox_mode = "workspace-write".`
    await first.process({ type: 'info', level: 'warning', message } as AgentEvent)
    expect([first.warningRows(message).length, first.banners(message).length]).toEqual([1, 1])

    const pi = rig('pi')
    pi.resume(message)
    await pi.process({ type: 'info', level: 'warning', message } as AgentEvent)
    expect([pi.warningRows(message).length, pi.banners(message).length]).toEqual([2, 1])
  })

  it('BOUNDARY (the repair): a repeated UserPromptSubmit hook block warning is a NEW event — saved and shown again', async () => {
    const r = rig('codex-runtime')
    r.resume(HOOK_BLOCK_WARNING)
    await r.process({ type: 'info', level: 'warning', message: HOOK_BLOCK_WARNING } as AgentEvent)
    expect([r.warningRows(HOOK_BLOCK_WARNING).length, r.banners(HOOK_BLOCK_WARNING).length]).toEqual([2, 1])
  })

  it('BOUNDARY (the repair): a repeated uncarried-image diagnostic is a NEW event — saved and shown again', async () => {
    const r = rig('codex-runtime')
    r.resume(UNCARRIED_IMAGE_WARNING)
    await r.process({ type: 'info', level: 'warning', message: UNCARRIED_IMAGE_WARNING } as AgentEvent)
    expect([r.warningRows(UNCARRIED_IMAGE_WARNING).length, r.banners(UNCARRIED_IMAGE_WARNING).length]).toEqual([2, 1])
  })
})

/**
 * The restatement pattern P3.267 used for its config-writer prefixes: the host spells these strings without
 * importing them, so the emitter's own source is asserted here — a reword upstream turns this red instead of
 * silently detaching the family match (the arms above then fail with it).
 */
describe('F1.1092 · the family matcher is pinned against its emitters', () => {
  const SOURCE = readFileSync(fileURLToPath(new URL('../../../../shared/src/agent/codex-agent.ts', import.meta.url)), 'utf8')

  it('the divergence opening, the egress prefix, the hook yield and the metadata shape are spelled in codex-agent.ts', () => {
    expect(SOURCE).toContain(DIVERGENCE_OPENING)
    expect(SOURCE).toContain(EGRESS_DENIED_PREFIX)
    expect(SOURCE).toContain('`UserPromptSubmit hook: ${')
    expect(SOURCE).toContain('`Image attachment${uncarriedImageNames.length === 1')
    // The both-halves shape of the model-metadata constant (P6.580), which the host mirrors.
    expect(SOURCE).toContain("'model metadata'")
    expect(SOURCE).toContain("'not found'")
  })
})
