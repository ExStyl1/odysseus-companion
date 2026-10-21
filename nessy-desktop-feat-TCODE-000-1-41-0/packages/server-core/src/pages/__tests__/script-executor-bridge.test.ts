/**
 * UA9.2 — the Pages script executor runs a granted script through `runApprovedScript` against the page grant
 * itself (ledger kind `page-grant`), never the raw runner.
 *
 * Adapted from craft-agents-oss `v0.13.4:packages/server-core/src/pages/__tests__/script-executor-bridge.test.ts`
 * (Apache-2.0): upstream's arms (the invocation reaches the runner as a script action with no `page`, the page env
 * is injected, the abort signal is forwarded, a blocked run throws, a non-zero exit resolves) are kept, against
 * the REAL runner and ledger where the arm is about approval:
 * - positive: a granted script runs from the ledger grant, with the page env and no refresh marker;
 * - negative: a script edited after the grant is refused with `grant-script-changed` and never spawned;
 *   a grant recorded for other arguments is refused by the runner; managed local-automation deny beats a grant.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { scriptSha256, type ApprovedScriptRequest } from '@nessy-agent/shared/automations'
import { issuePageGrant, PAGE_GRANT_SCRIPT_CHANGED } from '@nessy-agent/shared/pages'
import type { HostApprovalsKeyProvider } from '@nessy-agent/shared/approvals/host-approvals'
import {
  describeManagedLocalAutomationRefusal,
  recordCodexLocalAutomationRequirement,
  resetManagedLocalAutomationForTests,
} from '@nessy-agent/shared/config/managed-local-automation'
import { createPagesScriptExecutor } from '../script-executor-bridge'

const KEY = randomBytes(32)
const keyProvider: HostApprovalsKeyProvider = { getKey: async () => KEY }
const CONTENT_DIGEST = 'e'.repeat(64)
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never

describe('createPagesScriptExecutor (UA9.2)', () => {
  let root: string
  let audits: Array<{ event: string; payload: Record<string, unknown> }>

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-ua92-script-')))
    mkdirSync(join(root, 'pages', 'dash'), { recursive: true })
    audits = []
    resetManagedLocalAutomationForTests()
  })

  afterEach(() => {
    resetManagedLocalAutomationForTests()
    rmSync(root, { recursive: true, force: true })
  })

  function grantScript(rel: string, source: string, args?: string[]): { sha: string } {
    writeFileSync(join(root, rel), source)
    const sha = scriptSha256(readFileSync(join(root, rel)))
    issuePageGrant(root, KEY, 'dash', {
      id: 'grant_s',
      action: { kind: 'script', script: rel, ...(args ? { args } : {}) },
      contentDigest: CONTENT_DIGEST,
      scriptSha256: sha,
    })
    return { sha }
  }

  function executor(runScript?: (request: ApprovedScriptRequest) => Promise<never>) {
    return createPagesScriptExecutor({
      workspaceRootPath: root,
      workspaceId: 'ws',
      log,
      keyProvider,
      audit: (event, payload) => { audits.push({ event, payload }) },
      ...(runScript ? { runScript } : {}),
    })
  }

  const signal = () => new AbortController().signal

  it('positive: a granted script runs from the ledger grant, with the page env and no refresh marker', async () => {
    const rel = 'pages/dash/run.ts'
    const { sha } = grantScript(rel, 'console.log(JSON.stringify({ slug: process.env.NESSY_PAGE_SLUG ?? null, argv: process.argv.slice(2) }))', ['--once'])
    const outcome = await executor()({ pageSlug: 'dash', grantId: 'grant_s', script: rel, args: ['--once'], scriptSha256: sha }, { signal: signal() })
    expect(outcome.exitCode).toBe(0)
    expect(JSON.parse(outcome.stdout)).toEqual({ slug: 'dash', argv: ['--once'] })
    expect(audits.map(entry => entry.event)).toEqual(['automation_script_ran'])
    expect(audits[0]!.payload.trigger).toBe('page-action')
    // An on-demand run never writes the refresh completion marker.
    expect(() => readFileSync(join(root, 'pages', 'dash', 'page.json'), 'utf-8')).toThrow()
  })

  it('a non-zero exit resolves with the output (the page still wants it)', async () => {
    const rel = 'pages/dash/fail.ts'
    const { sha } = grantScript(rel, 'console.error("boom"); process.exit(3)')
    const outcome = await executor()({ pageSlug: 'dash', grantId: 'grant_s', script: rel, scriptSha256: sha }, { signal: signal() })
    expect(outcome.exitCode).toBe(3)
    expect(outcome.stderr).toContain('boom')
  })

  it('negative: a script edited after the grant is refused as grant-script-changed and never spawned', async () => {
    const rel = 'pages/dash/run.ts'
    const { sha } = grantScript(rel, 'console.log("granted")')
    writeFileSync(join(root, rel), 'console.log("swapped in after the grant")')
    let spawned = false
    const run = executor(async () => { spawned = true; throw new Error('unreachable') })
    await expect(run({ pageSlug: 'dash', grantId: 'grant_s', script: rel, scriptSha256: sha }, { signal: signal() }))
      .rejects.toThrow(`${PAGE_GRANT_SCRIPT_CHANGED}:`)
    expect(spawned).toBe(false)
  })

  it('negative: the runner verifies the grant itself — arguments other than the granted ones are refused', async () => {
    const rel = 'pages/dash/run.ts'
    const { sha } = grantScript(rel, 'console.log("ran")', ['--once'])
    await expect(executor()({ pageSlug: 'dash', grantId: 'grant_s', script: rel, args: ['--twice'], scriptSha256: sha }, { signal: signal() }))
      .rejects.toThrow('approval does not match')
    expect(audits.map(entry => entry.event)).toEqual(['automation_script_refused'])
  })

  it('negative: managed local-automation deny beats a grant; off again, the same grant runs', async () => {
    const rel = 'pages/dash/run.ts'
    const { sha } = grantScript(rel, 'console.log("ran")')
    recordCodexLocalAutomationRequirement(true)
    await expect(executor()({ pageSlug: 'dash', grantId: 'grant_s', script: rel, scriptSha256: sha }, { signal: signal() }))
      .rejects.toThrow(describeManagedLocalAutomationRefusal())
    recordCodexLocalAutomationRequirement(undefined)
    const control = await executor()({ pageSlug: 'dash', grantId: 'grant_s', script: rel, scriptSha256: sha }, { signal: signal() })
    expect(control.stdout).toContain('ran')
  })

  it('forwards the broker signal and the page-grant approval to the runner (upstream arm, our approval)', async () => {
    const rel = 'pages/dash/run.ts'
    const { sha } = grantScript(rel, 'console.log("ran")')
    const controller = new AbortController()
    let seen: ApprovedScriptRequest | undefined
    const run = createPagesScriptExecutor({
      workspaceRootPath: root,
      log,
      runScript: async request => {
        seen = request
        return { type: 'script', script: rel, success: true, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }
      },
    })
    await run({ pageSlug: 'dash', grantId: 'grant_s', script: rel, scriptSha256: sha }, { signal: controller.signal })
    expect(seen?.signal).toBe(controller.signal)
    expect(seen?.approval).toEqual({ kind: 'page-grant', subject: 'page:dash#grant_s' })
    expect(seen?.action.page).toBeUndefined()
    expect(seen?.env.NESSY_PAGE_SLUG).toBe('dash')
  })
})
