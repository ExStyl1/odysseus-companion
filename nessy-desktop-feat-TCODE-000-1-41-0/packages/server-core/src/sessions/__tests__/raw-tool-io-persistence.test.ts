/**
 * P1 — the raw tool input and result are persisted alongside the display
 * projections, and the display projections relativize against the SESSION's
 * own working directory, not the host process cwd.
 *
 * Both halves are driven through the SHIPPED `processEvent` switch, on the SDK
 * dual-event shape a real Claude run produces: the first `tool_start` carries
 * an EMPTY input, and the second pass (`existingStartMsg.toolInput = …`) is
 * what actually fills it — a single-event fixture would keep a broken
 * implementation green, because the create site alone never sees the input the
 * 34 no-input corpus rows lost. The result likewise lands via the update path
 * on the row the start created, plus the orphan create for a result with no
 * start.
 *
 * The session cwd here is deliberately NOT `process.cwd()` and NOT the
 * workspace root: an implementation that keeps either default leaves the
 * absolute paths unrewritten, and the `./src/…` assertions fail.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { messageToStored, storedToPersistedMessage } from '@nessy-agent/core/types'
import type { PersistedMessage } from '@nessy-agent/core/types'
import type { AgentEvent } from '@nessy-agent/shared/agent'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './test-session-manager.ts'

const sessionKey = { workspaceId: 'workspace-raw-io', sessionId: 'session-raw-io' }

// String-level base only — the formatters never touch the filesystem, so this
// does not need to exist. It must differ from process.cwd() (the repo) so a
// host-cwd rebase provably rewrites nothing.
const SESSION_CWD = '/Users/raw-io-fixture/project'

function harness() {
  const manager = createTestSessionManager()
  const internals = manager as unknown as {
    sessions: Map<string, unknown>
    processEvent(managed: unknown, event: AgentEvent): Promise<void>
    sendEvent(event: unknown, workspaceId: string): void
    persistSession(managed: unknown, immediate?: boolean): void
    flushSession(sessionId: string, workspaceId?: string): Promise<void>
  }
  const managed: Record<string, unknown> = {
    id: sessionKey.sessionId,
    // A real temp dir: the tool_start path loads workspace sources from it.
    workspace: { id: sessionKey.workspaceId, rootPath: mkdtempSync(join(tmpdir(), 'nessy-raw-io-test-')) },
    workingDirectory: SESSION_CWD,
    llmConnection: 'pi',
    messagesLoaded: true,
    messages: [],
    backgroundShellCommands: new Map(),
    backgroundTaskOutputs: new Map(),
    piBackgroundTaskKinds: new Map(),
    agent: { isProcessing: () => true },
  }
  internals.sessions.set(encodeSessionKey(sessionKey), managed)
  internals.sendEvent = () => undefined
  internals.persistSession = () => undefined
  internals.flushSession = async () => undefined

  const feed = async (...events: AgentEvent[]) => {
    for (const event of events) await internals.processEvent(managed, event)
  }
  // Tool rows carry no attachments, so the backend persisted shape is the
  // honest read type — it is also what `messageToStored` takes.
  const toolRows = () => (managed.messages as PersistedMessage[]).filter(message => message.role === 'tool')
  return { managed, feed, toolRows }
}

describe('raw tool input/result persist alongside the display projections (P1)', () => {
  test('input filled by the SECOND tool_start and result via the update path carry both shapes', async () => {
    const h = harness()
    const rawInput = { file_path: `${SESSION_CWD}/src/file.ts` }
    const rawResult = `1\timport x\n(read ${SESSION_CWD}/src/file.ts)`

    await h.feed(
      // SDK dual-event shape: the stream_event start has NO input…
      { type: 'tool_start', toolName: 'Read', toolUseId: 'tu-dual', input: {} },
      // …and the assistant-message start fills it via the update path.
      { type: 'tool_start', toolName: 'Read', toolUseId: 'tu-dual', input: rawInput },
      { type: 'tool_result', toolUseId: 'tu-dual', toolName: 'Read', result: rawResult, isError: false },
    )

    const rows = h.toolRows()
    expect(rows).toHaveLength(1)
    const row = rows[0]!

    // Display projections are relativized against the SESSION cwd. The host
    // process cwd is the repo, under which SESSION_CWD paths do not sit — a
    // defaulted rebase would leave them absolute and fail here.
    expect(row.toolInput).toEqual({ file_path: './src/file.ts' })
    expect(row.toolResult).toBe('1\timport x\n(read ./src/file.ts)')

    // The raw pair is what the runtime actually saw, absolute paths intact.
    expect(row.rawToolInput).toEqual(rawInput)
    expect(row.rawToolResult).toBe(rawResult)

    // …and both survive the persistence boundary through the stored mappers.
    const reloaded = storedToPersistedMessage(messageToStored(row))
    expect(reloaded.rawToolInput).toEqual(rawInput)
    expect(reloaded.rawToolResult).toBe(rawResult)
    expect(reloaded.toolInput).toEqual({ file_path: './src/file.ts' })
  })

  test('an orphan result creates the row with the raw copy, capped like the display copy', async () => {
    const h = harness()
    const rawHead = `saved to ${SESSION_CWD}/out/data.json\n`
    const rawResult = rawHead + 'x'.repeat(201_000)

    await h.feed({ type: 'tool_result', toolUseId: 'tu-orphan', toolName: 'Write', result: rawResult, isError: false })

    const rows = h.toolRows()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.toolStatus).toBe('completed')

    // Same rewrite split as above, on the orphan create site.
    expect(row.toolResult!.startsWith('saved to ./out/data.json')).toBe(true)
    expect(row.rawToolResult!.startsWith(rawHead)).toBe(true)

    // The raw copy keeps the display cap — its gain is the correct cwd, not
    // unbounded length.
    expect(row.toolResult).toContain('[Truncated for storage:')
    expect(row.rawToolResult).toContain('[Truncated for storage:')
    expect(row.rawToolResult!.length).toBeLessThan(rawResult.length)
  })
})
