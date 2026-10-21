import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendHostRuntimeContext } from '@nessy-agent/shared/agent/backend'
// P2.521 · the gateway URL and the window table read from the modules that OWN
// them, never re-declared here: a fixture carrying its own copy of either would
// keep passing after the real value moved, which is the whole failure mode the
// whole-URL rule and the shared table exist to prevent. The barrel re-exports
// only `isNessyGatewayBaseUrl`, so the constant comes through the wildcard
// subpath that `pi-context-window-drift.test.ts` reaches by relative path.
import { NESSY_GATEWAY_CHAT_BASE_URL } from '@nessy-agent/shared/agent/backend/internal/drivers/upstream-target'
import { nestorGatewayModelWindow } from '@nessy-agent/shared/auth/nestor'
import { gatewayModelFixture } from '@nessy-agent/shared/config/__tests__/fixtures/gateway-connection-fixture.ts'
import type { LlmConnection } from '@nessy-agent/shared/config'
import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import { initializeCredentialManagerV2 } from '@nessy-agent/shared/credentials'
import {
  canHostSession,
  classifyRuntimeSwitch,
  gatewayDpCredentialsPresent,
  planHistoryCarry,
  renormalizeForRuntime,
  supportsNativeHistoryCarry,
  HISTORY_CARRY_TOKEN_MARGIN,
  SESSION_RESTING_CONTEXT_TOKENS,
  type HistoryCarryRow,
} from './runtime-switch.ts'
import { makeTestJwt } from '@nessy-agent/shared/auth/dp/__tests__/test-jwt.ts'

// `canHostSession`'s credential arm fails OPEN when the process credential
// singleton is unbound — an unbound store means "not asked", never "refused".
// That is right for production boot order and fatal for THIS suite: the two
// credential rows below would pass vacuously, reporting `{ok:true}` for a
// connection whose credential was never stored. So bind it here, the way
// `session-mirror-resolve.test.ts` does; if another suite in this process
// bound it first, a manager exists either way.
try {
  initializeCredentialManagerV2({ storageLayoutVersion: 2, verificationId: 'test-can-host-session' })
} catch {
  // Already bound — fine.
}

describe('classifyRuntimeSwitch', () => {
  it('is a model change when the slug is unchanged', () => {
    expect(classifyRuntimeSwitch({ slug: 'a', provider: 'pi' }, { slug: 'a', provider: 'pi' })).toBe('model')
  })

  it('is same-runtime when two connections share a provider', () => {
    // Claude Pro/Max (anthropic) → Claude Code via Nessy Gateway (claude-runtime):
    // two providerTypes, ONE AgentProvider, one durable transcript location.
    expect(classifyRuntimeSwitch({ slug: 'claude-max', provider: 'anthropic' }, { slug: 'claude-gateway', provider: 'anthropic' }))
      .toBe('connection-same-runtime')
  })

  it('is cross-runtime when the provider differs', () => {
    expect(classifyRuntimeSwitch({ slug: 'nessy-gateway', provider: 'pi' }, { slug: 'codex-gateway', provider: 'codex-runtime' }))
      .toBe('connection-cross-runtime')
  })

  it('treats a session with no connection as cross-runtime onto a different provider', () => {
    expect(classifyRuntimeSwitch({ provider: 'pi' }, { slug: 'claude-gateway', provider: 'anthropic' }))
      .toBe('connection-cross-runtime')
  })
})

/**
 * T4. The verdicts are pinned against a FAKE packaged host root, because
 * `isPackaged: true` is the deterministic resolver mode: it reads only fixed
 * candidate paths under the given root — no dev walk-up to the monorepo, no
 * PATH lookups — so what the test creates there is everything the resolver
 * can find, on any machine. The real codex binary is gitignored and the
 * credential store is per-process isolated, which is why the seam-position
 * suite (`__tests__/runtime-switch-session.test.ts`) stubs this check and the
 * decision logic is owned here.
 */
describe('canHostSession', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'can-host-session-'))
  const hostRuntime: BackendHostRuntimeContext = {
    appRootPath: hostRoot,
    resourcesPath: join(hostRoot, 'resources'),
    isPackaged: true,
  }
  // Mirrors `resolveCodexBinaryPath`'s packaged candidate exactly.
  const codexArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch
  const codexBinaryDir = join(hostRoot, 'resources', 'bin', 'codex', `${process.platform}-${codexArch}`)
  const codexBinaryName = process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server'

  const codexConnection = (slug: string): LlmConnection => ({
    slug,
    name: slug,
    providerType: 'codex-runtime',
    authType: 'api_key',
    createdAt: Date.now(),
  } as unknown as LlmConnection)

  // The two flags are read from `process.env` at CALL time in test runs (the
  // esbuild `--define` bake-in only applies to packaged main bundles), so the
  // cases pin them and `afterAll` restores whatever the environment had.
  const savedEnv: Record<string, string | undefined> = {
    NESSY_FEATURE_CODEX_RUNTIME: process.env.NESSY_FEATURE_CODEX_RUNTIME,
    NESSY_FEATURE_CLAUDE_RUNTIME: process.env.NESSY_FEATURE_CLAUDE_RUNTIME,
  }

  beforeAll(() => {
    process.env.NESSY_FEATURE_CODEX_RUNTIME = '1'
  })

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const { getCredentialManager } = await import('@nessy-agent/shared/credentials')
    await getCredentialManager().deleteLlmApiKey('can-host-codex-healthy')
    rmSync(hostRoot, { recursive: true, force: true })
  })

  it('refuses a runtime the build does not carry', async () => {
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0'
    try {
      const claudeGateway = {
        slug: 'can-host-claude-gw',
        name: 'Claude Code (Nessy Gateway)',
        providerType: 'claude-runtime',
        authType: 'api_key_with_endpoint',
        createdAt: Date.now(),
      } as unknown as LlmConnection
      // The host root is EMPTY, so a check that skipped the flag arm would
      // report the binary instead — the distinct code pins the arm order.
      expect(await canHostSession(claudeGateway, hostRuntime))
        .toEqual({ ok: false, code: 'runtime-disabled' })
    } finally {
      if (savedEnv.NESSY_FEATURE_CLAUDE_RUNTIME === undefined) delete process.env.NESSY_FEATURE_CLAUDE_RUNTIME
      else process.env.NESSY_FEATURE_CLAUDE_RUNTIME = savedEnv.NESSY_FEATURE_CLAUDE_RUNTIME
    }
  })

  it('refuses a runtime whose binary is not on disk', async () => {
    // Flag ON, nothing under the packaged root yet.
    expect(await canHostSession(codexConnection('can-host-codex-nobin'), hostRuntime))
      .toEqual({ ok: false, code: 'runtime-binary-missing' })
  })

  it('refuses a connection with no stored credential', async () => {
    mkdirSync(codexBinaryDir, { recursive: true })
    writeFileSync(join(codexBinaryDir, codexBinaryName), '')
    expect(await canHostSession(codexConnection('can-host-codex-nocreds'), hostRuntime))
      .toEqual({ ok: false, code: 'credentials-missing' })
  })

  // The negative control: flag on, binary on disk, credential stored — a
  // helper that refused everything would pass the three rows above.
  it('accepts a target whose flag, binary and credential all check out', async () => {
    mkdirSync(codexBinaryDir, { recursive: true })
    writeFileSync(join(codexBinaryDir, codexBinaryName), '')
    const { getCredentialManager } = await import('@nessy-agent/shared/credentials')
    await getCredentialManager().setLlmApiKey('can-host-codex-healthy', 'gateway-jwt')
    expect(await canHostSession(codexConnection('can-host-codex-healthy'), hostRuntime))
      .toEqual({ ok: true })
  })
})

describe('renormalizeForRuntime', () => {
  const codexCaps = {
    reasoning: { levels: ['off', 'low', 'medium', 'high'] },
    permissions: { modes: ['default', 'plan', 'acceptEdits', 'bypassPermissions'] },
  } as unknown as ComposerCapabilities

  it('clamps a thinking level the target runtime does not offer', () => {
    expect(renormalizeForRuntime({
      thinkingLevel: 'max', capabilities: codexCaps, disabledPermissionModes: [],
    }).thinkingLevel).toBe('high')
  })

  it('leaves an offered level alone', () => {
    expect(renormalizeForRuntime({
      thinkingLevel: 'low', capabilities: codexCaps, disabledPermissionModes: [],
    }).thinkingLevel).toBe('low')
  })

  it('leaves an undefined level undefined rather than inventing one', () => {
    expect(renormalizeForRuntime({ capabilities: codexCaps, disabledPermissionModes: [] }).thinkingLevel)
      .toBeUndefined()
  })

  // A2. The graded chain is the authority, not a bespoke `'default'` fallback.
  // `bypassPermissions` disabled walks fallbacks ['auto','acceptEdits',...];
  // `auto` is not in the Codex capability list, so it lands on `acceptEdits` —
  // the NEAREST still-reachable mode, and strictly narrower than what it left.
  it('clamps a disabled permission mode down the graded chain, not to a fixed default', () => {
    expect(renormalizeForRuntime({
      permissionMode: 'bypassPermissions', capabilities: codexCaps, disabledPermissionModes: ['bypassPermissions'],
    }).permissionMode).toBe('acceptEdits')
  })

  // A2's actual defect. `explore` is a NO-WRITE mode the Codex capability list
  // above does not carry. The deleted helper mapped it onto write-capable
  // `default`; the chain lands it on the `plan` floor.
  it('lands a no-write mode the target does not offer on the plan floor, never on default', () => {
    const result = renormalizeForRuntime({
      permissionMode: 'plan', capabilities: codexCaps, disabledPermissionModes: [],
    })
    expect(result.permissionMode).toBe('plan')
    expect(result.permissionMode).not.toBe('default')
  })

  // Negative subject: a mode the target both offers and does not disable must
  // come back untouched, or the clamp is firing where it must not.
  it('leaves an offered, enabled mode alone', () => {
    expect(renormalizeForRuntime({
      permissionMode: 'acceptEdits', capabilities: codexCaps, disabledPermissionModes: [],
    }).permissionMode).toBe('acceptEdits')
  })

  it('leaves an undefined mode undefined rather than inventing one', () => {
    expect(renormalizeForRuntime({ capabilities: codexCaps, disabledPermissionModes: [] }).permissionMode)
      .toBeUndefined()
  })
})

/**
 * P3. What a cross-runtime switch will carry, decided BEFORE the switch runs.
 *
 * The fixtures are the plan's own measured corpus over 677 sessions: median
 * 0.7 KB, p95 41 KB, p99 484 KB (~124 000 tokens), max 528 KB across 25 rows —
 * one huge tool result, not a long conversation. They are here rather than only
 * in the prose so the estimation contract is asserted against reality instead
 * of against zero.
 */
describe('planHistoryCarry', () => {
  /** Real prose, so `estimateTokensDensityAware` takes its normal 4-chars/token arm. */
  const prose = (bytes: number): string =>
    'the quick brown fox jumps over a lazy dog. '.repeat(Math.ceil(bytes / 42) + 1).slice(0, bytes)

  const rowsOfBytes = (bytes: number): HistoryCarryRow[] => [
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: 'ok', rawToolResult: prose(bytes) },
  ]

  /** p99: 484 KB ≈ 124 000 tokens. */
  const P99_BYTES = 484 * 1024
  /** max: 528 KB ≈ 135 000 tokens. */
  const MAX_BYTES = 528 * 1024

  /**
   * A gateway card the way a REAL one-click card is shaped: object-shaped
   * `models` carrying `contextWindow`.
   *
   * That tier is the ONLY one that can answer for a gateway id —
   * `getDefaultModelsForConnection` returns `[]` for
   * `pi_compat`/`claude-runtime`/`codex-runtime` and `MODEL_REGISTRY` holds no
   * `tgpt/` ids — so a fixture of bare id strings (which is what the sibling
   * seam suite used to carry) leaves the whole window resolution untested.
   */
  const gatewayConnection = (contextWindow: number, id = 'tgpt/qwen35-397b-a17b-fp8'): LlmConnection => ({
    slug: 'codex-gateway',
    name: 'Codex (Nessy Gateway)',
    providerType: 'codex-runtime',
    authType: 'bearer_token',
    defaultModel: id,
    // P6.784 — the row comes from the card's own builder, so it carries the
    // tri-states the shipped card declares. Written by hand it omitted
    // `supportsThinking`, which `ModelDefinition` documents as *"Defaults to
    // true when undefined"* while both shipped gateway rows declare `false` —
    // so this fixture stood for a card that reasons. `name`/`shortName` and the
    // `codex-runtime` provider stay local: they are this suite's own subject.
    models: [{
      ...gatewayModelFixture({ id, contextWindow, provider: 'codex-runtime' }),
      name: 'Qwen Coder',
      shortName: 'Qwen',
    }],
    createdAt: 0,
  } as unknown as LlmConnection)

  type PlanInput = Parameters<typeof planHistoryCarry>[0]
  const plan = (over: Partial<PlanInput> = {}) => planHistoryCarry({
    rows: rowsOfBytes(700),
    targetProvider: 'codex-runtime',
    targetConnection: gatewayConnection(262_144),
    targetModel: 'tgpt/qwen35-397b-a17b-fp8',
    targetHasAnchor: false,
    ...over,
  })

  /** The same, with the capability gate lifted so the arms behind it are reachable. */
  const planAsIfNative = (over: Partial<PlanInput> = {}) =>
    plan({ nativeCarrySupportedOverride: true, ...over })

  // ---- the estimation contract itself --------------------------------------

  it('estimates the measured corpus at the ratio the corpus was measured with', () => {
    // Bounds, not equalities: the point is that the ratio in the code is the
    // ratio behind the plan's p99/max numbers, not that a fixture reproduces a
    // byte count exactly.
    const p99 = plan({ rows: rowsOfBytes(P99_BYTES) }).estimatedTokens
    expect(p99).toBeGreaterThan(118_000)
    expect(p99).toBeLessThan(130_000)
    const max = plan({ rows: rowsOfBytes(MAX_BYTES) }).estimatedTokens
    expect(max).toBeGreaterThan(129_000)
    expect(max).toBeLessThan(142_000)
  })

  it('adds the declared margin and the resting context, and reports what it added', () => {
    const decision = plan({ rows: rowsOfBytes(P99_BYTES) })
    expect(decision.requiredTokens).toBe(
      SESSION_RESTING_CONTEXT_TOKENS + Math.ceil(decision.estimatedTokens * HISTORY_CARRY_TOKEN_MARGIN),
    )
    // The margin has to be worth more than the resting context on a p99 payload,
    // or it could never change a verdict and would be decoration.
    expect(decision.requiredTokens - decision.estimatedTokens).toBeGreaterThan(SESSION_RESTING_CONTEXT_TOKENS)
  })

  it('counts P1 raw tool fields in preference to the display projections', () => {
    const raw = plan({ rows: [{ role: 'assistant', content: '', rawToolResult: prose(40_000), toolResult: 'x' }] })
    const display = plan({ rows: [{ role: 'assistant', content: '', toolResult: prose(40_000) }] })
    expect(raw.estimatedTokens).toBe(display.estimatedTokens)
    // Positive control: it is not simply ignoring both.
    expect(raw.estimatedTokens).toBeGreaterThan(8_000)
  })

  // ---- the four outcomes ---------------------------------------------------

  // A5. `native` requires the target's native carry to be IMPLEMENTED. Without
  // this gate the modal would promise "the whole conversation, tool calls
  // included" at every commit between P3 and T1a/T2 while the code still sent
  // 24 × 1200 chars with no tool rows.
  //
  // **T1a flipped `codex-runtime`; T2 flipped `anthropic`; T7 flipped `pi`
  // (2026-08-21, after owner gate G2).** The map is the licence for the whole
  // native path, so it is asserted member by member rather than through
  // whichever provider happens to be implemented: a runtime that gains the
  // `true` without gaining the mechanism is the failure this row guards.
  //
  // The surviving negative control is now `nestor-cloud-agent`, and it is a
  // real one rather than a leftover: the remote agent keeps no local store to
  // author, which is why it is also absent from `ANCHORED_PROVIDERS`.
  it('gates `native` on the map, which T1a opened for Codex, T2 for Claude and T7 for Pi', () => {
    expect(supportsNativeHistoryCarry('codex-runtime')).toBe(true)
    expect(supportsNativeHistoryCarry('anthropic')).toBe(true)
    expect(supportsNativeHistoryCarry('pi')).toBe(true)
    expect(supportsNativeHistoryCarry('nestor-cloud-agent')).toBe(false)

    const intoCodex = plan()
    expect(intoCodex.plan).toBe('native')
    expect(intoCodex.reason).toBe('fits')

    // T2 · the same conversation into Claude now plans `native` too — but only
    // for a model id whose window is one we actually enforce. The `claude-*`
    // arm below is what keeps a real Claude model on the text tier.
    const intoClaude = plan({ targetProvider: 'anthropic' })
    expect(intoClaude.plan).toBe('native')
    expect(intoClaude.reason).toBe('fits')

    // T7 · the same conversation into Pi plans `native` as well. A FIRST entry
    // only: this call passes no anchor, and the `anchor` tier above the map
    // answers before it for a returning leg.
    const intoPi = plan({ targetProvider: 'pi' })
    expect(intoPi.plan).toBe('native')
    expect(intoPi.reason).toBe('fits')
    // …and the anchor tier still wins over it, which is the property T7's
    // subprocess guard enforces a second time where it cannot be argued with.
    expect(plan({ targetProvider: 'pi', targetHasAnchor: true }).plan).toBe('anchor')

    // Same conversation, same window, a target whose carry is not built: the
    // refusal comes from the map and names itself.
    const intoRemote = plan({ targetProvider: 'nestor-cloud-agent' })
    expect(intoRemote.plan).toBe('text')
    expect(intoRemote.reason).toBe('no-native-carry-implemented')
  })

  // P6.10 · this row asserted the OPPOSITE until 2026-09-01, and the sentence it
  // was written from was still literally true when it was deleted.
  //
  // P3's narrowing was an inline `modelId.startsWith('claude-')` answering
  // `text`, justified by "we never set the spawn-time window override for those
  // ids, so the fit would be judged against a number we neither set or verify".
  // Both halves hold; the conclusion does not. We do not set the override
  // because the BINARY resolves the id to a real Claude model and enforces that
  // model's own window — `model-config.md`, section
  // `#correct-the-window-for-a-gateway-or-custom-model-id`, verbatim: "If the ID
  // starts with `claude-` in any casing or resolves to a Claude model, the
  // variable takes effect only when `DISABLE_COMPACT` is also set, which
  // disables all compaction." So the number is enforced by a better authority
  // than ours, and the risk argument inverts: over-estimating the fit costs a
  // COMPACTION, not the silent conversation reset the old comment feared.
  //
  // The cost of the collapse was measured, not theoretical: `claude-sonnet-4-6`
  // resolved 200 000 then (1M since F1.1221, so the arms below use the 200K
  // `claude-sonnet-4-5-20250929`), so every conversation under
  // (200 000 − 46 000) / 1.25 = 123 200 estimated tokens passed the fit test and
  // was handed the 24 × 1200 text tail anyway.
  it('carries a real `claude-*` model natively when it fits, instead of a blanket text handoff', () => {
    const onClaudeModel = plan({ targetProvider: 'anthropic', targetModel: 'claude-sonnet-4-5-20250929' })
    expect(onClaudeModel.plan).toBe('native')
    expect(onClaudeModel.reason).toBe('fits')
    // The number the fit was judged against is the model's own, out of
    // `MODEL_REGISTRY` — not a window we declared to the subprocess.
    expect(onClaudeModel.contextWindow).toBe(200_000)
    expect(onClaudeModel.windowSource).toBe('static_registry')
    // POSITIVE CONTROL — the same target on a gateway id also rebuilds, so the
    // row above is the arithmetic speaking and not a new blanket verdict.
    expect(plan({ targetProvider: 'anthropic' }).plan).toBe('native')
  })

  // The NEGATIVE half of the row above, and the reason it is not a blanket
  // `native`: the same `claude-*` target with a payload the model's own window
  // cannot hold still degrades. 528 KB estimates 129 000–142 000 tokens, so
  // `requiredTokens` is at least 46 000 + ceil(129 000 × 1.25) = 207 250 against
  // a 200 000 window — over the line at every point in the estimator's range,
  // which is what makes this a stable boundary rather than a coin flip.
  it('still degrades a `claude-*` target whose payload does not fit its own window', () => {
    const decision = plan({
      targetProvider: 'anthropic',
      targetModel: 'claude-sonnet-4-5-20250929',
      rows: rowsOfBytes(MAX_BYTES),
    })
    expect(decision.plan).toBe('text')
    expect(decision.reason).toBe('does-not-fit')
    expect(decision.contextWindow).toBe(200_000)
  })

  // T2's `undefined`-contextWindow arm, now reachable for Claude for the first
  // time: a connection with no catalogue entry for the target model resolves
  // no window at all, and sending a rebuilt transcript blind is the one thing
  // worse than degrading. `claude-agent.ts`'s own note is the reason — the
  // gateway's over-limit 400 does not present as `prompt_too_long`, so an
  // overflow reads to the user as a silent conversation reset rather than as
  // an error.
  it('refuses the rebuild when the target window is unknown', () => {
    expect(plan({ targetProvider: 'anthropic', targetModel: undefined }).reason).toBe('context-window-unknown')
    expect(plan({ targetProvider: 'anthropic', targetModel: undefined }).plan).toBe('text')
    expect(plan({ targetProvider: 'anthropic', targetModel: 'tgpt/never-listed' }).reason).toBe('context-window-unknown')
  })

  it('is native once the target implements the carry and the payload fits', () => {
    const decision = planAsIfNative()
    expect(decision.plan).toBe('native')
    expect(decision.reason).toBe('fits')
    expect(decision.windowSource).toBe('connection_override')
  })

  it('is text when the payload does not fit', () => {
    const decision = planAsIfNative({
      rows: rowsOfBytes(P99_BYTES),
      targetConnection: gatewayConnection(100_000),
    })
    expect(decision.plan).toBe('text')
    expect(decision.reason).toBe('does-not-fit')
  })

  // D7. A returning leg: the target resumes its OWN transcript and the trimmed
  // text tail carries what it missed. Nothing is rebuilt, so the modal must not
  // promise "the whole conversation" — and this arm is decided BEFORE the fit
  // check, because it is true whatever the size.
  it('is anchor when the target already holds its own anchor, whatever the size', () => {
    for (const bytes of [700, MAX_BYTES]) {
      const decision = planAsIfNative({ rows: rowsOfBytes(bytes), targetHasAnchor: true })
      expect(decision.plan).toBe('anchor')
      expect(decision.reason).toBe('target-already-anchored')
    }
  })

  // The unknown-window arm, its own row, and not optional: the gateway's
  // over-limit 400 does not present as `prompt_too_long`, so nothing catches an
  // overflow and it reads to the user as a silent conversation reset.
  it('is text when the context window cannot be resolved at all', () => {
    const bareIds = {
      ...gatewayConnection(262_144),
      // Bare id strings — the shape no tier can answer for a gateway id.
      models: ['tgpt/qwen35-397b-a17b-fp8'],
    } as unknown as LlmConnection
    const decision = planAsIfNative({ targetConnection: bareIds })
    expect(decision.contextWindow).toBeNull()
    expect(decision.windowSource).toBe('unavailable')
    expect(decision.plan).toBe('text')
    expect(decision.reason).toBe('context-window-unknown')
  })

  it('is text when the target carries no model to resolve a window for', () => {
    const decision = planAsIfNative({ targetModel: undefined })
    expect(decision.plan).toBe('text')
    expect(decision.reason).toBe('context-window-unknown')
  })

  // ---- P2.521 · the gateway preset tier, and the two things it must not do --
  //
  // A gateway card whose stored window was LOST: the `models` entry is there,
  // its `contextWindow` is not. `fetchNestorModels` REPLACES the model list
  // hourly, so a refresh predating `NESTOR_GATEWAY_MODEL_WINDOWS` (or a
  // hand-edited connection) leaves exactly this shape — and it is the case the
  // reason vocabulary's own docblock exists for. Measured at the parent commit:
  // all three providers answered `context-window-unknown` on a
  // 179-estimated-token conversation while the table held 262 000.
  const GATEWAY_PRESET_ID = 'tgpt/qwen35-397b-a17b-fp8'
  const lostWindowCard = (baseUrl: string | undefined): LlmConnection => ({
    ...gatewayConnection(262_144, GATEWAY_PRESET_ID),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    models: [{
      id: GATEWAY_PRESET_ID,
      name: 'Qwen Coder',
      shortName: 'Qwen',
      description: '',
      provider: 'codex-runtime',
      // No `contextWindow` — the whole point of the fixture.
    }],
  } as unknown as LlmConnection)

  it('resolves a gateway model whose stored window was lost from the same table the spawn path reads', () => {
    const decision = planAsIfNative({
      targetConnection: lostWindowCard(NESSY_GATEWAY_CHAT_BASE_URL),
      targetModel: GATEWAY_PRESET_ID,
    })
    expect(decision.windowSource).toBe('preset')
    expect(decision.contextWindow).toBe(nestorGatewayModelWindow(GATEWAY_PRESET_ID) ?? null)
    expect(decision.plan).toBe('native')
    expect(decision.reason).toBe('fits')
  })

  // The boundary the tier must not cross. Same host, same id, a DIFFERENT path
  // — a BYO deployment that may serve a same-named model with a different real
  // window, and promising a fit against someone else's number is the failure
  // the whole-URL rule exists to prevent. `isNestorCliBaseUrl`'s prefix would
  // accept this URL; `isNessyGatewayBaseUrl` must not.
  it('does not lend the gateway window to a BYO endpoint on the same host', () => {
    const decision = planAsIfNative({
      targetConnection: lostWindowCard(
        NESSY_GATEWAY_CHAT_BASE_URL.replace('/openai-like/v1', '/other/v1'),
      ),
      targetModel: GATEWAY_PRESET_ID,
    })
    expect(decision.contextWindow).toBeNull()
    expect(decision.windowSource).toBe('unavailable')
    expect(decision.reason).toBe('context-window-unknown')
  })

  // The ranking, which is what keeps this a fallback rather than an override:
  // the live catalogue value still wins, so a card whose window is intact is
  // judged against ITS number even when the table holds a larger one.
  it('keeps the connection catalogue ahead of the preset table', () => {
    const decision = planAsIfNative({
      targetConnection: {
        ...gatewayConnection(8_192, GATEWAY_PRESET_ID),
        baseUrl: NESSY_GATEWAY_CHAT_BASE_URL,
      } as unknown as LlmConnection,
      targetModel: GATEWAY_PRESET_ID,
    })
    expect(decision.windowSource).toBe('connection_override')
    expect(decision.contextWindow).toBe(8_192)
    expect(decision.reason).toBe('does-not-fit')
  })

  // The `sdk-owned` leg of the three-way answer, on the other id shape: a
  // `claude-*` model whose window comes off the CONNECTION rather than out of
  // `MODEL_REGISTRY`. Same verdict, because the classifier stops at the prefix
  // before it ever looks at the catalogue — which is the point of asserting it
  // on both shapes rather than once.
  it('carries a claude-* id whose window comes from the connection', () => {
    const decision = planAsIfNative({
      targetModel: 'claude-opus-4-8',
      targetConnection: gatewayConnection(200_000, 'claude-opus-4-8'),
    })
    expect(decision.contextWindow).toBe(200_000)
    expect(decision.plan).toBe('native')
    expect(decision.reason).toBe('fits')
  })

  /**
   * The `missing` leg — the one case the collapse was right about, kept.
   *
   * `resolveClaudeSpawnContextWindow` answers `missing` for a real id we have no
   * window for: we declare nothing to the subprocess, its proactive compaction
   * never arms, and `buildClaudeContextWindowWarning` tells the user so. Judging
   * a fit against a window nothing enforces is the silent-conversation-reset
   * failure for real.
   *
   * **Reaching it takes a contrived id, and that is itself the finding.**
   * The arm above it (`context-window-unknown`) already catches almost every
   * route in: for the classifier to say `missing` while `resolveContextWindow`
   * still answers, the window has to come from a tier the classifier does not
   * read, and measured 2026-09-01 `MODEL_REGISTRY` holds exactly ONE entry that
   * is not `claude-`-prefixed and carries a window. So this arm is a guard on a
   * near-unreachable state today, and it stops being near-unreachable the moment
   * the registry or the gateway preset table grows.
   */
  it('refuses the rebuild when the target window is one nothing will enforce', () => {
    const noStoredWindow = {
      ...gatewayConnection(262_144),
      providerType: 'anthropic',
      baseUrl: 'https://byo.example.invalid/v1',
      // Bare id strings: nothing for the classifier's catalogue tier to read.
      models: ['nestor-cloud-code-agent'],
    } as unknown as LlmConnection
    const decision = planAsIfNative({
      targetProvider: 'anthropic',
      targetModel: 'nestor-cloud-code-agent',
      targetConnection: noStoredWindow,
    })
    // The window IS known — which is why this is not `context-window-unknown`.
    expect(decision.contextWindow).toBe(200_000)
    expect(decision.windowSource).toBe('static_registry')
    expect(decision.plan).toBe('text')
    expect(decision.reason).toBe('context-window-unenforced')

    // CONTROL — the classifier speaks for the Claude subprocess and nothing
    // else. Pi sizes itself from the same catalogue the tier above just read, so
    // the identical conversation onto Pi is unaffected by this arm.
    const ontoPi = planAsIfNative({
      targetProvider: 'pi',
      targetModel: 'nestor-cloud-code-agent',
      targetConnection: noStoredWindow,
    })
    expect(ontoPi.plan).toBe('native')
    expect(ontoPi.reason).toBe('fits')
  })

  // A1 at the unit level, and **T1a corrected what this row can claim.** It
  // used to assert that zero rows never read as `native`; that held only
  // because the capability map was false everywhere, and it is false now: an
  // empty transcript estimates zero, zero fits, and a Codex target plans
  // `native`.
  //
  // Which is exactly A1's point rather than a hole in it. The defence against
  // "an unopened session promises the world" was never the planner — it is the
  // ORDERING, `ensureMessagesLoaded` before `planHistoryCarry`, asserted both
  // behaviourally and structurally in
  // `__tests__/runtime-switch-session.test.ts`. This row pins the premise that
  // makes that ordering load-bearing, so the two cannot drift apart.
  it('reads an empty row set as a payload of zero — which is why the load must precede the plan', () => {
    expect(planAsIfNative({ rows: [] }).estimatedTokens).toBe(0)
    expect(plan({ rows: [] }).plan).toBe('native')
    // The same emptiness on a runtime with no native carry still refuses, so
    // the `native` above really is the map speaking and not the row count.
    // (The control is whichever member the map still reads `false`: `pi` until
    // T7 flipped it 2026-08-21, `nestor-cloud-agent` since.)
    expect(plan({ rows: [], targetProvider: 'nestor-cloud-agent' }).plan).toBe('text')
  })

  // A2. The window is resolved for the TARGET's effective model, so a larger
  // source window cannot rescue a target that will not hold the payload. Same
  // conversation, two target windows, two verdicts.
  it('judges the fit against the target window, not a larger source one', () => {
    const onGatewayWindow = planAsIfNative({
      rows: rowsOfBytes(P99_BYTES),
      targetConnection: gatewayConnection(262_144),
    })
    const onSmallerTarget = planAsIfNative({
      rows: rowsOfBytes(P99_BYTES),
      targetConnection: gatewayConnection(180_000),
    })
    expect(onGatewayWindow.plan).toBe('native')
    expect(onGatewayWindow.contextWindow).toBe(262_144)
    expect(onSmallerTarget.plan).toBe('text')
    expect(onSmallerTarget.reason).toBe('does-not-fit')
    expect(onSmallerTarget.contextWindow).toBe(180_000)
  })
})

/**
 * The credential arm's gateway leg. The dp sign-in flow writes ONLY
 * `~/.nessy/dp_auth_creds.json` — never the LLM credential store — so a
 * store-only credential arm refuses every one-click gateway card on a
 * perfectly signed-in machine. Found live 2026-08-21 by the CDP wave (every
 * switch onto a gateway card came back `credentials-missing`); T4's own
 * healthy-arm case had seeded the store directly and masked it. These rows
 * drive the helper with its own creds path so they are deterministic on any
 * machine, whatever the real `~/.nessy` holds.
 */
describe('gatewayDpCredentialsPresent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-dp-creds-'))
  const credsAt = (name: string, body: unknown): string => {
    const path = join(dir, name)
    writeFileSync(path, JSON.stringify(body))
    return path
  }
  // DA1.50 · the gate is `isUsableJwt`, not `isJwtShaped`: three base64url
  // segments AND a payload that decodes to an object carrying a numeric `exp`.
  // Still no signature check, and the value is fabricated.
  const jwt = makeTestJwt({ preferred_username: 'probe', sub: 'probe' })
  const gateway = { baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1' }

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('accepts a gateway card whose dp file holds a valid, unexpired JWT', () => {
    const path = credsAt('valid.json', { jwt, expiresAt: Date.now() + 3_600_000, username: 'u', userId: 'id' })
    expect(gatewayDpCredentialsPresent(gateway, path)).toBe(true)
  })

  it('refuses an expired token', () => {
    const path = credsAt('expired.json', { jwt, expiresAt: Date.now() - 1_000, username: 'u', userId: 'id' })
    expect(gatewayDpCredentialsPresent(gateway, path)).toBe(false)
  })

  it('refuses a token that is not JWT-shaped', () => {
    const path = credsAt('malformed.json', { jwt: 'not-a-jwt', expiresAt: Date.now() + 3_600_000, username: 'u', userId: 'id' })
    expect(gatewayDpCredentialsPresent(gateway, path)).toBe(false)
  })

  it('refuses when the file is absent', () => {
    expect(gatewayDpCredentialsPresent(gateway, join(dir, 'nope.json'))).toBe(false)
  })

  // The scoping control: the dp file never vouches for a NON-gateway card,
  // however valid it is — the same verified-URL rule that scopes the Nestor
  // request rewriting.
  it('never vouches for a non-gateway base URL, even with a valid file', () => {
    const path = credsAt('valid2.json', { jwt, expiresAt: Date.now() + 3_600_000, username: 'u', userId: 'id' })
    expect(gatewayDpCredentialsPresent({ baseUrl: 'https://llm-proxy.example.com/v1' }, path)).toBe(false)
    expect(gatewayDpCredentialsPresent({}, path)).toBe(false)
  })
})
