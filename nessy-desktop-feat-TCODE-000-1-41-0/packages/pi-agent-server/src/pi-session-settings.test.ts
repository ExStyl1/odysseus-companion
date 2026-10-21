import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { VERSION, SettingsManager } from '@earendil-works/pi-coding-agent'
import { cacheWarmingForSession } from './pi-session-settings.ts'
// The warmer helpers are internal to the SDK (the root exports only their
// types), so the negative control reads the module by file path. The provenance
// assertion below pins that this is the hoisted workspace copy — the SDK whose
// VERSION the adapter validates — not a stray cache copy.
import { getPromptCacheTtlMs } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js'

// UB7.16 (B2 S-02) — Pi 0.87.1 warms prompt caches by default; the host now
// pins the mode per session purpose instead of leaving the native default
// unexamined. Main keeps `streaming` (stated); utility sessions read `off`.

describe('cacheWarmingForSession (UB7.16)', () => {
  it('positive: main reads streaming, ephemeral reads off', () => {
    expect(cacheWarmingForSession('main')).toBe('streaming')
    expect(cacheWarmingForSession('ephemeral')).toBe('off')
  })

  it('the pins actually bind against the installed 0.87.1 SDK settings manager', () => {
    // Positive control on the INSTRUMENT: if the SDK ever renames the key or
    // changes the default, these two readings are where the row finds out.
    const main = SettingsManager.inMemory({}, { projectTrusted: false })
    expect(main.getCacheWarmingMode()).toBe('streaming')
    const ephemeral = SettingsManager.inMemory({ cacheWarming: 'off' }, { projectTrusted: false })
    expect(ephemeral.getCacheWarmingMode()).toBe('off')
  })

  it('the warmer helper is read from the same SDK tree the adapter validates', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(pkg.version).toBe(VERSION)
  })

  // The call sites live in `index.ts`, whose module body IS the subprocess entry
  // point (importing it boots a server), so the wiring is read off its SOURCE —
  // the precedent and its reasoning are `__tests__/pi-model-mutation-persistence.test.ts`.
  // The chain is then whole: the site names the helper (here), the helper says
  // `off` (above), the adapter hands it to the settings manager verbatim
  // (`compat/pi-runtime-adapter.test.ts`), and the manager reads it (above).
  describe('the createSession call sites in index.ts', () => {
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    const createSessionCalls = (): string[] => {
      const calls: string[] = []
      for (const match of indexSource.matchAll(/runtimeAdapter\.createSession\(/g)) {
        const open = match.index! + match[0].length - 1
        let depth = 0
        for (let i = open; i < indexSource.length; i++) {
          const ch = indexSource[i]
          if (ch === '(' || ch === '{') depth++
          else if (ch === ')' || ch === '}') depth--
          if (depth === 0) {
            calls.push(indexSource.slice(open, i + 1))
            break
          }
        }
      }
      return calls
    }
    const isUtility = (call: string) => call.includes("strategy: { kind: 'memory' }")

    it('CONTROL — the extractor sees every site: the main session, its cwd reopen, and the one utility session', () => {
      const calls = createSessionCalls()
      expect(calls).toHaveLength(3)
      expect(calls.filter(isUtility)).toHaveLength(1)
      // Each extracted call is a whole argument list, so a key test below reads
      // that call and no neighbour.
      for (const call of calls) expect(call.endsWith('})')).toBe(true)
    })

    it('positive: the utility (call_llm / title / summary) session passes the ephemeral pin', () => {
      const [utility] = createSessionCalls().filter(isUtility)
      expect(utility).toContain("cacheWarming: cacheWarmingForSession('ephemeral')")
    })

    it("negative: no main-chat site turns warming off — they leave the key unnamed, which the SDK reads as 'streaming'", () => {
      const mains = createSessionCalls().filter(call => !isUtility(call))
      expect(mains).toHaveLength(2)
      for (const call of mains) expect(call).not.toContain('cacheWarming')
    })
  })

  it('negative control: a gateway model without a promptCache tier schedules no warm', () => {
    // The SDK's own warm decision reads the model's promptCache tier
    // (dist/core/cache-warmer.js getPromptCacheTtlMs): no tier → no TTL → the
    // warmer has nothing to refresh, whatever the mode says. Gateway
    // catalogue models carry no tier, so warming is a BYO-catalogue cost.
    const gatewayLike = { id: 'gateway-fast', api: 'openai-completions' } as never
    expect(getPromptCacheTtlMs(gatewayLike, undefined)).toBeUndefined()
    // Boundary: a model that DOES declare a tier gets a finite TTL.
    const byo = { id: 'byo-model', api: 'anthropic-messages', promptCache: { short: 300 } } as never
    expect(getPromptCacheTtlMs(byo, undefined)).toBe(300_000)
  })
})
