/**
 * C3.160 — the six ambient prompt-caching OFF switches on the claude arm.
 *
 * Owner answer QK4 = A (2026-09-11) fixed the ORDER and not the direction; the
 * direction taken is DECLARE, and the reason is with the constant
 * (`config/claude-provider-routing-env.ts` symbol
 * `CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS`). This suite pins the two halves that
 * would make the decision reversible by accident:
 *
 * - the names are FORWARDED, not stripped — the operator's documented control
 *   still works on claude, which is native-first step 1;
 * - and the host invents nothing when the operator set nothing, so a session
 *   that never asked to debug caching is not quietly running without a cache.
 *
 * The sixth name is the one worth a test of its own: `_MYTHOS` is in the
 * bundle's own env-accessor registry and in no page table, so a list derived
 * from the page alone would be one short — the bundle is the denominator for
 * what the runtime can already do.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { readFileSync } from 'node:fs'
import { buildClaudeSubprocessEnv } from '../options.ts'
import {
  CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS,
  CLAUDE_SDK_STRIPPED_ENV_KEYS,
} from '../../config/claude-provider-routing-env.ts'

// One case below reads the 233 MB native binary, and the FIRST read of a freshly
// installed artefact is I/O — measured in minutes elsewhere in this tree against
// bun's 5 s default. The budget belongs to the FILE, not to the case.
setDefaultTimeout(60_000)

const prior = new Map(CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS.map(name => [name, process.env[name]]))

/**
 * `delete` before assigning, and on the restore path too — Bun 1.3.14 leaves an
 * assigned-but-never-deleted name readable by property and INVISIBLE to
 * `Object.keys` and `{...process.env}` (AGENTS.md §Traps). The child env is built
 * by spreading, so enumerability is the property that decides whether the child
 * sees the value at all.
 */
function setEnv(name: string, value: string | undefined): void {
  delete process.env[name]
  if (value !== undefined) process.env[name] = value
}

beforeEach(() => { for (const name of CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS) setEnv(name, undefined) })
afterEach(() => { for (const name of CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS) setEnv(name, prior.get(name)) })

describe('C3.160 — the operator\'s off switch reaches the claude child', () => {
  it('forwards an ambient switch verbatim, enumerably, and does not strip it', () => {
    // POSITIVE. `1` is the page's own value; it travels by name and this fork
    // never parses it, so the assertion is on the string and not on a boolean.
    setEnv('DISABLE_PROMPT_CACHING', '1')
    const env = buildClaudeSubprocessEnv()
    expect(env.DISABLE_PROMPT_CACHING).toBe('1')
    expect(Object.keys({ ...env })).toContain('DISABLE_PROMPT_CACHING')
  })

  it('invents nothing when the operator set nothing', () => {
    // NEGATIVE, and the one that costs money if it ever flips: writing a value
    // here would turn an absence into a decision and run every claude session
    // without a prompt cache.
    const env = buildClaudeSubprocessEnv()
    for (const name of CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS) expect(env[name]).toBeUndefined()
  })

  it('the per-tier names travel too, and stay independent of each other', () => {
    setEnv('DISABLE_PROMPT_CACHING_OPUS', '1')
    const env = buildClaudeSubprocessEnv()
    expect(env.DISABLE_PROMPT_CACHING_OPUS).toBe('1')
    // A tier switch must not read as the global one: the page gives each its own
    // row, and the binary its own accessor.
    expect(env.DISABLE_PROMPT_CACHING).toBeUndefined()
  })

  it('none of the six is in the strip list — the decision, pinned', () => {
    // The alternative this row declined. If a later edit adds one of these to
    // the strip union, it deletes a working vendor control and this fails.
    for (const name of CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS) {
      expect(CLAUDE_SDK_STRIPPED_ENV_KEYS as readonly string[]).not.toContain(name)
    }
    // Positive control on the same assertion: the strip union is not empty and
    // this is how a name in it looks.
    expect(CLAUDE_SDK_STRIPPED_ENV_KEYS as readonly string[]).toContain('CLAUDE_CODE_USE_BEDROCK')
  })
})

describe('C3.160 — the list is derived from the BUNDLE, not from the page', () => {
  it('all six names are read by the vendored binary, including the undocumented one', () => {
    const binary = 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    let text: string
    try {
      text = readFileSync(binary).toString('latin1')
    } catch {
      // A DECLARED skip, not a silence — the native CLI is per-platform.
      expect(process.platform === 'darwin' && process.arch === 'arm64').toBe(false)
      return
    }
    const count = (needle: string): number => text.split(needle).length - 1
    // The negative control first, so a probe that reads nothing cannot pass.
    expect(count('ZZZ_FAKE_CONTROL_NAME')).toBe(0)
    for (const name of CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS) expect(count(name)).toBeGreaterThan(0)
    // The sixth is the reason this list is not the page's five: it appears in
    // the binary's env-accessor registry beside its documented siblings.
    expect(count('DISABLE_PROMPT_CACHING_MYTHOS:')).toBeGreaterThan(0)
  })
})
