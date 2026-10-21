/**
 * Workflow launch consent — `workflows.md` §Approve the plan before it runs.
 *
 * "In the Desktop app, an approval card shows the workflow name, the phase
 * list, and a token-usage caution, with Once, Always, and Deny actions", and
 * the CLI's Always is scoped: "don't ask again for `<name>` in `<path>`". Both
 * halves of that scope are load-bearing and tested here — the same workflow in
 * a different project prompts again, and a different workflow in the same
 * project prompts again.
 *
 * This is a NORMAL remember-able approval, not the non-suppressible worktree
 * floor.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  WorkflowLaunchConsentStore,
  describeWorkflowLaunchConsent,
  resolveWorkflowLaunchPlan,
  workflowConsentProjectKey,
} from './workflow-launch-consent.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'nessy-workflow-consent-'))
  roots.push(root)
  return join(root, 'workflow-launch-consent.json')
}

describe('resolving the launch plan', () => {
  it('reads phases from a saved recipe resolved by name', () => {
    const plan = resolveWorkflowLaunchPlan(
      { name: 'audit-routes' },
      () => ({
        source: [
          "export const meta = { name: 'audit-routes', description: 'Audit', phases: ['Discover', 'Audit', 'Report'] }",
          'return 1;',
        ].join('\n'),
      }),
    )
    expect(plan).toEqual({ name: 'audit-routes', phases: ['Discover', 'Audit', 'Report'] })
  })

  it('reads phases from a saved recipe resolved to already-parsed meta', () => {
    // The loader's recipe store strips `export const meta` from the executable
    // source, so the gate resolves the parsed meta directly — re-parsing the
    // stripped body silently lost the declared phases (pass-8 defect b).
    const plan = resolveWorkflowLaunchPlan(
      { name: 'audit-routes' },
      () => ({ meta: { name: 'audit-routes', description: 'Audit', phases: [{ title: 'Discover' }] } }),
    )
    expect(plan).toEqual({ name: 'audit-routes', phases: ['Discover'] })
  })

  it('reads phases from an inline script and from explicit tool input', () => {
    const inline = resolveWorkflowLaunchPlan({
      script: [
        "export const meta = { name: 'inline-audit', description: 'Audit', phases: ['One'] }",
        'return 1;',
      ].join('\n'),
    })
    expect(inline).toEqual({ name: 'inline-audit', phases: ['One'] })

    // Explicit `phases` on the tool call wins: it is what the run will show.
    const explicit = resolveWorkflowLaunchPlan({
      name: 'audit-routes',
      phases: [{ title: 'Only' }],
    }, () => ({ source: "export const meta = { name: 'audit-routes', description: 'Audit', phases: ['Ignored'] }" }))
    expect(explicit).toEqual({ name: 'audit-routes', phases: ['Only'] })
  })

  it('still yields a launch plan when no metadata is resolvable', () => {
    const plan = resolveWorkflowLaunchPlan({ script: 'return 1;' })
    expect(plan.name).toBe('workflow')
    expect(plan.phases).toEqual([])
  })

  it('names the workflow and lists the phases in the consent text', () => {
    const text = describeWorkflowLaunchConsent({ name: 'audit-routes', phases: ['Discover', 'Audit'] })
    expect(text).toContain('audit-routes')
    expect(text).toContain('Discover')
    expect(text).toContain('Audit')
    expect(describeWorkflowLaunchConsent({ name: 'ad-hoc', phases: [] })).toContain('ad-hoc')
  })
})

describe('per-workflow-per-project remember', () => {
  it('suppresses only the same workflow in the same project', () => {
    const store = new WorkflowLaunchConsentStore({ path: storePath() })
    expect(store.has('/repo/a', 'audit-routes')).toBe(false)

    store.remember('/repo/a', 'audit-routes')
    expect(store.has('/repo/a', 'audit-routes')).toBe(true)
    // Same workflow, different project.
    expect(store.has('/repo/b', 'audit-routes')).toBe(false)
    // Different workflow, same project.
    expect(store.has('/repo/a', 'release-audit')).toBe(false)
  })

  it('persists across store instances and is idempotent', () => {
    const path = storePath()
    const first = new WorkflowLaunchConsentStore({ path })
    first.remember('/repo/a', 'audit-routes')
    first.remember('/repo/a', 'audit-routes')

    const second = new WorkflowLaunchConsentStore({ path })
    expect(second.has('/repo/a', 'audit-routes')).toBe(true)
  })

  it('treats an unreadable or malformed record file as no consent', () => {
    const store = new WorkflowLaunchConsentStore({ path: join('/nonexistent-dir-for-tests', 'x.json') })
    expect(store.has('/repo/a', 'audit-routes')).toBe(false)
  })
})

describe('the two sides of the record derive the same project key', () => {
  it('canonicalizes and prefers the working directory over the workspace root', () => {
    expect(workflowConsentProjectKey({ workingDirectory: '/repo/a/', workspaceRootPath: '/ws' }))
      .toBe(workflowConsentProjectKey({ workingDirectory: '/repo/a', workspaceRootPath: '/other' }))
    expect(workflowConsentProjectKey({ workspaceRootPath: '/ws' })).toBe('/ws')
    expect(workflowConsentProjectKey({ workingDirectory: '   ', workspaceRootPath: '/ws' })).toBe('/ws')
  })

  it('is the ONLY derivation used by the reader and the writer', () => {
    // The reader is the agent-side gate; the writer is the session host. Two
    // independent derivations would store an approval under one key and look it
    // up under another — a remember that silently never takes effect.
    const reader = readFileSync(join(repoRoot, 'packages/shared/src/agent/base-agent.ts'), 'utf8')
    const writer = readFileSync(join(repoRoot, 'packages/server-core/src/sessions/SessionManager.ts'), 'utf8')
    expect(reader).toContain('workflowConsentProjectKey({')
    expect(writer).toContain('workflowConsentProjectKey({')
    // Neither side may hand-roll the fallback chain.
    expect(reader).not.toContain('filesystemScope?.primaryRoot\n      ?? cwd')
  })
})
