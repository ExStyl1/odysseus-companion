import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  assertClaudeParityCloseoutReady,
  scoreClaudeParityEvidence,
  validateClaudeDesktopEvidenceIndex,
  validateClaudeParityEvidence,
  type ClaudeDesktopEvidenceIndexV1,
  type ClaudeParityEvidenceV1,
} from '../../../../shared/src/agent/pi-harness/claude-parity-evidence.ts'

const core = JSON.parse(readFileSync(
  resolve(import.meta.dir, 'fixtures/claude-code-2.1.218.json'),
  'utf8',
)) as ClaudeParityEvidenceV1

const desktop = JSON.parse(readFileSync(
  resolve(import.meta.dir, '../../../../shared/src/plugins/__tests__/fixtures/claude-desktop-host-evidence.json'),
  'utf8',
)) as ClaudeDesktopEvidenceIndexV1

const repoRoot = resolve(import.meta.dir, '../../../../..')

const POST_PARITY_EVIDENCE = {
  'mcp-deferred-discovery': {
    sourceRefs: [
      'repo://packages/pi-agent-server/src/deferred-mcp-tools.test.ts',
      'repo://packages/shared/src/mcp/__tests__/client-transport.test.ts',
      'repo://packages/shared/src/mcp/__tests__/proxy-tool-names.test.ts',
    ],
    observable: 'List-changed notifications atomically refresh tools, resources and prompts, preserve the last good catalog on failure, and revoke withdrawn deferred tools before their next use.',
  },
  'plugin-mcp-runtime': {
    sourceRefs: [
      'repo://packages/shared/src/plugins/management-service-v2.ts',
      'repo://packages/shared/src/plugins/__tests__/management-service-v2.test.ts',
      'repo://packages/shared/src/plugins/plugin-settings.test.ts',
      'repo://packages/server-core/src/pi-harness/lsp-service.test.ts',
      'repo://packages/server-core/src/pi-harness/plugin-monitor-service.test.ts',
    ],
    observable: 'Portable plugin LSP, namespaced settings, trusted scheduled monitors and leased MCP channels use existing host owners and drain on disable or uninstall.',
  },
  'skill-invocation': {
    sourceRefs: [
      'repo://packages/shared/src/capabilities/runtime-skill-context.test.ts',
      'repo://packages/shared/src/agent/core/__tests__/skill-invocation.test.ts',
    ],
    observable: 'Inline and fenced skill shell placeholders each execute through ProcessSupervisor after permission admission with pinned cwd, five-second and 32 KiB bounds, and volatile-only output substituted in place.',
  },
  'permission-receipt-authority': {
    sourceRefs: [
      'repo://packages/shared/src/agent/pi-harness/managed-policy.test.ts',
      'repo://packages/server-core/src/pi-harness/managed-policy-loader.test.ts',
      'repo://packages/server-core/src/sessions/SessionManager.orchestration.test.ts',
    ],
    observable: 'Host-owned managed Pi policy loads once, denies before process or capability creation, and cannot be widened by user, project or plugin scopes.',
  },
  'environment-hook-containment': {
    sourceRefs: [
      'repo://packages/server-core/src/sessions/SessionManager.plugin-hook-runners.test.ts',
      'repo://packages/shared/src/plugins/__tests__/hooks-automation.test.ts',
    ],
    observable: 'Trusted agent, MCP and credentialless HTTP plugin hooks revalidate pinned authority, permission, timeout and abort, then append one redacted terminal receipt.',
  },
  'durable-receipt-observability': {
    sourceRefs: [
      'repo://packages/shared/src/agent/pi-harness/execution-observability.test.ts',
      'repo://packages/server-core/src/pi-harness/otlp-telemetry.test.ts',
      'repo://packages/server-core/src/sessions/SessionManager.execution-observability.test.ts',
    ],
    observable: 'Optional bounded OTLP HTTP export projects only safe hashed lifecycle and terminal outcomes, and exporter failure never fails an agent turn.',
  },
} as const

function expectRepoEvidenceToExist(refs: readonly string[]): void {
  for (const ref of refs) {
    if (!ref.startsWith('repo://')) continue
    const relativePath = ref.slice('repo://'.length).split('#', 1)[0]!
    expect(existsSync(resolve(repoRoot, relativePath)), ref).toBe(true)
  }
}

function assertPostParityEvidence(evidence: ClaudeParityEvidenceV1): void {
  const outcomes = new Map(evidence.outcomes.map(outcome => [outcome.id, outcome]))
  for (const [id, expected] of Object.entries(POST_PARITY_EVIDENCE)) {
    const outcome = outcomes.get(id)
    if (!outcome || outcome.currentScore !== 1 || outcome.targetScore !== 1) {
      throw new Error(`Unqualified post-parity outcome: ${id}`)
    }
    for (const ref of expected.sourceRefs) {
      if (!outcome.sourceRefs.includes(ref)) throw new Error(`Missing qualified production evidence: ${ref}`)
    }
    if (!outcome.observables.includes(expected.observable)) {
      throw new Error(`Missing qualified production observable: ${id}`)
    }
  }
}

describe('current Claude parity evidence', () => {
  test('freezes separate core and Desktop targets with non-overlapping scores', () => {
    expect(() => validateClaudeParityEvidence(core)).not.toThrow()
    expect(() => validateClaudeDesktopEvidenceIndex(desktop)).not.toThrow()
    expect(scoreClaudeParityEvidence(core)).toEqual(core.expectedScore)
    expect(core.expectedScore).toEqual({
      core: { weight: 80, currentPoints: 78, targetPoints: 78, currentPercentage: 97.5, targetPercentage: 97.5 },
      desktop: { weight: 20, currentPoints: 20, targetPoints: 20, currentPercentage: 100, targetPercentage: 100 },
      combined: { weight: 100, currentPoints: 98, targetPoints: 98, currentPercentage: 98, targetPercentage: 98 },
    })
    expect(new Set(core.targets.map(target => target.id))).toEqual(new Set([
      'claude-code-cli-sdk', 'claude-code-on-desktop', 'claude-desktop-mcpb',
    ]))
    for (const outcome of core.outcomes) expectRepoEvidenceToExist(outcome.sourceRefs)
    for (const entry of desktop.cases) {
      expectRepoEvidenceToExist(entry.evidenceRefs)
      expectRepoEvidenceToExist(entry.liveSmoke.evidenceRefs)
    }
  })

  test('records a complete exact Pi intake and stays on the available family', () => {
    expect(core.runtimeIntake).toMatchObject({
      installedVersion: '0.87.1',
      candidateVersion: '0.87.1',
      candidateGitHead: 'f07218c4d4bbc12bef056a7058c3dd49dfe41abe',
      candidateLicense: 'MIT',
      candidateNode: '>=22.19.0',
      decision: 'upgrade',
    })
    expect(Object.values(core.runtimeIntake.approvedRegistryAvailability)).toEqual([
      'available', 'available', 'available', 'available', 'available', 'available', 'available', 'available',
    ])
  })

  test('qualifies Tasks 1–5 production observables without score inflation', () => {
    expect(() => assertPostParityEvidence(core)).not.toThrow()
    expect(scoreClaudeParityEvidence(core)).toEqual(core.expectedScore)

    const missing = structuredClone(core) as ClaudeParityEvidenceV1
    const hook = missing.outcomes.find(outcome => outcome.id === 'environment-hook-containment')!
    const refs = hook.sourceRefs as string[]
    refs.splice(refs.indexOf('repo://packages/server-core/src/sessions/SessionManager.plugin-hook-runners.test.ts'), 1)
    expect(() => assertPostParityEvidence(missing)).toThrow(
      'Missing qualified production evidence: repo://packages/server-core/src/sessions/SessionManager.plugin-hook-runners.test.ts',
    )
  })

  test('fails closed on score inflation, denominator overlap and unsafe evidence', () => {
    const inflated = structuredClone(core) as any
    inflated.outcomes[0] = { ...inflated.outcomes[0]!, currentScore: 1.5 as 1 }
    expect(() => validateClaudeParityEvidence(inflated)).toThrow('Invalid score')

    const overlap = structuredClone(core) as any
    overlap.outcomes[0] = { ...overlap.outcomes[0]!, weight: 14 }
    expect(() => validateClaudeParityEvidence(overlap)).toThrow('Invalid core denominator')

    const unsafe = structuredClone(desktop) as ClaudeDesktopEvidenceIndexV1 & { token?: string }
    unsafe.token = 'must-not-enter-evidence'
    expect(() => validateClaudeDesktopEvidenceIndex(unsafe)).toThrow('Forbidden evidence field')
  })

  test('qualifies the frozen evidence and rejects a partial outcome or pending Desktop smoke', () => {
    const partial = structuredClone(core) as ClaudeParityEvidenceV1
    const skill = partial.outcomes.find(outcome => outcome.id === 'skill-invocation') as any
    skill.currentScore = 0.5
    expect(() => validateClaudeParityEvidence(partial)).toThrow(
      'Required Claude parity outcome must score 1: skill-invocation',
    )

    expect(() => assertClaudeParityCloseoutReady(core, desktop)).not.toThrow()

    const pendingDesktop = structuredClone(desktop) as ClaudeDesktopEvidenceIndexV1
    pendingDesktop.cases[0]!.liveSmoke.status = 'pending'
    pendingDesktop.cases[0]!.liveSmoke.evidenceRefs = []
    expect(() => assertClaudeParityCloseoutReady(core, pendingDesktop)).toThrow(
      'Desktop live smoke is pending: desktop-plugin-lifecycle',
    )
  })
})
