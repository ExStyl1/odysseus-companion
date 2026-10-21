/**
 * C3.157 — `ANTHROPIC_DEFAULT_MODEL` on the claude arm: the build is REFUTED by
 * the page and by the binary, and this file is the guard the refutation needs.
 *
 * QK2's answer was A (build): resolve the new-session default through the SDK's
 * own key at bundle `2.1.247` instead of leaving the host tiers as the only
 * reader. Measured at HEAD, that build cannot change any outcome, and the two
 * readings agree:
 *
 * - **The page.** `model-config.md#set-a-default-model-for-new-sessions`,
 *   verbatim: *"Claude Code starts a new session on the variable's model only
 *   when none of these selects a model"* — and the list's first two entries are
 *   *"The `--model` flag"* and *"`ANTHROPIC_MODEL`"*.
 * - **The binary**, read out of the vendored `claude` (`claudeCodeVersion
 *   2.1.247`) rather than inferred from the page: the startup chain is
 *   `t.model||process.env.ANTHROPIC_MODEL||_.ANTHROPIC_DEFAULT_MODEL`, so an
 *   explicit model wins outright. The name scores 13 OCCURRENCES there
 *   (`grep -aoF … | wc -l`; 10 by LINES — the instrument is named because the two
 *   disagree on a minified artefact, C3.294, re-measured 2026-09-12) and sits
 *   in the bundle's own env-name registry beside `ANTHROPIC_MODEL` (22 / 18), against
 *   `ZZZ_FAKE_CONTROL_NAME` 0 as the negative control on the same rig.
 * - **This host names a model on EVERY claude turn** — `claude-agent.ts`
 *   resolves `config.session?.model ?? config.model ?? DEFAULT_MODEL` and passes
 *   it as `Options.model`, so the first branch of that chain is never empty.
 *
 * So honouring the key would mean the host ceasing to name a model **on the
 * claude arm alone**, which is the fourth, runtime-specific tier P6.363
 * (`0a55e2bd2`) measured and refused: the default for a new session is resolved
 * ABOVE `resolveBackendContext` (explicit > trusted project > workspace >
 * connection), so all three runtimes receive one already-resolved answer, and
 * `server-core/src/sessions/__tests__/project-default-composition.test.ts` pins
 * the explicit, project and workspace tiers plus survival across a reload.
 * Writing the host's answer INTO the name instead would be a value the child's
 * own chain never consults — a wire that looks connected and carries nothing,
 * which is the shape this plan keeps refusing.
 *
 * **What is left is an invariant nothing pinned.** The refutation rests entirely
 * on "the host always names a model". If that ever becomes conditional, an
 * operator's ambient `ANTHROPIC_DEFAULT_MODEL` silently starts deciding the
 * session model on one runtime of three, with nothing declaring it — so the
 * negative case below reads the spawn's own source and fails the day it does.
 * The positive case pins the other half of the decision: the vendor control is
 * neither written nor stripped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { buildClaudeSubprocessEnv } from '../options.ts'
import { CLAUDE_SDK_STRIPPED_ENV_KEYS } from '../../config/claude-provider-routing-env.ts'

const NAMES = ['ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_MODEL'] as const
const prior = new Map(NAMES.map(name => [name, process.env[name]]))

/** `delete` before assigning, and on the restore path too (AGENTS.md §Traps). */
function setEnv(name: string, value: string | undefined): void {
  delete process.env[name]
  if (value !== undefined) process.env[name] = value
}

beforeEach(() => { for (const name of NAMES) setEnv(name, undefined) })
afterEach(() => { for (const name of NAMES) setEnv(name, prior.get(name)) })

describe('C3.157 — the vendor key is forwarded, not written and not stripped', () => {
  it('an operator\'s ambient value reaches the child unchanged and enumerably', () => {
    // POSITIVE. The decision has two halves and this is the one a "tidy up the
    // inert variable" edit would break: we do not delete a control the binary
    // reads, we simply never defer to it.
    setEnv('ANTHROPIC_DEFAULT_MODEL', 'claude-sonnet-4-5')
    const env = buildClaudeSubprocessEnv()
    expect(env.ANTHROPIC_DEFAULT_MODEL).toBe('claude-sonnet-4-5')
    expect(Object.keys({ ...env })).toContain('ANTHROPIC_DEFAULT_MODEL')
    expect(CLAUDE_SDK_STRIPPED_ENV_KEYS as readonly string[]).not.toContain('ANTHROPIC_DEFAULT_MODEL')
  })

  it('and the host writes no value of its own into it', () => {
    // The other direction: a host that wrote its resolved model here would be
    // claiming a wire the child's chain never reads.
    expect(buildClaudeSubprocessEnv().ANTHROPIC_DEFAULT_MODEL).toBeUndefined()
  })
})

describe('C3.157 — the invariant the refutation rests on', () => {
  it('the claude spawn names a model on every turn, so the vendor default can never select', () => {
    // NEGATIVE/boundary, and deliberately read off the SOURCE: there is no seam
    // that returns the spawn's options without a live session, and the thing
    // worth guarding is structural — that the model is unconditional. Both
    // halves must hold: a terminal fallback so the value is never empty, and the
    // field actually reaching `Options`.
    const source = readFileSync('packages/shared/src/agent/claude-agent.ts', 'utf8')
    expect(source).toMatch(/const model = config\.session\?\.model \?\? config\.model \?\? DEFAULT_MODEL/)
    expect(source).toMatch(/\n\s+model: effectiveModel,/)
    // Positive control for the probe itself: a fabricated pattern must not match,
    // so a test that silently read the wrong file cannot pass.
    expect(source).not.toMatch(/zzzNotARealClaudeAgentSymbol/)
  })
})
