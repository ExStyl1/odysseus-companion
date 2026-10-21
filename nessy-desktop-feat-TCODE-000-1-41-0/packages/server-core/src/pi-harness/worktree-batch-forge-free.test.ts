/**
 * C3.107 — the batch opens no merge request, and here that stops being a
 * sentence.
 *
 * Owner answer QH2 = B: worktrees and branches here, a human opens the merge
 * requests, and the last step must not call the built-in `dpGitlab` MCP. Before
 * this file the guarantee was carried by three docblocks, one tool description
 * and a test asserting that a summary string contains *"No merge request was
 * opened"* — none of which a `gh pr create` added tomorrow would disturb.
 *
 * The file under test is the machine half. This suite's job is to make sure the
 * machine half can actually FAIL, which is the failure mode of every guard of
 * this shape: a detector that matches nothing and a slicer that returns nothing
 * both report a beautifully clean scan. So every absence claim below is paired
 * with a positive control — a sample each signature MUST catch, and an anchor
 * each slice MUST contain.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BATCH_FAN_OUT_REGIONS,
  BATCH_REFUSAL_SENTENCE,
  FORGE_WRITE_SIGNATURES,
  findForgeWrites,
  readBatchFanOutRegion,
  sliceDeclaration,
} from './worktree-batch-forge-free.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')

/**
 * One sample per signature: the thing that signature exists to catch.
 *
 * Kept as a map keyed by id, with a completeness arm below, so a signature
 * added without a control cannot slip in — an uncontrolled signature is one
 * that may already be matching nothing.
 */
const CAUGHT_SAMPLES: Record<string, string> = {
  'git-push': 'await runGit(["push", "origin", unit.branch])  // argv spelling',
  'gh-cli': 'await bash(`gh pr create --title "${unit.name}"`)',
  'glab-cli': 'await bash("glab mr create --source-branch " + unit.branch)',
  'dp-gitlab-mcp': "await callTool('dp_gitlab_create-merge-request', { source: unit.branch })",
  'forge-api-route': "await post(`${origin}/api/v4/projects/${id}/merge_requests`)",
  'forge-write-verb': 'await createMergeRequest({ sourceBranch: unit.branch })',
  'network-call': 'await fetch(forgeUrl, { method: "POST" })',
}

describe('C3.107 · the forge-write detector', () => {
  // POSITIVE CONTROL. Without this the whole suite is an assertion that seven
  // regular expressions matched nothing, which they would also do if they were
  // all typed wrong.
  test('every signature catches the write it exists for', () => {
    // Table-driven and compared whole, so a failure names the signature that
    // stopped matching instead of the first one that did.
    const caught = FORGE_WRITE_SIGNATURES.map(signature => [
      signature.id,
      findForgeWrites(CAUGHT_SAMPLES[signature.id] ?? '').some(hit => hit.id === signature.id),
    ])
    expect(caught).toEqual(FORGE_WRITE_SIGNATURES.map(signature => [signature.id, true]))
  })

  test('every signature has a control, and every control names a live signature', () => {
    const ids = FORGE_WRITE_SIGNATURES.map(signature => signature.id).sort()
    expect(Object.keys(CAUGHT_SAMPLES).sort()).toEqual(ids)
  })

  // NEGATIVE CONTROL. The patterns run over files whose prose is ABOUT merge
  // requests and whose code calls `Array.prototype.push` on every other line. A
  // guard that fired on those would be turned off within a week, so the
  // narrowness is part of the contract and is pinned here.
  test('the ordinary vocabulary of this path is not a hit', () => {
    const benign = [
      'lines.push("No merge request was opened — submit these branches yourself:")',
      'started.push({ sessionId: session.id, name: unit.name, branch: unit.branch })',
      '// P6.508 — one request fans out into N agents, and a HUMAN opens the merge requests.',
      'await runGit(["worktree", "add", "-b", unit.branch, path])',
      'await runGit(["checkout", "-B", branch, defaultSha])',
      'const pushed = deferred.length',
    ].join('\n')
    expect(findForgeWrites(benign)).toEqual([])
  })
})

describe('C3.107 · the slicer', () => {
  test('a symbol that is not there returns null rather than an empty clean scan', () => {
    expect(sliceDeclaration('export const somethingElse = 1\n', 'runWorktreeBatch')).toBeNull()
  })

  test('a slice stops before the next tenant at the same indent', () => {
    const source = [
      'export const First = {',
      '  alpha: 1,',
      '}',
      '',
      'export const Second = {',
      '  beta: 2,',
      '}',
    ].join('\n')
    const sliced = sliceDeclaration(source, 'First')
    expect(sliced).toContain('alpha')
    expect(sliced).not.toContain('beta')
  })

  test('a slice keeps a multi-line template literal whose lines start at column 0', () => {
    const source = [
      'const descriptions = {',
      '  Alpha: `First line.',
      '',
      'Second line at column zero.`,',
      '',
      '  Beta: `Other tool.`,',
      '}',
    ].join('\n')
    const sliced = sliceDeclaration(source, 'Alpha')
    expect(sliced).toContain('Second line at column zero.')
    expect(sliced).not.toContain('Other tool.')
  })
})

describe('C3.107 · the fan-out issues no forge write', () => {
  // The completeness arm: a region whose file was renamed away would otherwise
  // make the guard quietly smaller.
  test('every named region exists on disk', () => {
    for (const region of BATCH_FAN_OUT_REGIONS) {
      expect({ file: region.file, exists: existsSync(join(REPO_ROOT, region.file)) })
        .toEqual({ file: region.file, exists: true })
    }
  })

  test('the list covers planner, executor, handler, schema and description', () => {
    expect(BATCH_FAN_OUT_REGIONS.map(region => `${region.file}#${region.symbol ?? 'whole'}`)).toEqual([
      'packages/server-core/src/pi-harness/worktree-batch-plan.ts#whole',
      'packages/server-core/src/sessions/SessionManager.ts#runWorktreeBatch',
      'packages/session-tools-core/src/handlers/worktree.ts#handleWorktreeBatch',
      'packages/session-tools-core/src/tool-defs.ts#WorktreeBatchSchema',
      'packages/session-tools-core/src/tool-defs.ts#WorktreeBatch',
    ])
  })

  // THE PROPERTY. Read against the shipped bytes, region by region, with the
  // anchor proving the slice landed where it was aimed.
  test('no region of the fan-out contains a forge write', () => {
    for (const region of BATCH_FAN_OUT_REGIONS) {
      const source = readBatchFanOutRegion(region)
      // Positive control for the SLICE: wrong slice, no anchor, loud failure.
      expect({ region: region.file, anchored: source.includes(region.anchor) })
        .toEqual({ region: region.file, anchored: true })
      expect({ region: `${region.file}#${region.symbol ?? 'whole'}`, hits: findForgeWrites(source) })
        .toEqual({ region: `${region.file}#${region.symbol ?? 'whole'}`, hits: [] })
    }
  })

  // The disclosure half, the shape H20's `MERGE_REQUEST_WATCH_REFUSAL_LINE` has:
  // a refusal nobody can see is indistinguishable from a defect, and the model
  // is the reader here — it is the thing that would otherwise try to finish the
  // job by opening one itself.
  test('the tool tells the model what it will not do', () => {
    const description = readBatchFanOutRegion(
      BATCH_FAN_OUT_REGIONS.find(region => region.symbol === 'WorktreeBatch')!,
    )
    expect(description).toContain(BATCH_REFUSAL_SENTENCE)
  })

  // The branches are the whole point of stopping here: a batch that ran and
  // named nothing would leave thirty branches nobody knows about.
  test('the planner still NAMES the branches a person has to submit', () => {
    const planner = readFileSync(
      join(REPO_ROOT, 'packages/server-core/src/pi-harness/worktree-batch-plan.ts'),
      'utf8',
    )
    expect(planner).toContain('export function describeBatchSubmission')
    expect(planner).toContain('No merge request was opened')
    expect(planner).toContain('submit these branches yourself')
  })
})
