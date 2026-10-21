/**
 * Membership of `CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS`.
 *
 * Two suites already exercise this constant table-driven (`claude-turn-options`
 * for the subprocess strip, `llm-connections-auth-env` for the host-env clear),
 * so both would pass unchanged with a name silently deleted from the list.
 * Nothing pinned WHICH names have to be in it — which is how
 * `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` and `CLAUDE_CODE_USE_GATEWAY` were
 * absent from every strip site in `packages/` and `apps/` for a month. That is
 * what this file pins.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS,
  CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS,
  CLAUDE_LAUNCHER_ENV_KEYS,
  CLAUDE_PROVIDER_ENDPOINT_CREDENTIAL_ENV_KEYS,
  CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS,
  CLAUDE_SDK_STRIPPED_ENV_KEYS,
} from '../claude-provider-routing-env.ts'

const KEYS = new Set<string>(CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS)

/**
 * The seven provider TOGGLES the shipped SDK selects on, spelled out so a
 * deletion fails here by name rather than silently shrinking a table.
 */
const SDK_PROVIDER_TOGGLES = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
] as const

/** Walk up from this file to the workspace copy of the vendored SDK bundle. */
function resolveVendoredSdkBundle(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(
      dir,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'sdk.mjs',
    )
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * The SDK's own routing array, read out of the shipped bundle.
 *
 * Two array literals in `sdk.mjs` open with `CLAUDE_CODE_USE_BEDROCK`: the
 * 14-name routing set and a 3-name AWS-auth-refresh subset. Take the longest
 * match, which is deterministically the former.
 */
function readSdkRoutingArray(bundlePath: string): readonly string[] {
  const source = readFileSync(bundlePath, 'latin1')
  const pattern = /\["CLAUDE_CODE_USE_BEDROCK"(?:,"[A-Z0-9_]+")+\]/g
  let longest = ''
  for (const match of source.matchAll(pattern)) {
    if (match[0].length > longest.length) longest = match[0]
  }
  if (longest === '') return []
  return longest.slice(1, -1).split(',').map((name) => name.slice(1, -1))
}

describe('CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS membership', () => {
  it('strips every provider toggle the SDK selects on, by name', () => {
    // Positive: each of the seven is present. `_ANTHROPIC_GOOGLE_CLOUD` sits in
    // the SAME ternary chain as five we always stripped; `_GATEWAY` is the arm
    // AHEAD of that chain and installs an `unpinned` gateway session, so it is
    // the highest-precedence route of the seven, not the most obscure.
    for (const toggle of SDK_PROVIDER_TOGGLES) {
      expect({ toggle, stripped: KEYS.has(toggle) }).toEqual({ toggle, stripped: true })
    }
  })

  it('puts every toggle in the TOGGLE half, which is the half managed-env derives from', () => {
    // The halves are not interchangeable. `config/managed-env.ts` builds its
    // `routing` classification from the toggle array alone, so a new toggle
    // filed under the endpoint/credential array would still be stripped from
    // the subprocess and would still NOT be withheld from a server-cached
    // managed `env` block — P3.111's exact failure, re-entering through the
    // one seam the derivation leaves open. Nothing else pins the split.
    expect([...CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS]).toEqual([...SDK_PROVIDER_TOGGLES])
    expect(
      CLAUDE_PROVIDER_ENDPOINT_CREDENTIAL_ENV_KEYS.filter(name =>
        name.startsWith('CLAUDE_CODE_USE_'),
      ),
    ).toEqual([])
    // And the exported union is still exactly the two halves, in order.
    expect([...CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS]).toEqual([
      ...CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS,
      ...CLAUDE_PROVIDER_ENDPOINT_CREDENTIAL_ENV_KEYS,
    ])
  })

  it('covers every CLAUDE_CODE_USE_* name in the vendored SDK routing array', () => {
    // The self-updating half: an SDK bump that adds an eighth toggle fails
    // here instead of shipping an ambient route we never measured. Reading the
    // bundle rather than a doc page is deliberate — two of today's seven are in
    // zero of the 191 published pages, so a doc-derived list cannot see them.
    const bundlePath = resolveVendoredSdkBundle()
    expect(bundlePath).not.toBeNull()

    const routingArray = readSdkRoutingArray(bundlePath!)
    // Guard the instrument itself: an empty/short read must fail loudly rather
    // than vacuously pass if a future bundle changes shape.
    expect(routingArray.length).toBeGreaterThanOrEqual(14)

    const sdkToggles = routingArray.filter((name) => name.startsWith('CLAUDE_CODE_USE_'))
    expect(sdkToggles.length).toBeGreaterThanOrEqual(SDK_PROVIDER_TOGGLES.length)
    expect(sdkToggles.filter((toggle) => !KEYS.has(toggle))).toEqual([])
  })

  it('keeps R40 companion exclusion: a name that only routes once a toggle is set stays', () => {
    // Negative/boundary. R40's rule survives this widening intact — the seven
    // provider-input companions in the SDK's own array are unreachable once
    // every toggle is stripped, and stripping them would break user shell
    // tooling inside the subprocess for nothing.
    const companionsDeliberatelyKept = [
      'ANTHROPIC_FOUNDRY_RESOURCE',
      'ANTHROPIC_VERTEX_PROJECT_ID',
      'ANTHROPIC_AWS_WORKSPACE_ID',
      'ANTHROPIC_GOOGLE_CLOUD_PROJECT',
      'ANTHROPIC_GOOGLE_CLOUD_LOCATION',
      'ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID',
      'CLOUD_ML_REGION',
      // Generic AWS_*, the exclusion R40 wrote down explicitly.
      'AWS_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ]
    expect(companionsDeliberatelyKept.filter((name) => KEYS.has(name))).toEqual([])

    // Control on the same rig, so the absence above is not just a typo'd list:
    // the Claude-specific bearer IS stripped. NOT because it authenticates on
    // its own — measured 2026-08-28, the binary reads it only inside the
    // Bedrock and Mantle client constructors, so it is a companion like the
    // eleven above — but because it is one of the four the pages document and
    // R40 therefore shipped. That reason is written out in the constant's
    // header under P3.112; keep the two in step.
    expect(KEYS.has('AWS_BEARER_TOKEN_BEDROCK')).toBe(true)
  })
})

/**
 * P3.113 — the one non-provider name in the strip set.
 *
 * Kept in its own describe because the assertions above read the SDK's
 * 14-name provider array, which does NOT contain this flag: filing it there
 * would have made that guard demand a name the array never had. What pins it
 * instead is the bundle's own base-URL array, which does list it.
 */
describe('CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS membership', () => {
  const FLAG = '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL'

  it('is stripped, is not filed under the provider array, and the union is both halves in order', () => {
    expect([...CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS]).toEqual([FLAG])
    // Negative/boundary: it must NOT leak into the provider half, whose
    // membership is derived from the SDK's own array and from which
    // `config/managed-env.ts` builds its `routing` classification.
    expect(KEYS.has(FLAG)).toBe(false)
    expect([...CLAUDE_SDK_STRIPPED_ENV_KEYS]).toEqual([
      ...CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS,
      ...CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS,
    ])
  })

  it('names a flag the vendored bundle actually carries', () => {
    // An absence claim needs a positive control and a presence claim needs the
    // instrument proved: read the shipped bundle, assert the flag is there and
    // a fabricated sibling is not. This is what re-fires on an SDK bump that
    // retires the flag — at which point the strip becomes dead code rather
    // than silently protective.
    const bundlePath = resolveVendoredSdkBundle()
    expect(bundlePath).not.toBeNull()
    const source = readFileSync(bundlePath!, 'latin1')
    expect(source.includes(FLAG)).toBe(true)
    expect(source.includes('_CLAUDE_CODE_ASSUME_THIRD_PARTY_BASE_URL')).toBe(false)
  })
})

/**
 * P6.587 — `CLAUDE_CODE_SHELL` joins its twin.
 *
 * The list is the ONLY thing that has to change for the scrub and its
 * announcement to cover a name (`agent/options.ts` deletes from the child env
 * and `agent/claude-agent.ts:buildClaudeLauncherDropNotices` announces, both by
 * iterating this array), so membership is what a test can pin. What it must
 * ALSO pin is the boundary: a launcher name that drifts into the silent union
 * is dropped without a word, which is the exact defect P3.300 exists to refuse.
 */
describe('CLAUDE_LAUNCHER_ENV_KEYS membership (P3.300 + P6.587)', () => {
  const LAUNCHER = new Set<string>(CLAUDE_LAUNCHER_ENV_KEYS)

  it('carries every name that picks the process running a claude shell command', () => {
    expect([...CLAUDE_LAUNCHER_ENV_KEYS]).toEqual([
      'CLAUDE_CODE_SHELL',
      'CLAUDE_CODE_SHELL_PREFIX',
      'CLAUDE_CODE_PROCESS_WRAPPER',
    ])
  })

  it('keeps them OUT of the silent union, or the announcement is dead code', () => {
    // Negative/boundary. A name in both lists would be deleted by the silent
    // loop first, so `buildClaudeLauncherDropNotices` would find nothing to say
    // and the drop would be silent again — P3.300's defect, restored quietly.
    for (const key of CLAUDE_LAUNCHER_ENV_KEYS) {
      expect({ key, inSilentUnion: (CLAUDE_SDK_STRIPPED_ENV_KEYS as readonly string[]).includes(key) })
        .toEqual({ key, inSilentUnion: false })
    }
    // And the control the subprocess suite leans on stays scrubbed by NOBODY:
    // with both CLAUDE_CODE_SHELL* names in the list above, a test proving the
    // deletion is by name rather than by prefix needs a neighbour that survives.
    expect(LAUNCHER.has('CLAUDE_CODE_SESSION_NAME')).toBe(false)
    expect(KEYS.has('CLAUDE_CODE_SESSION_NAME')).toBe(false)
  })

  it('names variables the vendored bundle actually reads', () => {
    // Presence needs its instrument proved, same rig as the flag above: the
    // three are in the shipped bundle and a fabricated sibling is not. This
    // fires on an SDK bump that retires one, at which point the scrub is dead
    // code rather than a divergence being closed.
    const bundlePath = resolveVendoredSdkBundle()
    expect(bundlePath).not.toBeNull()
    const source = readFileSync(bundlePath!, 'latin1')
    for (const key of CLAUDE_LAUNCHER_ENV_KEYS) {
      expect({ key, present: source.includes(key) }).toEqual({ key, present: true })
    }
    expect(source.includes('CLAUDE_CODE_SHELL_SUFFIX')).toBe(false)
  })
})
