/**
 * UA1.7 — Conductor node hostability (`assertNodesHostable`): the node predicate IS `SCHEDULED_DELIVERY_RUNTIMES`,
 * `canHostSession` runs once per DISTINCT connection, and an unresolvable connection refuses instead of defaulting.
 *
 * The connection lookups and `canHost` are injected, so no arm reads the user's config, the credential store or the
 * disk; the predicate arms run the REAL `SCHEDULED_DELIVERY_RUNTIMES` and the real providerType mapping.
 *
 * Module-graph cost (waves O20): this file statically imports `node-hostability.ts`, which imports
 * `SessionManager.ts`. A static import is paid at file load, before any case starts, so no test timer covers it and
 * no budget constant is declared (`module-graph-budgets.ts` budgets hooks and per-case work, the costs a timer does
 * see). Readings with the zero-case control (`-t '<matches nothing>'`) are in the UA-b lane report (2026-10-02).
 */
import { describe, expect, it } from 'bun:test'
import type { LlmConnection } from '@nessy-agent/shared/config'
import type { BackendHostRuntimeContext } from '@nessy-agent/shared/agent/backend'
import type { CanHostSessionVerdict } from '../../sessions/runtime-switch'
import { assertNodesHostable, type HostabilitySpec, type NodeHostabilityDeps, type NodeUnhostableDetail } from '../node-hostability'

const HOST: BackendHostRuntimeContext = { appRootPath: '/nonexistent/ua1-7', isPackaged: false } as BackendHostRuntimeContext

const conn = (slug: string, providerType: string): LlmConnection =>
  ({ slug, name: slug, providerType, authType: 'none', createdAt: 0 }) as unknown as LlmConnection

const CONNECTIONS: Record<string, LlmConnection> = {
  'pi-conn': conn('pi-conn', 'pi'),
  'pi-compat-conn': conn('pi-compat-conn', 'pi_compat'),
  'claude-pro': conn('claude-pro', 'anthropic'),
  'claude-gateway': conn('claude-gateway', 'claude-runtime'),
  'codex-conn': conn('codex-conn', 'codex-runtime'),
  'nestor-cloud': conn('nestor-cloud', 'nestor-cloud-agent'),
  'mystery': conn('mystery', 'sonnet-of-nobody'),
}

function rig(verdict: (c: LlmConnection) => CanHostSessionVerdict = () => ({ ok: true })) {
  const asked: string[] = []
  const defaultAsked: Array<string | undefined> = []
  const deps: NodeHostabilityDeps = {
    hostRuntime: HOST,
    workspaceDefaultConnection: 'ws-default',
    resolveConnection: slug => CONNECTIONS[slug] ?? null,
    resolveDefaultConnection: workspaceDefault => { defaultAsked.push(workspaceDefault); return CONNECTIONS['pi-conn']! },
    canHost: async target => { asked.push(target.slug); return verdict(target) },
  }
  return { deps, asked, defaultAsked }
}

async function refusal(spec: HostabilitySpec, deps: NodeHostabilityDeps): Promise<{ code: unknown; message: string; data: NodeUnhostableDetail }> {
  let caught: unknown
  try {
    await assertNodesHostable(spec, deps)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  const error = caught as Error & { code?: unknown; data?: NodeUnhostableDetail }
  return { code: error.code, message: error.message, data: error.data! }
}

describe('UA1.7 — assertNodesHostable', () => {
  it('POSITIVE — pi, anthropic (Pro/Max and claude-runtime) and codex-runtime nodes pass', async () => {
    const h = rig()
    await assertNodesHostable({
      nodes: [
        { id: 'a', llmConnection: 'pi-conn' },
        { id: 'b', llmConnection: 'pi-compat-conn' },
        { id: 'c', llmConnection: 'claude-pro' },
        { id: 'd', llmConnection: 'claude-gateway' },
        { id: 'e', llmConnection: 'codex-conn' },
      ],
    }, h.deps)
    expect(h.asked).toEqual(['pi-conn', 'pi-compat-conn', 'claude-pro', 'claude-gateway', 'codex-conn'])
  })

  it('NEGATIVE — a nestor-cloud node is refused, the node and the connection named, before canHostSession is asked', async () => {
    // The real canHostSession answers `ok` for nestor-cloud (a remote session is hosted remotely), so the refusal
    // has to come from the SCHEDULED_DELIVERY_RUNTIMES predicate, and before canHost is ever asked.
    const r = await refusal({ nodes: [{ id: 'plan', llmConnection: 'pi-conn' }, { id: 'remote', llmConnection: 'nestor-cloud' }] }, {
      ...rig().deps,
      canHost: async target => {
        if (target.slug === 'nestor-cloud') throw new Error('canHostSession must not be asked about nestor-cloud')
        return { ok: true }
      },
    })
    expect(r.code).toBe('RUNTIME_UNHOSTABLE')
    expect(r.data).toEqual({ nodeId: 'remote', connection: 'nestor-cloud', reason: 'runtime-not-node-capable' })
    expect(r.message).toContain('"remote"')
    expect(r.message).toContain('"nestor-cloud"')
  })

  it('NEGATIVE — runtime-binary-missing is refused before dispatch', async () => {
    const h = rig(c => c.slug === 'codex-conn' ? { ok: false, code: 'runtime-binary-missing' } : { ok: true })
    let dispatched = 0
    const run = async (spec: HostabilitySpec) => { await assertNodesHostable(spec, h.deps); dispatched += 1 }
    let error: unknown
    await run({ nodes: [{ id: 'first', llmConnection: 'pi-conn' }, { id: 'coder', llmConnection: 'codex-conn' }] }).catch(e => { error = e })

    expect(dispatched).toBe(0)
    expect((error as { data?: unknown }).data).toEqual({ nodeId: 'coder', connection: 'codex-conn', reason: 'runtime-binary-missing' })
  })

  it('NEGATIVE — an unresolvable connection is refused, never defaulted', async () => {
    const h = rig()
    const r = await refusal({ nodes: [{ id: 'typo', llmConnection: 'pi-conm' }] }, h.deps)
    expect(r.data).toEqual({ nodeId: 'typo', connection: 'pi-conm', reason: 'connection-unresolved' })
    expect(h.defaultAsked).toEqual([]) // the default connection was never consulted for a NAMED slug
    expect(h.asked).toEqual([])
  })

  it('NEGATIVE — an unknown providerType is refused, not mapped to some runtime', async () => {
    const h = rig()
    const r = await refusal({ nodes: [{ id: 'odd', llmConnection: 'mystery' }] }, h.deps)
    expect(r.data).toEqual({ nodeId: 'odd', connection: 'mystery', reason: 'runtime-unknown' })
  })

  it('BOUNDARY — a node naming no connection takes spec.defaults, else the default createSession would use; none at all refuses', async () => {
    const h = rig()
    await assertNodesHostable({ defaults: { llmConnection: 'codex-conn' }, nodes: [{ id: 'x' }] }, h.deps)
    expect(h.asked).toEqual(['codex-conn'])
    expect(h.defaultAsked).toEqual([])

    await assertNodesHostable({ nodes: [{ id: 'y' }] }, h.deps)
    expect(h.defaultAsked).toEqual(['ws-default'])

    const r = await refusal({ nodes: [{ id: 'z' }] }, { ...h.deps, resolveDefaultConnection: () => null })
    expect(r.data).toEqual({ nodeId: 'z', connection: undefined, reason: 'connection-unresolved' })
  })

  it('CONTROL — a two-node spec on one connection calls canHostSession once; a second connection adds one call', async () => {
    const one = rig()
    await assertNodesHostable({ nodes: [{ id: 'a', llmConnection: 'pi-conn' }, { id: 'b', llmConnection: 'pi-conn' }] }, one.deps)
    expect(one.asked).toEqual(['pi-conn'])

    const two = rig()
    await assertNodesHostable({
      defaults: { llmConnection: 'pi-conn' },
      nodes: [{ id: 'a' }, { id: 'b', llmConnection: 'codex-conn' }, { id: 'c', llmConnection: 'pi-conn' }],
    }, two.deps)
    expect(two.asked).toEqual(['pi-conn', 'codex-conn'])
  })
})
