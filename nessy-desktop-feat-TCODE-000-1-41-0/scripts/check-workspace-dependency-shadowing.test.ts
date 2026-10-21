import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkWorkspaceDependencyShadowing,
  nestedPackages,
  resolvePackageFrom,
  workspaceDirectories,
} from './check-workspace-dependency-shadowing.ts'

/**
 * D1.106 — the gate that would have caught the lift shadow, and the four ways a
 * naive version of it would have cried wolf on this repo instead.
 *
 * The fixture is a whole throwaway workspace tree rather than a mock, because
 * what is under test IS the layout on disk: where a package sits decides which
 * copy an importer gets, and no stub can be wrong about that in the same way.
 */

interface PackageSpec {
  /** `<name>@<version>` entries to place under this directory's node_modules. */
  nested?: string[]
  declared?: Record<string, string>
}

function writePackage(dir: string, name: string, version: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
}

function buildTree(spec: {
  root: PackageSpec
  workspaces: Record<string, PackageSpec>
}): string {
  const root = mkdtempSync(join(tmpdir(), 'nessy-shadow-fixture-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'fixture-root',
    workspaces: ['packages/*'],
    dependencies: spec.root.declared ?? {},
  }))
  for (const entry of spec.root.nested ?? []) {
    const [name, version] = splitSpec(entry)
    writePackage(join(root, 'node_modules', name), name, version)
  }
  for (const [workspace, ws] of Object.entries(spec.workspaces)) {
    const dir = join(root, 'packages', workspace)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `@fixture/${workspace}`,
      version: '1.0.0',
      dependencies: ws.declared ?? {},
    }))
    for (const entry of ws.nested ?? []) {
      const [name, version] = splitSpec(entry)
      writePackage(join(dir, 'node_modules', name), name, version)
    }
  }
  return root
}

function splitSpec(entry: string): [string, string] {
  const at = entry.lastIndexOf('@')
  return [entry.slice(0, at), entry.slice(at + 1)]
}

describe('D1.106 · a workspace-nested copy that shadows the lift', () => {
  it('FAILS on the measured case: a nested copy the workspace\'s own pin refuses', () => {
    // The 2026-09-11 incident in miniature: the workspace pins the lifted
    // version exactly, `bun install` left the previous one under its own
    // node_modules, and every root-reading instrument said the lift was done.
    const root = buildTree({
      root: { nested: ['@earendil-works/pi-coding-agent@0.84.4'] },
      workspaces: {
        'pi-agent-server': {
          declared: { '@earendil-works/pi-coding-agent': '0.84.4' },
          nested: ['@earendil-works/pi-coding-agent@0.84.2'],
        },
      },
    })
    try {
      const report = checkWorkspaceDependencyShadowing(root)
      expect(report.findings.length).toBe(1)
      const finding = report.findings[0]!
      expect(finding.name).toBe('@earendil-works/pi-coding-agent')
      expect(finding.version).toBe('0.84.2')
      expect(finding.declared).toBe('0.84.4')
      expect(finding.nested).toBe(true)
      expect(finding.reason).toBe('violates-declared-range')
      // The path is what a human needs to act: which copy to remove.
      expect(finding.path).toContain('packages/pi-agent-server/node_modules')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('CONTROL — the same tree with the nested copy AT the pinned version passes', () => {
    // Without this arm the case above would pass for a gate that fails on any
    // nested copy at all, which is the gate this one deliberately is not.
    const root = buildTree({
      root: { nested: ['@earendil-works/pi-coding-agent@0.84.4'] },
      workspaces: {
        'pi-agent-server': {
          declared: { '@earendil-works/pi-coding-agent': '0.84.4' },
          nested: ['@earendil-works/pi-coding-agent@0.84.4'],
        },
      },
    })
    try {
      const report = checkWorkspaceDependencyShadowing(root)
      expect(report.findings).toEqual([])
      expect(report.notes.map(note => note.reason)).toContain('duplicate-same-version')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('NEGATIVE — a DELIBERATE nest at another version is not a finding', () => {
    // This repo carries nine of these today (`@types/node` 22 under five
    // server-side packages against 25 at the root; four of apps/viewer's pins).
    // A gate that reported them would be switched off within a week.
    const root = buildTree({
      root: { nested: ['@types/node@25.9.4'] },
      workspaces: {
        server: {
          declared: { '@types/node': '^22.0.0' },
          nested: ['@types/node@22.19.21'],
        },
      },
    })
    try {
      const report = checkWorkspaceDependencyShadowing(root)
      expect(report.findings).toEqual([])
      expect(report.checked).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an UNDECLARED nested copy is judged against the root, both ways', () => {
    // No declared range means the root install is the only contract there is.
    // `apps/electron` really does carry one of these — the build stages the
    // Claude SDK and its native binary there — so the same-version arm is the
    // one that keeps this repo green, and the other-version arm is the defect.
    const root = buildTree({
      root: { nested: ['sdk@1.0.0', 'kept@2.0.0'] },
      workspaces: {
        electron: { nested: ['sdk@0.9.0', 'kept@2.0.0', 'binary-only@3.0.0'] },
      },
    })
    try {
      const report = checkWorkspaceDependencyShadowing(root)
      expect(report.findings.length).toBe(1)
      expect(report.findings[0]!.name).toBe('sdk')
      expect(report.findings[0]!.reason).toBe('undeclared-copy-shadows-root')
      const byReason = Object.fromEntries(report.notes.map(note => [note.name, note.reason]))
      expect(byReason.kept).toBe('undeclared-duplicate')
      // Present here and nowhere at the root: a workspace-only staging copy,
      // which is a note and never a failure.
      expect(byReason['binary-only']).toBe('workspace-only-copy')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a workspace LINK is not a nested copy', () => {
    // bun links internal packages into node_modules as symlinks whose target
    // has a package.json; read with `stat` they look like nested copies of
    // themselves, and every workspace would report one.
    const root = buildTree({ root: {}, workspaces: { shared: {}, server: {} } })
    try {
      const linkDir = join(root, 'packages', 'server', 'node_modules', '@fixture')
      mkdirSync(linkDir, { recursive: true })
      symlinkSync(join(root, 'packages', 'shared'), join(linkDir, 'shared'), 'dir')
      expect(nestedPackages(join(root, 'packages', 'server'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolution walks UP from the importer, nearest copy first', () => {
    const root = buildTree({
      root: { nested: ['pkg@1.0.0'] },
      workspaces: { near: { nested: ['pkg@0.1.0'] }, far: {} },
    })
    try {
      expect(resolvePackageFrom(join(root, 'packages', 'near'), 'pkg')?.version).toBe('0.1.0')
      expect(resolvePackageFrom(join(root, 'packages', 'far'), 'pkg')?.version).toBe('1.0.0')
      expect(resolvePackageFrom(join(root, 'packages', 'far'), 'absent')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads THIS repo, and finds nothing — the control that it is not vacuous', () => {
    // Counts are not pinned (they move with every dependency change); what is
    // pinned is that the walker sees a real monorepo and judged real packages.
    const report = checkWorkspaceDependencyShadowing(join(import.meta.dir, '..'))
    expect(report.workspaces.length).toBeGreaterThan(10)
    expect(report.checked).toBeGreaterThan(50)
    expect(workspaceDirectories(join(import.meta.dir, '..'))).toContain(
      join(import.meta.dir, '..', 'packages', 'pi-agent-server'),
    )
    expect(report.findings).toEqual([])
    // The budget is the case's OWN work, not a module graph: the walk reads
    // every workspace's node_modules and took 6.8 s here against the 5 s
    // default (load ~11, the box's I/O floor; the CLI form measures 21 s wall
    // at 0.06 s user). Sized against that measured floor, never zero.
  }, 120_000)
})
