/**
 * F1.1041 (origin DN-144) — `NESSY_WEB_SEARCH_ALLOWED_DOMAINS` reaches Claude Code's OWN `WebSearch`,
 * through the tool's own `allowed_domains` input, rewritten by the host's PreToolUse hook
 * (`updatedInput`). Before this row the operator's list filtered Pi's tool and the host search and
 * never Claude's own search, on the arms that keep it (a direct Anthropic session, an
 * `anthropic-messages` passthrough model).
 *
 * The pure half pins {@link scopeClaudeWebSearchInput}; the live half drives the REAL PreToolUse hook
 * a Claude turn registers, so the wiring (after the trusted hooks, before the gate) is what is read.
 */
import { afterAll, describe, expect, it, mock, setDefaultTimeout } from 'bun:test'
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendConfig } from '../backend/types.ts'
import { scopeClaudeWebSearchInput, WEB_SEARCH_ALLOWED_DOMAINS_ENV } from '../../config/web-search-allowlist.ts'

// The module graph (the whole claude agent) is the cost, not the bodies.
setDefaultTimeout(180_000)

describe('scopeClaudeWebSearchInput', () => {
  it('leaves the input object itself untouched when no allowlist is set (unset is off)', () => {
    const input = { query: 'q', blocked_domains: ['spam.test'] }
    expect(scopeClaudeWebSearchInput(input, [])).toEqual({ input })
    expect((scopeClaudeWebSearchInput(input, []) as { input: unknown }).input).toBe(input)
  })

  it('writes the operator list when the model named none, and drops blocked_domains', () => {
    expect(scopeClaudeWebSearchInput({ query: 'q', blocked_domains: ['spam.test'] }, ['example.com', 'docs.test']))
      .toEqual({ input: { query: 'q', allowed_domains: ['example.com', 'docs.test'] } })
  })

  it('intersects the model list, keeping the narrower host of each overlapping pair', () => {
    const scoped = scopeClaudeWebSearchInput(
      { query: 'q', allowed_domains: ['https://Docs.Example.com/x', 'other.test', 'test'] },
      ['example.com', 'api.other.test'],
    )
    expect(scoped).toEqual({ input: { query: 'q', allowed_domains: ['docs.example.com', 'api.other.test'] } })
  })

  it('refuses a search whose hosts are all outside the list, naming the variable', () => {
    const scoped = scopeClaudeWebSearchInput({ query: 'q', allowed_domains: ['notexample.com'] }, ['example.com'])
    expect('refusal' in scoped).toBe(true)
    expect((scoped as { refusal: string }).refusal).toContain(`${WEB_SEARCH_ALLOWED_DOMAINS_ENV}=example.com`)
  })
})

// ---------------------------------------------------------------- the live hook

/** A SNAPSHOT of the SDK's exports, never the live namespace (AGENTS.md §Traps, `mock.module`). */
const realSdk = { ...sdkPackage }
type HookFn = (input: Record<string, unknown>, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>
let capturedOptions: Record<string, unknown> | undefined
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedOptions = input.options
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    async function* serve(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        yield { type: 'result', subtype: 'success', result: 'ok', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
      }
    }
    const stream = serve() as AsyncGenerator<unknown> & { interrupt(): Promise<unknown> }
    stream.interrupt = async () => ({ still_queued: [] })
    return stream
  },
}))
const priorAllowlist = process.env[WEB_SEARCH_ALLOWED_DOMAINS_ENV]
afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk)
  delete process.env[WEB_SEARCH_ALLOWED_DOMAINS_ENV]
  if (priorAllowlist !== undefined) process.env[WEB_SEARCH_ALLOWED_DOMAINS_ENV] = priorAllowlist
})

const { ClaudeAgent } = await import('../claude-agent.ts')
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'f1041-')))

type HookAnswer = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } }

let counter = 0
/** One default-mode turn, then the REAL PreToolUse hook it registered, asked about one WebSearch call. */
async function webSearchHook(allowlist: string | undefined, input: Record<string, unknown>): Promise<HookAnswer> {
  delete process.env[WEB_SEARCH_ALLOWED_DOMAINS_ENV]
  if (allowlist !== undefined) process.env[WEB_SEARCH_ALLOWED_DOMAINS_ENV] = allowlist
  counter += 1
  const ws = join(ROOT, `ws-${counter}`)
  mkdirSync(ws, { recursive: true })
  capturedOptions = undefined
  const agent = new ClaudeAgent({
    provider: 'anthropic', providerType: 'anthropic', model: 'claude-sonnet-4-6', isHeadless: true, skipConfigWatcher: true,
    workspace: { id: `ws-f1041-${counter}`, name: 'F1041', rootPath: ws, workspaceRootPath: ws, sessionRootPath: join(ROOT, 'sessions') } as never,
    session: { id: `session-f1041-${counter}`, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: ws, permissionMode: 'default' } as never,
  } as BackendConfig)
  try {
    agent.setPermissionMode('default')
    const chatImpl = (agent as unknown as { chatImpl(message: string): AsyncGenerator<unknown> }).chatImpl.bind(agent)
    for await (const _ of chatImpl('go')) { /* drain the one turn */ }
    const seen = capturedOptions as Record<string, unknown> | undefined
    const hook = (seen?.hooks as { PreToolUse?: Array<{ hooks: HookFn[] }> } | undefined)?.PreToolUse?.[0]?.hooks?.[0]
    if (!hook) throw new Error('the turn registered no PreToolUse hook')
    return await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_use_id: 'toolu_f1041', tool_input: input, session_id: 'sdk-f1041', transcript_path: join(ROOT, 't.jsonl'), cwd: ws },
      'toolu_f1041',
      { signal: new AbortController().signal },
    ) as HookAnswer
  } finally {
    agent.destroy()
  }
}

describe('the claude PreToolUse hook scopes WebSearch to the operator allowlist', () => {
  it('rewrites the call to the list through updatedInput, blocked_domains gone', async () => {
    const out = (await webSearchHook('example.com, https://docs.test/x', { query: 'q', blocked_domains: ['spam.test'] })).hookSpecificOutput
    expect(out?.permissionDecision).toBe('allow')
    expect(out?.updatedInput).toEqual({ query: 'q', allowed_domains: ['example.com', 'docs.test'] })
  })

  it('forwards the call unchanged when no allowlist is set (no updatedInput at all)', async () => {
    const out = (await webSearchHook(undefined, { query: 'q', blocked_domains: ['spam.test'] })).hookSpecificOutput
    expect(out?.permissionDecision).toBe('allow')
    expect(out?.updatedInput).toBeUndefined()
  })

  it('denies a call whose own allowed_domains are all outside the list, naming the variable', async () => {
    const out = (await webSearchHook('example.com', { query: 'q', allowed_domains: ['other.test'] })).hookSpecificOutput
    expect(out?.permissionDecision).toBe('deny')
    expect(out?.permissionDecisionReason).toContain(WEB_SEARCH_ALLOWED_DOMAINS_ENV)
  })
})
