import { describe, expect, test } from 'bun:test'
import type { LoadedSource } from '@nessy-agent/shared/sources'
import { resolveToolDisplayMeta } from './SessionManager.ts'
import { SESSION_TOOL_DISPLAY_NAMES } from '@nessy-agent/shared/utils/toolNames'

/**
 * A transcript row's icon and label are keyed off the MCP tool name's server
 * segment. The two coding runtimes spell that name differently for the SAME
 * pool tool:
 *
 *   Pi / Claude   mcp__<wire>__<tool>
 *   Codex         mcp__sources__<wire>__<tool>
 *
 * Codex reaches the pool through its own `[mcp_servers.sources]` bridge
 * (`packages/codex-responses-adapter/src/config-writer.ts:280`), and its row
 * carries the model-facing name verbatim, so the wire name — the part that
 * names the real server — sits one segment later.
 */

const WIRE = 'plugin_cdp-echo-probe_echo'

const source = (slug: string, name: string): LoadedSource => ({
  config: {
    id: `id-${slug}`,
    name,
    slug,
    enabled: true,
    provider: slug,
    type: 'mcp',
    icon: '🛰️',
    tagline: `${name} tagline`,
  },
  guide: null,
  folderPath: `/workspace/.nessy/sources/${slug}`,
  workspaceRootPath: '/workspace',
  workspaceId: 'workspace-1',
})

const SOURCES: LoadedSource[] = [
  source(WIRE, 'Echo Probe'),
  source('stripe', 'Stripe'),
]

const resolve = (toolName: string) =>
  resolveToolDisplayMeta(toolName, undefined, '/workspace', SOURCES)

describe('resolveToolDisplayMeta — MCP server segment', () => {
  test('a Codex pool row keys off the wire name, not the `sources` bridge', async () => {
    const meta = await resolve(`mcp__sources__${WIRE}__whoami`)

    expect(meta).toEqual({
      displayName: 'Echo Probe',
      iconDataUrl: '🛰️',
      description: 'Echo Probe tagline',
      category: 'source',
    })
  })

  test('a Codex pool row keeps the shift when the tool name itself carries `__`', async () => {
    const meta = await resolve(`mcp__sources__${WIRE}__echo__twice`)

    expect(meta?.displayName).toBe('Echo Probe')
  })

  test('a Pi-shaped name resolves byte-identically to the Codex-shaped one', async () => {
    const pi = await resolve(`mcp__${WIRE}__whoami`)
    const codex = await resolve(`mcp__sources__${WIRE}__whoami`)

    expect(pi).toEqual({
      displayName: 'Echo Probe',
      iconDataUrl: '🛰️',
      description: 'Echo Probe tagline',
      category: 'source',
    })
    expect(pi).toEqual(codex!)
  })

  test('the shift leaves every other Pi-shaped name untouched', async () => {
    expect(await resolve('mcp__stripe__charge')).toMatchObject({ displayName: 'Stripe' })
    // Unknown server → still no meta, so the row renders generic as before.
    expect(await resolve('mcp__unknown-server__whoami')).toBeUndefined()
    // The api-bridge special case still reads the slug out of the tool segment.
    expect(await resolve('mcp__api-bridge__api_stripe')).toMatchObject({ displayName: 'Stripe' })
    // Internal server tools still win before any source lookup.
    expect(await resolve('mcp__session__SubmitPlan')).toMatchObject({
      displayName: 'Submit Plan',
      category: 'native',
    })
  })

  test('a session recorded under the legacy Codex server segment still gets its label', async () => {
    // Codex mounted the bundled session server as `[mcp_servers.nessy_session]`
    // until the wire-name unification renamed the key to `session`. Rows in a
    // transcript written before that carry the old segment forever (history is
    // append-only), and without the alias they miss the internal table, match no
    // source, and render bare.
    const legacy = await resolve('mcp__nessy_session__config_validate')
    expect(legacy).toEqual({
      displayName: 'Validate Config',
      iconDataUrl: undefined,
      category: 'native',
    })
    expect(legacy).toEqual((await resolve('mcp__session__config_validate'))!)
    // The alias is the session table and nothing else: an unknown tool under it
    // still falls through, exactly as it does under `session`.
    expect(await resolve('mcp__nessy_session__not_a_tool')).toBeUndefined()
  })

  test('F1.251 — spawn_session, archive_session and send_agent_message are named by the host table', async () => {
    // Real session tools (session-tools-core tool-defs.ts) that had no entry, so
    // `toolDisplayMeta` was undefined for them and a row whose model supplied no
    // `_displayName` showed raw snake_case. Upstream v0.13.4's table names all
    // three; the renderer's own table (`getToolDisplayName`) got them too.
    for (const [tool, displayName] of [
      ['spawn_session', 'Spawn Session'],
      ['archive_session', 'Archive Session'],
      ['send_agent_message', 'Send Agent Message'],
    ] as const) {
      expect(await resolve(`mcp__session__${tool}`)).toEqual({ displayName, iconDataUrl: undefined, category: 'native' })
    }
    // The negative: an unknown session tool still falls through unchanged.
    expect(await resolve('mcp__session__not_a_tool')).toBeUndefined()
  })

  test('a degenerate `mcp__sources__<x>` falls back instead of throwing', async () => {
    // No third segment to shift to — old behavior: look `sources` up as a slug.
    expect(await resolve('mcp__sources__whoami')).toBeUndefined()
    expect(await resolve('mcp__sources__')).toBeUndefined()
    expect(await resolve('mcp__sources____whoami')).toBeUndefined()
    expect(await resolve('mcp__sources')).toBeUndefined()
  })

  test('F1.435 — the host names every session tool from the ONE shared table the renderer reads', async () => {
    // At HEAD the host carried its own seventeen names; fourteen of them the
    // renderer did not know, five of the renderer's it did not know, and fifteen
    // snake_case tools (F1.434) were in neither. Both now read
    // SESSION_TOOL_DISPLAY_NAMES, so the symmetric difference is empty by
    // construction — asserted here on the host's side, and on the renderer's
    // side by packages/ui session-tool-display-names.test.ts.
    const disagreeing: string[] = []
    for (const [tool, label] of Object.entries(SESSION_TOOL_DISPLAY_NAMES)) {
      const meta = await resolve(`mcp__session__${tool}`)
      if (meta?.displayName !== label || meta?.category !== 'native') disagreeing.push(tool)
    }
    expect(disagreeing).toEqual([])
    // The legacy codex segment reads the same table.
    expect((await resolve('mcp__nessy_session__plugin_install'))?.displayName).toBe('Plugin Install')
    // Negative: an unknown session tool, and another server's same-named tool, still fall through.
    expect(await resolve('mcp__session__not_a_tool')).toBeUndefined()
    expect(await resolve('mcp__brave__web_search')).toBeUndefined()
  })
})
