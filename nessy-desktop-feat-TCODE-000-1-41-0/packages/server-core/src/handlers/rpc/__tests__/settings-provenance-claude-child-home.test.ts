/**
 * D1.334 `[host]` `[claude]` — the settings-provenance view's second stack names
 * the file the CHILD opens, not this process's home.
 *
 * RS-77 read the two accounts side by side on the packaged 1.40.0 and found
 * **zero overlap** — the one FAIL of seven, and the product rather than the
 * case:
 *
 * | account | file |
 * | --- | --- |
 * | the SURFACE published | `~/<operator>/.claude/settings.json`, state `supplies` |
 * | the CHILD's own `[DEBUG]` named | `<config>/workspaces/<id>/claude-config/settings.json` |
 *
 * The operator's home file exists on that machine (6 604 bytes, 14 keys
 * including `permissions`, `hooks`, `env` and `model`), which is exactly why it
 * classified as **supplying** — to a child that never opens it. The second stack
 * exists because *"showing one stack would be the silent divergence this view
 * removes"*; publishing the wrong file committed that divergence inside the
 * instrument built to expose it.
 *
 * Three properties are pinned, and the third is the one a naive fix breaks:
 *
 *  1. the child's `user` entry is the per-Workspace `claude-config/settings.json`;
 *  2. the operator's home file is NOT in the child stack (it stays in the HOST
 *     families, where it is correct — this process's own
 *     `resolveInstructionExcludes` really does read it);
 *  3. reading the page CREATES NOTHING. `workspaceClaudeConfigDir` makes the
 *     directory it names, and this handler is read-only by construction (owner
 *     decision D12) — so the derivation had to grow a non-creating sibling.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CONFIG_DIR } from '@nessy-agent/shared/config'
import type { SettingsProvenanceReportV1 } from '@nessy-agent/shared/config/config-doctor'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'

import type { HandlerDeps } from '../../handler-deps'
import { registerSettingsHandlers } from '../settings'

const WORKSPACE_ID = 'wsd1334'

/**
 * F1.790 — the project handle service's trust answer for the view's project, the
 * same store `SessionManager` reads a session's `projectTrusted` from. `throws`
 * is the service refusing the path (a managed or missing folder): no project.
 */
type TrustAnswer = 'trusted' | 'unknown' | 'untrusted' | 'throws'

/** F1.1088 — every handle the view released, as `workspaceId:handleId`. */
const released: string[] = []

function trustService(answer: TrustAnswer) {
  return {
    async validateProjectDirectory(workspaceId: string, projectPath: string) {
      if (answer === 'throws') throw new Error('project-directory-managed')
      return { id: 'h-f1790', workspaceId, displayPath: projectPath, trustState: answer, expiresAt: Date.now() + 60_000 }
    },
    releaseHandle(workspaceId: string, handleId: string) { released.push(`${workspaceId}:${handleId}`) },
  }
}

function harness(workspaces: Record<string, { workspaceRootPath: string }>, trust?: TrustAnswer) {
  const registered = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { registered.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as unknown as RpcServer
  const deps = {
    sessionManager: trust ? { getProjectHandleService: () => trustService(trust) } : {},
    workspaceService: {
      resolve(workspaceId: string) {
        const found = workspaces[workspaceId]
        if (!found) throw new Error(`Unknown workspace: ${workspaceId}`)
        return found
      },
    },
    platform: {
      appRootPath: '/app/root',
      resourcesPath: '/app/resources',
      isPackaged: true,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSettingsHandlers(server, deps)
  const handler = registered.get(RPC_CHANNELS.settings.GET_PROVENANCE)
  if (!handler) throw new Error('GET_PROVENANCE is not registered')
  const ctx = { clientId: 'client-d1334', workspaceId: WORKSPACE_ID, webContentsId: null }
  return (workspaceId?: string) => handler(ctx, workspaceId) as Promise<SettingsProvenanceReportV1>
}

describe('D1.334 — the claude child stack names the directory the child is launched with', () => {
  it('publishes the per-Workspace claude-config settings file, and never the operator home one', async () => {
    const projectDirectory = join(CONFIG_DIR, 'd1334-project')
    // F1.1184 — a trust service answering 'trusted' no longer changes this view: its "project" is the workspace's
    // own data folder, which the real ProjectHandleService always refuses, so the arm could never fire.
    const report = await harness({ [WORKSPACE_ID]: { workspaceRootPath: projectDirectory } }, 'trusted')(WORKSPACE_ID)
    const childFiles = report.claudeChildSettingSources.map(entry => entry.file)

    // The expectation is built from `CONFIG_DIR` rather than from the function
    // under test, so this cannot pass by agreeing with itself.
    const expected = join(CONFIG_DIR, 'workspaces', WORKSPACE_ID, 'claude-config', 'settings.json')
    expect(childFiles).toContain(expected)
    expect(childFiles).not.toContain(join(homedir(), '.claude', 'settings.json'))

    // POSITIVE CONTROL — the stack really was built: the user leg is the one
    // entry (F1.1184: no project legs on this page), so an empty stack cannot
    // pass the absence above.
    expect(childFiles).toEqual([expected])

    // The user leg is the FIRST, which is the scope order
    // `settingSources: ['user','project','local']` names.
    expect(childFiles[0]).toBe(expected)
  })

  it('creates nothing: the read-only contract survives the new derivation', async () => {
    const configDir = join(CONFIG_DIR, 'workspaces', WORKSPACE_ID, 'claude-config')
    expect(existsSync(configDir)).toBe(false)
    await harness({ [WORKSPACE_ID]: { workspaceRootPath: join(CONFIG_DIR, 'd1334-project') } })(WORKSPACE_ID)
    expect(existsSync(configDir)).toBe(false)
  })

  it('omits the user leg when there is no workspace, rather than naming a file nobody reads', async () => {
    const report = await harness({})()
    const childFiles = report.claudeChildSettingSources.map(entry => entry.file)
    expect(childFiles).not.toContain(join(homedir(), '.claude', 'settings.json'))
    expect(childFiles).toEqual([])

    // CONTROL — the HOST families still name the operator's home file, because
    // this process's own reader really does read it. The row is about the child
    // stack alone, and a fix that swept the home file out of both would have
    // made the view lie in the other direction.
    const hostFiles = report.families.flatMap(family => family.entries.map(entry => entry.file))
    expect(hostFiles).toContain(join(homedir(), '.claude', 'settings.json'))
  })
})

/**
 * F1.790 `[claude]` — the child stack names only the sources the child is GIVEN.
 *
 * Since F1.768 `ClaudeAgent.projectTrustSettingSources` hands the child
 * `project` and `local` only for a project the host trusted, and `['user']`
 * otherwise. Until this row the view still listed the project's
 * `.claude/settings.json` and `.claude/settings.local.json` for every project,
 * so a restricted one looked as if the child read files it never opens.
 */
describe('F1.790 — the claude child stack follows the host\'s project trust', () => {
  const projectDirectory = join(CONFIG_DIR, 'f1790-project')
  const childUser = join(CONFIG_DIR, 'workspaces', WORKSPACE_ID, 'claude-config', 'settings.json')
  const projectFile = join(projectDirectory, '.claude', 'settings.json')
  const localFile = join(projectDirectory, '.claude', 'settings.local.json')
  const read = (trust?: TrustAnswer) =>
    harness({ [WORKSPACE_ID]: { workspaceRootPath: projectDirectory } }, trust)(WORKSPACE_ID)

  // F1.1184 — 'trusted' joins the list: the view's folder is the workspace's data folder, never a project.
  for (const trust of ['trusted', 'unknown', 'untrusted', 'throws', undefined] as const) {
    it(`lists the user leg alone, whatever a trust service would answer (${trust ?? 'no handle service'})`, async () => {
      const report = await read(trust)
      expect(report.claudeChildSettingSources.map(entry => [entry.scope, entry.file]))
        .toEqual([['user', childUser]])

      // CONTROL — the project WAS resolved: the host's own permissions family
      // still names its file, so the child legs are missing by trust, not
      // because the view had no project to name.
      const hostFiles = report.families.flatMap(family => family.entries.map(entry => entry.file))
      expect(hostFiles).toContain(projectFile)
    })
  }

  it('F1.1184: no trust lookup is made, so no handle is issued (F1.1088 had to release one per view open)', async () => {
    released.length = 0
    await read('trusted')
    await read('unknown')
    expect(released).toEqual([])
  })

  it('CONTROL: the project files exist as paths the host stack names, and the child stack still leaves them out', async () => {
    const report = await read('trusted')
    expect(report.claudeChildSettingSources.map(entry => entry.file)).not.toContain(projectFile)
    expect(report.claudeChildSettingSources.map(entry => entry.file)).not.toContain(localFile)
  })

  it('follows an operator-narrowed list the same way the child does, and trust still only narrows it', async () => {
    const name = 'NESSY_CLAUDE_SETTING_SOURCES'
    const saved = process.env[name]
    delete process.env[name]
    process.env[name] = 'user,local'
    try {
      const trusted = await read('trusted')
      expect(trusted.claudeChildSettingSources.map(entry => entry.scope)).toEqual(['user']) // F1.1184
      const restricted = await read('unknown')
      expect(restricted.claudeChildSettingSources.map(entry => entry.scope)).toEqual(['user'])
    } finally {
      delete process.env[name]
      if (saved !== undefined) process.env[name] = saved
    }
  })
})
