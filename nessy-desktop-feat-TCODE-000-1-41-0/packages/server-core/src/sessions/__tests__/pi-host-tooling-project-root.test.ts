import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveChangedFile, resolvePiHostToolingRoot } from '../../pi-harness/edit-feedback.ts'
import { resolvePiLspDocumentUri } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

/**
 * F1.1012 — Pi's post-edit checks, `format` op and plugin language servers work
 * under the session's PROJECT, not the managed workspace folder.
 *
 * All three were handed `managed.workspace.rootPath` — the app's own folder for
 * the workspace — so for a project outside it `resolveChangedFile` answered null
 * (no check ever ran) and `resolvePiLspDocumentUri` threw
 * `lsp-path-outside-workspace` (every LSP request on a project file failed). The
 * measurement is kept below as the control arm, so this file shows the defect
 * and the fix side by side.
 */

const sessionKey = { workspaceId: 'ws-f1012', sessionId: 'session-f1012' }

interface RecordedStart {
  semanticId: string
  cwd: string
  workspaceRoot: string
}

async function createFixture() {
  // Two SIBLING folders: the project is outside the managed workspace folder,
  // which is the ordinary layout (a code folder the user picked vs the app's
  // per-workspace directory).
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessy-f1012-workspace-'))
  const project = await mkdtemp(join(tmpdir(), 'nessy-f1012-project-'))
  await mkdir(join(project, 'src'))
  // `biome.json` is a marker both `detectChecks` and `detectFormatter` read.
  await writeFile(join(project, 'biome.json'), '{}\n')
  await writeFile(join(project, 'src', 'a.ts'), 'export const a: number = 1\n')
  // The same marker and a code file in the managed workspace folder, so the
  // boundary arm is refused by the ROOT and not by a missing marker.
  await writeFile(join(workspaceRoot, 'biome.json'), '{}\n')
  await writeFile(join(workspaceRoot, 'stray.ts'), 'export {}\n')
  return {
    workspaceRoot,
    project,
    cleanup: async () => {
      await rm(workspaceRoot, { recursive: true, force: true })
      await rm(project, { recursive: true, force: true })
    },
  }
}

function managerWithRecordingSupervisor() {
  const manager = createTestSessionManager() as any
  const starts: RecordedStart[] = []
  manager.piWorkspaceDrainParticipant = {
    processSupervisorPort: {
      start: async (request: RecordedStart) => {
        starts.push({ semanticId: request.semanticId, cwd: request.cwd, workspaceRoot: request.workspaceRoot })
        return { exitCode: 0, output: '' }
      },
    },
  }
  manager.piLspDiagnostics = new Map()
  return { manager, starts }
}

describe('F1.1012 — Pi host edit tooling is rooted at the session project', () => {
  test('a project file reaches the checks, the formatter and the LSP URI under the project root', async () => {
    const fixture = await createFixture()
    try {
      const projectFile = join(fixture.project, 'src', 'a.ts')
      const edit = { toolName: 'Edit', toolInput: { file_path: projectFile } }

      // Control — the root HEAD handed all three: the project file is refused.
      expect(resolveChangedFile(edit, fixture.workspaceRoot)).toBeNull()
      await expect(resolvePiLspDocumentUri(fixture.workspaceRoot, projectFile))
        .rejects.toThrow('lsp-path-outside-workspace')

      const root = resolvePiHostToolingRoot({
        workingDirectory: fixture.project,
        workspace: { rootPath: fixture.workspaceRoot },
      })
      expect(root).toBe(fixture.project)

      const { manager, starts } = managerWithRecordingSupervisor()
      await manager.buildEditFeedbackRunner(sessionKey, root)(edit)
      await manager.buildFormatRunner(sessionKey, root)({ path: 'src/a.ts' })
      expect(starts).toEqual([
        { semanticId: 'edit-feedback', cwd: fixture.project, workspaceRoot: fixture.project },
        { semanticId: 'format', cwd: fixture.project, workspaceRoot: fixture.project },
      ])

      const uri = await resolvePiLspDocumentUri(root, 'src/a.ts')
      expect(uri).toStartWith('file:')
      expect(uri).toEndWith('/src/a.ts')
    } finally {
      await fixture.cleanup()
    }
  })

  test('a file outside the project is still refused, and a session with no project falls back to the workspace folder', async () => {
    const fixture = await createFixture()
    try {
      const strayFile = join(fixture.workspaceRoot, 'stray.ts')
      const { manager, starts } = managerWithRecordingSupervisor()

      expect(await manager.buildEditFeedbackRunner(sessionKey, fixture.project)({
        toolName: 'Write',
        toolInput: { file_path: strayFile },
      })).toBeUndefined()
      await manager.buildFormatRunner(sessionKey, fixture.project)({ path: strayFile })
      // Nothing spawned: the containment boundary moved WITH the root.
      expect(starts).toEqual([])
      await expect(resolvePiLspDocumentUri(fixture.project, strayFile))
        .rejects.toThrow('lsp-path-outside-workspace')

      expect(resolvePiHostToolingRoot({ workspace: { rootPath: fixture.workspaceRoot } }))
        .toBe(fixture.workspaceRoot)
    } finally {
      await fixture.cleanup()
    }
  })

  test('the three SessionManager sites that build them hand over the project root', () => {
    const source = readFileSync(fileURLToPath(new URL('../SessionManager.ts', import.meta.url)), 'utf8')

    /** The text of the ONE call site that begins with `needle`, up to its closing line. */
    function soleSite(needle: string, closing: string): string {
      const start = source.indexOf(needle)
      expect(start).toBeGreaterThan(-1)
      expect(source.indexOf(needle, start + needle.length)).toBe(-1)
      const end = source.indexOf(closing, start)
      expect(end).toBeGreaterThan(start)
      return source.slice(start, end)
    }

    const lsp = soleSite('new LspService({', '\n          })')
    expect(lsp).toContain('workspaceRoot: lspRoot,')
    expect(lsp).toContain('resolveDocumentUri: path => resolvePiLspDocumentUri(lspRoot, path),')
    expect(lsp).not.toContain('managed.workspace.rootPath')
    const loop = soleSite('for (const registration of capabilityRuntime.view.lspServers ?? [])', 'new LspService({')
    expect(loop).toContain('const lspRoot = resolvePiHostToolingRoot(managed)')

    for (const needle of ['this.buildEditFeedbackRunner(', 'this.buildFormatRunner(']) {
      const site = soleSite(needle, '\n        )')
      expect(site).toContain('resolvePiHostToolingRoot(managed),')
      expect(site).not.toContain('managed.workspace.rootPath')
    }
  })
})
