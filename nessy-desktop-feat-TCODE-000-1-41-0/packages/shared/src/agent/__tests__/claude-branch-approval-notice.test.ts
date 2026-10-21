import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { RecoveryMessage } from '../backend/types.ts'
import { TestAgent, createMockBackendConfig } from './test-utils.ts'

/**
 * C3.300 — the MODEL-facing half of C3.267.
 *
 * A branch is a NEW host session id, and both session-scoped grant stores are
 * keyed by it (`SessionManager` symbols `storeAdminRememberApproval` and
 * `applyOutsideWorkingDirectoryReadAnswer`), so an "allow for this session"
 * grant does not travel into the branch. The user-facing half of that fact is
 * on the branch affordance itself (`chat.branchFromThisMessageDescription`,
 * `953d17405`); this file pins the half the MODEL reads, so a re-prompt for
 * something the transcript above shows was approved is explainable instead of
 * looking like amnesia.
 *
 * TWO preambles are pinned because they are ALTERNATIVES, not layers.
 * `SessionManager` pins every new branch to `branchContextStrategy: 'sdk-fork'`
 * ("New branches always use strict provider-level SDK fork semantics") and
 * leaves `seeded-fresh-session` — the only strategy that produces branch seed
 * messages — to legacy sessions. So the seed builder covers the legacy/degraded
 * path on every runtime, and `ClaudeAgent`'s own `<branch_context>` hint covers
 * the path a claude branch made today actually takes. A guard on one of them
 * alone would go green while the live path said nothing.
 *
 * The claude half is asserted over the module's SOURCE TEXT rather than through
 * a driven turn: the hint is composed inside `chatImpl`, behind a live SDK
 * `query()`, and the assertion is about a sentence in a template literal. A
 * negative control (a sentence that is not there) keeps the reader honest —
 * without it a `toContain` over a 11k-line file proves only that the file is
 * long.
 */

const APPROVALS_CLAUSE = 'Approvals the user granted for the parent session alone did not travel into this branch'

const SEED_MESSAGES: RecoveryMessage[] = [
  { type: 'user', content: 'Run the migration script.' },
  { type: 'assistant', content: 'Approved once; running it now.' },
]

class BranchSeedAgent extends TestAgent {
  buildBranchSeedContextForTest(messages?: RecoveryMessage[]): string | null {
    return this.buildBranchSeedContext(messages)
  }
}

function branchSeed(messages: RecoveryMessage[]): string {
  const agent = new BranchSeedAgent(createMockBackendConfig())
  return agent.buildBranchSeedContextForTest(messages)!
}

describe('C3.300 — the branch seed tells the model which approvals did not travel', () => {
  it('states the loss in the HOST region, above the untrusted transcript fence', () => {
    const text = branchSeed(SEED_MESSAGES)

    expect(text).toContain(APPROVALS_CLAUSE)
    // The sentence is the host speaking. Inside the fence it would be a
    // transcript line a parent message could have forged, which is the whole
    // point of `fenceUntrustedTranscript` (P2.18).
    expect(text.indexOf(APPROVALS_CLAUSE)).toBeLessThan(text.indexOf('<untrusted'))
  })

  it('says the approvals are GONE and never that any are in force', () => {
    const text = branchSeed(SEED_MESSAGES)

    // The boundary this sentence must not cross: it reports a loss, so the
    // model can explain a re-prompt. A line that read as a standing grant
    // would be a permission statement written by a prompt builder.
    expect(text).toContain('may be asked about again')
    expect(text).not.toContain('already approved')
    expect(text).not.toContain('do not ask')
  })

  it('produces nothing at all when the session was not branched', () => {
    const agent = new BranchSeedAgent(createMockBackendConfig())

    expect(agent.buildBranchSeedContextForTest(undefined)).toBeNull()
    expect(agent.buildBranchSeedContextForTest([])).toBeNull()
  })
})

describe("C3.300 — ClaudeAgent's own SDK-fork hint carries the same sentence", () => {
  const source = readFileSync(join(import.meta.dir, '..', 'claude-agent.ts'), 'utf8')

  it('is inside the <branch_context> block the fork path injects', () => {
    const start = source.indexOf('<branch_context>')
    const end = source.indexOf('</branch_context>')

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(source.slice(start, end)).toContain(
      'Approvals the user granted for the parent session alone did not travel into this branch'
    )
  })

  it('negative control: a sentence that was never written is not found', () => {
    expect(source).not.toContain('Approvals the user granted for the parent session alone still apply')
  })
})
