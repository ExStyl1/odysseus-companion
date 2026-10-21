/**
 * Our withhold classifier, pinned against the SDK's own withhold set (P3.134).
 *
 * ## Why a pin and not a copy
 *
 * The shipped SDK carries a fail-CLOSED counterpart to this module: a `Set`
 * (89 names at `0.3.223`, 93 at `0.3.233`, **123** at the vendored `0.3.247`)
 * and a filter that removes every one of them from a cached remote-settings
 * `env` block. The
 * filter body, re-read at `0.3.233` with its minified names elided because they
 * do not survive a bump (P3.309 — this sentence used to give five of them, and
 * all five had moved):
 *
 *   `(e){if(!e?.env)return e;let t=<omitBy>(e.env,(n,r)=><set>.has(r.toUpperCase()));return{...e,env:t}}`
 *
 * where `<omitBy>` is lodash's `pickBy ∘ negate`. So on their side a name in
 * that set NEVER reaches the environment from a cache.
 *
 * **Find it again by CONTENT**, all three counted in the vendored `sdk.mjs`
 * with `nessyNotARealSdkKey` → **0** as the control on the same rig: the
 * filter's own opening `if(!e?.env)return e;` (**1**), the set's opening
 * `new Set(["HTTPS_PROXY","HTTP_PROXY","NO_PROXY"` (**1**, and the marker this
 * file's own reader uses), and the filename constant `"remote-settings.json"`
 * (**1**), which sits three functions away.
 *
 * Ours withholds until the fetch confirms and then applies, which is what
 * `server-managed-settings.md#fetch-and-caching-behavior` specifies — "Once the
 * server confirms the payload … the withheld variables apply for the rest of
 * the session" — and our threat model is not theirs. That difference is fine.
 * What was NOT fine is that the difference was invisible: before this file, 66
 * of their 89 fell through our classifier's `immediate` default with nothing
 * recording whether that was a decision. Two provider toggles sat in exactly
 * that state for a month (P3.84/P3.111), so the failure mode is measured, not
 * hypothetical.
 *
 * This file makes every divergence a DECISION. A name in the SDK's set must be
 * withheld, refused, or listed in {@link DELIBERATE_IMMEDIATE} with a reason.
 * A new name in a future bundle satisfies none of the three and fails here.
 *
 * ## Why membership comes from the bundle and not a page
 *
 * The same reason `claude-provider-routing-env.test.ts` reads the bundle: two
 * of today's provider toggles appear in ZERO of the 191 published pages
 * (P3.84's census), so a doc-derived list is structurally blind. For BEHAVIOUR
 * the documentation is still the contract — the categories and the release
 * condition above are quoted from it, not inferred here.
 *
 * One honest caveat about the instrument: `sdk.mjs`'s own copy of the cached
 * settings reader is stubbed — the path reader beside the
 * `"remote-settings.json"` constant is a bare `(){return}` body, re-verified at
 * `0.3.233` — so this file uses that `Set` as the SDK's declared MEMBERSHIP
 * list, which is all it is used for, and does not claim to have observed the
 * filter run. (The native binary's copy is a real body and DOES run it; see
 * `config/managed-env.ts`'s `CLAUDE_CODE_MOCK_REMOTE_SETTINGS` note.)
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyManagedEnvVar,
  isRefusedManagedEnvVar,
  isWithheldManagedEnvVar,
  type ManagedEnvCategoryV1,
} from '../managed-env.ts'

/**
 * Names the SDK withholds and we deliberately apply at startup, with the reason
 * each. Every entry is asserted BOTH ways below: it must really be in the SDK's
 * set (so a stale entry cannot linger after an SDK bump drops the name) and it
 * must really classify `immediate` (so an entry cannot claim a divergence that
 * no longer exists).
 *
 * Twelve entries as of 2026-09-10, against a 123-name SDK set — ten from
 * 2026-08-28's 89-name reading, plus the two P7.12 added when the `0.3.247`
 * lift grew the set by thirty. Every OTHER one of those thirty is classified
 * into a withheld category in `managed-env.ts`; these two are the only ones
 * argued back out, and they are argued out by an EXISTING entry rather than a
 * new rule.
 */
const DELIBERATE_IMMEDIATE: Readonly<Record<string, string>> = Object.freeze({
  // Seven provider-input COMPANIONS. P3.112 measured every one of them read
  // only inside a provider client that the selector can construct after a
  // toggle has already chosen that provider — and all seven toggles are
  // `routing` here, so an unconfirmed cache can never select one. A cached
  // companion therefore has no reachable reader before the fetch OR after it.
  // (`AWS_REGION` is the deliberate exception on the other side: it is withheld
  // as `routing`, because the Bedrock endpoint HOST is derived from it.)
  ANTHROPIC_VERTEX_PROJECT_ID: 'provider companion: unreachable while every provider toggle is withheld',
  ANTHROPIC_FOUNDRY_RESOURCE: 'provider companion: unreachable while every provider toggle is withheld',
  ANTHROPIC_AWS_WORKSPACE_ID: 'provider companion: unreachable while every provider toggle is withheld',
  ANTHROPIC_GOOGLE_CLOUD_PROJECT: 'provider companion: unreachable while every provider toggle is withheld',
  ANTHROPIC_GOOGLE_CLOUD_LOCATION: 'provider companion: unreachable while every provider toggle is withheld',
  ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID: 'provider companion: unreachable while every provider toggle is withheld',
  CLOUD_ML_REGION: 'provider companion: unreachable while every provider toggle is withheld',

  // Three that change none of the five things our rule is about — not who we
  // trust, not where a request goes, not what identity we present, not which
  // binary runs, not which file a secret or a policy is read from.
  API_FORCE_IDLE_TIMEOUT:
    'a connection idle timeout; worst case is a recycled or longer-lived socket to the same host',
  CLAUDE_CODE_ENVIRONMENT_KIND:
    'a label the client reports about its own environment; nothing reads it as a source of trust',
  CLAUDE_CODE_REMOTE_SESSION_ID:
    'an identifier for a remote session, not a credential and not a location',

  // P7.12 — the generic gcloud spellings of a project id, and they are here for
  // exactly the reason their `ANTHROPIC_*` twins three entries up are: the SAME
  // P3.112 reachability argument, inherited rather than re-measured. Splitting
  // the pair — `ANTHROPIC_GOOGLE_CLOUD_PROJECT` immediate, `GOOGLE_CLOUD_PROJECT`
  // withheld — would make this table disagree with itself about one fact. A
  // project id is a label inside a URL a provider client builds, and no such
  // client is constructed while every provider toggle is withheld; it names no
  // file, no host, no identity and no binary.
  GOOGLE_CLOUD_PROJECT: 'provider companion: unreachable while every provider toggle is withheld',
  GCLOUD_PROJECT: 'provider companion: unreachable while every provider toggle is withheld',
})

/** Walk up from this file to the workspace copy of the vendored SDK bundle. */
function resolveVendoredSdkBundle(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** A `NAME=[ "A", "B", … ]` array literal out of the minified bundle. */
function readArrayLiteral(source: string, marker: string): readonly string[] {
  const at = source.indexOf(marker)
  if (at < 0) return []
  const start = source.indexOf('[', at)
  if (start < 0) return []
  const end = source.indexOf(']', start)
  if (end < 0) return []
  const body = source.slice(start + 1, end)
  return body
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.startsWith('"'))
    .map((token) => token.slice(1, -1))
}

/**
 * The SDK's remote-settings withhold set, with its spreads expanded.
 *
 * It is written as `new Set([ …literals…, ...routing, ...baseUrls,
 * ...credentials, … ])`, and one of those arrays spreads a further one, so the
 * resolver recurses. Each array is read from the bundle rather than restated,
 * so an SDK bump that grows any of them grows this set too.
 *
 * **Located by CONTENT, never by minified name — this instrument was broken by
 * exactly that, and the guard test below is the only reason anyone noticed.**
 * It used to hunt `jNe=new Set([` and expand `...Fk`, `...zk`, `...Bk`. The
 * `0.3.223 → 0.3.233` bump reassigned all four (`zk` and `Bk` now name noop
 * OpenTelemetry classes, `jNe` an AJV data-type helper), the reader returned
 * `[]`, and two of the four assertions below went from proving something to
 * proving nothing about an empty list. The Set is now found by the three
 * literals it opens with, and each spread is resolved by looking up whatever
 * identifier the bundle happens to use.
 */
/** The body of the bracket-matched array literal starting at `start`. */
function bracketMatchedBody(source: string, start: number): string {
  let depth = 0
  let end = start
  for (; end < source.length; end += 1) {
    if (source[end] === '[') depth += 1
    else if (source[end] === ']') {
      depth -= 1
      if (depth === 0) break
    }
  }
  return source.slice(start + 1, end)
}

/** Resolve `...NAME` by finding whatever `NAME=[…]` the bundle declares. */
function resolveSpread(source: string, name: string, depth: number): readonly string[] {
  if (depth > 6) return []
  // Escape the captured name (F1.255): at `0.3.267` one spread is `...$D`, and a
  // bare `$` inside `new RegExp` is an END ANCHOR, so that spread silently
  // resolved to [] and the set read 108 instead of 124 — the trap
  // `claude-auto-compact-window-env.test.ts` records for `$G`, met a second time.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const declaration = new RegExp(`(?<![A-Za-z0-9_$])${escaped}=\\[`).exec(source)
  if (declaration === null) return []
  const start = source.indexOf('[', declaration.index)
  return expandArrayBody(source, bracketMatchedBody(source, start), depth + 1)
}

/** String literals and resolved spreads, in order. */
function expandArrayBody(source: string, body: string, depth: number): readonly string[] {
  const names: string[] = []
  for (const token of body.split(',')) {
    const trimmed = token.trim()
    if (trimmed.startsWith('...')) names.push(...resolveSpread(source, trimmed.slice(3), depth))
    else if (trimmed.startsWith('"')) names.push(trimmed.slice(1, -1))
  }
  return names
}

/**
 * The three literals the Set opens with. They are the proxy trio, which has led
 * this array since it existed, and they are content rather than a name — the
 * whole point of the rewrite above.
 */
const SDK_WITHHOLD_SET_MARKER = 'new Set(["HTTPS_PROXY","HTTP_PROXY","NO_PROXY"'

function readSdkWithholdSet(bundlePath: string): readonly string[] {
  const source = readFileSync(bundlePath, 'latin1')
  const at = source.indexOf(SDK_WITHHOLD_SET_MARKER)
  if (at < 0) return []
  const start = source.indexOf('[', at)
  const names = expandArrayBody(source, bracketMatchedBody(source, start), 0)
  return [...new Set(names.map((name) => name.toUpperCase()))]
}

describe("our classifier against the SDK's own withhold set", () => {
  const bundlePath = resolveVendoredSdkBundle()
  const sdkWithholdSet = bundlePath === null ? [] : readSdkWithholdSet(bundlePath)

  test('the instrument reads a plausible set out of the bundle', () => {
    // Guard the reader itself. An empty or truncated parse would make every
    // assertion below pass vacuously, which is the failure mode that makes a
    // bundle-derived pin worse than no pin at all.
    expect(bundlePath).not.toBeNull()
    // The floor is the last measured size minus a little slack, so a spread that
    // silently resolves to [] fails here rather than downstream. 2026-08-28: 89.
    // 2026-09-03 on `0.3.233`: 93. 2026-09-10 on the vendored `0.3.247`: 123.
    // 2026-09-13 on the vendored `0.3.251` (C3.380): 124 — one name, and it is
    // `GCE_METADATA_ROOT`, now classified `selector` in `managed-env.ts` beside
    // its two sibling spellings. 2026-09-24 on `0.3.267` (F1.255): 124, the same
    // set name for name — and this floor is what caught the unescaped `$D` spread.
    // 2026-10-10 on `0.3.280` (UA12.211, the C7 lift's withheld-set re-read): 127 —
    // three names, `HOMEDRIVE`, `HOMEPATH` and `PROGRAMDATA`, all classified
    // `selector` beside `HOME`; both bundles diffed with this file's own reader
    // (0.3.274 → 124, 0.3.280 → 127, three added, none dropped).
    expect(sdkWithholdSet.length).toBeGreaterThanOrEqual(120)
    // Positive control: names from each of the three expanded spreads and from
    // the surrounding literal, so a spread silently resolving to [] fails here.
    for (const name of [
      'CLAUDE_CODE_USE_GATEWAY', // the provider-routing spread
      'ANTHROPIC_VERTEX_BASE_URL', // the base-URL spread
      'CLAUDE_CODE_MEMORY_API_TOKEN', // a spread nested INSIDE the base-URL one
      'ANTHROPIC_FOUNDRY_API_KEY', // the credential spread
      'HOME', // a literal in the Set itself
    ]) {
      expect({ name, present: sdkWithholdSet.includes(name) }).toEqual({ name, present: true })
    }
  })

  test('every name is withheld, refused, or a listed deliberate difference', () => {
    const undecided = sdkWithholdSet.filter(
      (name) =>
        !isWithheldManagedEnvVar(name)
        && !isRefusedManagedEnvVar(name)
        && !(name in DELIBERATE_IMMEDIATE),
    )
    // A name reaching this list is a decision nobody has made yet — the exact
    // state the two unstripped provider toggles sat in. Classify it, or add it
    // to DELIBERATE_IMMEDIATE with the reason.
    expect(undecided).toEqual([])
  })

  test('each deliberate difference is real, current, and carries a reason', () => {
    for (const [name, reason] of Object.entries(DELIBERATE_IMMEDIATE)) {
      expect({
        name,
        inSdkSet: sdkWithholdSet.includes(name),
        category: classifyManagedEnvVar(name),
        hasReason: reason.trim().length > 20,
      }).toEqual({ name, inSdkSet: true, category: 'immediate', hasReason: true })
    }
  })

  test('the divergence is small and counted, not merely enumerated', () => {
    // Dated, because a prose count beside a list ages silently. 2026-08-28:
    // 89 in the SDK's set, 10 deliberately immediate, 1 refused outright.
    // Re-read 2026-09-03 on the vendored 0.3.233: 93 in the SDK's set, same 10,
    // same 1 — the four new names all classify without a new exception.
    // Re-read 2026-09-10 on the vendored 0.3.247 (P7.12): 123 in the SDK's set,
    // 12 deliberately immediate, same 1 refused. The thirty new names split 7
    // routing / 5 credential / 15 selector / 1 execution / 2 deliberate — and
    // ALL THIRTY classified `immediate` before this commit, i.e. a cached
    // managed `env` block carrying `AWS_SECRET_ACCESS_KEY` or
    // `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES` was applied at startup,
    // unconfirmed. The gap existed at HEAD and was invisible only because our
    // membership list came from the older bundle.
    // Re-read 2026-10-10 on `0.3.280` (UA12.211): 127 in the SDK's set, same 12
    // deliberately immediate, same 1 refused — the three new names all classify
    // `selector` beside `HOME` (its Windows spellings, plus the machine-wide
    // Git-config root), so none needed arguing out. Found by this test after the
    // 0.3.280 lift landed without running it: at HEAD the undecided arm received
    // all three and they fell through `classifyManagedEnvVar`'s `immediate`
    // default — applied at startup from an unconfirmed cache, the exact fail-open
    // shape P7.12 closed.
    const immediate = sdkWithholdSet.filter(
      (name) => !isRefusedManagedEnvVar(name) && classifyManagedEnvVar(name) === 'immediate',
    )
    expect(immediate.sort()).toEqual(Object.keys(DELIBERATE_IMMEDIATE).sort())
    expect(sdkWithholdSet.filter(isRefusedManagedEnvVar))
      .toEqual(['CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION'])
  })

  test('the categories the doc names are the categories we assign', () => {
    // Table-driven spot check across all five, so a name drifting into a
    // neighbouring bucket fails by name rather than only changing a count.
    const expected: ReadonlyArray<readonly [string, ManagedEnvCategoryV1]> = [
      ['NODE_EXTRA_CA_CERTS', 'transport'],
      ['ANTHROPIC_BASE_URL', 'routing'],
      ['CLAUDE_CODE_OAUTH_TOKEN', 'credential'],
      ['NODE_OPTIONS', 'execution'],
      ['CLAUDE_CONFIG_DIR', 'selector'],
      ['HOME', 'selector'],
      // The two WIF halves land on opposite sides on purpose: the token is what
      // identity we present, the *_FILE is where it is read from.
      ['ANTHROPIC_IDENTITY_TOKEN', 'credential'],
      ['ANTHROPIC_IDENTITY_TOKEN_FILE', 'selector'],
    ]
    for (const [name, category] of expected) {
      expect({ name, category: classifyManagedEnvVar(name) }).toEqual({ name, category })
    }
  })
})
