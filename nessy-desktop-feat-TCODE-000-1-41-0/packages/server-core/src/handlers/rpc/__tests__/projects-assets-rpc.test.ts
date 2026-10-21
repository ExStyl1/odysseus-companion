/**
 * UA5.6 — the project ASSET channels of `rpc/projects.ts` (adapted from craft-agents-oss
 * `v0.13.4:packages/server-core/src/handlers/rpc/projects.ts` L99–L135, Apache-2.0): `projects:listAssets`,
 * `projects:uploadAsset`, `projects:deleteAsset`.
 *
 * Driven through the real storage (`@nessy-agent/shared/projects`) over a temp workspace root.
 * Positive: upload (base64, text), then list — newest first — and delete; each mutation pushes `projects:changed` to the
 * workspace, as upstream. Negative: a traversal name is refused its path (the upload lands inside `assets/`, the
 * project's `config.json` untouched, and a delete by `../config.json` never reaches it); a `sourcePath` from the wire is
 * refused with nothing written (NESSY, reason (b)); a foreign workspace (and a caller with none) is refused on all
 * three with nothing written or pushed; an unknown project is refused.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, getProjectAssetsPath, getProjectPath } from '@nessy-agent/shared/projects'
import type { ProjectAsset } from '@nessy-agent/shared/projects/types'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { HANDLED_CHANNELS, registerProjectsHandlers } from '../projects'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const ASSET_CHANNELS = [
  RPC_CHANNELS.projects.LIST_ASSETS,
  RPC_CHANNELS.projects.UPLOAD_ASSET,
  RPC_CHANNELS.projects.DELETE_ASSET,
]

function harness() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-ua5-6-ws-'))
  roots.push(workspaceRoot)
  const handlers = new Map<string, HandlerFn>()
  const pushes: Array<{ channel: string; target: unknown; args: unknown[] }> = []
  const server: RpcServer = {
    handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
    push(channel: string, target: unknown, ...args: unknown[]) { pushes.push({ channel, target, args }) },
    async invokeClient() { return { canceled: true, filePaths: [] } },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as unknown as RpcServer
  const deps = {
    sessionManager: { getProjectHandleService: () => undefined, getRecentProjectStore: () => undefined },
    workspaceService: {
      resolve(workspaceId: string) {
        if (workspaceId !== 'ws-a') throw new Error(`Workspace not found: ${workspaceId}`)
        return { workspaceRootPath: workspaceRoot }
      },
    },
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerProjectsHandlers(server, deps)
  const callAs = <T>(context: RequestContext, channel: string, ...args: unknown[]): Promise<T> =>
    handlers.get(channel)!(context, ...args) as Promise<T>
  const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    callAs<T>({ clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null }, channel, ...args)
  const changed = () => pushes.filter(push => push.channel === RPC_CHANNELS.projects.CHANGED)
  const slug = createProject(workspaceRoot, { name: 'Acme' }).slug
  return { workspaceRoot, handlers, pushes, call, callAs, changed, slug }
}

describe('UA5.6 — project asset RPC', () => {
  it('declares and registers the three asset channels', () => {
    for (const channel of ASSET_CHANNELS) expect(HANDLED_CHANNELS as readonly string[]).toContain(channel)
    const { handlers } = harness()
    for (const channel of ASSET_CHANNELS) expect(handlers.has(channel)).toBe(true)
  })

  it('POSITIVE: upload (base64, text), then list newest first, then delete — one projects:changed push per mutation', async () => {
    const h = harness()
    const pdf = await h.call<ProjectAsset>(RPC_CHANNELS.projects.UPLOAD_ASSET, 'ws-a', h.slug, {
      filename: 'spec.pdf', base64: Buffer.from('%PDF-1.4').toString('base64'),
    })
    const notes = await h.call<ProjectAsset>(RPC_CHANNELS.projects.UPLOAD_ASSET, 'ws-a', h.slug, { filename: 'notes.md', text: '# n' })
    expect(pdf).toMatchObject({ filename: 'spec.pdf', sizeBytes: 8, mimeType: 'application/pdf' })
    expect(readFileSync(join(getProjectAssetsPath(h.workspaceRoot, h.slug), 'notes.md'), 'utf-8')).toBe('# n')
    utimesSync(pdf.absolutePath, 1_000, 1_000)
    utimesSync(notes.absolutePath, 2_000, 2_000)
    const listed = await h.call<ProjectAsset[]>(RPC_CHANNELS.projects.LIST_ASSETS, 'ws-a', h.slug)
    expect(listed.map(asset => asset.filename)).toEqual(['notes.md', 'spec.pdf'])
    await h.call(RPC_CHANNELS.projects.DELETE_ASSET, 'ws-a', h.slug, 'notes.md')
    expect((await h.call<ProjectAsset[]>(RPC_CHANNELS.projects.LIST_ASSETS, 'ws-a', h.slug)).map(asset => asset.filename)).toEqual(['spec.pdf'])
    expect(h.changed()).toHaveLength(3) // upload ×2, delete; list pushes nothing
    expect(h.changed()[0]!.target).toEqual({ to: 'workspace', workspaceId: 'ws-a' })
  })

  it('NEGATIVE: a traversal name is refused its path — it lands in assets/, and delete by ../config.json never reaches the config', async () => {
    const h = harness()
    const configPath = join(getProjectPath(h.workspaceRoot, h.slug), 'config.json')
    const before = readFileSync(configPath, 'utf-8')
    const up = await h.call<ProjectAsset>(RPC_CHANNELS.projects.UPLOAD_ASSET, 'ws-a', h.slug, { filename: '../../config.json', text: '{"evil":true}' })
    expect(up.absolutePath).toBe(join(getProjectAssetsPath(h.workspaceRoot, h.slug), 'config.json'))
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
    expect(existsSync(join(h.workspaceRoot, 'config.json'))).toBe(false)
    await h.call(RPC_CHANNELS.projects.DELETE_ASSET, 'ws-a', h.slug, '../config.json')
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
    expect(existsSync(up.absolutePath)).toBe(false)
  })

  it('NEGATIVE (NESSY): a sourcePath from the wire is refused, nothing written or pushed — even beside base64', async () => {
    const h = harness()
    const secret = join(h.workspaceRoot, 'outside-secret.txt')
    writeFileSync(secret, 'secret')
    await expect(h.call(RPC_CHANNELS.projects.UPLOAD_ASSET, 'ws-a', h.slug, { filename: 's.txt', sourcePath: secret }))
      .rejects.toThrow('project-asset-source-path-refused')
    await expect(h.call(RPC_CHANNELS.projects.UPLOAD_ASSET, 'ws-a', h.slug, { filename: 's.txt', base64: 'eA==', sourcePath: secret }))
      .rejects.toThrow('project-asset-source-path-refused')
    expect(readdirSync(getProjectAssetsPath(h.workspaceRoot, h.slug))).toEqual([])
    expect(h.changed()).toHaveLength(0)
  })

  it('NEGATIVE: a foreign workspace (and a caller with none) is refused on all three, nothing written or pushed', async () => {
    const h = harness()
    const argsFor: Record<string, unknown[]> = {
      [RPC_CHANNELS.projects.LIST_ASSETS]: ['ws-a', h.slug],
      [RPC_CHANNELS.projects.UPLOAD_ASSET]: ['ws-a', h.slug, { filename: 'a.txt', text: 'x' }],
      [RPC_CHANNELS.projects.DELETE_ASSET]: ['ws-a', h.slug, 'a.txt'],
    }
    for (const workspaceId of ['ws-b', null]) {
      for (const channel of ASSET_CHANNELS) {
        await expect(h.callAs({ clientId: 'client-b', workspaceId, webContentsId: null }, channel, ...argsFor[channel]!))
          .rejects.toThrow('project-workspace-mismatch')
      }
    }
    expect(readdirSync(getProjectAssetsPath(h.workspaceRoot, h.slug))).toEqual([])
    expect(h.pushes).toHaveLength(0)
    // Control: the same upload from the workspace's own caller lands.
    await h.call(RPC_CHANNELS.projects.UPLOAD_ASSET, 'ws-a', h.slug, { filename: 'a.txt', text: 'x' })
    expect(readdirSync(getProjectAssetsPath(h.workspaceRoot, h.slug))).toEqual(['a.txt'])
  })

  it('NEGATIVE: an unknown project is refused (upload), and an unsafe slug never reaches the filesystem', async () => {
    const h = harness()
    await expect(h.call(RPC_CHANNELS.projects.UPLOAD_ASSET, 'ws-a', 'nope', { filename: 'a.txt', text: 'x' })).rejects.toThrow('project-not-found')
    expect(existsSync(join(h.workspaceRoot, 'projects', 'nope'))).toBe(false)
    await expect(h.call(RPC_CHANNELS.projects.LIST_ASSETS, 'ws-a', '..')).rejects.toThrow('project-slug-invalid')
    expect(h.changed()).toHaveLength(0)
  })

  /**
   * UA12.113 — a STATED size cap: an upload above it is refused with a code and nothing is written or pushed
   * (the base64 payload would otherwise be held twice in server memory — text and decoded bytes); one just
   * below it is accepted with its exact size. The cap holds the text arm too — no bypass — and the storage
   * level holds the in-process sourcePath arm behind the same check.
   */
  it('UA12.113: an upload above the 16 MiB cap is refused with project-asset-too-large; just below it is accepted', async () => {
    const h = harness()
    const CAP = 16 * 1024 * 1024

    const refused = await h.call(RPC_CHANNELS.projects.UPLOAD_ASSET, 'ws-a', h.slug, {
      filename: 'too-big.bin', base64: Buffer.alloc(CAP + 1).toString('base64'),
    }).then(() => null, (error: unknown) => error)
    expect((refused as Error | null)?.message).toContain('project-asset-too-large')
    expect(existsSync(join(getProjectAssetsPath(h.workspaceRoot, h.slug), 'too-big.bin'))).toBe(false)
    expect(h.changed()).toEqual([])

    const accepted = await h.call<ProjectAsset>(RPC_CHANNELS.projects.UPLOAD_ASSET, 'ws-a', h.slug, {
      filename: 'under.bin', base64: Buffer.alloc(CAP - 1).toString('base64'),
    })
    expect(accepted.sizeBytes).toBe(CAP - 1)

    await expect(h.call(RPC_CHANNELS.projects.UPLOAD_ASSET, 'ws-a', h.slug, { filename: 'big.md', text: 'x'.repeat(CAP + 1) }))
      .rejects.toThrow('project-asset-too-large')
    expect(readdirSync(getProjectAssetsPath(h.workspaceRoot, h.slug))).toEqual(['under.bin'])
    expect(h.changed()).toHaveLength(1) // only the accepted upload pushed
  })
})
