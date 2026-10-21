/**
 * C3.183 — does a flat Markdown file in a project `.claude/commands/` become
 * `/<name>` on the claude runtime? DRIVEN, because nothing else can answer it.
 *
 * L67 has read `—` on all three runtimes since the P6.189 admission, and the
 * reason it stayed unfilled is recorded there: on claude the SDK loads
 * `.claude/commands/` ITSELF from the setting sources this fork already passes
 * (`claude-agent.ts` symbol `buildClaudeTurnShapeOptions` sets
 * `settingSources: ['user','project','local']`), *"so on that runtime it may
 * already work through a path the host does not know about, which is itself the
 * risk"*. A grep cannot see that, and neither can a page: the question is what
 * the binary does with a directory it finds.
 *
 * ## The rig
 *
 * The same shape as `claude-auto-mode-classifier-e2e.test.ts`: the VENDORED
 * native binary, a loopback Anthropic Messages stub, no credentials and no
 * network. One arm writes `.claude/commands/hello.md` into the project
 * directory; the control arm writes nothing. The instrument is the child's own
 * `system/init` message, which declares `slash_commands` — the roster P6.1006
 * already reads in production — plus the request body the stub receives, which
 * shows whether the command's TEXT was expanded into the turn.
 *
 * Gated on `NESSY_CLAUDE_SDK_E2E=1` like its neighbour, because it spawns a
 * 233 MB binary: a recorded local run rather than a CI gate. The offline half
 * (the fixture the arms share) runs unconditionally so the file is never a
 * silent skip.
 *
 *   NESSY_CLAUDE_SDK_E2E=1 bun test ./packages/shared/src/agent/__tests__/claude-project-commands-e2e.test.ts
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { listCustomSlashCommands } from '../../slash-commands/custom-commands.ts'

setDefaultTimeout(180_000)

/** The command file under test. Its BODY is the marker an expansion carries. */
const COMMAND_NAME = 'w16fhello'
const COMMAND_BODY = 'Reply with the single word NESSY_W16F_COMMAND_BODY_MARKER and nothing else.'
const COMMAND_MARKER = 'NESSY_W16F_COMMAND_BODY_MARKER'
/** A name no directory defines — the negative control for the roster and the wire. */
const ABSENT_COMMAND = 'w16fnosuchcommand'
const MODEL = 'claude-sonnet-4-5'

interface StubHandle {
  port: number
  bodies: string[]
  close: () => Promise<void>
}

/** A loopback Anthropic Messages endpoint that answers every request with `done`. */
async function startStub(): Promise<StubHandle> {
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

/** Write the project tree one arm runs in. */
function makeProject(withCommand: boolean): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'w16f-commands-')))
  if (withCommand) {
    mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true })
    // FLAT Markdown, no frontmatter: the shape L67 names.
    writeFileSync(join(cwd, '.claude', 'commands', `${COMMAND_NAME}.md`), `${COMMAND_BODY}\n`, 'utf8')
  }
  return cwd
}

interface ArmOutcome {
  slashCommands: string[]
  version: string | null
  upstreamText: string
}

async function runArm(withCommand: boolean, prompt: string): Promise<ArmOutcome> {
  const stub = await startStub()
  const configDir = mkdtempSync(join(tmpdir(), 'w16f-commands-cfg-'))
  const cwd = makeProject(withCommand)
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const outcome: ArmOutcome = { slashCommands: [], version: null, upstreamText: '' }

  // Every CLAUDE*/ANTHROPIC* key is dropped before this arm's own overrides go
  // back on: this suite may itself run inside a Claude Code session, whose env
  // would otherwise pick the binary and set feature flags.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/i.test(key)),
  ) as Record<string, string>

  const query = sdk.query({
    prompt,
    options: {
      cwd,
      model: MODEL,
      // The sources this fork passes in production — the whole point of the row.
      settingSources: ['user', 'project', 'local'],
      permissionMode: 'default',
      pathToClaudeCodeExecutable: BINARY ?? undefined,
      canUseTool: async () => ({ behavior: 'deny', message: 'e2e: no tools on this rig' }),
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
        ANTHROPIC_API_KEY: 'not-needed',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    } as never,
  })

  try {
    for await (const message of query) {
      const typed = message as {
        type: string
        subtype?: string
        claude_code_version?: string
        slash_commands?: string[]
      }
      if (typed.type === 'system' && typed.subtype === 'init') {
        outcome.version = typed.claude_code_version ?? null
        outcome.slashCommands = typed.slash_commands ?? []
      }
      if (typed.type === 'result') break
    }
  } catch { /* an arm that fails still reports what it captured */ }

  outcome.upstreamText = stub.bodies.join('\n')
  await stub.close()
  rmSync(configDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
  return outcome
}

describe('C3.183 — the fixture, offline', () => {
  it('writes a flat Markdown command file with no frontmatter', () => {
    const cwd = makeProject(true)
    expect(existsSync(join(cwd, '.claude', 'commands', `${COMMAND_NAME}.md`))).toBe(true)
    rmSync(cwd, { recursive: true, force: true })
    // The control arm must leave the directory absent, or the negative proves nothing.
    const bare = makeProject(false)
    expect(existsSync(join(bare, '.claude', 'commands'))).toBe(false)
    rmSync(bare, { recursive: true, force: true })
  })
})

/**
 * The other two runtimes, answered where their answer is actually decided: the
 * HOST's own loader. Pi and codex have no `.claude/commands` reader of their own
 * — the host lists custom commands for them — so this is a behavioural test and
 * not a reading, and it doubles as the CONTROL for the claude arm above: the
 * child accepts a directory the host's listing never offers.
 */
describe('C3.183 — Pi and codex: the host loader is the whole answer', () => {
  it('does not read `.claude/commands`, and does read the directory the import writes', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'w16f-host-commands-')))
    mkdirSync(join(root, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(root, '.claude', 'commands', `${COMMAND_NAME}.md`), `${COMMAND_BODY}\n`, 'utf8')
    const fromClaudeDir = listCustomSlashCommands({ workingDirectory: root, workspaceRootPath: root })
    expect(fromClaudeDir.map(command => command.name)).not.toContain(COMMAND_NAME)

    // POSITIVE CONTROL on the same rig: the target `claude-setup-import.ts`
    // copies to IS read, so the negative above is a scope verdict rather than a
    // loader that reads nothing.
    mkdirSync(join(root, '.nessy-agent', 'commands'), { recursive: true })
    writeFileSync(join(root, '.nessy-agent', 'commands', `${COMMAND_NAME}.md`), `${COMMAND_BODY}\n`, 'utf8')
    const afterImport = listCustomSlashCommands({ workingDirectory: root, workspaceRootPath: root })
    expect(afterImport.map(command => command.name)).toContain(COMMAND_NAME)
    rmSync(root, { recursive: true, force: true })
  })
})

describe.skipIf(!LIVE)('C3.183 — driven against the vendored binary', () => {
  it('a project .claude/commands/<name>.md is registered as /<name>', async () => {
    const outcome = await runArm(true, `/${COMMAND_NAME}`)
    expect(outcome.version).not.toBeNull()
    // POSITIVE CONTROL for the rig itself: the roster is non-empty, so an empty
    // `slash_commands` cannot pass as "the command is absent".
    expect(outcome.slashCommands.length).toBeGreaterThan(0)
    expect(outcome.slashCommands).toContain(COMMAND_NAME)
    // The turn the model actually received carries the command's BODY, which is
    // what "dispatches" means — a literal `/name` passed through would not.
    expect(outcome.upstreamText).toContain(COMMAND_MARKER)
  })

  it('the same session without the file has neither the name nor the body', async () => {
    const outcome = await runArm(false, `/${ABSENT_COMMAND}`)
    expect(outcome.version).not.toBeNull()
    expect(outcome.slashCommands.length).toBeGreaterThan(0)
    expect(outcome.slashCommands).not.toContain(COMMAND_NAME)
    expect(outcome.upstreamText).not.toContain(COMMAND_MARKER)
  })
})
