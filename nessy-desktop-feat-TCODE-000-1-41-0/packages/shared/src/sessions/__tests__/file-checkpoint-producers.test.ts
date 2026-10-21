/**
 * The producer inventory has to stay an inventory.
 *
 * `RUNTIME_FILE_CHECKPOINT_PRODUCERS` claims which runtimes checkpoint a file
 * edit. It is only worth anything if it is (a) total over the runtime
 * vocabulary, so a new runtime cannot inherit a silent `true`, and (b) still
 * describing the tree — a `false` that has quietly become true is how the whole
 * defect this record exists for was invisible in the first place.
 *
 * (b) is checked by reading the source, because the record's own text is what
 * would otherwise be checked against itself.
 */
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { AGENT_PROVIDERS, runtimesNotDecidedBy } from '../../agent/backend/runtime-vocabulary.ts'
import type { AgentProvider } from '../../agent/backend/types.ts'
import {
  RUNTIME_FILE_CHECKPOINT_PRODUCERS,
  runtimeProducesFileCheckpoints,
} from '../file-checkpoints.ts'

const REPO_ROOT = resolve(import.meta.dir, '../../../../..')

/**
 * Where each runtime's own tool-dispatch code lives, so "does this runtime take
 * a checkpoint" can be asked of the tree rather than of the record.
 *
 * `anthropic` covers both the gateway `claude-runtime` card and a BYO Anthropic
 * key — one `AgentProvider`, one backend, listed once.
 *
 * These are literal directory pathspecs on purpose: a `git grep` pathspec
 * carrying a wildcard directory segment matches no files here and would silently
 * search nothing.
 */
const RUNTIME_SOURCE_ROOTS: Readonly<Record<AgentProvider, readonly string[]>> = Object.freeze({
  pi: ['packages/pi-agent-server/src'],
  'nestor-cloud-agent': ['packages/shared/src/agent/backend/nestor-cloud'],
  anthropic: [
    'packages/shared/src/agent/backend/claude',
    'packages/shared/src/agent/claude-agent.ts',
  ],
  'codex-runtime': [
    'packages/shared/src/agent/backend/codex',
    'packages/shared/src/agent/codex-agent.ts',
  ],
})

/**
 * Files under `roots` that call `createFileCheckpoint(`.
 *
 * `--text` because a source file in this tree can carry a NUL byte, and a plain
 * grep skips such a file SILENTLY — which would turn a producer into a clean
 * "absent". `--untracked` so a producer added but not yet committed still
 * counts. Test files are dropped: a test calling the producer proves nothing
 * about the runtime.
 */
function filesCallingCreateFileCheckpoint(roots: readonly string[]): string[] {
  const result = spawnSync(
    'git',
    ['grep', '--text', '--untracked', '-l', '-F', 'createFileCheckpoint(', '--', ...roots],
    { cwd: REPO_ROOT, encoding: 'utf-8' },
  )
  // git grep exits 1 for "no matches", which is an answer rather than a failure.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git grep failed (${result.status}): ${result.stderr}`)
  }
  return (result.stdout ?? '')
    .split('\n')
    .filter(line => line.length > 0 && !line.includes('.test.') && !line.includes('__tests__/'))
}

describe('RUNTIME_FILE_CHECKPOINT_PRODUCERS', () => {
  it('decides every runtime in the vocabulary', () => {
    expect(runtimesNotDecidedBy(RUNTIME_FILE_CHECKPOINT_PRODUCERS)).toEqual([])
    expect(Object.keys(RUNTIME_FILE_CHECKPOINT_PRODUCERS).sort())
      .toEqual([...AGENT_PROVIDERS].sort())
  })

  it('matches which runtimes actually call createFileCheckpoint', () => {
    const scanned = Object.entries(RUNTIME_SOURCE_ROOTS).map(([provider, roots]) => ({
      provider: provider as AgentProvider,
      produces: filesCallingCreateFileCheckpoint(roots).length > 0,
    }))
    // The instrument's own positive control: if the scan found nothing anywhere
    // — a broken pathspec, a moved package — every per-runtime assertion below
    // would pass vacuously and report the defect as fixed.
    expect(scanned.filter(row => row.produces).map(row => row.provider).sort())
      .toEqual(['codex-runtime', 'nestor-cloud-agent', 'pi'])

    for (const { provider, produces } of scanned) {
      expect({ provider, declared: RUNTIME_FILE_CHECKPOINT_PRODUCERS[provider] })
        .toEqual({ provider, declared: produces })
    }
  })

  it('answers false for a runtime this build does not know, and for nothing at all', () => {
    // Defaulting an unknown provider OPEN would re-create the defect: a surface
    // would promise a restore for a runtime nobody has written a producer for.
    expect(runtimeProducesFileCheckpoints('some-future-runtime')).toBe(false)
    expect(runtimeProducesFileCheckpoints(undefined)).toBe(false)
    expect(runtimeProducesFileCheckpoints('pi')).toBe(true)
    expect(runtimeProducesFileCheckpoints('anthropic')).toBe(false)
  })
})
