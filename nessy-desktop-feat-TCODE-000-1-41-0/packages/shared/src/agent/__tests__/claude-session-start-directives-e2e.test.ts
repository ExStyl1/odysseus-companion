/**
 * C3.94 — does the vendored binary honour `initialUserMessage` and `watchPaths`
 * for a SessionStart hook declared in its OWN settings tiers?
 *
 * G17 says five SessionStart surfaces are wired and the denominator sweep
 * REFUTED two of them on the host side: `base-agent.ts` stores `watchPaths`
 * behind `chat.hookDirective.watchPathsInert` by a recorded decision, because
 * this fork's FileChanged fires from tool completion rather than from a disk
 * watcher. The question this row asks is the one that decides whether a host
 * consumer is needed at all on the claude arm: the SDK's child reads settings
 * itself, so a hook declared in a settings tier never passes through our
 * directive plumbing. A grep is presence, not behaviour — so this is driven.
 *
 * ## The rig
 *
 * The vendored native binary, a loopback Anthropic Messages stub, no credentials
 * and no network (the shape `claude-auto-mode-classifier-e2e.test.ts`
 * established). The hooks live in the child's USER tier — `<CLAUDE_CONFIG_DIR>/
 * settings.json` — so no project-trust question is in play, and every hook is a
 * shell command writing to a file, so what fired is observable after the run.
 *
 * `watchPaths` needs the session to be ALIVE while a watched file changes, and
 * the stub is what makes that deterministic: it writes the watched file itself
 * on the first request and only then answers, so the change lands inside the
 * turn rather than racing it.
 *
 * Gated on `NESSY_CLAUDE_SDK_E2E=1`: it spawns a 233 MB binary, so it is a
 * recorded local run rather than a CI gate.
 *
 *   NESSY_CLAUDE_SDK_E2E=1 bun test ./packages/shared/src/agent/__tests__/claude-session-start-directives-e2e.test.ts
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

setDefaultTimeout(180_000)

const SEEDED_TURN = 'NESSY_W16F_SEEDED_FIRST_TURN'
const MODEL = 'claude-sonnet-4-5'

/** Path to the native binary we VENDOR, so the run measures what we ship. */
function vendoredClaudeBinary(): string | null {
  const suffix = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  try {
    const require_ = createRequire(import.meta.url)
    const sdkRoot = dirname(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'))
    const candidate = join(dirname(sdkRoot), `claude-agent-sdk-${process.platform}-${arch}`, suffix)
    return existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}

const BINARY = vendoredClaudeBinary()
const LIVE = process.env.NESSY_CLAUDE_SDK_E2E === '1' && BINARY !== null

interface Rig {
  configDir: string
  cwd: string
  /** The file a `watchPaths` arm watches; the stub rewrites it inside the turn. */
  watched: string
  /** Written by the FileChanged hook, if it ever runs. */
  fileChangedMarker: string
}

type SessionStartOutputBuilder = (paths: { cwd: string; configDir: string; watched: string }) => Record<string, unknown>

function makeRig(buildSessionStartOutput: SessionStartOutputBuilder | null): Rig {
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'w16f-directives-cfg-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'w16f-directives-cwd-')))
  const watched = join(cwd, 'watched.txt')
  writeFileSync(watched, 'before\n', 'utf8')
  const fileChangedMarker = join(configDir, 'file-changed-fired.txt')

  const hooks: Record<string, unknown> = {
    // Omitted matcher: "matches every watched file and adds nothing to the watch
    // list" (hooks.md), which is the group the page tells you to use for paths a
    // SessionStart hook supplies dynamically.
    FileChanged: [{ hooks: [{ type: 'command', command: `printf fired > ${JSON.stringify(fileChangedMarker)}` }] }],
  }
  if (buildSessionStartOutput) {
    const payload = join(configDir, 'session-start-output.json')
    writeFileSync(payload, JSON.stringify(buildSessionStartOutput({ cwd, configDir, watched })), 'utf8')
    // `cat` IS the hook: its stdout is the hook's JSON output, which is exactly
    // what the page specifies and keeps the fixture free of shell quoting.
    hooks.SessionStart = [{ hooks: [{ type: 'command', command: `cat ${JSON.stringify(payload)}` }] }]
  }
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ hooks }, null, 2), 'utf8')
  return { configDir, cwd, watched, fileChangedMarker }
}

interface StubHandle {
  port: number
  bodies: string[]
  close: () => Promise<void>
}

/**
 * The loopback upstream. `onFirstRequest` runs BEFORE the answer is streamed and
 * the answer is held for `holdMs`, so a file change lands inside the live turn
 * instead of racing the end of it.
 */
async function startStub(onFirstRequest?: () => void, holdMs = 0): Promise<StubHandle> {
  const bodies: string[] = []
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const path = (req.url ?? '').replace(/\?.*$/, '')
    if (req.method !== 'POST' || !path.endsWith('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `stub: ${path}` } }))
      return
    }
    bodies.push(Buffer.concat(chunks).toString('utf8'))
    if (bodies.length === 1 && onFirstRequest) {
      onFirstRequest()
      if (holdMs > 0) await new Promise<void>(resolve => setTimeout(resolve, holdMs))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const frame = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    frame('message_start', { type: 'message_start', message: { id: `msg_stub_${bodies.length}`, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } })
    frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
    frame('message_stop', { type: 'message_stop' })
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    port: (server.address() as { port: number }).port,
    bodies,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

interface ArmOutcome {
  version: string | null
  upstreamText: string
  fileChangedFired: boolean
}

async function runArm(
  buildSessionStartOutput: SessionStartOutputBuilder | null,
  options: { touchWatched?: boolean; holdMs?: number } = {},
): Promise<ArmOutcome> {
  const rig = makeRig(buildSessionStartOutput)
  const stub = await startStub(
    options.touchWatched ? () => writeFileSync(rig.watched, `after ${Date.now()}\n`, 'utf8') : undefined,
    options.holdMs ?? 0,
  )
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const outcome: ArmOutcome = { version: null, upstreamText: '', fileChangedFired: false }

  // Every CLAUDE*/ANTHROPIC* key is dropped before this arm's own overrides go
  // back on: this suite may itself run inside a Claude Code session.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/i.test(key)),
  ) as Record<string, string>

  const query = sdk.query({
    prompt: 'say done',
    options: {
      cwd: rig.cwd,
      model: MODEL,
      // The child reads its own tiers — which is the whole question: a hook
      // declared here never passes through this fork's directive plumbing.
      settingSources: ['user', 'project', 'local'],
      permissionMode: 'default',
      pathToClaudeCodeExecutable: BINARY ?? undefined,
      canUseTool: async () => ({ behavior: 'deny', message: 'e2e: no tools on this rig' }),
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: rig.configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
        ANTHROPIC_API_KEY: 'not-needed',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    } as never,
  })

  try {
    for await (const message of query) {
      const typed = message as { type: string; subtype?: string; claude_code_version?: string }
      if (typed.type === 'system' && typed.subtype === 'init') outcome.version = typed.claude_code_version ?? null
      if (typed.type === 'result') break
    }
  } catch { /* an arm that fails still reports what it captured */ }

  // A watcher is asynchronous by nature: give it a bounded moment after the turn
  // rather than reading the marker the instant the stream ends.
  for (let attempt = 0; attempt < 20 && !existsSync(rig.fileChangedMarker); attempt++) {
    await new Promise<void>(resolve => setTimeout(resolve, 100))
  }
  outcome.fileChangedFired = existsSync(rig.fileChangedMarker)
  outcome.upstreamText = stub.bodies.join('\n')
  await stub.close()
  rmSync(rig.configDir, { recursive: true, force: true })
  rmSync(rig.cwd, { recursive: true, force: true })
  return outcome
}

describe('C3.94 — the fixture, offline', () => {
  it('declares the hooks in the child\'s own USER settings tier', () => {
    const rig = makeRig(() => ({ hookSpecificOutput: { hookEventName: 'SessionStart', initialUserMessage: SEEDED_TURN } }))
    const settings = JSON.parse(readFileSync(join(rig.configDir, 'settings.json'), 'utf8')) as {
      hooks?: Record<string, unknown>
    }
    expect(Object.keys(settings.hooks ?? {})).toContain('SessionStart')
    expect(Object.keys(settings.hooks ?? {})).toContain('FileChanged')
    rmSync(rig.configDir, { recursive: true, force: true })
    rmSync(rig.cwd, { recursive: true, force: true })
  })
})

describe.skipIf(!LIVE)('C3.94 — driven against the vendored binary', () => {
  it('honours `initialUserMessage` from a settings-tier SessionStart hook', async () => {
    // hooks.md#sessionstart-decision-control: "String used as the first user
    // message of the session… If a prompt is provided, it follows as the next
    // turn." So the seeded text must reach the upstream turn.
    const outcome = await runArm(() => ({
      hookSpecificOutput: { hookEventName: 'SessionStart', initialUserMessage: SEEDED_TURN },
    }))
    expect(outcome.version).not.toBeNull()
    expect(outcome.upstreamText).toContain(SEEDED_TURN)
  })

  it('`watchPaths` from the same hook seeds the watcher: FileChanged fires inside the turn', async () => {
    // hooks.md#sessionstart-decision-control: "Array of absolute paths to watch
    // for FileChanged events during this session", and §FileChanged: "Claude
    // Code starts the watcher only when something names a file to watch, so seed
    // the list with … a SessionStart … hook that returns `watchPaths`". The stub
    // rewrites the watched file on the first request and holds the answer, so the
    // change happens while the session is alive rather than racing its end.
    const outcome = await runArm(
      ({ watched }) => ({ hookSpecificOutput: { hookEventName: 'SessionStart', watchPaths: [watched] } }),
      { touchWatched: true, holdMs: 3000 },
    )
    expect(outcome.version).not.toBeNull()
    expect(outcome.fileChangedFired).toBe(true)
  })

  it('and with NO `watchPaths` the same file change fires nothing — the watcher is not on by default', async () => {
    // The control the positive arm needs: identical rig, identical write inside
    // the turn, identical FileChanged group, and no hook to seed the watch list.
    // Without it, "FileChanged fired" could mean the matcher watched the tree
    // anyway. hooks.md: "Claude Code starts the watcher only when something names
    // a file to watch".
    const outcome = await runArm(null, { touchWatched: true, holdMs: 3000 })
    expect(outcome.version).not.toBeNull()
    expect(outcome.fileChangedFired).toBe(false)
  })

  it('the control arm, same rig with no SessionStart hook, carries no seeded turn', async () => {
    const outcome = await runArm(null)
    expect(outcome.version).not.toBeNull()
    expect(outcome.upstreamText).not.toContain(SEEDED_TURN)
    expect(outcome.fileChangedFired).toBe(false)
  })
})
