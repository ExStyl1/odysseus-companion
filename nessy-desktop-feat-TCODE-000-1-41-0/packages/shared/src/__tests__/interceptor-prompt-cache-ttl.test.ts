/**
 * P6.378 — the two prompt-cache TTL buckets, derived from the PAGE.
 *
 * `prompt-caching.md#choose-the-ttl-yourself` defines two independent controls
 * and one precedence order. The page says both controls *"require Claude Code
 * v2.1.242 or later"*, and this header used to say the bundle LAGGED that page
 * at `2.1.233` with the last test standing as a tripwire for the day it caught
 * up. **The bundle caught up: it declares `2.1.247`** (P7.1, 2026-09-10), the
 * tripwire fired, and P7.15 answered it — the last case is INVERTED and now pins
 * that the bundle is at or past the version the page names, so a downgrade
 * becomes visible instead of silently making the forwarding inert. Read that
 * case's own docblock for why nothing had to stand down on the claude arm; the
 * HOST still resolves both controls for all three runtimes, because one answer
 * has to travel by whatever channel each runtime has.
 */
import { describe, expect, it, afterEach, beforeEach, setDefaultTimeout } from 'bun:test'

// P7.15 — one case below reads the 233 MB native binary, and the FIRST read of a
// freshly installed artefact is I/O: measured 15.1 s elsewhere in this tree
// against bun's 5 s default, then 0.15 s warm. The budget belongs to the file.
setDefaultTimeout(60_000)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '../config/paths'
import {
  PROMPT_CACHE_TTL_ENV,
  PROMPT_CACHE_TTL_SETTING,
  _resetConfigCacheForTesting,
  resolvePromptCacheTtl,
} from '../interceptor-common'

const NAMES = [
  'FORCE_PROMPT_CACHING_5M',
  'ENABLE_PROMPT_CACHING_1H',
  PROMPT_CACHE_TTL_ENV.conversation,
  PROMPT_CACHE_TTL_ENV.subagent,
]

/**
 * `delete` before assigning, and `delete` on the restore path too — Bun 1.3.14
 * leaves an assigned-but-never-deleted name invisible to `Object.keys` and to
 * `{...process.env}` (AGENTS.md §Traps). None of these four is a name Bun
 * pre-creates a slot for today, but the rule is unconditional because that list
 * cannot be complete.
 */
function setEnv(name: string, value: string | undefined): void {
  delete process.env[name]
  if (value !== undefined) process.env[name] = value
}

beforeEach(() => { for (const n of NAMES) setEnv(n, undefined) })
afterEach(() => { for (const n of NAMES) setEnv(n, undefined) })

describe('P6.378 — the two buckets are independent', () => {
  it('names the page\'s own environment variable for each bucket', () => {
    expect(PROMPT_CACHE_TTL_ENV.conversation).toBe('CLAUDE_CODE_PROMPT_CACHE_TTL')
    expect(PROMPT_CACHE_TTL_ENV.subagent).toBe('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL')
  })

  it('names the page\'s own settings key for each bucket', () => {
    expect(PROMPT_CACHE_TTL_SETTING.conversation).toBe('promptCacheTtl')
    expect(PROMPT_CACHE_TTL_SETTING.subagent).toBe('subagentPromptCacheTtl')
  })

  it('one bucket set does not move the other', () => {
    setEnv(PROMPT_CACHE_TTL_ENV.subagent, '1h')
    expect(resolvePromptCacheTtl('subagent')).toBe('1h')
    // The conversation bucket falls through to this fork's boolean, which is
    // false by default — it must NOT inherit the subagent's hour.
    expect(resolvePromptCacheTtl('conversation')).not.toBe('1h')
  })

  it('takes both values, and ignores anything the page says it ignores', () => {
    setEnv(PROMPT_CACHE_TTL_ENV.subagent, '5m')
    expect(resolvePromptCacheTtl('subagent')).toBe('5m')
    setEnv(PROMPT_CACHE_TTL_ENV.subagent, '30m')
    expect(resolvePromptCacheTtl('subagent')).toBeUndefined()
    setEnv(PROMPT_CACHE_TTL_ENV.subagent, '1H')
    expect(resolvePromptCacheTtl('subagent')).toBe('1h')
  })
})

describe('P6.378 — the page\'s precedence order, first match wins', () => {
  it('1 — FORCE_PROMPT_CACHING_5M forces five minutes for BOTH buckets', () => {
    setEnv('FORCE_PROMPT_CACHING_5M', '1')
    setEnv(PROMPT_CACHE_TTL_ENV.conversation, '1h')
    setEnv(PROMPT_CACHE_TTL_ENV.subagent, '1h')
    setEnv('ENABLE_PROMPT_CACHING_1H', '1')
    expect(resolvePromptCacheTtl('conversation')).toBe('5m')
    expect(resolvePromptCacheTtl('subagent')).toBe('5m')
  })

  it('2 — the bucket variable outranks ENABLE_PROMPT_CACHING_1H', () => {
    setEnv('ENABLE_PROMPT_CACHING_1H', '1')
    setEnv(PROMPT_CACHE_TTL_ENV.subagent, '5m')
    expect(resolvePromptCacheTtl('subagent')).toBe('5m')
    expect(resolvePromptCacheTtl('conversation')).toBe('1h')
  })

  it('5 — ENABLE_PROMPT_CACHING_1H asks for an hour on both buckets', () => {
    setEnv('ENABLE_PROMPT_CACHING_1H', '1')
    expect(resolvePromptCacheTtl('conversation')).toBe('1h')
    expect(resolvePromptCacheTtl('subagent')).toBe('1h')
  })

  it('6 — with nothing set, the subagent bucket keeps the runtime\'s own default', () => {
    expect(resolvePromptCacheTtl('subagent')).toBeUndefined()
  })
})

describe('P6.378 — the bundle caught up, and P7.15 is the answer the tripwire asked for', () => {
  const vendoredVersion = (): { major: number; minor: number; patch: number } => {
    const pkg = JSON.parse(
      readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'),
    ) as { claudeCodeVersion?: string }
    const [major = NaN, minor = NaN, patch = NaN] = (pkg.claudeCodeVersion ?? '')
      .split('.')
      .map((n) => Number.parseInt(n, 10))
    return { major, minor, patch }
  }

  const atLeast = (a: number, b: number, c: number): boolean => {
    const { major, minor, patch } = vendoredVersion()
    expect(Number.isFinite(patch)).toBe(true)
    return major > a || (major === a && (minor > b || (minor === b && patch >= c)))
  }

  /**
   * The tripwire FIRED, by design, and this is its replacement.
   *
   * It read `expect(atLeast(2, 1, 242)).toBe(false)` and its comment said: when
   * this flips, the claude child honours `CLAUDE_CODE_PROMPT_CACHE_TTL` /
   * `_SUBAGENT_` itself — re-read P6.378 and decide whether the host's own
   * rewrite should stand down rather than become a second implementation of one
   * contract. P7.1 lifted the bundle to `2.1.247` and P7.15 made that decision.
   *
   * **The answer is that there is nothing to stand down on the claude arm**, and
   * it is a measurement, not a preference: `unified-network-interceptor.ts` —
   * where `upgradePromptCacheTtl` lives — is preloaded into the **Pi** subprocess
   * with Bun `--preload`, and the SDK's native binary accepts no such flag
   * (`runtime-resolver.ts`: *"Not used for Claude anymore — the new native SDK
   * binary doesn't accept `--preload`"*). So the rewrite has never reached a
   * claude request. `applyPromptCacheTtl` in `agent/options.ts` is the whole
   * claude path, it was already written to the documented spelling, and it
   * simply started being honoured. Pi keeps the rewrite because Pi has no env
   * control of its own; the host keeps RESOLVING for all three, so one answer
   * travels by whatever channel each runtime has.
   *
   * The assertion is INVERTED rather than deleted: it now pins that the bundle
   * is at or past the version the page names, so a downgrade below it becomes
   * visible instead of silently making the forwarding inert again.
   */
  it('the vendored bundle is at or past the version that honours the two names', () => {
    expect(atLeast(2, 1, 242)).toBe(true)
  })

  it('and the child really carries both names — the reason the forwarding is not inert', () => {
    // Read from the artefact rather than from the page, with this repo's
    // standing control on the same rig. Both scored 0 at the vendored 0.3.233.
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
    expect(count('nessyNotARealSdkKey')).toBe(0)
    expect(count(PROMPT_CACHE_TTL_ENV.conversation)).toBeGreaterThan(0)
    expect(count(PROMPT_CACHE_TTL_ENV.subagent)).toBeGreaterThan(0)
  })
})


describe('P6.378 follow-up — step 3, the bucket\'s own SETTING', () => {
  /**
   * The step the first pass could not reach: `config/validators.ts`'s envelope
   * is strict, so writing `promptCacheTtl` into `config.json` used to throw
   * `UnsupportedStorageLayoutError` and cost the user every OTHER setting in the
   * file. Both keys are declared there now.
   *
   * Written into the ISOLATED config dir, which the preload points at a temp
   * directory under `bun test` — asserted below, because a rig that silently
   * wrote the developer's real `config.json` would pass just as happily.
   */
  const file = join(CONFIG_DIR, 'config.json')

  function writeConfig(values: Record<string, unknown>): void {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(file, JSON.stringify(values))
    _resetConfigCacheForTesting()
  }

  afterEach(() => {
    rmSync(file, { force: true })
    _resetConfigCacheForTesting()
  })

  it('runs against an ISOLATED config dir, not the developer\'s own', () => {
    // The control for every assertion below. `NESSY_CONFIG_DIR` must be exported
    // before bun starts for the isolation to hold (AGENTS.md §Traps), and this
    // is the cheapest place to notice it did not.
    expect(CONFIG_DIR).not.toBe(join(process.env.HOME ?? '/nonexistent', '.nessy-agent'))
  })

  it('reads each bucket\'s own key, independently', () => {
    writeConfig({ promptCacheTtl: '1h', subagentPromptCacheTtl: '5m' })
    expect(resolvePromptCacheTtl('conversation')).toBe('1h')
    expect(resolvePromptCacheTtl('subagent')).toBe('5m')
  })

  it('applies the page\'s value rule to a SETTING exactly as to a variable', () => {
    writeConfig({ subagentPromptCacheTtl: '30m' })
    // "Claude Code ignores any other value" — ignored, so it falls THROUGH to
    // step 5 rather than becoming a default of its own.
    expect(resolvePromptCacheTtl('subagent')).toBeUndefined()
    writeConfig({ subagentPromptCacheTtl: 3600 })
    expect(resolvePromptCacheTtl('subagent')).toBeUndefined()
    writeConfig({ subagentPromptCacheTtl: ' 1H ' })
    expect(resolvePromptCacheTtl('subagent')).toBe('1h')
  })

  it('sits BELOW the bucket variable and ABOVE ENABLE_PROMPT_CACHING_1H', () => {
    writeConfig({ subagentPromptCacheTtl: '5m' })
    setEnv('ENABLE_PROMPT_CACHING_1H', '1')
    expect(resolvePromptCacheTtl('subagent')).toBe('5m')
    setEnv(PROMPT_CACHE_TTL_ENV.subagent, '1h')
    expect(resolvePromptCacheTtl('subagent')).toBe('1h')
  })

  it('outranks this fork\'s legacy extendedPromptCache boolean on the conversation bucket', () => {
    // Step 5b is ours and stays below the page's own step 3, so a user who
    // writes the documented key is not overruled by the older toggle.
    writeConfig({ extendedPromptCache: false, promptCacheTtl: '1h' })
    expect(resolvePromptCacheTtl('conversation')).toBe('1h')
    writeConfig({ extendedPromptCache: false })
    expect(resolvePromptCacheTtl('conversation')).toBe('5m')
  })
})
