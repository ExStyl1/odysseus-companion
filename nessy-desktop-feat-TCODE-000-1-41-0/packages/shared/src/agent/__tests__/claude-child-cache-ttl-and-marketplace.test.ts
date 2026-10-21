/**
 * P6.378 (the child half) and P6.385 — two documented names the claude child
 * reads and this fork never wrote.
 *
 * They share a suite because they share the one seam every claude spawn passes
 * through, `buildClaudeSubprocessEnv`, and because they make OPPOSITE choices
 * about an operator's ambient value — which is the part worth pinning:
 *
 * - **P6.378** writes the host's resolution and writes NOTHING when the chain
 *   resolves to "the runtime's own default". `prompt-caching.md`'s step 6 is an
 *   absence, and turning an absence into a value is a decision nobody made.
 * - **P6.385** writes unconditionally. The only value that keeps the child's
 *   plugin surface inside the host's policy is the opt-out, so an ambient `0`
 *   must not re-arm the auto-install — the same judgement the neighbouring
 *   `CLAUDE_CODE_DISABLE_CRON` block already makes.
 *
 * Every assignment under test goes through `delete` first (Bun 1.3.14 env-slot
 * trap), and the suite exercises the INTRODUCING direction — a name absent from
 * the launch environment — because that is the arm a reader who tests by
 * overwriting never sees.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildClaudeSubprocessEnv } from '../options.ts'
import { PROMPT_CACHE_TTL_ENV } from '../../interceptor-common.ts'
import { upgradePromptCacheTtl } from '../../unified-network-interceptor.ts'
import { OFFICIAL_MARKETPLACE_AUTOINSTALL_OFF_ENV } from '../pi-harness/managed-marketplace-entries.ts'

const NAMES = [
  'FORCE_PROMPT_CACHING_5M',
  'ENABLE_PROMPT_CACHING_1H',
  PROMPT_CACHE_TTL_ENV.conversation,
  PROMPT_CACHE_TTL_ENV.subagent,
  OFFICIAL_MARKETPLACE_AUTOINSTALL_OFF_ENV,
  'NESSY_USE_BUILTIN_RIPGREP',
  'USE_BUILTIN_RIPGREP',
]

const prior = new Map(NAMES.map(name => [name, process.env[name]]))

function setEnv(name: string, value: string | undefined): void {
  delete process.env[name]
  if (value !== undefined) process.env[name] = value
}

beforeEach(() => { for (const name of NAMES) setEnv(name, undefined) })
afterEach(() => { for (const name of NAMES) setEnv(name, prior.get(name)) })

describe('P6.378 — the two per-bucket TTL controls reach the child', () => {
  it('forwards the host\'s resolution for BOTH buckets', () => {
    setEnv('ENABLE_PROMPT_CACHING_1H', '1')
    const env = buildClaudeSubprocessEnv()
    expect(env[PROMPT_CACHE_TTL_ENV.conversation]).toBe('1h')
    expect(env[PROMPT_CACHE_TTL_ENV.subagent]).toBe('1h')
  })

  it('the buckets stay independent through the child\'s environment too', () => {
    setEnv(PROMPT_CACHE_TTL_ENV.subagent, '5m')
    const env = buildClaudeSubprocessEnv()
    expect(env[PROMPT_CACHE_TTL_ENV.subagent]).toBe('5m')
    // The conversation bucket falls to this fork's own boolean, which is not
    // an hour by default — it must not inherit the subagent's value.
    expect(env[PROMPT_CACHE_TTL_ENV.conversation]).not.toBe('5m')
  })

  it('writes NOTHING for a bucket the chain leaves at the runtime\'s own default', () => {
    // Step 6 of the page's chain is an absence. A host that wrote `5m` here
    // would be making the decision the page reserves for the runtime.
    const env = buildClaudeSubprocessEnv()
    expect(env[PROMPT_CACHE_TTL_ENV.subagent]).toBeUndefined()
  })

  it('clears an ambient value the resolution does not endorse', () => {
    // The ambient name arrives through the `...process.env` spread. Leaving it
    // would let a stale shell export outrank the host's own resolution — the
    // half a `delete`-less implementation gets wrong in exactly one direction.
    setEnv(PROMPT_CACHE_TTL_ENV.subagent, 'not-a-ttl')
    expect(buildClaudeSubprocessEnv()[PROMPT_CACHE_TTL_ENV.subagent]).toBeUndefined()
  })

  it('the forwarded name is ENUMERABLE on the built environment', () => {
    // Bun 1.3.14 pre-creates slots for some names, and a value assigned into
    // one is readable by property while invisible to `Object.keys` and to the
    // spread that builds a grandchild's environment. The child env is built by
    // spreading, so enumerability is the property that actually matters.
    setEnv('ENABLE_PROMPT_CACHING_1H', '1')
    const env = buildClaudeSubprocessEnv()
    expect(Object.keys({ ...env })).toContain(PROMPT_CACHE_TTL_ENV.conversation)
  })
})

/**
 * C3.158 — the claude arm's TWO channels read ONE resolver, so they agree.
 *
 * The row asked whether the host's wire rewrite should stand down on claude now
 * that the child honours the env names itself. The premise that it never meets a
 * claude request is one deployment too strong: on the headless server
 * `bin/nessy-server` preloads `unified-network-interceptor.ts` into the server's
 * OWN process, and a `claude-runtime` session's `anthropic-messages` passthrough
 * hop is forwarded by that process's `fetch` — so both channels can be live at
 * once. What makes that harmless is not distance but SHARED PROVENANCE: both
 * read `resolvePromptCacheTtl`. These two cases pin the agreement in both
 * directions; if either side ever grew its own resolution they would diverge
 * here first.
 */
describe('C3.158 — the child env and the wire rewrite give the same answer', () => {
  /** One ephemeral block, the smallest body either side will touch. */
  const bodyWithCacheControl = (ttl?: string): Record<string, unknown> => ({
    system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ...(ttl ? { ttl } : {}) } }],
  })
  const blockTtl = (body: Record<string, unknown>): unknown =>
    ((body.system as Array<{ cache_control?: Record<string, unknown> }>)[0]!.cache_control ?? {}).ttl

  it('an hour on the child\'s env is an hour on the wire', () => {
    setEnv('ENABLE_PROMPT_CACHING_1H', '1')
    expect(buildClaudeSubprocessEnv()[PROMPT_CACHE_TTL_ENV.conversation]).toBe('1h')
    const body = bodyWithCacheControl()
    expect(upgradePromptCacheTtl(body)).toBe(1)
    expect(blockTtl(body)).toBe('1h')
  })

  it('five minutes on the child\'s env STRIPS the ttl on the wire, never leaves an hour', () => {
    // The negative direction is the one that costs money: a user who chose the
    // cheaper write rate must not have the SDK's own `1h` pass through.
    setEnv('FORCE_PROMPT_CACHING_5M', '1')
    expect(buildClaudeSubprocessEnv()[PROMPT_CACHE_TTL_ENV.conversation]).toBe('5m')
    const body = bodyWithCacheControl('1h')
    expect(upgradePromptCacheTtl(body)).toBe(1)
    expect(blockTtl(body)).toBeUndefined()
  })
})

describe('P6.385 — the official-marketplace auto-install opt-out reaches the child', () => {
  it('is set on a plain build, with no ambient value at all', () => {
    expect(buildClaudeSubprocessEnv()[OFFICIAL_MARKETPLACE_AUTOINSTALL_OFF_ENV]).toBe('1')
  })

  it('outranks an ambient `0`, which would otherwise re-arm the auto-install', () => {
    setEnv(OFFICIAL_MARKETPLACE_AUTOINSTALL_OFF_ENV, '0')
    expect(buildClaudeSubprocessEnv()[OFFICIAL_MARKETPLACE_AUTOINSTALL_OFF_ENV]).toBe('1')
  })

  it('is ENUMERABLE, so it survives the spread into the child process', () => {
    const env = buildClaudeSubprocessEnv()
    expect(Object.keys({ ...env })).toContain(OFFICIAL_MARKETPLACE_AUTOINSTALL_OFF_ENV)
  })

  it('an envOverrides entry cannot switch it back off', () => {
    // Overrides are spread BEFORE this runs, deliberately: a per-session
    // override is for routing (base URL, credentials), not for opting a session
    // back into a marketplace the host's policy cannot see.
    const env = buildClaudeSubprocessEnv({ [OFFICIAL_MARKETPLACE_AUTOINSTALL_OFF_ENV]: '0' })
    expect(env[OFFICIAL_MARKETPLACE_AUTOINSTALL_OFF_ENV]).toBe('1')
  })
})

describe('P6.359 — the search-backend switch reaches the child under our own name', () => {
  it('maps `NESSY_USE_BUILTIN_RIPGREP` onto the vendor\'s name', () => {
    // troubleshooting.md#search-and-discovery-issues names the shell
    // environment as the FIRST of its two routes, and that is the one the host
    // owns. Same shape as P6.178's telemetry mapping two blocks above it.
    setEnv('NESSY_USE_BUILTIN_RIPGREP', '0')
    expect(buildClaudeSubprocessEnv().USE_BUILTIN_RIPGREP).toBe('0')
  })

  it('leaves an operator\'s own ambient value alone when ours is unset', () => {
    // The page's documented route. Overwriting it with our absence would take a
    // working control away — the failure mode this plan keeps finding.
    setEnv('USE_BUILTIN_RIPGREP', '0')
    expect(buildClaudeSubprocessEnv().USE_BUILTIN_RIPGREP).toBe('0')
  })

  it('ours outranks an ambient value when both are set', () => {
    setEnv('USE_BUILTIN_RIPGREP', '1')
    setEnv('NESSY_USE_BUILTIN_RIPGREP', '0')
    expect(buildClaudeSubprocessEnv().USE_BUILTIN_RIPGREP).toBe('0')
  })

  it('passes the value through verbatim — the child owns the parsing', () => {
    // Re-deriving truthiness here would be a second implementation of a rule we
    // do not own, and the two would drift.
    setEnv('NESSY_USE_BUILTIN_RIPGREP', 'no')
    expect(buildClaudeSubprocessEnv().USE_BUILTIN_RIPGREP).toBe('no')
  })

  it('writes nothing at all when neither name is set', () => {
    expect(buildClaudeSubprocessEnv().USE_BUILTIN_RIPGREP).toBeUndefined()
  })
})
