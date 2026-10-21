import { describe, it, expect } from 'bun:test'
import {
  MAX_PIPED_STDIN_BYTES,
  parseAgentsArg,
  parseArgs,
  renderWorkspaceRemoval,
  WORKSPACE_REMOVAL_RESIDUE_TEXT,
  pipedStdinUnreadableWarning,
  readPrompt,
  resolveApiKey,
  shouldSetupLlmConnection,
} from './index.ts'

// ---------------------------------------------------------------------------
// Arg parsing tests
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses --url, --token, --workspace', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--url', 'ws://localhost:3000',
      '--token', 'secret123',
      '--workspace', 'ws-1',
      'ping',
    ])
    expect(args.url).toBe('ws://localhost:3000')
    expect(args.token).toBe('secret123')
    expect(args.workspace).toBe('ws-1')
    expect(args.command).toBe('ping')
  })

  it('parses --timeout and --json', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--timeout', '5000',
      '--json',
      'workspaces',
    ])
    expect(args.timeout).toBe(5000)
    expect(args.json).toBe(true)
    expect(args.command).toBe('workspaces')
  })

  // `env-vars.md:318` — "Equivalent to passing `--safe-mode`", and the env
  // var is the other half of the same switch.
  it('parses --safe-mode and defaults it off', () => {
    expect(parseArgs(['bun', 'index.ts', '--safe-mode', 'ping']).safeMode).toBe(true)
    expect(parseArgs(['bun', 'index.ts', 'ping']).safeMode).toBe(false)
  })

  // `model-config.md:366` — "Set a chain for one session with the
  // `--fallback-model` flag, which accepts a comma-separated list".
  it('parses --fallback-model as a raw comma-separated list', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--fallback-model', 'pi/one,pi/two,pi/three',
      'run', 'hello',
    ])
    expect(args.fallbackModel).toBe('pi/one,pi/two,pi/three')
    expect(args.command).toBe('run')
  })

  it('leaves the fallback chain empty when the flag is absent', () => {
    // The negative case: no flag and no env var must not configure a chain,
    // because an empty value would OVERRIDE the fallbackModel setting.
    expect(parseArgs(['bun', 'index.ts', 'ping']).fallbackModel).toBe('')
  })

  it('parses --tls-ca', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--tls-ca', '/path/to/ca.pem',
      'ping',
    ])
    expect(args.tlsCa).toBe('/path/to/ca.pem')
  })

  it('parses --send-timeout', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--send-timeout', '60000',
      'send', 'session-1', 'hello',
    ])
    expect(args.sendTimeout).toBe(60000)
    expect(args.command).toBe('send')
    expect(args.rest).toEqual(['session-1', 'hello'])
  })

  it('falls back to env vars for url and token', () => {
    const prevUrl = process.env.NESSY_SERVER_URL
    const prevToken = process.env.NESSY_SERVER_TOKEN
    const prevCa = process.env.NESSY_TLS_CA

    process.env.NESSY_SERVER_URL = 'ws://env-server:8080'
    process.env.NESSY_SERVER_TOKEN = 'env-token'
    process.env.NESSY_TLS_CA = '/env/ca.pem'

    try {
      const args = parseArgs(['bun', 'index.ts', 'ping'])
      expect(args.url).toBe('ws://env-server:8080')
      expect(args.token).toBe('env-token')
      expect(args.tlsCa).toBe('/env/ca.pem')
    } finally {
      if (prevUrl === undefined) delete process.env.NESSY_SERVER_URL
      else process.env.NESSY_SERVER_URL = prevUrl
      if (prevToken === undefined) delete process.env.NESSY_SERVER_TOKEN
      else process.env.NESSY_SERVER_TOKEN = prevToken
      if (prevCa === undefined) delete process.env.NESSY_TLS_CA
      else process.env.NESSY_TLS_CA = prevCa
    }
  })

  it('explicit flags override env vars', () => {
    const prevUrl = process.env.NESSY_SERVER_URL
    process.env.NESSY_SERVER_URL = 'ws://env-server:8080'

    try {
      const args = parseArgs(['bun', 'index.ts', '--url', 'ws://flag-server:9090', 'ping'])
      expect(args.url).toBe('ws://flag-server:9090')
    } finally {
      if (prevUrl === undefined) delete process.env.NESSY_SERVER_URL
      else process.env.NESSY_SERVER_URL = prevUrl
    }
  })

  it('parses --help as command', () => {
    const args = parseArgs(['bun', 'index.ts', '--help'])
    expect(args.command).toBe('help')
  })

  it('parses --version as command', () => {
    const args = parseArgs(['bun', 'index.ts', '--version'])
    expect(args.command).toBe('version')
  })

  it('parses --validate-server as command', () => {
    const args = parseArgs(['bun', 'index.ts', '--validate-server'])
    expect(args.command).toBe('validate')
  })

  it('parses session subcommand with args', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      'session', 'create', '--name', 'test', '--mode', 'safe',
    ])
    expect(args.command).toBe('session')
    // --mode is now a global flag, consumed at top level
    expect(args.rest).toEqual(['create', '--name', 'test'])
    expect(args.mode).toBe('safe')
  })

  it('parses send with message text', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      'send', 'sess-123', 'What', 'files', 'are', 'here?',
    ])
    expect(args.command).toBe('send')
    expect(args.rest).toEqual(['sess-123', 'What', 'files', 'are', 'here?'])
  })

  it('parses invoke with channel and JSON args', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      'invoke', 'sessions:get', '["workspace-1"]',
    ])
    expect(args.command).toBe('invoke')
    expect(args.rest).toEqual(['sessions:get', '["workspace-1"]'])
  })

  it('defaults to empty command (shows help)', () => {
    const args = parseArgs(['bun', 'index.ts'])
    expect(args.command).toBe('')
  })

  it('defaults timeout to 10000', () => {
    const args = parseArgs(['bun', 'index.ts', 'ping'])
    expect(args.timeout).toBe(10000)
  })

  it('defaults sendTimeout to 300000', () => {
    const args = parseArgs(['bun', 'index.ts', 'send', 's1', 'hi'])
    expect(args.sendTimeout).toBe(300000)
  })

  it('defaults json to false', () => {
    const args = parseArgs(['bun', 'index.ts', 'ping'])
    expect(args.json).toBe(false)
  })

  // --- run-specific flags ---

  it('parses run command with positional args', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello', 'world'])
    expect(args.command).toBe('run')
    expect(args.rest).toEqual(['hello', 'world'])
  })

  it('--source accumulates into array', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--source', 'nessy-kb',
      '--source', 'github',
      'run', 'do stuff',
    ])
    expect(args.sources).toEqual(['nessy-kb', 'github'])
  })

  it('defaults sources to empty array', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.sources).toEqual([])
  })

  it('--mode sets mode', () => {
    const args = parseArgs(['bun', 'index.ts', '--mode', 'safe', 'run', 'hello'])
    expect(args.mode).toBe('safe')
  })

  it('defaults mode to empty (run defaults to allow-all)', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.mode).toBe('')
  })

  it('--output-format sets outputFormat', () => {
    const args = parseArgs(['bun', 'index.ts', '--output-format', 'stream-json', 'run', 'hello'])
    expect(args.outputFormat).toBe('stream-json')
  })

  it('defaults outputFormat to text', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.outputFormat).toBe('text')
  })

  it('--no-cleanup sets noCleanup', () => {
    const args = parseArgs(['bun', 'index.ts', '--no-cleanup', 'run', 'hello'])
    expect(args.noCleanup).toBe(true)
  })

  it('defaults noCleanup to false', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.noCleanup).toBe(false)
  })

  it('--server-entry sets serverEntry', () => {
    const args = parseArgs(['bun', 'index.ts', '--server-entry', '/path/to/server.ts', 'run', 'hello'])
    expect(args.serverEntry).toBe('/path/to/server.ts')
  })

  it('defaults serverEntry to undefined', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.serverEntry).toBeUndefined()
  })

  it('--workspace-dir sets workspaceDir', () => {
    const args = parseArgs(['bun', 'index.ts', '--workspace-dir', '/tmp/ws', 'run', 'hello'])
    expect(args.workspaceDir).toBe('/tmp/ws')
  })

  it('defaults workspaceDir to undefined', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.workspaceDir).toBeUndefined()
  })

  it('parses --provider deepseek for run', () => {
    const args = parseArgs(['bun', 'index.ts', '--provider', 'deepseek', 'run', 'hello'])
    expect(args.provider).toBe('deepseek')
  })

  // --- R66 · flag names, session retention, unknown-flag reporting ---

  it('--permission-mode is the documented spelling and --mode stays an alias', () => {
    // `cli-reference.md:107` names the flag `--permission-mode`; the values were
    // already Claude's, so the two spellings must land on the same field.
    expect(parseArgs(['bun', 'index.ts', '--permission-mode', 'acceptEdits', 'run', 'hello']).mode)
      .toBe('acceptEdits')
    expect(parseArgs(['bun', 'index.ts', '--mode', 'acceptEdits', 'run', 'hello']).mode)
      .toBe('acceptEdits')
    // The flag and its value are consumed, never left in the prompt.
    expect(parseArgs(['bun', 'index.ts', '--permission-mode', 'plan', 'run', 'hello']).rest)
      .toEqual(['hello'])
  })

  it('--dangerously-skip-permissions is a value-less alias for --permission-mode bypassPermissions', () => {
    // `permission-modes.md`: "The `--dangerously-skip-permissions` flag is
    // equivalent" (to bypassPermissions). Unlike `--permission-mode` it takes
    // no value, so the next token must stay a positional/prompt word.
    const args = parseArgs(['bun', 'index.ts', '--dangerously-skip-permissions', 'run', 'hello'])
    expect(args.mode).toBe('bypassPermissions')
    expect(args.rest).toEqual(['hello'])
    expect(args.unknownFlags).toEqual([])
  })

  it('--no-session-persistence sets the flag and defaults off', () => {
    const args = parseArgs(['bun', 'index.ts', '--no-session-persistence', 'run', 'hello'])
    expect(args.noSessionPersistence).toBe(true)
    // The prompt-poisoning regression: the flag must not reach `rest`, which is
    // what `run` joins into the message it sends the model.
    expect(args.rest).toEqual(['hello'])
    expect(args.unknownFlags).toEqual([])
    expect(parseArgs(['bun', 'index.ts', 'run', 'hello']).noSessionPersistence).toBe(false)
  })

  it('the skip-prompt-history env vars set it without the flag', () => {
    // `cli-reference.md:105` — the env var "does the same in any mode".
    const nessy = process.env.NESSY_SKIP_PROMPT_HISTORY
    const claude = process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
    try {
      delete process.env.NESSY_SKIP_PROMPT_HISTORY
      process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1'
      expect(parseArgs(['bun', 'index.ts', 'run', 'hello']).noSessionPersistence).toBe(true)

      process.env.NESSY_SKIP_PROMPT_HISTORY = '1'
      delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
      expect(parseArgs(['bun', 'index.ts', 'run', 'hello']).noSessionPersistence).toBe(true)

      // The Nessy spelling wins when both are set, so an explicit local `0`
      // beats an inherited compat `1`.
      process.env.NESSY_SKIP_PROMPT_HISTORY = '0'
      process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1'
      expect(parseArgs(['bun', 'index.ts', 'run', 'hello']).noSessionPersistence).toBe(false)
    } finally {
      if (nessy === undefined) delete process.env.NESSY_SKIP_PROMPT_HISTORY
      else process.env.NESSY_SKIP_PROMPT_HISTORY = nessy
      if (claude === undefined) delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
      else process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = claude
    }
  })

  it('collects an unrecognized dash-argument instead of putting it in the prompt', () => {
    // `headless.md:33` — an invalid flag is reported before the run starts. It
    // used to be concatenated into `run`'s prompt.
    const args = parseArgs(['bun', 'index.ts', 'run', 'Fix the lint', '--allowedTools', 'Bash,Read'])
    expect(args.unknownFlags).toEqual(['--allowedTools'])
    // Only the flag itself is diverted; its value is indistinguishable from a
    // prompt word to a parser that does not know the flag.
    expect(args.rest).toEqual(['Fix the lint', 'Bash,Read'])
  })

  it('keeps the sub-command flags other commands mine out of rest', () => {
    expect(parseArgs(['bun', 'index.ts', 'session', 'create', '--name', 'x']).unknownFlags).toEqual([])
    expect(parseArgs(['bun', 'index.ts', 'send', 's1', '--stdin']).unknownFlags).toEqual([])
    expect(parseArgs(['bun', 'index.ts', 'plugin', 'validate', './p', '--strict']).rest)
      .toEqual(['validate', './p', '--strict'])
  })

  it('-- ends the flags so a dash-leading positional stays reachable', () => {
    const args = parseArgs(['bun', 'index.ts', 'invoke', 'some:channel', '--', '-1', '--not-a-flag'])
    expect(args.command).toBe('invoke')
    expect(args.rest).toEqual(['some:channel', '-1', '--not-a-flag'])
    expect(args.unknownFlags).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Piped stdin cap (`headless.md:88`)
// ---------------------------------------------------------------------------

function streamOf(
  chunks: number[],
  hooks?: { onCancel?: () => void; onPull?: () => void },
): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      hooks?.onPull?.()
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(chunks[i++]!).fill(0x61))
    },
    cancel() {
      hooks?.onCancel?.()
    },
  })
}

describe('readPrompt stdin cap', () => {
  it('accepts a payload of exactly the cap — the boundary is inclusive', async () => {
    const text = await readPrompt([], ['--stdin'], streamOf([MAX_PIPED_STDIN_BYTES]))
    expect(text.length).toBe(MAX_PIPED_STDIN_BYTES)
  })

  it('rejects one byte over the cap with the documented clear error', async () => {
    const stream = streamOf([MAX_PIPED_STDIN_BYTES, 1])
    await expect(readPrompt([], ['--stdin'], stream)).rejects.toThrow(/10MB/)
  })

  it('cancels the reader as soon as the cap is crossed rather than draining first', async () => {
    // 32 MiB offered in 1 MiB chunks: the cap is crossed on the 11th, so a
    // fail-fast reader stops there and a drain-then-check one does not.
    let cancelled = false
    let pulls = 0
    const stream = streamOf(
      Array.from({ length: 32 }, () => 1024 * 1024),
      { onCancel: () => { cancelled = true }, onPull: () => { pulls++ } },
    )

    await expect(readPrompt([], ['--stdin'], stream)).rejects.toThrow(/10MB/)
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(32)
  })

  it('flushes the decoder so a chunk-split multibyte character survives', async () => {
    // "é" is 0xC3 0xA9; delivering the two bytes in separate chunks used to drop
    // the character entirely, because the streaming decoder was never flushed.
    let i = 0
    const parts = [new Uint8Array([0xC3]), new Uint8Array([0xA9])]
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= parts.length) controller.close()
        else controller.enqueue(parts[i++]!)
      },
    })
    expect(await readPrompt([], ['--stdin'], stream)).toBe('é')
  })
})

// ---------------------------------------------------------------------------
// P6.458 — an UNREADABLE piped stdin
// ---------------------------------------------------------------------------

/**
 * `headless.md#pipe-data-through-claude`, whole sentence:
 *
 * > If Claude Code can't read stdin, for example because the process that
 * > started it disconnected its end, Claude Code prints a warning to stderr and
 * > continues with the prompt from the command line.
 *
 * The row was born believing no page sentence existed for this arm; it does.
 * Measured before the branch (2026-09-06, darwin-arm64, `run "say hi" --stdin`
 * with stdin pointed at a directory fd): `Error: EISDIR: illegal operation on a
 * directory, fstat` and exit 1, the command-line prompt discarded. Not silent —
 * it STOPPED, which the page says it must not.
 *
 * The failure fires when the stream is OPENED, not on the first `read()`, so a
 * catch around the read alone would have left the measured case unchanged.
 */
describe('P6.458 · readPrompt with an unreadable stdin', () => {
  function erroringStream(at: 'open' | 'read'): ReadableStream<Uint8Array> {
    if (at === 'open') {
      // Bun.stdin.stream() throws at construction on a directory fd; a getter
      // that throws is the injectable stand-in for that.
      return new Proxy({} as ReadableStream<Uint8Array>, {
        get() { throw new Error('EISDIR: illegal operation on a directory, fstat') },
      })
    }
    return new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('EIO: stdin disconnected')) },
    })
  }

  function captureStderr(): { lines: () => string; restore: () => void } {
    const original = process.stderr.write.bind(process.stderr)
    let buffer = ''
    ;(process.stderr as unknown as { write: unknown }).write = ((chunk: unknown) => {
      buffer += String(chunk)
      return true
    }) as typeof process.stderr.write
    return {
      lines: () => buffer,
      restore: () => { (process.stderr as unknown as { write: unknown }).write = original },
    }
  }

  for (const at of ['open', 'read'] as const) {
    it(`warns and continues with the command-line prompt when stdin fails at ${at}`, async () => {
      const cap = captureStderr()
      let text: string
      try {
        text = await readPrompt(['say', 'hi'], ['--stdin'], erroringStream(at))
      } finally {
        cap.restore()
      }
      // Continued with the command-line prompt, EXACTLY as typed — no trailing
      // separator for a read that never happened.
      expect(text).toBe('say hi')
      expect(cap.lines()).toContain('could not read piped stdin')
      expect(cap.lines()).toContain('continuing with the prompt from the command line')
      // A warning, not an error: `Error: ` is the CLI's failure prefix and this
      // line does not end the run.
      expect(cap.lines().startsWith('Error:')).toBe(false)
    })
  }

  it('leaves the 10MB cap a hard failure — the warning does not swallow it', async () => {
    const cap = captureStderr()
    try {
      await expect(readPrompt([], ['--stdin'], streamOf([MAX_PIPED_STDIN_BYTES, 1]))).rejects.toThrow(/10MB/)
    } finally {
      cap.restore()
    }
    expect(cap.lines()).not.toContain('could not read piped stdin')
  })

  it('leaves a readable pipe alone — the negative control', async () => {
    const cap = captureStderr()
    let text: string
    try {
      text = await readPrompt(['say', 'hi'], ['--stdin'], streamOf([4]))
    } finally {
      cap.restore()
    }
    expect(text).toBe('say hi\naaaa')
    expect(cap.lines()).toBe('')
  })

  it('builds the warning line in one place, so the run and this test cannot drift', () => {
    expect(pipedStdinUnreadableWarning('EIO'))
      .toBe('Warning: could not read piped stdin (EIO); continuing with the prompt from the command line')
  })
})

// ---------------------------------------------------------------------------
// Provider credential resolution tests
// ---------------------------------------------------------------------------

describe('resolveApiKey', () => {
  it('uses DEEPSEEK_API_KEY for the deepseek provider', () => {
    const prev = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'deepseek-test-key'

    try {
      expect(resolveApiKey('deepseek', '')).toBe('deepseek-test-key')
    } finally {
      if (prev === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = prev
    }
  })
})

describe('shouldSetupLlmConnection', () => {
  it('forces setup for non-default providers even when connections already exist', () => {
    expect(shouldSetupLlmConnection(2, { provider: 'deepseek', baseUrl: '' })).toBe(true)
  })

  it('skips setup for the default anthropic provider when connections already exist', () => {
    expect(shouldSetupLlmConnection(2, { provider: 'anthropic', baseUrl: '' })).toBe(false)
  })

  it('forces setup for custom endpoints', () => {
    expect(shouldSetupLlmConnection(2, { provider: 'anthropic', baseUrl: 'https://api.example.com' })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Validate steps structure tests
// ---------------------------------------------------------------------------

import { getValidateSteps } from './index.ts'

describe('getValidateSteps', () => {
  it('returns a non-empty array of steps', () => {
    const steps = getValidateSteps()
    expect(steps.length).toBeGreaterThan(0)
    // Sanity: at least the known lifecycle groups exist
    expect(steps.length).toBeGreaterThanOrEqual(20)
  })

  it('first step is handshake', () => {
    const steps = getValidateSteps()
    expect(steps[0].name).toBe('Connect + handshake')
  })

  it('last step is disconnect', () => {
    const steps = getValidateSteps()
    expect(steps[steps.length - 1].name).toBe('Disconnect')
  })

  it('has no duplicate step names', () => {
    const names = getValidateSteps().map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('includes session lifecycle steps (create, read, delete)', () => {
    const steps = getValidateSteps()
    const names = steps.map((s) => s.name)
    expect(names).toContain('sessions:create')
    expect(names).toContain('sessions:getMessages')
    expect(names).toContain('sessions:delete')
  })

  it('includes send message + stream step', () => {
    const steps = getValidateSteps()
    const names = steps.map((s) => s.name)
    expect(names).toContain('send message + stream')
  })

  it('includes send message + tool use step', () => {
    const steps = getValidateSteps()
    const names = steps.map((s) => s.name)
    expect(names).toContain('send message + tool use')
  })

  it('includes source lifecycle steps (create, mention, delete)', () => {
    const steps = getValidateSteps()
    const names = steps.map((s) => s.name)
    expect(names).toContain('sources:create')
    expect(names).toContain('send + source mention')
    expect(names).toContain('sources:delete')
  })

  it('includes skill lifecycle steps (create, mention, delete)', () => {
    const steps = getValidateSteps()
    const names = steps.map((s) => s.name)
    expect(names).toContain('send + skill create')
    expect(names).toContain('send + skill mention')
    expect(names).toContain('skills:delete')
  })

  it('includes automation lifecycle steps', () => {
    const names = getValidateSteps().map((s) => s.name)
    expect(names).toContain('automation:create')
    expect(names).toContain('automation:trigger (status change)')
    expect(names).toContain('automation:verify session')
    expect(names).toContain('automation:verify labels')
    expect(names).toContain('automations:getLastExecuted')
    expect(names).toContain('automation:cleanup')
  })

  it('includes session tool validation steps', () => {
    const names = getValidateSteps().map((s) => s.name)
    expect(names).toContain('session-tools:set_session_labels')
    expect(names).toContain('session-tools:get_session_info')
    expect(names).toContain('session-tools:list_sessions')
  })

  it('session tool steps come after tool use and before branching', () => {
    const names = getValidateSteps().map((s) => s.name)
    const toolUse = names.indexOf('send message + tool use')
    const labels = names.indexOf('session-tools:set_session_labels')
    const branch = names.indexOf('sessions:branch')
    expect(labels).toBeGreaterThan(toolUse)
    expect(branch).toBeGreaterThan(labels)
  })

  it('includes session branching steps', () => {
    const names = getValidateSteps().map((s) => s.name)
    expect(names).toContain('sessions:branch')
    expect(names).toContain('sessions:branch verify')
    expect(names).toContain('sessions:branch send')
  })

  it('includes webhook validation steps', () => {
    const names = getValidateSteps().map((s) => s.name)
    expect(names).toContain('webhook:test (RPC)')
    expect(names).toContain('webhook:verify failure')
  })

  it('creates session with allow-all permission mode', () => {
    const steps = getValidateSteps()
    const createStep = steps.find((s) => s.name === 'sessions:create')
    expect(createStep).toBeDefined()
  })

  it('validates --workspace-dir as an external Project and keeps its path out of managed cleanup state', async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const client = {
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args })
        if (channel === 'workspaces:create') return { id: 'ws-validate', name: 'validate-workspace' }
        if (channel === 'projects:validateDirectory') {
          return {
            id: 'project-handle-1',
            workspaceId: 'ws-validate',
            displayPath: '/tmp/user-project',
            trustState: 'unknown',
            expiresAt: Date.now() + 60_000,
          }
        }
        return undefined
      },
    }
    const ctx: any = { workspaceDir: '/tmp/user-project' }
    const step = getValidateSteps().find((candidate) => candidate.name === 'workspaces:get')!

    await step.fn(client as any, ctx)

    expect(calls).toEqual([
      { channel: 'workspaces:create', args: [expect.stringMatching(/^validate-workspace-/)] },
      { channel: 'window:switchWorkspace', args: ['ws-validate'] },
      {
        channel: 'projects:validateDirectory',
        args: [{ workspaceId: 'ws-validate', candidatePath: '/tmp/user-project' }],
      },
    ])
    expect(ctx).toMatchObject({
      workspaceId: 'ws-validate',
      projectHandleId: 'project-handle-1',
      createdWorkspace: true,
    })
    expect(ctx.workspaceRootPath).toBeUndefined()
    expect(calls.some(({ channel }) => channel === 'projects:setTrust')).toBe(false)
  })

  it('passes the validated project handle to sessions:create', async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const client = {
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args })
        return { id: 'session-1' }
      },
    }
    const ctx: any = { workspaceId: 'ws-1', projectHandleId: 'project-handle-1' }
    const step = getValidateSteps().find((candidate) => candidate.name === 'sessions:create')!

    await step.fn(client as any, ctx)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.channel).toBe('sessions:create')
    expect(calls[0]!.args[0]).toBe('ws-1')
    expect(calls[0]!.args[1]).toMatchObject({
      permissionMode: 'bypassPermissions',
      projectHandleId: 'project-handle-1',
    })
  })

  it('creates and verifies a Workspace skill through managed RPCs without a managed path', async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const client = {
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args })
        if (channel === 'capabilities:getCatalog') {
          return {
            capabilities: [{ kind: 'skill', logicalName: '__cli-validate-skill' }],
          }
        }
        return undefined
      },
    }
    const ctx: any = {
      workspaceId: 'ws-1',
      createdSessionId: 'session-1',
      createdSourceSlug: 'cat-facts',
    }
    const steps = getValidateSteps()

    await steps.find((step) => step.name === 'send + skill create')!.fn(client as any, ctx)
    await steps.find((step) => step.name === 'skills:get (verify)')!.fn(client as any, ctx)

    expect(ctx.workspaceRootPath).toBeUndefined()
    expect(calls[0]).toEqual({
      channel: 'capabilities:submitManagedEdit',
      args: [{
        session: { workspaceId: 'ws-1', sessionId: 'session-1' },
        resource: { scope: 'workspace', workspaceId: 'ws-1', kind: 'skills-root' },
        contextKey: 'add-skill',
        instructions: expect.stringContaining('__cli-validate-skill'),
      }],
    })
    expect(calls[1]).toEqual({
      channel: 'capabilities:getCatalog',
      args: [{ workspaceId: 'ws-1' }],
    })
    expect(calls.some(({ channel }) => channel === 'skills:get')).toBe(false)
  })

  it('creates and cleans validation automations through server-owned RPCs', async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    let nextId = 0
    const client = {
      isConnected: true,
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args })
        if (channel === 'automations:create') {
          nextId++
          return { automationId: `automation-${nextId}`, event: 'SessionStatusChange', matcherIndex: nextId - 1 }
        }
        return undefined
      },
    }
    const ctx: any = { workspaceId: 'ws-1', createdSessionId: 'session-1' }
    const steps = getValidateSteps()

    await steps.find((step) => step.name === 'automation:create')!.fn(client as any, ctx)
    await steps.find((step) => step.name === 'automation:cleanup')!.fn(client as any, ctx)

    const creates = calls.filter(({ channel }) => channel === 'automations:create')
    expect(creates).toHaveLength(3)
    expect(creates.every(({ args }) => args[0] === 'ws-1')).toBe(true)
    expect(JSON.stringify(creates)).not.toContain('workspaceRootPath')
    expect(calls.filter(({ channel }) => channel === 'automations:delete')).toEqual([
      { channel: 'automations:delete', args: ['ws-1', 'automation-1'] },
      { channel: 'automations:delete', args: ['ws-1', 'automation-2'] },
      { channel: 'automations:delete', args: ['ws-1', 'automation-3'] },
    ])
  })

  it('tests a saved webhook and verifies its safe history through RPC', async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const client = {
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args })
        if (channel === 'automations:test') {
          return { actions: [{ type: 'webhook', success: false, statusCode: 0, error: 'Webhook request failed' }] }
        }
        if (channel === 'automations:getHistory') {
          return [{
            id: 'webhook-1',
            ts: Date.now(),
            ok: false,
            webhook: { method: 'POST', url: 'http://127.0.0.1:19999/validate-test', statusCode: 0, durationMs: 1 },
          }]
        }
        return undefined
      },
    }
    const ctx: any = { workspaceId: 'ws-1', webhookAutomationId: 'webhook-1' }
    const steps = getValidateSteps()

    await steps.find((step) => step.name === 'webhook:test (RPC)')!.fn(client as any, ctx)
    await steps.find((step) => step.name === 'webhook:verify failure')!.fn(client as any, ctx)

    expect(ctx.workspaceRootPath).toBeUndefined()
    expect(calls).toEqual([
      {
        channel: 'automations:test',
        args: [{ workspaceId: 'ws-1', automationId: 'webhook-1', actions: [] }],
      },
      {
        channel: 'automations:getHistory',
        args: ['ws-1', 'webhook-1'],
      },
    ])
  })

  it('fails required managed validation steps when their opaque context is missing', async () => {
    const client = { invoke: async () => undefined }
    const steps = getValidateSteps()

    await expect(
      steps.find((step) => step.name === 'send + skill create')!.fn(client as any, {} as any),
    ).rejects.toThrow('Skill validation requires a Workspace session')
    await expect(
      steps.find((step) => step.name === 'automation:create')!.fn(client as any, {} as any),
    ).rejects.toThrow('Automation validation requires a Workspace session')
    await expect(
      steps.find((step) => step.name === 'webhook:verify failure')!.fn(client as any, {} as any),
    ).rejects.toThrow('Webhook history validation requires a saved automation')
  })

  it('deletes only the managed validation Workspace before disconnecting', async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    let destroyed = false
    const client = {
      isConnected: true,
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args })
      },
      destroy: () => {
        destroyed = true
      },
    }
    const ctx: any = {
      workspaceId: 'ws-validate',
      workspaceDir: '/tmp/user-project',
      createdWorkspace: true,
    }
    const step = getValidateSteps().find((candidate) => candidate.name === 'Disconnect')!

    await step.fn(client as any, ctx)

    expect(calls).toEqual([{ channel: 'workspaces:delete', args: ['ws-validate'] }])
    expect(destroyed).toBe(true)
  })

  it('cleanup steps come after send steps', () => {
    const steps = getValidateSteps()
    const names = steps.map((s) => s.name)
    const skillDelete = names.indexOf('skills:delete')
    const sourceDelete = names.indexOf('sources:delete')
    const sessionDelete = names.indexOf('sessions:delete')
    const skillMention = names.indexOf('send + skill mention')
    expect(skillDelete).toBeGreaterThan(skillMention)
    expect(sourceDelete).toBeGreaterThan(skillDelete)
    expect(sessionDelete).toBeGreaterThan(sourceDelete)
  })

  it('branching steps come after send message + tool use', () => {
    const names = getValidateSteps().map((s) => s.name)
    const toolUse = names.indexOf('send message + tool use')
    const branch = names.indexOf('sessions:branch')
    expect(branch).toBeGreaterThan(toolUse)
  })

  it('automation cleanup comes before sources:delete', () => {
    const names = getValidateSteps().map((s) => s.name)
    const cleanup = names.indexOf('automation:cleanup')
    const srcDelete = names.indexOf('sources:delete')
    expect(cleanup).toBeGreaterThan(-1)
    expect(cleanup).toBeLessThan(srcDelete)
  })
})

/**
 * P6.279 — a session's files can be rewound without the app.
 *
 * The operation was already reachable headlessly over RPC (W7-j measured it:
 * `sessions:command` `{type:'revertFileCheckpoint'}`, with the checkpoint list
 * projected onto `sessions:getPiHarnessRuntime` for every provider). What was
 * missing was a verb and, harder, a REPORT: the row's `done_means` asks for what
 * was restored AND what was skipped, "with the same per-reason vocabulary the UI
 * renders".
 */
import {
  noCheckpointProducerMessage,
  renderRewindResult,
} from './index.ts'
import { SKIP_REASON_TEXT, runtimeProducesFileCheckpoints } from '@nessy-agent/shared/sessions'
import type { FileCheckpointSkipReason } from '@nessy-agent/shared/sessions'

describe('P6.501 · workspace remove', () => {
  it('parses the verb as a subcommand rather than a flag', () => {
    // The subcommand table is the shape the CLI already has (`session
    // create|messages|delete|rewind`); a flag would put a workspace id in the
    // same position a prompt can occupy.
    const args = parseArgs(['bun', 'index.ts', 'workspace', 'remove', 'ws-1'])
    expect(args.command).toBe('workspace')
    expect(args.rest).toEqual(['remove', 'ws-1'])
  })

  it('always says what was NOT touched, which is the whole of the delegated decision', () => {
    // Q-den 18 chose option A: purge our own state and SAY that codex's
    // ~/.codex history is untouched. If this line can be dropped without a test
    // going red, the decision is one edit away from being silently reversed.
    const clean = renderWorkspaceRemoval({ deleted: true, cleanupFailures: [] }, 'ws-1')
    expect(clean).toContain('Removed workspace: ws-1')
    expect(clean).toContain(WORKSPACE_REMOVAL_RESIDUE_TEXT)
    expect(WORKSPACE_REMOVAL_RESIDUE_TEXT).toContain('~/.codex')
  })

  it('names each record the cleanup could not remove, so a partial purge never prints as a clean one', () => {
    const partial = renderWorkspaceRemoval({
      deleted: true,
      cleanupFailures: [
        { resource: 'credentials', code: 'EACCES', message: 'keychain locked' },
        { resource: 'plugin-data', code: 'EBUSY', message: 'directory in use' },
      ],
    }, 'ws-1')
    expect(partial).toContain('  not cleaned up: credentials (EACCES) keychain locked')
    expect(partial).toContain('  not cleaned up: plugin-data (EBUSY) directory in use')
    // …and the residue line is still there, below the failures.
    expect(partial.trimEnd().endsWith(WORKSPACE_REMOVAL_RESIDUE_TEXT)).toBe(true)
  })
})

describe('P6.279 · session rewind', () => {
  it('parses the verb with and without a checkpoint id', () => {
    const listing = parseArgs(['bun', 'index.ts', 'session', 'rewind', 'sess-1'])
    expect(listing.command).toBe('session')
    expect(listing.rest).toEqual(['rewind', 'sess-1'])

    const revert = parseArgs(['bun', 'index.ts', 'session', 'rewind', 'sess-1', 'ckpt-9'])
    expect(revert.rest).toEqual(['rewind', 'sess-1', 'ckpt-9'])
  })

  it('names what it restored, and the path it restored', () => {
    expect(renderRewindResult({ success: true, restored: true, filePath: '/repo/a.ts' }, 'ckpt-9'))
      .toBe('restored: /repo/a.ts')
    expect(renderRewindResult({ success: true, deleted: true, filePath: '/repo/new.ts' }, 'ckpt-9'))
      .toBe('deleted: /repo/new.ts')
    expect(renderRewindResult({ success: false, error: 'checkpoint not found' }, 'ckpt-9'))
      .toBe('failed: ckpt-9\n  checkpoint not found')
    expect(renderRewindResult({ success: true, restored: true, partial: true, filePath: '/repo/a.ts' }, 'ckpt-9'))
      .toBe('restored (partial): /repo/a.ts')
  })

  /**
   * The clause the row is actually about. A rewind that silently declines has
   * told the user their files are back when they are not — so EVERY reason in
   * the union must produce a sentence, and it must be the app's sentence.
   */
  it('names what it SKIPPED, exhaustively over the reason union and in the shared words', () => {
    const reasons = Object.keys(SKIP_REASON_TEXT) as FileCheckpointSkipReason[]
    expect(reasons).toHaveLength(6)

    const rendered = renderRewindResult({
      success: true,
      restored: true,
      filePath: '/repo/a.ts',
      skippedLinks: reasons.length,
      skippedPaths: reasons.map((reason, index) => ({ filePath: `/repo/skipped-${index}.ts`, reason })),
    }, 'ckpt-9')

    for (const [index, reason] of reasons.entries()) {
      expect(rendered).toContain(`  skipped /repo/skipped-${index}.ts: ${SKIP_REASON_TEXT[reason]}`)
    }
  })

  it('separates an irreversible effect from a skipped path', () => {
    const rendered = renderRewindResult({
      success: true,
      restored: true,
      filePath: '/repo/a.ts',
      irreversibleEffects: ['a bash command wrote outside the tracked path'],
    }, 'ckpt-9')
    expect(rendered).toContain('  not undone: a bash command wrote outside the tracked path')
    expect(rendered).not.toContain('skipped')
  })

  /**
   * The refusal the row names as its control. On claude (the one runtime
   * with no producer since C3.67 gave codex one) the checkpoint store is
   * EMPTY rather than absent, so a rewind succeeds while
   * restoring nothing — and a successful no-op reads as a completed rewind.
   */
  it('CONTROL: a runtime with no producer is named, not reported as a successful no-op', () => {
    expect(runtimeProducesFileCheckpoints('anthropic')).toBe(false)
    expect(runtimeProducesFileCheckpoints('pi')).toBe(true)
    // C3.67: codex is a producer now — asserted TRUE here so this control keeps
    // discriminating (AGENTS.md §Traps, a default flip has no instrument).
    expect(runtimeProducesFileCheckpoints('codex-runtime')).toBe(true)

    const message = noCheckpointProducerMessage('anthropic')
    expect(message).toContain('anthropic')
    expect(message).toContain('nothing to rewind')
    // It must not be able to read as a rewind that happened.
    expect(message).not.toContain('restored')
  })
})

/**
 * P6.335 — `nessy-general-agent session create --worktree <MR url>`.
 *
 * `--worktree` is a SUBCOMMAND flag, mined out of `rest` by `cmdSessionCreate`,
 * so the top-level unknown-flag gate has to let it through — that gate is what
 * tells a typo apart from a prompt word, and a flag missing from the allowlist
 * is rejected before the command ever sees it.
 */
describe('P6.335 · --worktree survives the unknown-flag gate', () => {
  it('carries a merge-request URL through as a positional value', () => {
    const args = parseArgs([
      'bun', 'index.ts', 'session', 'create',
      '--worktree', 'https://gitlab.example.com/g/a/-/merge_requests/12',
    ])
    // The first positional is the COMMAND; `rest` is what follows it.
    expect(args.command).toBe('session')
    expect(args.rest).toEqual([
      'create', '--worktree', 'https://gitlab.example.com/g/a/-/merge_requests/12',
    ])
  })

  it('carries the bare form and a slug the same way', () => {
    expect(parseArgs(['bun', 'index.ts', 'session', 'create', '--worktree']).rest)
      .toEqual(['create', '--worktree'])
    expect(parseArgs(['bun', 'index.ts', 'session', 'create', '--worktree', 'bold-oak']).rest)
      .toEqual(['create', '--worktree', 'bold-oak'])
  })
})

/**
 * P6.317 (2) — the headless `--agents` flag.
 *
 * The row's done_means is "`nessy-general-agent --agents '<json>'` registers
 * those agents for that session and writes nothing to disk", and the half these
 * cases can see is the CLI half: the token reaches `CliArgs` rather than the
 * PROMPT, and the value's outer shape is refused before anything is spawned.
 */
describe('P6.317 (2) — --agents', () => {
  it('takes its value off the argv and keeps it out of the prompt', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--agents', '{"auditor":{"prompt":"Audit."}}',
      'run', 'review this',
    ])
    expect(args.agents).toBe('{"auditor":{"prompt":"Audit."}}')
    expect(args.command).toBe('run')
    // The JSON must not be absorbed into `rest`, which for `run` is the prompt.
    expect(args.rest).toEqual(['review this'])
    expect(args.unknownFlags).toEqual([])
  })

  it('is absent as the empty string, and reads as no agents at all', () => {
    expect(parseArgs(['bun', 'index.ts', 'ping']).agents).toBe('')
    expect(parseAgentsArg('')).toBeUndefined()
  })

  it('returns the map for the documented shape', () => {
    expect(parseAgentsArg('{"auditor":{"prompt":"Audit.","tools":["ReadFile"]}}'))
      .toEqual({ auditor: { prompt: 'Audit.', tools: ['ReadFile'] } })
  })

  it('refuses only the shapes that registered nothing', () => {
    expect(() => parseAgentsArg('{')).toThrow(/^--agents is not valid JSON/)
    expect(() => parseAgentsArg('[]')).toThrow('--agents expects a JSON object keyed by agent name')
    expect(() => parseAgentsArg('{}')).toThrow('--agents expects a JSON object keyed by agent name')
    expect(() => parseAgentsArg('{"auditor":"Audit."}'))
      .toThrow('--agents entry "auditor" expects an object with a prompt')
  })

  it('leaves every FIELD refusal to the host, which validates through the same parsers a file goes through', () => {
    // A1: a malformed definition is skipped and NAMED, never fatal. If the CLI
    // refused fields too, one bad field would fail the whole run here while the
    // identical file on disk only loses its own agent — two answers to one
    // question, in two processes, with two vocabularies.
    expect(parseAgentsArg('{"auditor":{"prompt":"Audit.","effort":"exhaustive","maxTurns":-4}}'))
      .toEqual({ auditor: { prompt: 'Audit.', effort: 'exhaustive', maxTurns: -4 } })
  })
})
