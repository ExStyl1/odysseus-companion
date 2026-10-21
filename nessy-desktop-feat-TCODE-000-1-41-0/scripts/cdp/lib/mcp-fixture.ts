/**
 * Shared reads for the MCP-W wave (`cases/mcp-w1.ts`…`mcp-w3.ts`).
 *
 * Everything here is a READ. The fixture tree and the installs are the
 * operator's (`fixtures/mcp-naming.ts` + the recipe in the checklist row), per
 * the harness rule that a case never installs a plugin or rewrites config.
 */

import { existsSync, readFileSync } from 'node:fs'

import type { CdpSession } from './connect.ts'
import { blocked } from './report.ts'
import { fixturePaths, type FixtureTokens } from '../fixtures/mcp-naming.ts'

export interface CatalogRow {
  key: string
  kind: string
  logicalName: string
  origin: string
  state: string
  unavailableReason?: string
  diagnosticCodes: string[]
}

export interface CapabilityDiagnostic {
  severity: string
  code: string
  messageKey: string
  safeArgs?: Record<string, string>
  capabilityKey?: string
}

/**
 * The workspace every read is scoped to.
 *
 * A purpose-built fixture config dir holds exactly one, and the one-workspace
 * rule is what stops a case silently reading a DIFFERENT workspace's servers
 * than the one it drove. But a run against an operator's real config dir is
 * legitimate and common — Q6-LIVE requires one, because it needs a project that
 * is already bound and trusted — and there the count is whatever the operator
 * has. `NESSY_CDP_WORKSPACE_ID` names the workspace in that case; it is checked
 * against the live list rather than trusted, so a stale id fails loudly instead
 * of scoping every read to a workspace that no longer exists.
 */
export async function fixtureWorkspaceId(session: CdpSession): Promise<string> {
  const ids = await session.call<string[]>(`
    return (await window.electronAPI.getWorkspaces()).map(w => w.id)
  `)
  const pinned = process.env.NESSY_CDP_WORKSPACE_ID?.trim()
  if (pinned) {
    if (!ids.includes(pinned)) {
      throw new Error(`unknown-workspace: NESSY_CDP_WORKSPACE_ID=${pinned} is not one of the ${ids.length} the app has`)
    }
    return pinned
  }
  if (ids.length !== 1) {
    throw new Error(
      `ambiguous-workspace: expected exactly one workspace in the fixture config dir, found ${ids.length}. `
      + `Set NESSY_CDP_WORKSPACE_ID to pick one when running against a config dir that has several.`,
    )
  }
  return ids[0]!
}

/**
 * The catalog under `{ workspaceId }`, or under `{ workspaceId, sessionId }` —
 * the context the renderer itself reads with (`capabilityContext` in
 * `renderer/lib/capability-catalog.ts`). The two are NOT interchangeable for a
 * plugin capability: its key carries the scope it was resolved in
 * (`…#<capabilityId>@<kind>:<workspace>:<projectKey>`), so a session with a
 * project answers a different key than the workspace alone (F1.149).
 */
export async function catalogRows(session: CdpSession, workspaceId: string, sessionId?: string): Promise<CatalogRow[]> {
  const context = sessionId ? { workspaceId, sessionId } : { workspaceId }
  return session.call<CatalogRow[]>(`
    const cat = await window.electronAPI.capabilities.getCatalog(${JSON.stringify(context)})
    return (cat.capabilities ?? []).map(c => ({
      key: c.key, kind: c.kind, logicalName: c.logicalName, origin: c.origin,
      state: c.state, unavailableReason: c.unavailableReason,
      diagnosticCodes: c.diagnosticCodes ?? [],
    }))
  `)
}

export async function capabilityDiagnostics(
  session: CdpSession,
  workspaceId: string,
  capabilityKey: string,
): Promise<CapabilityDiagnostic[]> {
  return session.call<CapabilityDiagnostic[]>(`
    const d = await window.electronAPI.capabilities.getDetail(
      { workspaceId: ${JSON.stringify(workspaceId)} },
      ${JSON.stringify(capabilityKey)},
    )
    return d.diagnostics ?? []
  `)
}

/** `capabilities.listMcpTools` — a live connect + `tools/list` against the server. */
export async function mcpTools(
  session: CdpSession,
  workspaceId: string,
  capabilityKey: string,
): Promise<{ status: string; tools?: { name: string }[]; reason?: string }> {
  return session.call(`
    return await window.electronAPI.capabilities.listMcpTools(
      { workspaceId: ${JSON.stringify(workspaceId)} },
      ${JSON.stringify(capabilityKey)},
    )
  `)
}

/**
 * The probe servers' OWN log — ground truth that does not come from the app.
 *
 * AGENTS.md: a feature's absence must be confirmed against a source the feature
 * writes itself. When a case claims "the call reached the server", this file is
 * what makes that a measurement rather than a reading of the app's own account
 * of itself.
 */
export interface ProbeCall {
  at: number
  label: string
  method: string
  tool?: string
}

export function probeCalls(): ProbeCall[] {
  const path = fixturePaths().logFile
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as ProbeCall]
      } catch {
        return []
      }
    })
}

/** `tools/call` entries for one fixture server since `since` (epoch ms). */
export function probeToolCalls(label: string, since: number): ProbeCall[] {
  return probeCalls().filter(c => c.label === label && c.method === 'tools/call' && c.at >= since)
}

export function requireTokens(): FixtureTokens {
  const path = fixturePaths().tokensFile
  if (!existsSync(path)) {
    blocked(
      `no fixture tree at ${fixturePaths().root} — boot the app ONCE on NESSY_CONFIG_DIR=<root>/config and quit, `
      + 'THEN run `bun run scripts/cdp/fixtures/mcp-naming.ts` (writing first is the custom-root-reset-required dead '
      + 'gate, F1.146), relaunch and install the probe plugins — the MCP-W row of scripts/cdp/README.md.',
    )
  }
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureTokens
}

/**
 * Force the dark theme before anything visual.
 *
 * Project convention (light is deferred), and it is a WRITE of the app's own
 * stored preference followed by a reload, not a `classList.add('dark')` — the
 * latter would paint one element dark and leave every themed child on the
 * light palette, which is worse than not forcing it at all.
 */
export async function ensureDarkTheme(session: CdpSession): Promise<'already-dark' | 'forced-dark'> {
  const isDark = await session.call<boolean>(`return document.documentElement.classList.contains('dark')`)
  if (isDark) return 'already-dark'
  await session.call<null>(`
    const raw = localStorage.getItem('nessy-theme')
    const stored = raw ? JSON.parse(raw) : {}
    localStorage.setItem('nessy-theme', JSON.stringify({ ...stored, mode: 'dark', isUserOverride: true }))
    return null
  `)
  await session.send('Page.reload', {})
  // The renderer has to remount and re-apply the class; poll the DOM rather
  // than sleeping a guessed interval.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await Bun.sleep(500)
    const dark = await session.call<boolean>(`return document.documentElement.classList.contains('dark')`).catch(() => false)
    if (dark) return 'forced-dark'
  }
  throw new Error('theme-not-dark: the app did not apply the dark class after the preference write and a reload')
}
