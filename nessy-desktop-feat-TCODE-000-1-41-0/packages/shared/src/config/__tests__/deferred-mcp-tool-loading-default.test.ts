/**
 * Deferred MCP tool loading ships ON, and it takes TWO files to say so.
 *
 * `syncConfigDefaults()` overwrites `~/.nessy-agent/config-defaults.json` from
 * the bundled asset on every launch, and falls back to the in-code constant only
 * when the assets directory is missing. So the bundled JSON governs a normal
 * launch and the constant governs a broken one — and a flip applied to just one
 * of them works in the running session, reverts on the next launch, and passes
 * every test in between. That is the failure this file exists to catch, and it
 * is why the assertion is on both sites together rather than on either alone.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

import { FALLBACK_CONFIG_DEFAULTS } from '../storage.ts'

const BUNDLED_ASSET = join(
  import.meta.dir, '..', '..', '..', '..', '..',
  'apps', 'electron', 'resources', 'config-defaults.json',
)

describe('the shipped deferral default', () => {
  it('is on in the bundled asset AND in the in-code fallback', () => {
    const bundled = JSON.parse(readFileSync(BUNDLED_ASSET, 'utf-8')) as {
      workspaceDefaults?: { deferredMcpToolLoading?: unknown }
    }

    expect(bundled.workspaceDefaults?.deferredMcpToolLoading).toBe(true)
    expect(FALLBACK_CONFIG_DEFAULTS.workspaceDefaults.deferredMcpToolLoading).toBe(true)
  })

  it('reads back as a real boolean, not a truthy string', () => {
    // `loadConfigDefaults` re-coerces with `=== true`, so a JSON `"true"` would
    // arrive as `false` — on by declaration and off in fact. The coercion is
    // right; this pins the declaration to the shape it accepts.
    const raw = readFileSync(BUNDLED_ASSET, 'utf-8')
    expect(raw).toContain('"deferredMcpToolLoading": true')
  })
})
