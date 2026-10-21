/**
 * F1.542 — in the per-turn `<source_issue>` block, a connection that failed THIS session
 * outranks a stored status, except `needs_auth`.
 *
 * `formatSourceState` wrote `status="<stored status> ?? (failed now ? 'failed' : …)"`, so ANY
 * status the type declares beat the live failure. A source whose stored config said
 * `connected` (or `untested` / `local_disabled`) and whose connection failed in this session was
 * put in a `<source_issue>` block — because it failed — and labelled `status="connected"`,
 * a contradiction the model had to resolve on its own. The comment beside it argued only
 * that `needs_auth` is the sharper verdict (P6.343), and that one argument still holds: it
 * carries its own fix instruction, where a live failure carries only "failed".
 *
 * The REASON follows the verdict that won. The stored `connectionError` was preferred "for
 * the same reason the stored status is"; where the live failure now names the status, the
 * live reason is the one that describes it, and a stored error only fills its silence.
 * Where `needs_auth` wins, nothing changes.
 */

import { describe, it, expect } from 'bun:test'
import { SourceManager } from '../source-manager.ts'
import type { LoadedSource } from '../../../sources/types.ts'
import type { McpPoolHealth } from '../../../mcp/mcp-pool.ts'
import { TestAgent, createMockBackendConfig } from '../../__tests__/test-utils.ts'

function source(slug: string, overrides: Partial<LoadedSource['config']> = {}): LoadedSource {
  return {
    config: {
      id: `${slug}-id`, name: slug, slug, enabled: true, provider: 'test', type: 'mcp',
      tagline: `${slug} tagline`,
      mcp: { transport: 'http', url: 'https://mcp.example.test' },
      ...overrides,
    } as LoadedSource['config'],
    guide: null,
    folderPath: `/test/sources/${slug}`,
    workspaceRootPath: '/test/workspace',
    workspaceId: 'test-workspace',
  }
}

function formatted(
  overrides: Partial<LoadedSource['config']>,
  live: { failed: string[]; reasons?: Record<string, string>; connected?: string[] },
): string {
  const manager = new SourceManager({
    failedSourceSlugs: () => live.failed,
    failedSourceErrors: () => live.reasons ?? {},
    connectedSourceSlugs: () => live.connected ?? [],
  })
  manager.setAllSources([source('x', overrides)])
  manager.updateActiveState([], [], ['x'])
  return manager.formatSourceState()
}

/** The JSON-quoted reason on the block's reported-error line, parsed back. */
function reportedReason(block: string): string | undefined {
  const line = block.split('\n').find((l) => l.startsWith('Error as reported'))
  if (!line) return undefined
  return JSON.parse(line.slice(line.indexOf('"')))
}

describe('F1.542 — a live failure outranks a stored status', () => {
  for (const stored of ['connected', 'untested', 'local_disabled'] as const) {
    it(`stored "${stored}" plus a failure this session reads status="failed"`, () => {
      expect(formatted({ connectionStatus: stored }, { failed: ['x'] }))
        .toContain('<source_issue source="x" status="failed">')
    })
  }

  it('stored "needs_auth" plus a failure this session still reads needs_auth — the sharper verdict', () => {
    const block = formatted({ connectionStatus: 'needs_auth' }, { failed: ['x'] })
    expect(block).toContain('<source_issue source="x" status="needs_auth">')
  })

  it('control: stored "connected" with no failure this session raises no issue at all', () => {
    expect(formatted({ connectionStatus: 'connected' }, { failed: [] })).not.toContain('<source_issue')
  })

  it('control: stored "failed" with no live failure still reports the stored verdict and error', () => {
    const block = formatted({ connectionStatus: 'failed', connectionError: 'stored reason' }, { failed: [] })
    expect(block).toContain('<source_issue source="x" status="failed">')
    expect(reportedReason(block)).toBe('stored reason')
  })
})

describe('F1.542 — the reason follows the verdict that won', () => {
  it('where the live failure names the status, its reason leads over a stale stored error', () => {
    const block = formatted(
      { connectionStatus: 'connected', connectionError: 'a stale error from an earlier test' },
      { failed: ['x'], reasons: { x: 'connect ECONNREFUSED 127.0.0.1:9999' } },
    )
    expect(block).toContain('status="failed"')
    expect(reportedReason(block)).toBe('connect ECONNREFUSED 127.0.0.1:9999')
  })

  it('a stored error still fills the silence when the live failure caught no reason', () => {
    const block = formatted(
      { connectionStatus: 'connected', connectionError: 'the only reason there is' },
      { failed: ['x'] },
    )
    expect(reportedReason(block)).toBe('the only reason there is')
  })

  it('where needs_auth wins, the stored error it came with still leads', () => {
    const block = formatted(
      { connectionStatus: 'needs_auth', connectionError: 'Refresh error: 400 invalid_grant' },
      { failed: ['x'], reasons: { x: 'HTTP 401' } },
    )
    expect(block).toContain('status="needs_auth"')
    expect(reportedReason(block)).toBe('Refresh error: 400 invalid_grant')
  })
})

/**
 * UB12.56 — `source_test` persists its own vocabulary ('connected' | 'disconnected' | 'error' |
 * 'unknown') into `connectionStatus`, and the attention filter compared the stored value raw
 * against 'needs_auth' / 'failed', so a stored failed test never produced a `<source_issue>`
 * unless the pool also failed this session. Both reads now go through `normalizeStoredStatus`.
 */
describe('UB12.56 — a stored failed source_test verdict reaches the model', () => {
  it('a stored "error" with no live failure reads status="failed" with the stored reason quoted', () => {
    const block = formatted(
      { connectionStatus: 'error' as never, connectionError: 'connect ECONNREFUSED 127.0.0.1:9999' },
      { failed: [] },
    )
    expect(block).toContain('<source_issue source="x" status="failed">')
    expect(reportedReason(block)).toBe('connect ECONNREFUSED 127.0.0.1:9999')
  })

  it('a stored "disconnected" (the soft failure) with no live failure reads status="failed"', () => {
    expect(formatted({ connectionStatus: 'disconnected' as never }, { failed: [] }))
      .toContain('<source_issue source="x" status="failed">')
  })

  it('negative: a stored "connected" with no live failure raises no issue', () => {
    expect(formatted({ connectionStatus: 'connected' }, { failed: [] })).not.toContain('<source_issue')
  })

  it('boundary: a stored "unknown" (an inconclusive test) reads untested and raises no issue', () => {
    expect(formatted({ connectionStatus: 'unknown' as never }, { failed: [] })).not.toContain('<source_issue')
  })
})

/**
 * UB12.114 — a stored failed verdict RETIRES while this session's pool holds a live connection
 * to the MCP source and has no live failure for it (the symmetric arm of F1.542). Before, the
 * block was emitted on every turn until a writer replaced the stored value, so a source whose
 * tools worked this session was still reported unreachable.
 */
describe('UB12.114 — a live connection retires a stored failed verdict', () => {
  for (const stored of ['error', 'disconnected', 'failed'] as const) {
    it(`positive: a stored "${stored}" on an MCP source the pool has connected raises no issue`, () => {
      expect(formatted(
        { connectionStatus: stored as never, connectionError: 'connect ECONNREFUSED 127.0.0.1:9999' },
        { failed: [], connected: ['x'] },
      )).not.toContain('<source_issue')
    })
  }

  it('negative: a stored "error" with no live signal still reads status="failed" with its reason', () => {
    const block = formatted(
      { connectionStatus: 'error' as never, connectionError: 'connect ECONNREFUSED 127.0.0.1:9999' },
      { failed: [], connected: [] },
    )
    expect(block).toContain('<source_issue source="x" status="failed">')
    expect(reportedReason(block)).toBe('connect ECONNREFUSED 127.0.0.1:9999')
  })

  it('boundary: another slug connected does not retire this one', () => {
    expect(formatted({ connectionStatus: 'error' as never }, { failed: [], connected: ['y'] }))
      .toContain('<source_issue source="x" status="failed">')
  })

  it('boundary: connected AND failed this session (a capability failure) still reads failed, live reason first', () => {
    const block = formatted(
      { connectionStatus: 'error' as never, connectionError: 'the stored reason' },
      { failed: ['x'], connected: ['x'], reasons: { x: 'tools/list failed' } },
    )
    expect(block).toContain('<source_issue source="x" status="failed">')
    expect(reportedReason(block)).toBe('tools/list failed')
  })

  it('boundary: an API source is not retired — its in-process connection says nothing of the endpoint', () => {
    expect(formatted(
      { type: 'api', mcp: undefined, api: { baseUrl: 'https://api.example.test/', authType: 'none' }, connectionStatus: 'error' as never },
      { failed: [], connected: ['x'] },
    )).toContain('<source_issue source="x" status="failed">')
  })

  it('boundary: a stored "needs_auth" is not retired — the sharper verdict keeps its fix instruction', () => {
    expect(formatted({ connectionStatus: 'needs_auth' }, { failed: [], connected: ['x'] }))
      .toContain('<source_issue source="x" status="needs_auth">')
  })
})

/**
 * UB12.114 — the wiring: `BaseAgent` reads `connected` from the same `health(mcpLeaserId)` call
 * its `failedSourceSlugs` / `failedSourceErrors` closures read (P6.343, P6.715). Removing the
 * reader turns the positive arm red; the negative arm proves the stub pool can still fail it.
 */
describe('UB12.114 — BaseAgent passes the pool\'s live connected list', () => {
  function agentFormatted(health: McpPoolHealth): { block: string; leasers: Array<string | undefined> } {
    const leasers: Array<string | undefined> = []
    const mcpPool = {
      health: (leaserId?: string) => {
        leasers.push(leaserId)
        return health
      },
    }
    const agent = new TestAgent(createMockBackendConfig({ mcpPool: mcpPool as never, mcpLeaserId: 'session:L' }))
    const manager = (agent as unknown as { sourceManager: SourceManager }).sourceManager
    manager.setAllSources([source('x', { connectionStatus: 'error' as never })])
    manager.updateActiveState([], [], ['x'])
    return { block: manager.formatSourceState(), leasers }
  }

  it('positive: the pool reports x connected — the stored failure is retired', () => {
    const { block, leasers } = agentFormatted({ status: 'ready', connected: ['x'], failed: [], failureReasons: {} })
    expect(block).not.toContain('<source_issue')
    expect(leasers.length).toBeGreaterThan(0)
    expect(new Set(leasers)).toEqual(new Set(['session:L']))
  })

  it('negative: the pool reports nothing connected — the stored failure is still reported', () => {
    const { block } = agentFormatted({ status: 'unavailable', connected: [], failed: [], failureReasons: {} })
    expect(block).toContain('<source_issue source="x" status="failed">')
  })
})
