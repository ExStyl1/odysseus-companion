/**
 * D12 — a Stop hook can see WHAT the agent left running.
 *
 * `hooks.md:2204` (fetched raw 2026-07-30): "| `command`     | Shell command
 * line, capped at 1000 characters. Present only for `shell` tasks |".
 *
 * The registry used to report `{ id, type: 'shell', description: <the same id> }`
 * because `ProcessStore` never persisted a command line and the host stored the
 * handle under its own key. A fleet Stop hook could neither log nor block on the
 * background work — precisely the datum an incident review asks for first.
 *
 * This drives the real emission path (`processEvent` for the live half,
 * `buildHookTaskRegistryPort` for what `hookTaskRegistryInput` emits) rather
 * than the pure projection, because the defect lived in the WIRING: the pure
 * function was already given whatever the host chose to put in the map.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackgroundTaskEntryV1 } from '@nessy-agent/shared/automations'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { formatToolInputPaths } from '@nessy-agent/shared/utils/files'
import { ProcessStore } from '../../pi-harness/process-store.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE = 'workspace-stop-shell-command'
const SESSION = 'session-stop-shell-command'

/** A command line with a bearer token in an argument — the leak-surface case. */
const TOKENED = 'curl -H "Authorization: Bearer sk_live_abcdefghijklmnopqrstuvwxyz012345" https://example.test/health'

describe('the Stop payload names the background shell command (hooks.md :2204)', () => {
  let root: string
  let manager: ReturnType<typeof createTestSessionManager>
  let managed: any

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stop-shell-command-'))
    manager = createTestSessionManager()
    managed = {
      id: SESSION,
      workspace: { id: WORKSPACE, rootPath: root },
      permissionMode: 'ask',
      llmConnection: 'pi',
      messagesLoaded: true,
      messages: [],
      backgroundShellCommands: new Map<string, string>(),
      backgroundTaskOutputs: new Map(),
      piBackgroundTaskKinds: new Map(),
      childSessionState: undefined,
      agent: null,
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE, sessionId: SESSION }), managed)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const backgroundTasks = (): readonly BackgroundTaskEntryV1[] =>
    (manager as any).buildHookTaskRegistryPort(managed).backgroundTasks()

  test('a live background shell reports its command, not its own id', async () => {
    await (manager as any).processEvent(managed, {
      type: 'shell_backgrounded',
      toolUseId: 'call-1',
      shellId: 'process_ab',
      command: 'npm run build -- --watch',
    })

    const shell = backgroundTasks().find(entry => entry.type === 'shell')
    expect(shell).toEqual({
      id: 'process_ab',
      type: 'shell',
      status: 'running',
      description: 'npm run build -- --watch',
      command: 'npm run build -- --watch',
    })
    // The bug in one assertion: the id is not the description.
    expect(shell?.description).not.toBe(shell?.id)
  })

  test('a shell adopted across a restart still carries the command', async () => {
    // A record written by a PREVIOUS process: the store on disk is all that
    // survives, and the runtime map starts empty exactly as it does after a
    // resume. Two records, so the non-shell one proves the filter.
    const store: ProcessStore = (manager as any).piProcessStore
    const sessionKey = { workspaceId: WORKSPACE, sessionId: SESSION }
    const base = {
      sessionKey,
      pid: 4242,
      startedAt: Date.now(),
      deadlineAt: Date.now() + 60_000,
      status: 'running' as const,
      exitCode: null,
      signal: null,
      pidStartMarker: null,
      profile: 'workspace' as const,
      isolationProfile: 'workspace:seatbelt',
      environmentProfile: 'restricted' as const,
      environmentDigest: 'digest',
      cwd: root,
    }
    const shell = await store.create({
      ...base, executionId: 'exec-shell', semanticId: 'bash_background',
      command: 'tail -f /var/log/deploy.log',
    })
    const lsp = await store.create({
      ...base, executionId: 'exec-lsp', semanticId: 'lsp', command: 'typescript-language-server --stdio',
    })

    expect(managed.backgroundShellCommands.size).toBe(0)
    await (manager as any).adoptSupervisedShellCommands(managed)

    const entries = backgroundTasks()
    expect(entries.map(entry => entry.id)).toEqual([shell.handle])
    expect(entries[0]?.command).toBe('tail -f /var/log/deploy.log')
    // An LSP subprocess is not background work the session is waiting on.
    expect(entries.map(entry => entry.id)).not.toContain(lsp.handle)
  })

  test('adoption never overwrites what the live stream already knows', async () => {
    const store: ProcessStore = (manager as any).piProcessStore
    const record = await store.create({
      sessionKey: { workspaceId: WORKSPACE, sessionId: SESSION },
      executionId: 'exec-shell', semanticId: 'bash_background',
      command: 'the stale record', pid: null, startedAt: Date.now(), deadlineAt: Date.now() + 60_000,
      status: 'running', exitCode: null, signal: null, pidStartMarker: null,
      profile: 'workspace', isolationProfile: 'workspace:seatbelt',
      environmentProfile: 'restricted', environmentDigest: 'digest', cwd: root,
    })
    managed.backgroundShellCommands.set(record.handle, 'the live command')

    await (manager as any).adoptSupervisedShellCommands(managed)

    expect(managed.backgroundShellCommands.get(record.handle)).toBe('the live command')
  })

  test('the command is the same string the transcript keeps — one answer, not two', async () => {
    // The redaction question, settled against the record that already exists.
    // The transcript persists `toolInput` through `formatToolInputPaths`, which
    // relativises paths and redacts NOTHING; every `PreToolUse` hook is handed
    // the same `tool_input`. A masked Stop payload would be a second answer for
    // one string, and the hook process that reads both would see them disagree.
    await (manager as any).processEvent(managed, {
      type: 'shell_backgrounded', toolUseId: 'call-1', shellId: 'process_ab', command: TOKENED,
    })

    const transcriptForm = String(formatToolInputPaths({ command: TOKENED }, root)?.command)
    expect(transcriptForm).toBe(TOKENED)
    expect(backgroundTasks().find(entry => entry.type === 'shell')?.command).toBe(transcriptForm)
  })
})
