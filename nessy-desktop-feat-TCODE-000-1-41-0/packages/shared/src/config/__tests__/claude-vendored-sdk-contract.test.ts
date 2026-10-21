/**
 * What the VENDORED Claude artefacts say, pinned so an SDK bump re-opens the
 * reads instead of silently invalidating them.
 *
 * Three rows live here, and they are one artefact because they share one
 * instrument — the shipped `@anthropic-ai/claude-agent-sdk` package tree — and
 * one failure mode: a measurement recorded in prose, correct on the day, and
 * unchecked ever after. `AGENTS.md`'s bundle-lags-page inversion is the whole
 * subject: **the bundle is the denominator for what the runtime can already
 * do, the documentation is the denominator for what we must be able to
 * accept**, and every claim below says which side it came from.
 *
 * ## P3.299 — `sdkCompat.testedWrapperVersions` tops out below the wrapper
 *
 * Read 2026-09-03 from `manifest.json` inside the wrapper package itself:
 * `version: "2.1.233"`, `commit: "f8d57569aaf350fe25dc4dfa10cad59db8ea4d45"`,
 * `buildDate: "2026-08-14T17:37:41Z"`, and
 * `sdkCompat: { testedWrapperVersions: [ "0.3.195" … "0.3.227" ] (28 entries),
 * harnessSchema: 1 }` against a wrapper whose own `package.json` says
 * `0.3.233`.
 *
 * **The pairing is the vendor's intended one and the manifest lags.** Three
 * measurements say so, and the row closes on them:
 *
 * 1. The manifest ships *inside* `@anthropic-ai/claude-agent-sdk@0.3.233` and
 *    names `2.1.233` — the wrapper's own artefact names the binary version it
 *    is paired with, so there is nothing to reconcile.
 * 2. The binary we ship is the one this wrapper pulls, by digest: the
 *    `platforms["darwin-arm64"].checksum` equals the sha256 of the installed
 *    `claude`. Asserted below for whichever platform package is installed.
 * 3. `testedWrapperVersions` cannot be a pairing gate: it omits **its own
 *    shipping version** and every version from `0.3.228` up, because the
 *    manifest is generated at BINARY build time and cannot name wrappers cut
 *    afterwards — and nothing reads it. `testedWrapperVersions`, `sdkCompat`
 *    and `harnessSchema` score 0 in `sdk.mjs`, `bridge.mjs`,
 *    `extractFromBunfs.js` and `browser-sdk.js`, and 0 across `packages/`,
 *    `apps/`, `scripts/`. The string `manifest.json` scores 0 in all four too:
 *    the manifest is a build artefact for the installer, read by no shipped JS.
 *    (An earlier pass of this row recorded it at 1 in `sdk.mjs` as a positive
 *    control. That was `grep -c 'manifest.json'` with an unescaped `.`, which
 *    matched `application/manifest+json` inside a mime table — a bogus control
 *    that would have made the absences look verified. Use `grep -F`, and pick a
 *    control that cannot be produced by the wildcard.)
 *
 * So S0-3's "difference covered" is not undermined by this field. Recorded
 * rather than acted on, which is the row's own criterion.
 *
 * ## P3.178 — the page documents `classifierContext`, the artefact lacks it
 *
 * `hooks.md#annotate-a-result-for-the-auto-mode-classifier` (anchor verified by
 * grepping `id="…"` on the rendered page) states the requirement outright:
 * *"The field requires Claude Code v2.1.236 or later."* We shipped `2.1.233`
 * when this was written, and `2.1.247` since the P7.1 lift — see §P7.14 below.
 * Probed 2026-09-03: `classifierContext` scores **0** in `sdk.d.ts`, **0** in
 * `sdk.mjs` and **0** in the native `claude` binary, against `updatedToolOutput`
 * 2 in `sdk.d.ts` as the positive control.
 *
 * **Which side governs: the page.** This is the accept-direction, where the
 * documentation is the denominator — the field is a real part of the contract
 * we will have to accept, three patch versions ahead of the artefact we ship.
 * The row asked for a re-check on the next SDK refresh; the assertion below IS
 * that re-check, expressed as a conditional on the manifest's own version, so
 * the bump that crosses 2.1.236 fails here rather than passing unnoticed.
 *
 * ### P6.302 — the pin covered two artefacts and the row's own probe was a third
 *
 * Re-measured 2026-09-05 at manifest `2.1.233`, on
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`: `classifierContext`
 * **0**, against `updatedToolOutput` **13** as the positive control on that same
 * file and a nonsense identifier **0** as the negative. So the absence is true
 * of the type surface, the bundle AND the binary — and the binary is the
 * artefact that actually runs the hook, so it is the one the pin most needed.
 * It is asserted below, skipped (as `null`, not as a pass) on a rig where the
 * platform's binary package is not installed.
 *
 * ### P7.14 — the null CLOSED, re-measured at the vendored `2.1.247`
 *
 * The lift crossed the version the page names, and all three artefacts agree in
 * the other direction now: `classifierContext` scores 1 in `sdk.d.ts` (declared
 * on `PostToolUseHookSpecificOutput` with its own gloss), and the gate below
 * takes its `present: true` branch rather than its `present: false` one. The
 * `FOLLOW_UP` string carries what was wired in response and the one part of it
 * a unit test cannot reach.
 *
 * **And a marker that only goes red does not say what to do.** The follow-up is
 * carried inside the compared VALUE, so the runner prints it — and it is now a
 * record of what WAS wired rather than a work order, because the bump that
 * triggered it has happened. The one clause it still asks for is the live one:
 * a marker test can prove the field leaves this fork, never that the
 * classifier inside the binary weighed it.
 *
 * ## P3.302 — the claude side of the subagent-roster absence, FLIPPED by P3.345
 *
 * H8's refreshed reading is that the `sdk-tools.d.ts` probe measures the wrong
 * thing, and both halves are pinned here so the correction cannot be lost:
 * `ListAgents` is absent from the SDK's DECLARED tool surface, and the concept
 * is nevertheless known to the bundle — its single `sdk.mjs` hit is a rename
 * map (`{…, ListPeers: "ListAgents", …}`). Those two are unchanged and still
 * pinned below.
 *
 * The third assertion was the one written to flip, and P3.345 flipped it. It
 * said `claude-runtime-agents.ts` forwards an author's `tools` list verbatim and
 * never unions `subagentRosterToolGrant`, so an author who wrote
 * `tools: [Read, send_agent_message]` on claude could write to a peer it could
 * not enumerate. The builder now unions the grant, under P6.19's three
 * narrowings, so the assertion is inverted rather than deleted — a revert that
 * removes the union fails here, which is the property the pin was for.
 */
import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Walk up to the workspace copy of the vendored SDK package directory. */
function resolveVendoredSdkDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
    if (existsSync(join(candidate, 'sdk.mjs'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const SDK_DIR = resolveVendoredSdkDir()

interface VendoredManifest {
  version: string
  commit: string
  buildDate: string
  platforms: Record<string, { binary: string; checksum: string; size: number }>
  sdkCompat?: { testedWrapperVersions?: string[]; harnessSchema?: number }
}

function readManifest(): VendoredManifest {
  return JSON.parse(readFileSync(join(SDK_DIR!, 'manifest.json'), 'utf8')) as VendoredManifest
}

/** `2.1.233` → `[2, 1, 233]`, for an ordered comparison that does not sort as text. */
function parseVersion(value: string): [number, number, number] {
  const parts = value.split('.').map((part) => Number.parseInt(part, 10))
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

function atLeast(actual: string, required: string): boolean {
  const a = parseVersion(actual)
  const b = parseVersion(required)
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return true
}

/** The host platform's key in the manifest's `platforms` map, or null. */
function currentPlatformKey(): string | null {
  const os = process.platform === 'win32' ? 'win32' : process.platform
  const arch = process.arch
  if (os !== 'darwin' && os !== 'linux' && os !== 'win32') return null
  if (arch !== 'arm64' && arch !== 'x64') return null
  return `${os}-${arch}`
}

/**
 * The shipped NATIVE binary for this platform, as a latin1 string, or `null`
 * when the platform package is not installed on this rig (P6.302). Only the
 * host platform's binary package is installed, so absence is a skip and not a
 * failure — the same treatment the digest assertion above already gives it.
 */
function readVendoredBinary(): string | null {
  const platformKey = currentPlatformKey()
  if (platformKey === null || SDK_DIR === null) return null
  const entry = readManifest().platforms[platformKey]
  if (entry === undefined) return null
  const binaryPath = join(dirname(SDK_DIR), `claude-agent-sdk-${platformKey}`, entry.binary)
  if (!existsSync(binaryPath)) return null
  return readFileSync(binaryPath, 'latin1')
}

describe('vendored Claude SDK manifest (P3.299)', () => {
  it('names the wrapper it ships inside, and carries the compat block the row read', () => {
    expect(SDK_DIR).not.toBeNull()
    const manifest = readManifest()
    const wrapperVersion = (
      JSON.parse(readFileSync(join(SDK_DIR!, 'package.json'), 'utf8')) as { version: string }
    ).version

    // Instrument guard first: an empty or reshaped manifest must fail loudly
    // rather than let the assertions below pass vacuously.
    expect(manifest.version).toMatch(/^2\.\d+\.\d+$/)
    expect(wrapperVersion).toMatch(/^0\.\d+\.\d+$/)
    expect(Object.keys(manifest.platforms).length).toBeGreaterThanOrEqual(8)

    // The field the row is about still exists and is still a sorted list — if a
    // future SDK drops or reshapes it, the recorded reading above stops being
    // about anything and someone must re-read it.
    const tested = manifest.sdkCompat?.testedWrapperVersions
    expect(Array.isArray(tested)).toBe(true)
    expect(tested!.length).toBeGreaterThan(0)
    expect([...tested!]).toEqual([...tested!].sort())
  })

  it('ships the binary its own manifest names, verified by digest', () => {
    // This is the assertion that would actually catch the mismatch the row
    // feared: a wrapper paired with a platform binary it does not describe.
    // Digest, not version string — a version string can be right while the
    // artefact is stale.
    expect(SDK_DIR).not.toBeNull()
    const manifest = readManifest()
    const platformKey = currentPlatformKey()
    expect(platformKey).not.toBeNull()

    const entry = manifest.platforms[platformKey!]
    expect(entry).toBeDefined()

    const binaryPath = join(
      dirname(SDK_DIR!),
      `claude-agent-sdk-${platformKey}`,
      entry!.binary,
    )
    if (!existsSync(binaryPath)) {
      // Only the host platform's binary package is installed, and on a rig
      // without it there is nothing to compare — recorded as a skip rather than
      // a vacuous pass.
      expect(existsSync(binaryPath)).toBe(false)
      return
    }

    const digest = createHash('sha256').update(readFileSync(binaryPath)).digest('hex')
    expect({ platformKey, digest }).toEqual({ platformKey, digest: entry!.checksum })
  })

  it('is informational: nothing in the bundle or this repo reads the compat block', () => {
    // What makes "the manifest lags" a safe conclusion rather than a hopeful
    // one. The positive control is a name measured present in this exact file
    // — deliberately NOT `manifest.json`, which is absent from every shipped JS
    // file and only appeared to be present under a `grep` whose unescaped `.`
    // matched `application/manifest+json` in a mime table.
    expect(SDK_DIR).not.toBeNull()
    const sdkSource = readFileSync(join(SDK_DIR!, 'sdk.mjs'), 'latin1')
    expect(sdkSource.includes('_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL')).toBe(true)
    for (const name of ['testedWrapperVersions', 'sdkCompat', 'harnessSchema', 'manifest.json']) {
      expect({ name, hits: sdkSource.includes(name) }).toEqual({ name, hits: false })
    }
  })
})

describe('classifierContext, the page ahead of the artefact (P3.178, P6.302)', () => {
  const REQUIRED_VERSION = '2.1.236'

  /**
   * P6.302: a marker test that only goes red says *something changed*. It has to
   * say WHAT TO DO, because the person who meets the failure is whoever bumped
   * the SDK and has no reason to know this row exists. Carried inside the
   * compared VALUE rather than in a comment, so the runner prints it.
   */
  const FOLLOW_UP =
    'P7.14 DONE (the lift to 0.3.247 brought the field): `classifierContext` is ' +
    "declared beside `updatedToolOutput` in `SdkAutomationCallbackResult['hookSpecificOutput']` " +
    'and on `PreToolUseDecision` (packages/shared/src/automations/types.ts), parsed ' +
    'nested-only from a hook result (automations/hook-command.ts), kept on PostToolUse ' +
    'alone by the contract table and JOINED across hooks (automations/hook-decision-contract.ts), ' +
    'and forwarded to the SDK with a host frame (plugins/hooks-automation.ts) because every ' +
    'configured hook here returns through an in-process callback, the tier whose note the ' +
    'classifier may weigh as user intent. This branch is now the assertion that it stayed ' +
    'wired. REMAINING, and it is a live case rather than a test: ONE auto-mode run whose ' +
    'classifier (packages/shared/src/agent/claude-auto-mode-policy.ts) is shown to see the ' +
    'annotation — no unit test can reach that, since the classifier runs inside the binary.'

  it('is absent from types, bundle AND binary while we ship below the version the page names, and required once we cross it', () => {
    expect(SDK_DIR).not.toBeNull()
    const types = readFileSync(join(SDK_DIR!, 'sdk.d.ts'), 'utf8')
    const bundle = readFileSync(join(SDK_DIR!, 'sdk.mjs'), 'latin1')
    const shippedVersion = readManifest().version

    // Positive control for the absence, on the same file: a sibling hook-output
    // field that IS declared.
    expect(types.includes('updatedToolOutput')).toBe(true)

    // THE THIRD ARTEFACT (P6.302). The pin covered `sdk.d.ts` and `sdk.mjs`
    // only, while the row's own probe was against the native binary — the one
    // artefact that actually runs the hook. Probed here so the absence cannot be
    // true of the wrapper and false of the binary without this going red.
    // Controls on that same file, measured 2026-09-05 at 2.1.233:
    // `updatedToolOutput` 13, `classifierContext` 0.
    const binary = readVendoredBinary()
    let binaryPresent: boolean | null = null
    if (binary !== null) {
      expect(binary.includes('updatedToolOutput')).toBe(true)
      binaryPresent = binary.includes('classifierContext')
    }

    const present =
      types.includes('classifierContext') || bundle.includes('classifierContext') || binaryPresent === true
    if (atLeast(shippedVersion, REQUIRED_VERSION)) {
      // The bump crossed the version `hooks.md` names — "The field requires
      // Claude Code v2.1.236 or later." — so the field must have arrived. If it
      // has, this row is no longer a null and the adapter surface is buildable.
      expect({ shippedVersion, present, binaryPresent, FOLLOW_UP }).toEqual({
        shippedVersion,
        present: true,
        binaryPresent,
        FOLLOW_UP,
      })
    } else {
      expect({ shippedVersion, present, binaryPresent, FOLLOW_UP }).toEqual({
        shippedVersion,
        present: false,
        binaryPresent: binaryPresent === null ? null : false,
        FOLLOW_UP,
      })
    }
  })
})

describe('permissions.blockReadsOutsideWorkingDirectories — the vendor half (C3.5)', () => {
  /** `settings-reference.md#permissions-blockreadsoutsideworkingdirectories`: "Requires Claude Code v2.1.257 or later." */
  const REQUIRED_VERSION = '2.1.257'

  /**
   * The decision, carried inside the compared VALUE so the runner prints it. The
   * person who meets this failure is whoever bumped the SDK and has no reason to
   * know the row exists — the same reasoning P6.302 wrote for `classifierContext`.
   */
  const FOLLOW_UP =
    'C3.5 DECISION, taken 2026-09-11 while the key was still absent, so it is applied rather than ' +
    'improvised on the lift. (1) WHICH REFUSAL WINS: the host fence wins, and by the runtime own ' +
    'ordering — `agent-sdk/permissions.md#how-permissions-are-evaluated` runs hooks at step 1 ' +
    '("Run hooks first. A hook can deny the call outright or pass it on.") and settings-file deny ' +
    'rules at step 2, and the fence reaches claude through the one PreToolUse hook in ' +
    'claude-agent.ts. So a user with both switches on meets ONE refusal, ours, naming the setting ' +
    'they turned on in this app. (2) THE VENDOR KEY IS DELIBERATELY NOT PASSED: it could only fire ' +
    'on calls the hook already refused, except for the page own Bash-`cat` clause, which would ' +
    'close A28 residue on claude ALONE while Pi keeps the tool-name fence and codex has no subject ' +
    '(P6.928) — a one-runtime divergence in what one user-owned setting means, i.e. a switch verdict ' +
    'for the owner and a flip candidate, not a quiet adoption. `composeClaudeSpawnSettings` also ' +
    'merges by top-level key, so a `permissions` contributor would silently drop any other one. ' +
    'The reason lives beside the fence: `packages/shared/src/agent/mode-manager.ts` symbol ' +
    '`getReadsOutsideWorkingDirectoriesViolation`. (3) A user own .claude/settings.json key is ' +
    'still honoured on the lift — we pass settingSources user/project/local; what is declined is ' +
    'MIRRORING our setting into theirs.'

  it('is absent from types, bundle AND binary while we ship below the version the page names', () => {
    expect(SDK_DIR).not.toBeNull()
    const types = readFileSync(join(SDK_DIR!, 'sdk.d.ts'), 'utf8')
    const bundle = readFileSync(join(SDK_DIR!, 'sdk.mjs'), 'latin1')
    const shippedVersion = readManifest().version

    // POSITIVE CONTROL on each artefact read, so a zero below is an absence and
    // not a failed read: a sibling permission option that IS declared.
    expect(types.includes('permissionMode')).toBe(true)
    expect(bundle.includes('permissionMode')).toBe(true)
    // NEGATIVE CONTROL on the same read.
    expect(types.includes('blockReadsOutsideWorkingDirectoriesNotARealKey')).toBe(false)

    const binary = readVendoredBinary()
    let binaryPresent: boolean | null = null
    if (binary !== null) {
      expect(binary.includes('permissionMode')).toBe(true)
      binaryPresent = binary.includes('blockReadsOutsideWorkingDirectories')
    }

    const present =
      types.includes('blockReadsOutsideWorkingDirectories')
      || bundle.includes('blockReadsOutsideWorkingDirectories')
      || binaryPresent === true

    if (atLeast(shippedVersion, REQUIRED_VERSION)) {
      // THE LIFT HAPPENED. The vendor now has its own executor for this setting
      // and the decision above comes due — apply it, do not re-derive it.
      expect({ shippedVersion, present, binaryPresent, FOLLOW_UP }).toEqual({
        shippedVersion,
        present: true,
        binaryPresent,
        FOLLOW_UP,
      })
    } else {
      // Measured 2026-09-11 at 2.1.247: 0 / 0 / 0.
      expect({ shippedVersion, present, binaryPresent, FOLLOW_UP }).toEqual({
        shippedVersion,
        present: false,
        binaryPresent: binaryPresent === null ? null : false,
        FOLLOW_UP,
      })
    }
  })

  it('the precedence rule has a subject: the fence still reaches claude through a PreToolUse hook', () => {
    // The half a version probe cannot see. The decision above rests on the fence
    // being a STEP-1 hook rather than a step-6 `canUseTool` answer; a refactor
    // that moves it would invert which refusal wins, silently, and this is the
    // only place that pairing is asserted.
    const shared = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
    const agent = readFileSync(join(shared, 'agent', 'claude-agent.ts'), 'utf8')
    const modeManager = readFileSync(join(shared, 'agent', 'mode-manager.ts'), 'utf8')

    // The call site, and that it is inside the PreToolUse branch: both halves,
    // because either alone can be true while the pairing is false.
    expect(agent.includes('runPreToolUseChecks({')).toBe(true)
    expect(agent.includes("_hookInput.hook_event_name !== 'PreToolUse'")).toBe(true)
    // The fence itself, reached from that pipeline.
    expect(modeManager.includes('getReadsOutsideWorkingDirectoriesViolation')).toBe(true)
    // Control on the same reads: a name in neither file must not satisfy them.
    expect(agent.includes('runPreToolUseChecksNotARealSymbol')).toBe(false)
  })
})

describe('subagent roster on claude (P3.302)', () => {
  it('is absent from the declared tool surface, while the CONCEPT is known to the bundle', () => {
    expect(SDK_DIR).not.toBeNull()
    const tools = readFileSync(join(SDK_DIR!, 'sdk-tools.d.ts'), 'utf8')
    const bundle = readFileSync(join(SDK_DIR!, 'sdk.mjs'), 'latin1')

    // Two positive controls and one nonsense control, because an identifier
    // probe is systematically biased toward false absence.
    expect(tools.includes('SendMessage')).toBe(true)
    expect(tools.includes('PushNotificationInput')).toBe(true)
    expect(tools.includes('ListPeersNotARealTool')).toBe(false)

    expect(tools.includes('ListAgents')).toBe(false)
    // …and the correction H8 recorded: the bundle DOES know the name, as a
    // rename-map value. An "absent from the bundle" claim would be false.
    expect(bundle.includes('ListPeers:"ListAgents"')).toBe(true)
  })

  it('is decided by OUR builder: claude now unions the roster grant (P3.345)', () => {
    // The half that can actually change, and the one this pin was written to
    // catch. `subagentRosterToolGrant` had a single Pi-side consumer; the claude
    // definition builder now calls it too.
    const shared = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
    const claudeAgents = readFileSync(join(shared, 'agent', 'claude-runtime-agents.ts'), 'utf8')
    const piDefinition = readFileSync(
      join(shared, 'agent', 'pi-harness', 'runtime-agent-definition.ts'),
      'utf8',
    )

    // Positive control on the same pair of reads: the grant really does exist
    // on the Pi side, so the claim below is about a shared symbol and not a typo.
    expect(piDefinition.includes('subagentRosterToolGrant')).toBe(true)
    expect(claudeAgents.includes('subagentRosterToolGrant')).toBe(true)
    // Negative control on the same read, so "the file contains the word" cannot
    // pass by accident: a name that is not in either module.
    expect(claudeAgents.includes('subagentRosterToolGrantNotARealSymbol')).toBe(false)
  })
})
