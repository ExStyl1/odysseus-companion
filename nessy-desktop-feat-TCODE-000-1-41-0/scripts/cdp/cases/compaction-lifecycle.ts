/**
 * COMPACT-LIFE (F5) — one runtime's whole compaction story, per run.
 *
 * The owner-pinned shape, in order: fill the session to ROUGHLY HALF the
 * effective window, invoke MANUAL compaction there and watch the context come
 * back down; then keep filling until AUTO-compaction fires on its own and
 * watch it come down again.
 *
 * Three arms, `NESSY_F5_RUNTIME=pi|claude|codex`. One arm per run — each needs
 * a different connection and its own detector, and a single driver that tried
 * all three would report whichever substrate happened to exist.
 *
 * ── WHY THE WINDOW HAS TO BE NARROWED, AND WHY NOT WITH AN ENV VAR ──────────
 *
 * A real gateway model's window is 262 144 and this profile spends ~70 800
 * input tokens on a ONE-LINE prompt (system prompt + the agentic tool surface,
 * measured live 2026-08-15: system_prompt 19 351, system_tools 20 182,
 * mcp_tools 20 078, custom_subagents 8 622, skills 1 048). Its auto-compaction
 * threshold therefore sits at 228 952, which no reasonable number of turns
 * reaches. The window has to come down for the case to be runnable at all.
 *
 * The naive lever — an env var at launch — is WRONG for the claude arm and has
 * been since F2: `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is written into the session's
 * `envOverrides`, and `buildClaudeSubprocessEnv` spreads those AFTER
 * `process.env`, so a launch-time value is silently clobbered by the product's
 * own. A case built on it would measure the product's window and report it as
 * the case's.
 *
 * So the window is narrowed through the PRODUCT PATH: a small `contextWindow`
 * on a connection's own `models[]` entry. That is strictly better than an env
 * override, because it also live-proves the threading this lane built — C2's
 * sync consumption, F1's Pi window, F2's env, F3's `model_context_window` —
 * end to end, and it is the ONE lever that works identically on all three arms.
 *
 * `NESSY_AUTO_COMPACT_WINDOW` is deliberately NOT used even on Pi, where it is
 * a genuine knob: it narrows the compaction CAPACITY while leaving
 * `contextUsage.contextWindow` at the model's real 262 144, so "half the
 * window" and "the threshold" would then be computed against two different
 * numbers. One lever, one window, three arms.
 *
 * ── AND WHY NOTHING OF THE OWNER'S IS TOUCHED ──────────────────────────────
 *
 * The rig is the OWNER'S REAL PROFILE, and their connections are not this run's
 * to edit or repoint. So the case CREATES its own connection instead:
 *
 *   - a slug the product's own suffix rule maps back onto a built-in template
 *     (`pi-api-key-91` → `pi-api-key`, `claude-gateway-91` → `claude-gateway`),
 *     so `createBuiltInConnection` gives it the right providerType;
 *   - it REFUSES to run if that slug already exists — an existing connection is
 *     somebody else's, and overwriting one is the failure this guard prevents;
 *   - the credential is the gateway JWT the product resolves for itself. It is
 *     read and spent inside ONE page-side expression, so no key value ever
 *     reaches this process, its logs or its report;
 *   - the run's SESSION is deleted first and then the connection, both in a
 *     `finally` that opens at creation — not after the assertions (the ordering
 *     `AGENT-INSTALL` had to be fixed for), and both deletions are VERIFIED by
 *     re-listing rather than assumed.
 *
 * ── THE TEARDOWN ORDER IS LOAD-BEARING (T21, 2026-08-21) ───────────────────
 *
 * `llmConnections.DELETE` refuses while anything still names the connection —
 * `N session(s) and M automation(s) still use "<slug>"`, a `CONNECTION_IN_USE`
 * CodedError added 2026-08-17 (`764ee8662`, `handlers/rpc/llm-connections.ts`)
 * two days after this case's last green run. The refusal is deliberate product
 * behaviour: deleting a connection out from under a live session moves it to the
 * workspace default — a different runtime — with no dialog and no notice, which
 * is exactly what `switchSessionRuntime` gates behind a tiered confirmation.
 *
 * This case creates a session ON its own connection and used to delete only the
 * connection, so from 2026-08-17 its last check could not pass by construction:
 * the packaged wave read `claude-gateway-92 is still listed` as the one red of
 * an otherwise perfect 12/13 run. The product was right and the case was wrong.
 * The session goes first now, and the guard is what makes the ORDER a real
 * assertion rather than a tidy-up.
 *
 * **`NESSY_F5_SLUG_SUFFIX` is mandatory on the operator profile, not a
 * convenience.** Sessions from earlier sittings keep pointing at the slug they
 * ran on even after that connection is gone, and a later run that re-uses the
 * suffix inherits their reference: on 2026-08-21 six sessions from 2026-08-13/15
 * still held `claude-gateway-91`, so `-91` refuses to be deleted no matter what
 * THIS run cleans up. Pass a free suffix, or delete those sessions by hand.
 *
 * ── DETECTORS (audit §5), AND THE ONES THAT LOOK RIGHT AND ARE NOT ─────────
 *
 * Each arm reads a source the PRODUCT writes for its own reasons, never a field
 * that merely ought to be populated:
 *
 *   pi     — `compaction` entries in `.pi-sessions/*.jsonl`, which carry their
 *            own `tokensBefore`; that number, not a sampled peak, is what the
 *            threshold assertion compares against
 *   claude — `compact_boundary` in the SDK's own transcript, with its
 *            `compactMetadata` reported verbatim
 *   codex  — nothing of its own (`CODEX_HOME` is a mkdtemp the agent removes on
 *            teardown), so that arm asserts on the occupancy sequence alone and
 *            says so
 *
 * Detectors tried and rejected before these, each of which reported a wrong
 * answer with a straight face (AGENTS.md, 2026-08-08):
 * `ContextUsageSnapshot.lastCompaction` is declared in the type and never
 * filled on the Pi path — it read "never compacted" through twenty-seven real
 * ones; a transcript service-message match reported a compaction belonging to a
 * PREVIOUS run, because the harness had fallen back to a reused session; and
 * `TokenUsage.contextTokens` is a DIFFERENT counter from
 * `ContextUsageSnapshot.inputTokens`, so comparing one against the other's
 * threshold compares two things.
 *
 * A fourth was found by this run and is worth recording because it looks like a
 * defensive read: `Session.contextUsage` at the DTO's top level is empty on
 * every session — measured 0 of 383, against 265 carrying
 * `tokenUsage.contextUsage`. A case that read the top level first and treated
 * its absence as "no accounting yet" would wait forever on a session that was
 * reporting perfectly well one field deeper.
 *
 * The codex arm additionally could not run before F3: its counter was pinned at
 * zero by the snake_case reader, so "the context never dropped" was guaranteed
 * regardless of the product's behaviour.
 *
 * ── FILLING FAST ENOUGH TO REACH A THRESHOLD ───────────────────────────────
 *
 * On the default 240 000 window the Pi threshold is 206 808, so the run has to
 * add ~61 000 tokens of conversation to reach half and ~100 000 more after the
 * manual compaction resets it. `typeText` dispatches three CDP events per
 * character, so a 60 000-character filler would take about half an hour to
 * TYPE. The case therefore pastes: `document.execCommand('insertText')`,
 * page-side, one call. Measured: ~20 500 tokens of occupancy per filler turn,
 * three turns to half and four to the threshold.
 *
 * That is NOT the banned `Input.insertText` (`lib/connect.ts`
 * `FORBIDDEN_METHODS`) and the ban's reason does not apply here. The ban exists
 * because a slash command committed without key events never opens the palette
 * and goes out as prose — a `/subtask` that was recorded as a fork and never
 * started one. This paste carries deliberate prose and nothing else; the ONE
 * command this case sends, `/compact`, still goes through `selectSlashCommand`
 * and its palette assertion. `execCommand` also dispatches `beforeinput`/`input`,
 * so the composer's own React `onInput` handler runs — verified live: a 4 000-
 * character paste left the composer holding 4 006 characters, and a real 60 000-
 * character filler turn went out and was answered.
 *
 * ── THE KNOB THAT MANUFACTURES ITS OWN FAILURE ─────────────────────────────
 *
 * A threshold sized below the session's RESTING base compacts after every turn
 * forever, and the trace reads exactly like "compaction is broken". The base
 * here is ~70 800 with the owner's plugin surface on.
 *
 * The binding constraint turned out to be tighter than that, and the product
 * found it rather than the reasoning: see `PI_KEEP_RECENT_TOKENS`. Half the
 * window must clear the base by more than the tail compaction always keeps, or
 * the runtime refuses with "Nothing to compact (session too small)" — which a
 * first live run got at 91 325 tokens on a 180 000 window. `MIN_WINDOW`
 * encodes that rule.
 *
 * Usage:
 *   NESSY_CDP_PORT=9224 bun run electron:dev
 *   NESSY_CDP_PORT=9224 NESSY_F5_RUNTIME=pi NESSY_F5_ALLOW_CONNECTION_WRITE=1 \
 *     bun run scripts/cdp/cases/compaction-lifecycle.ts
 */

import type { CdpSession } from '../lib/connect.ts'
import { blocked, exitCodeFor, runCase, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, sessionCommand, waitFor, type SessionKey } from '../lib/state.ts'
import { sendSlashCommand } from '../lib/chat.ts'
import { COMPOSER_SELECTOR, focusComposer, readComposer, submitComposer } from '../lib/composer.ts'
import { readClaudeSessionLog, readPiSessionLog, type RuntimeSessionEntry } from '../lib/runtime-session-log.ts'

const ID = 'COMPACT-LIFE'
const TITLE = 'Manual compaction at half, then auto-compaction at the threshold, on one runtime'

type Arm = 'pi' | 'claude' | 'codex'

/**
 * The session's resting context on this profile, measured rather than assumed:
 * 70 823 input tokens after one one-line turn, on the owner's plugin surface.
 * Everything below is sized against it.
 */
const MEASURED_RESTING_BASE = 70_823

/**
 * The tail compaction always KEEPS, and the reason this case's first shape did
 * not work.
 *
 * Pi's `prepareCompaction` walks the conversation backwards accumulating
 * message tokens and cuts only once it has passed `keepRecentTokens`
 * (`settings-manager.js`: `?? 20000`). Below that there is nothing on the older
 * side of the cut, so it returns `undefined` and `agent-session.js` throws
 * **"Nothing to compact (session too small)"** — which is what a live run got
 * at 91 325 occupied tokens with a 180 000 window.
 *
 * The number that decides compactability is therefore NOT the occupancy: it is
 * the CONVERSATION, and on this profile 70 823 of the occupancy is system
 * prompt and tool schemas that compaction never touches. Half of a 180 000
 * window leaves 19 200 tokens of conversation — under the tail — so the naive
 * "fill to half, then compact" shape asks the product for something it
 * correctly refuses.
 */
const PI_KEEP_RECENT_TOKENS = 20_000

/**
 * The smallest window this case will write.
 *
 * Half the window is where the manual compaction happens, so half must clear
 * the resting base by more than the kept tail — otherwise the compaction has
 * nothing on the older side of its cut. Two tails of headroom makes the drop
 * unambiguous rather than marginal.
 */
const MIN_WINDOW = 2 * (MEASURED_RESTING_BASE + 2 * PI_KEEP_RECENT_TOKENS)
const TEST_WINDOW = Number(process.env.NESSY_F5_WINDOW ?? 240_000)

/**
 * One filler turn's payload. ~15 000 tokens at four characters a token, so the
 * ~75 000 tokens between the base and a threshold cost about five turns rather
 * than fifty.
 */
const FILLER_CHARS = Number(process.env.NESSY_F5_FILLER_CHARS ?? 60_000)
const MAX_FILL_TURNS = Number(process.env.NESSY_F5_MAX_TURNS ?? 24)

/**
 * How far PAST the threshold the last approach turn aims — and why the approach
 * has to be calibrated at all.
 *
 * A threshold is not a point, it is the bottom of a BAND: below it the runtime
 * does not compact, and above the band's top the request no longer fits
 * anywhere. Filling in one fixed step jumps the band whole, and the run then
 * reports on something else entirely.
 *
 * Measured 2026-08-15 on the claude arm, which is what this constant exists
 * for. One 60 000-character filler was worth 29 075 tokens; the band was
 * 207 000 (the SDK's compaction point on a 240 000 window) up to 230 144 (the
 * largest input the gateway accepts once the adapter's 32 000-token completion
 * reserve is counted against the model's real 262 144) — 23 144 wide, NARROWER
 * than one filler. The fill stepped 175 610 → 204 685, one below the band, and
 * the next identical step asked for 233 764, one above it: the upstream refused
 * with a 400, the runtime silently started a fresh conversation, and the
 * occupancy "came down" 204 685 → 87 118 without a single token being
 * compacted. An occupancy-only assertion calls that a pass.
 *
 * So the last step is sized from the rate this run measures for itself
 * (tokens per character, from the previous turn) to land just inside the band.
 * Codex has the same shape — a 204 000 limit under a 228 000 wall is a 24 000
 * band — and Pi, whose window is its own and whose upstream never refuses,
 * simply crosses its threshold by less.
 */
const APPROACH_OVERSHOOT_TOKENS = Number(process.env.NESSY_F5_OVERSHOOT ?? 5_000)

/** Small enough to be a fine step, large enough to still carry the instruction. */
const MIN_FILLER_CHARS = 2_000
const TURN_TIMEOUT_MS = 600_000
/**
 * How long to give the occupancy counter to fall on its own after `/compact`
 * before reading it the way a user does — on the next turn. Short on purpose:
 * see the note at the call site, the counter usually does not move at all until
 * a provider answers again, and a long wait here only converts a working
 * compaction into a ten-minute timeout.
 */
const POST_COMPACT_SETTLE_MS = 45_000

/** The gateway, verbatim from `apisetup/nessy-gateway.ts`. */
const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1'
const GATEWAY_MODEL = 'tgpt/qwen35-397b-a17b-fp8'

/**
 * Slug bases whose built-in template gives each arm its providerType.
 * `createBuiltInConnection` strips a trailing `-<digits>`, so `pi-api-key-91`
 * resolves to the `pi-api-key` template and lands as `pi_compat`.
 */
const SLUG_BASE: Record<Arm, string> = {
  pi: 'pi-api-key',
  claude: 'claude-gateway',
  codex: 'codex-gateway',
}

function arm(): Arm {
  const raw = (process.env.NESSY_F5_RUNTIME ?? '').trim().toLowerCase()
  if (raw === 'pi' || raw === 'claude' || raw === 'codex') return raw
  return blocked(`NESSY_F5_RUNTIME must be pi|claude|codex — got ${JSON.stringify(raw)}`)
}

interface StoredConnection {
  slug: string
  providerType?: string
  baseUrl?: string
  models?: Array<string | { id: string; contextWindow?: number }>
}

async function connections(session: CdpSession): Promise<StoredConnection[]> {
  return session.call<StoredConnection[]>(`
    const res = await window.electronAPI.listLlmConnections()
    return (res?.connections ?? res ?? []).map(c => ({
      slug: c.slug, providerType: c.providerType, baseUrl: c.baseUrl ?? undefined, models: c.models ?? [],
    }))
  `)
}

/**
 * Create the run's own connection, narrowed, through the product's own SETUP
 * RPC.
 *
 * The JWT is fetched and spent inside a single page-side expression: this
 * process never receives it, so no credential can reach the report, the
 * transcript or an artifact. That is the same door the gateway cards use
 * (`gateway-one-click.ts` → `createGatewayConnection`), with one difference —
 * a run-owned slug instead of the fixed one, so the owner's connection is not
 * upserted into.
 */
async function createNarrowedConnection(
  session: CdpSession,
  which: Arm,
  slug: string,
  window: number,
): Promise<void> {
  // A `customEndpoint` forces `providerType: 'pi_compat'` in the SETUP handler,
  // which is exactly right for Pi and exactly wrong for the two adapter
  // runtimes — it would leave their local adapter unused. Same split the
  // one-click cards make.
  const piExtras = which === 'pi'
    ? `, piAuthProvider: 'openai', modelSelectionMode: 'userDefined3Tier',
       customEndpoint: { api: 'openai-completions', supportsImages: false }`
    : ''
  // `getNessyGatewayJwt()` answers `{ jwt }`, not a bare string — measured, and
  // worth naming: passing the envelope through lands `[object Object]` as the
  // stored credential, and the SETUP handler's own message for it
  // ("setup.credential?.includes is not a function") points at the caller, not
  // at the shape.
  const result = await session.call<{ success: boolean; error?: string }>(`
    const auth = await window.electronAPI.getNessyGatewayJwt()
    const jwt = typeof auth === 'string' ? auth : (auth && auth.jwt)
    if (!jwt) return { success: false, error: 'no gateway JWT — the profile is not signed in to the Nessy Gateway' }
    return await window.electronAPI.setupLlmConnection({
      slug: ${JSON.stringify(slug)},
      credential: jwt,
      baseUrl: ${JSON.stringify(GATEWAY_BASE_URL)},
      defaultModel: ${JSON.stringify(GATEWAY_MODEL)},
      models: [{
        id: ${JSON.stringify(GATEWAY_MODEL)},
        name: 'Qwen 3.5 397B (F5 narrowed)',
        shortName: 'Qwen F5',
        description: 'Run-owned F5 connection: gateway model with a narrowed context window.',
        provider: 'pi',
        contextWindow: ${window},
        supportsThinking: false,
        supportsImages: false,
      }]${piExtras},
    })
  `)
  if (!result?.success) {
    // A FAILED setup can still have left the connection behind: the handler
    // creates the record before it validates the credential, so the first run
    // of this case left `pi-api-key-91` on the profile and the next run
    // (correctly) refused to touch it. Clean up here rather than making the
    // operator do it by hand.
    const swept = await deleteConnection(session, slug)
    blocked(
      `could not create ${slug}: ${result?.error ?? 'setupLlmConnection returned no success flag'}`
      + ` (partial record ${swept.ok ? 'swept' : 'STILL PRESENT — delete it before re-running'})`,
    )
  }
}

/**
 * Remove a run-owned connection and VERIFY it is gone by re-listing.
 *
 * The thrown `CONNECTION_IN_USE` is swallowed and its MESSAGE kept: the re-list
 * is the real check, but the refusal names which sessions still hold the slug,
 * and that sentence is the difference between "cleanup failed" and "cleanup
 * failed because six sessions from a previous sitting still point at it".
 */
export async function deleteConnection(session: CdpSession, slug: string): Promise<{ ok: boolean; remaining: number; refusal?: string }> {
  return session.call<{ ok: boolean; remaining: number; refusal?: string }>(`
    let refusal
    try { await window.electronAPI.deleteLlmConnection(${JSON.stringify(slug)}) }
    catch (e) { refusal = String((e && (e.message || e.code)) || e) }
    const res = await window.electronAPI.listLlmConnections()
    const all = (res?.connections ?? res ?? [])
    return { ok: !all.some(c => c.slug === ${JSON.stringify(slug)}), remaining: all.length, refusal }
  `).catch(() => ({ ok: false, remaining: -1 }))
}

/**
 * Remove the session this run created, and VERIFY it by re-listing.
 *
 * Runs BEFORE `deleteConnection` — see the teardown-order note in the header.
 * A session that no longer exists cannot hold the connection, and this is the
 * only reference the run itself is responsible for.
 */
export async function deleteRunSession(session: CdpSession, key: SessionKey): Promise<{ ok: boolean; error?: string }> {
  return session.call<{ ok: boolean; error?: string }>(`
    let error
    try { await window.electronAPI.deleteSession(${JSON.stringify(key.sessionId)}) }
    catch (e) { error = String((e && (e.message || e.code)) || e) }
    const sessions = (await window.electronAPI.getSessions()) ?? []
    return { ok: !sessions.some(s => s.id === ${JSON.stringify(key.sessionId)}), error }
  `).catch(cause => ({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }))
}

/** The session's own context occupancy, as the product reports it. */
interface Occupancy {
  found: boolean
  inputTokens: number | null
  window: number | null
  /** Which counter the number above came from — the two are NOT interchangeable. */
  counter: 'contextUsage.inputTokens' | 'tokenUsage.contextTokens' | 'tokenUsage.inputTokens' | 'none'
  source?: string | null
  windowSource?: string | null
  threshold: number | null
  isCompacting?: boolean | null
  modelId?: string | null
  /** The whole `tokenUsage` for the non-Pi arms, so the report shows what existed. */
  raw?: Record<string, unknown> | null
}

/**
 * What the Claude SDK subtracts from its window before auto-compacting, copied
 * from `context-meter-state.ts` (F4) rather than imported: a check that derives
 * its expectation from the code under test passes whatever that code does.
 */
const CLAUDE_OUTPUT_RESERVE = 20_000
const CLAUDE_COMPACT_BUFFER = 13_000

/**
 * The fraction of the CONFIGURED window F7 writes into codex's own config.toml
 * as `model_auto_compact_token_limit`, copied from `config-writer.ts` rather
 * than imported — same reason as the two constants above.
 *
 * It matters here because it is the point the codex arm has to fill PAST, and
 * the number this case used to aim at was below it: with no threshold of its
 * own the arm stopped at 88% of the window it is told about (0.88 × 228 000 =
 * 200 640), while the limit is 0.85 of the window that was CONFIGURED
 * (0.85 × 240 000 = 204 000). Codex reports 95% of what it is given, so the two
 * fractions are 0.85/0.95 = 89.5% of the reported window against 88% — the old
 * target stopped 3 360 tokens short of the trigger, every time, and the arm
 * would have reported "codex never auto-compacts" about a fill that never
 * reached the limit.
 */
const CODEX_AUTO_COMPACT_WINDOW_FRACTION = 0.85

/**
 * Read the occupancy, from the counter the arm's runtime actually fills.
 *
 * **The two counters are different, and which one exists depends on the
 * runtime.** `ContextUsageSnapshot` is built in `packages/pi-agent-server`
 * (`context-usage.ts`) and nowhere else, and `SessionManager.applyContextUsageSnapshot`
 * is the ONLY writer of `tokenUsage.contextTokens` — so on claude-runtime and
 * codex-runtime there is no snapshot at all and `contextTokens` stays at its
 * initialised 0. Measured on this profile before the run: 266 of 344 pi_compat
 * sessions carry `tokenUsage.contextUsage`; **0 of 11 claude-runtime and 0 of 16
 * codex-runtime do**. The DTO's top-level `Session.contextUsage` is empty on all
 * 383 — declared and never projected.
 *
 * So the non-Pi arms fall back to the host's session-level `tokenUsage`, which
 * is what the renderer's own meter falls back to for them
 * (`mayFallBackToTokenUsage`). `counter` records which number was read, because
 * comparing Pi's whole-conversation occupancy against a per-turn provider count
 * is exactly the mistake AGENTS.md records from 2026-08-08.
 */
async function occupancy(session: CdpSession, key: SessionKey, which: Arm): Promise<Occupancy> {
  const claudeFormula = which === 'claude' ? CLAUDE_OUTPUT_RESERVE + CLAUDE_COMPACT_BUFFER : 0
  return session.call<Occupancy>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
    const tu = s && s.tokenUsage ? s.tokenUsage : null
    const cu = tu ? tu.contextUsage : null
    if (cu) {
      return {
        found: true,
        inputTokens: cu.inputTokens ?? null,
        window: cu.contextWindow ?? null,
        counter: 'contextUsage.inputTokens',
        source: cu.source ?? null,
        windowSource: cu.contextWindowSource ?? null,
        threshold: cu.autoCompactionThreshold ?? null,
        isCompacting: cu.isCompacting ?? null,
        modelId: cu.modelId ?? null,
      }
    }
    if (!tu) return { found: false, inputTokens: null, window: null, counter: 'none' }
    const ctx = typeof tu.contextTokens === 'number' && tu.contextTokens > 0 ? tu.contextTokens : null
    const inp = typeof tu.inputTokens === 'number' && tu.inputTokens > 0 ? tu.inputTokens : null
    const value = ctx ?? inp
    // NEVER \`const window\` in a page-side expression: it shadows the global for
    // the whole function scope, so \`window.electronAPI\` on the first line throws
    // \`Cannot access 'window' before initialization\` — a TDZ error that reads
    // like the preload failed.
    const win = typeof tu.contextWindow === 'number' && tu.contextWindow > 0 ? tu.contextWindow : null
    return {
      found: value !== null,
      inputTokens: value,
      window: win,
      counter: ctx !== null ? 'tokenUsage.contextTokens' : inp !== null ? 'tokenUsage.inputTokens' : 'none',
      threshold: win && ${claudeFormula} > 0 ? win - ${claudeFormula} : null,
      // Cache counters are carried because on an Anthropic wire \`input_tokens\`
      // EXCLUDES cached input — if a claude arm ever shows a large
      // \`cacheReadTokens\` beside a small \`inputTokens\`, the occupancy is the
      // sum and this read is understating it. Reported so the next run can see
      // that rather than infer it.
      raw: {
        inputTokens: tu.inputTokens, outputTokens: tu.outputTokens, contextTokens: tu.contextTokens,
        cacheReadTokens: tu.cacheReadTokens, cacheCreationTokens: tu.cacheCreationTokens,
        contextWindow: tu.contextWindow, modelUsage: tu.modelUsage ? Object.keys(tu.modelUsage) : null,
      },
    }
  `)
}

interface CompactionRecord {
  /** How many compaction records the runtime has written for this session. */
  count: number
  /** Whatever the runtime recorded about the newest one, verbatim. */
  newest?: Record<string, unknown>
  file?: string
  /** Why there is no record to read. Absence of an instrument, not of a compaction. */
  reason?: string
}

/** Compaction events the RUNTIME wrote for itself, per arm. */
function compactionRecord(which: Arm, key: SessionKey): CompactionRecord {
  const summarise = (entries: RuntimeSessionEntry[], file?: string): CompactionRecord => ({
    count: entries.length,
    ...(entries.length > 0 ? { newest: entries[entries.length - 1]!.raw } : {}),
    ...(file ? { file } : {}),
  })
  if (which === 'pi') {
    const log = readPiSessionLog(key)
    if (log.reason) return { count: 0, reason: log.reason }
    if (log.sidecarCount > 1) {
      return { count: 0, reason: `ambiguous-sidecars: ${log.sidecarCount} .jsonl files — this session was forked; refusing to average two conversations` }
    }
    return summarise(log.entries.filter(e => e.type === 'compaction'), log.file)
  }
  if (which === 'claude') {
    // Narrowed to THIS session's own transcript directory, not the newest in
    // the workspace: the profile carries dozens, and "newest" is how a previous
    // run's marker once got read as this run's. Every `.jsonl` INSIDE that
    // directory is read, because the SDK rotates to a new one when it starts a
    // fresh conversation and the boundary stays behind in the old file.
    const log = readClaudeSessionLog(key.workspaceId, undefined, key.sessionId)
    if (log.reason) return { count: 0, reason: log.reason }
    return summarise(
      log.entries.filter(e =>
        e.type === 'compact_boundary'
        || e.raw?.subtype === 'compact_boundary'
        || e.raw?.compactMetadata !== undefined),
      log.file,
    )
  }
  // Codex mints its CODEX_HOME with mkdtemp and removes it on teardown, so it
  // leaves no transcript this rig can read. Stated, never quietly replaced with
  // a sibling runtime's file.
  return { count: 0, reason: 'codex-writes-no-readable-compaction-record (CODEX_HOME is a mkdtemp removed on teardown)' }
}

/**
 * The runtime's OWN pre-compaction figure — the number the threshold is about.
 *
 * Both readable runtimes write one and neither calls it the same thing: Pi's
 * `compaction` entry carries `tokensBefore`, and the Claude SDK's
 * `compact_boundary` carries `compactMetadata.preTokens` (read off the shipped
 * binary's own construction site — `{trigger, preTokens, userContext,
 * messagesSummarized}`). Reading it beats the sampled peak on both, and for the
 * same reason: the sample taken after the crossing turn can already be
 * post-compaction, which reads as a trigger that fired early.
 */
function tokensBefore(record: CompactionRecord): number | null {
  const metadata = record.newest?.compactMetadata
  const candidates = [
    record.newest?.tokensBefore,
    metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).preTokens : undefined,
  ]
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/**
 * How the runtime itself labels a compaction as manual or automatic.
 *
 * Reported, never asserted: these are the SDKs' own fields and their meaning is
 * read off the manual/automatic PAIR, not off a contract we own. Pi writes
 * `fromHook` (false for a `/compact`, true for one its auto-compaction
 * extension drove); the Claude SDK writes `compactMetadata.trigger`
 * (`"manual"` / `"auto"`).
 */
function compactionTrigger(record: CompactionRecord): unknown {
  const metadata = record.newest?.compactMetadata
  if (metadata && typeof metadata === 'object') {
    const trigger = (metadata as Record<string, unknown>).trigger
    if (trigger !== undefined) return trigger
  }
  return record.newest?.fromHook
}

function filler(n: number, chars = FILLER_CHARS): string {
  // One line, deliberately. A `\n` typed into the composer is a newline the
  // product treats as content, and multi-line prompts have already cost this
  // rig a run (D4). The instruction is repeated at both ends because the
  // padding sits between them.
  const head = `Filler turn ${n}. Ignore the padding that follows it, use no tools, and reply with exactly OK. PADDING: `
  const tail = ` END PADDING. Reply with exactly OK.`
  const unit = `sample-${n}-`
  const padding = unit.repeat(Math.ceil(Math.max(0, chars - head.length - tail.length) / unit.length))
  return `${head}${padding}${tail}`
}

/**
 * Paste one filler turn and wait for it to be answered.
 *
 * `sendPrompt` cannot be used: it types character by character (three CDP
 * events each), which for this payload is half an hour a turn. See the paste
 * note in the file header for why `execCommand` is not the banned CDP method.
 */
async function sendFiller(session: CdpSession, key: SessionKey, text: string): Promise<void> {
  // Never submit into a busy session. `midStreamBehavior` for `pi_compat` is
  // `steer`, so a message sent while a turn (or a compaction) is still running
  // is redirected into it rather than starting a new one — the turn accounting
  // this case reads would then belong to a turn the case did not send.
  await waitFor(
    () => processing(session, key),
    busy => busy === false,
    { timeoutMs: TURN_TIMEOUT_MS, intervalMs: 2_000, label: 'the session to go idle before the next prompt' },
  )
  await focusComposer(session)
  const typed = await session.call<{ ok: boolean; length: number }>(`
    const el = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})
    if (!el) return { ok: false, length: -1 }
    el.focus()
    document.execCommand('selectAll', false, null)
    document.execCommand('delete', false, null)
    const ok = document.execCommand('insertText', false, ${JSON.stringify(text)})
    await new Promise(r => setTimeout(r, 500))
    return { ok, length: (el.innerText ?? '').length }
  `)
  if (!typed.ok || typed.length < text.length * 0.9) {
    throw new Error(`filler-paste-failed: execCommand=${typed.ok}, composer holds ${typed.length} of ${text.length} characters`)
  }

  const before = await messageCount(session, key)
  await submitComposer(session)
  // The user message lands immediately, so waiting for "count grew" alone can
  // return before the model has said anything. Wait for a SECOND message and
  // for the session to stop processing.
  await waitFor(
    async () => ({ count: await messageCount(session, key), processing: await processing(session, key) }),
    value => value.count >= before + 2 && !value.processing,
    { timeoutMs: TURN_TIMEOUT_MS, intervalMs: 2_000, label: 'the filler turn to be answered' },
  )
  const left = await readComposer(session)
  if (left.trim().length > 0) throw new Error(`composer-not-drained: still holds ${left.length} characters after submit`)
}

/** Same door as `errorRows`, for the same reason. */
async function messageCount(session: CdpSession, key: SessionKey): Promise<number> {
  return withRpcRetry('messageCount', () => session.call<number>(`
    const s = await window.electronAPI.getSessionMessages(${JSON.stringify(key.sessionId)})
    return s && Array.isArray(s.messages) ? s.messages.length : 0
  `))
}

/**
 * Retry a read that the APP's own RPC layer timed out on.
 *
 * `sessions:getMessages` carries a 30-second timeout inside the product, and it
 * fires when a poll races a compaction — a run that had already proven both
 * halves died on `Request timeout: sessions:getMessages (30000ms)`. It is
 * transient by construction: the main process is busy, not broken.
 *
 * **The obvious alternative is wrong and was measured wrong.** Reading the
 * transcript out of `getSessions()` instead looks cheaper and answers in 262 ms
 * over all 383 sessions — but that DTO does not hydrate `messages`, so the count
 * comes back 0 for every session and the turn-completion wait never fires. That
 * cost a ten-minute timeout on the claude arm before the empty array was
 * noticed.
 */
async function withRpcRetry<T>(label: string, read: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await read()
    } catch (cause) {
      last = cause
      const message = cause instanceof Error ? cause.message : String(cause)
      if (!/timeout/i.test(message)) throw cause
      await Bun.sleep(5_000)
    }
  }
  throw new Error(`${label}: still timing out after 4 attempts — ${last instanceof Error ? last.message : String(last)}`)
}

/** Error rows the product wrote into the transcript — a refusal is an answer. */
async function errorRows(session: CdpSession, key: SessionKey): Promise<string[]> {
  return withRpcRetry('errorRows', () => session.call<string[]>(`
    const s = await window.electronAPI.getSessionMessages(${JSON.stringify(key.sessionId)})
    return ((s && s.messages) ?? []).filter(m => m.role === 'error').map(m => String(m.content ?? '').slice(0, 200))
  `))
}

async function processing(session: CdpSession, key: SessionKey): Promise<boolean> {
  return session.call<boolean>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
    return Boolean(s && s.isProcessing)
  `)
}

/**
 * Fill until the occupancy reaches `target`, or the turns run out.
 * Returns the series so the report carries the real numbers, not a verdict.
 */
async function fillTo(
  session: CdpSession,
  key: SessionKey,
  which: Arm,
  run: CaseRun,
  label: string,
  target: number,
  firstTurn: number,
  stopWhenDropped = false,
): Promise<{ series: number[]; turns: number; peak: number; dropped: boolean }> {
  const series: number[] = []
  let peak = 0
  let dropped = false
  let turns = 0
  /**
   * Tokens per character of filler, MEASURED as this loop goes rather than
   * assumed: it is not a constant even on one arm (60 000 characters cost
   * 21 808 tokens before the first compaction and 29 075 after, because the
   * padding unit `sample-<n>-` tokenizes differently as `n` grows). The last
   * approach turn is sized from it — see APPROACH_OVERSHOOT_TOKENS.
   */
  let tokensPerChar: number | null = null
  while (turns < MAX_FILL_TURNS) {
    const now = await occupancy(session, key, which)
    const tokens = now.inputTokens ?? 0
    if (tokens > 0) {
      series.push(tokens)
      if (tokens < peak) dropped = true
      else peak = tokens
    }
    if (dropped && stopWhenDropped) break
    if (!dropped && tokens >= target) break
    turns += 1
    // Aim the step at "just past the target", never at "one more full filler".
    const wanted = target + APPROACH_OVERSHOOT_TOKENS - tokens
    const chars = tokensPerChar && tokens > 0 && wanted > 0
      ? Math.max(MIN_FILLER_CHARS, Math.min(FILLER_CHARS, Math.ceil(wanted / tokensPerChar)))
      : FILLER_CHARS
    const text = filler(firstTurn + turns, chars)
    await sendFiller(session, key, text)
    const after = await occupancy(session, key, which)
    const grew = (after.inputTokens ?? 0) - tokens
    if (tokens > 0 && grew > 0) tokensPerChar = grew / text.length
    run.observe(`${label}-turn-${turns}`, {
      inputTokens: after.inputTokens,
      window: after.window,
      threshold: after.threshold,
      fillerChars: text.length,
      grewBy: grew > 0 ? grew : null,
    })
  }
  const final = await occupancy(session, key, which)
  const tokens = final.inputTokens ?? 0
  if (tokens > 0) {
    series.push(tokens)
    if (tokens < peak) dropped = true
    else peak = tokens
  }
  return { series, turns, peak, dropped }
}

async function run(run_: CaseRun, session: CdpSession): Promise<void> {
  const which = arm()
  const suffix = (process.env.NESSY_F5_SLUG_SUFFIX ?? '91').trim()
  const slug = `${SLUG_BASE[which]}-${suffix}`
  run_.observe('arm', which)
  run_.observe('run-owned connection', slug)
  run_.observe('narrowed contextWindow', TEST_WINDOW)

  if (TEST_WINDOW < MIN_WINDOW) {
    blocked(
      `NESSY_F5_WINDOW=${TEST_WINDOW} is below MIN_WINDOW=${MIN_WINDOW}. Half of it — where the manual `
      + `compaction happens — must clear this profile's resting base of ${MEASURED_RESTING_BASE} by more than the `
      + `${PI_KEEP_RECENT_TOKENS}-token tail compaction always keeps, or the runtime answers "Nothing to compact `
      + '(session too small)" and the case reports a refusal it manufactured itself.',
    )
  }
  if (process.env.NESSY_F5_ALLOW_CONNECTION_WRITE !== '1') {
    blocked(
      'this case CREATES a connection on the owner\'s real profile (and deletes it again). That is a mutation '
      + 'of their config, so it needs explicit permission: set NESSY_F5_ALLOW_CONNECTION_WRITE=1 to authorise it.',
    )
  }

  await assertElectronApi(session)

  const existing = await connections(session)
  if (existing.some(c => c.slug === slug)) {
    blocked(
      `${slug} already exists. This case only ever creates its OWN connection — an existing one belongs to `
      + 'somebody else, and overwriting it is exactly what this guard prevents. Pass NESSY_F5_SLUG_SUFFIX for a free slug.',
    )
  }

  await createNarrowedConnection(session, which, slug, TEST_WINDOW)
  let deleted: { ok: boolean; remaining: number; refusal?: string } | null = null
  let sessionDeleted: { ok: boolean; error?: string } | null = null
  // Hoisted out of the `try` so the `finally` can remove it FIRST. The session
  // is created ~20 lines down; until it exists there is nothing to delete, and
  // an early failure therefore still reaches the connection sweep.
  let runSession: SessionKey | undefined
  try {
    const created = (await connections(session)).find(c => c.slug === slug)
    run_.observe('connection as stored', created)
    run_.require(
      'the run-owned connection landed with the arm\'s own providerType',
      created?.providerType === (which === 'pi' ? 'pi_compat' : `${which}-runtime`),
      `providerType=${created?.providerType}`,
    )
    const storedWindow = created?.models?.map(m => (typeof m === 'string' ? undefined : m.contextWindow)).find(w => w !== undefined)
    run_.require(
      'the narrowed contextWindow reached config.json — the product path, not an env override',
      storedWindow === TEST_WINDOW,
      `stored contextWindow=${String(storedWindow)}`,
    )

    const key = await freshSession(session, `F5 ${which} compaction`)
    runSession = key
    run_.observe('session', key)
    run_.require('the case ran in a session it created', key.fresh, key.reason ?? 'fresh')

    await sessionCommand(session, key.sessionId, { type: 'setConnection', connectionSlug: slug })
    const active = await waitFor(
      () => session.call<string | undefined>(`
        const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
        return s ? (s.llmConnection ?? undefined) : undefined
      `),
      value => value === slug,
      { timeoutMs: 30_000, intervalMs: 1_000, label: `the session to switch to ${slug}` },
    ).catch(() => undefined)
    run_.require(`the session runs on ${slug}`, active === slug, String(active))

    // The base, measured rather than assumed: everything below is relative to
    // what this profile costs before any conversation exists.
    await sendFiller(session, key, 'Reply with exactly: READY')
    const base = await waitFor(
      () => occupancy(session, key, which),
      value => value.found && typeof value.inputTokens === 'number',
      { timeoutMs: 120_000, intervalMs: 2_000, label: 'the first context-usage report' },
    ).catch(() => occupancy(session, key, which))
    run_.observe('base occupancy', base)
    if (!base.found) {
      // BLOCKED, not FAIL: the compaction was never exercised, so nothing about
      // it passed or failed. What DID get measured is why.
      //
      // The claude arm blocked here on 2026-08-15 and the cause was the
      // product's: a completed turn reported `tokenUsage.inputTokens` 0,
      // `contextTokens` 0, `cacheReadTokens` 0 while
      // `modelUsage['tgpt/…'].inputTokens` carried 58 392 — the same shape on
      // the OWNER's own claude-gateway sessions (0 against 58 377 / 86 540 /
      // 86 554), so it predated the run. **F6 fixed it**: the adapter took its
      // snapshot from `assistant.message.usage`, which is the `message_start`
      // frame and is all zeros on a wire that reports usage only at the end,
      // and it now reads `message_delta` as well. If this branch fires on
      // claude again, that fix has regressed — start at
      // `event-adapter.ts:recordAssistantUsage`, not at this case.
      //
      // `modelUsage` is not the substitute it looks like: `mergeModelUsage`
      // SUMS `inputTokens` across turns, so it climbs monotonically and could
      // never show a drop.
      blocked(
        `the ${which} runtime reported no context occupancy after a completed turn, so this case has no `
        + `instrument for "the context came back down". Counter read: ${JSON.stringify(base.raw)}. `
        + 'That is a missing measurement, not a passed or failed compaction — and on claude it is the product '
        + 'that has no number, not the rig: the per-model breakdown carries the input count while the '
        + 'session-level field every occupancy consumer reads stays 0.',
      )
    }
    // **Codex reports 95% of the window it was configured with.** Measured on
    // two independent points: `model_context_window = 240000` in the session's
    // own config.toml comes back as `modelContextWindow: 228000`, and the
    // pre-F3 sessions on this profile, which carried codex's own 272 000
    // default, report 258 400. Both are exactly ×0.95, so codex holds a 5%
    // reserve back before it tells anyone the number. That is codex's
    // accounting, not a threading bug — F3 put 240 000 in the file, verified by
    // reading the live `CODEX_HOME`'s config.toml — so the arm asserts the
    // reserved figure and says why.
    const expectedWindow = which === 'codex' ? Math.round(TEST_WINDOW * 0.95) : TEST_WINDOW
    run_.check(
      'the session runs on the narrowed window, so the product read the catalog entry',
      base.window === expectedWindow,
      `window=${base.window}, expected ${expectedWindow}`
      + (which === 'codex' ? ` (${TEST_WINDOW} configured, less codex's 5% reserve)` : ''),
    )
    run_.observe('threshold as the product reports it', base.threshold)

    // ── HALF 1: fill to roughly half, compact by hand, watch it drop ────────
    // Half of what the RUNTIME says its window is, not half of what was written
    // into the catalog entry — on codex those differ by its 5% reserve, and the
    // owner's shape is about the window the session is actually running on.
    const effectiveWindow = base.window ?? TEST_WINDOW
    const half = Math.floor(effectiveWindow / 2)
    const fill1 = await fillTo(session, key, which, run_, 'half', half, 0)
    const atHalf = await occupancy(session, key, which)
    run_.observe('half-fill', { turns: fill1.turns, series: fill1.series, target: half })
    run_.check(
      'the session reached roughly half the window',
      (atHalf.inputTokens ?? 0) >= half,
      `tokens=${atHalf.inputTokens} against half of ${effectiveWindow} = ${half}`,
    )

    // Whether there is anything to compact at all, stated before the command is
    // sent so a refusal is a legible number rather than a timeout: compaction
    // keeps the last `keepRecentTokens` of CONVERSATION and summarises what is
    // older, and the resting base is not conversation.
    const conversationAtHalf = (atHalf.inputTokens ?? 0) - (base.inputTokens ?? 0)
    run_.observe('compactable conversation at the manual point', {
      occupancy: atHalf.inputTokens,
      restingBase: base.inputTokens,
      conversation: conversationAtHalf,
      keptTail: PI_KEEP_RECENT_TOKENS,
      expectedToBeCompactable: conversationAtHalf > PI_KEEP_RECENT_TOKENS,
    })

    const beforeManual = compactionRecord(which, key)
    run_.observe('compaction records before /compact', { count: beforeManual.count, file: beforeManual.file, reason: beforeManual.reason })

    // The command goes through the palette, never as prose: `/compact` submits
    // itself on selection and leaves the composer empty.
    const errorsBefore = await errorRows(session, key)
    await sendSlashCommand(session, key, {
      token: 'compact',
      match: /compact/i,
      expectComposer: '',
      submitOnSelect: true,
      timeoutMs: TURN_TIMEOUT_MS,
    })
    // Two ways this can end, and a case that waits for only the first reports a
    // refusal as a timeout. The product answers a refused compaction with an
    // error ROW in the transcript ("Nothing to compact (session too small)"),
    // which is an answer — poll for either.
    let afterManual = await waitFor(
      async () => ({ now: await occupancy(session, key, which), errors: await errorRows(session, key) }),
      value =>
        (value.now.inputTokens !== null && value.now.inputTokens < (atHalf.inputTokens ?? 0) && value.now.isCompacting !== true)
        || value.errors.length > errorsBefore.length,
      { timeoutMs: POST_COMPACT_SETTLE_MS, intervalMs: 3_000, label: 'the context to come back down after /compact, or the runtime to refuse' },
    ).catch(() => null)
    const refusal = (afterManual?.errors ?? []).slice(errorsBefore.length)
    if (refusal.length > 0) run_.observe('the runtime REFUSED the manual compaction', refusal)

    // **THE OCCUPANCY DOES NOT FALL WHEN THE COMPACTION DOES.** Measured on this
    // rig: a manual `/compact` that demonstrably ran — a `compaction` entry with
    // `tokensBefore: 132323` in the session's own sidecar, seconds earlier —
    // left `contextUsage.inputTokens` reading 132 323 unchanged, because that
    // number is the PROVIDER's last reported figure (`source: 'sdk_usage'`) and
    // no provider has answered since. Ten minutes of polling would report a
    // working compaction as a failed one.
    //
    // So the drop is read where a user reads it: on the next turn. One cheap
    // prompt, then the same counter again. (`lastCompaction` is null here too —
    // the typed-but-unfilled field AGENTS.md already records.)
    if (refusal.length === 0 && (afterManual?.now.inputTokens ?? Infinity) >= (atHalf.inputTokens ?? 0)) {
      const settled = afterManual?.now ?? await occupancy(session, key, which)
      run_.observe('occupancy after /compact, before any new turn', {
        tokens: settled.inputTokens,
        before: atHalf.inputTokens,
        note: 'the provider-reported counter has not refreshed yet; sending one small turn to read it the way a user does',
      })
      await sendFiller(session, key, 'Reply with exactly: PING')
      afterManual = { now: await occupancy(session, key, which), errors: await errorRows(session, key) }
    }

    const manualTokens = afterManual?.now.inputTokens ?? (await occupancy(session, key, which)).inputTokens
    run_.observe('manual compaction', {
      before: atHalf.inputTokens,
      after: manualTokens,
      dropped: (atHalf.inputTokens ?? 0) - (manualTokens ?? 0),
    })
    run_.check(
      'manual /compact brought the context back down',
      manualTokens !== null && manualTokens < (atHalf.inputTokens ?? 0),
      `${atHalf.inputTokens} → ${manualTokens}`,
    )
    const manualRecord = compactionRecord(which, key)
    run_.observe('compaction records after /compact', manualRecord)
    if (which === 'codex') {
      run_.observe(
        'runtime-written record for the manual compaction',
        `NOT ASSERTED — ${manualRecord.reason}. The occupancy drop above is this arm's whole evidence.`,
      )
    } else {
      run_.check(
        'the runtime wrote its own compaction record',
        manualRecord.count > beforeManual.count,
        `${beforeManual.count} → ${manualRecord.count}${manualRecord.reason ? ` (${manualRecord.reason})` : ''}`,
      )
    }

    // ── HALF 2: keep filling until the runtime compacts on its own ──────────
    const threshold = atHalf.threshold ?? base.threshold
    run_.observe('auto-compaction threshold in play', threshold)
    // Codex reports no threshold of its own, so the arm has to aim at the one
    // F7 WRITES for it — `model_auto_compact_token_limit`, 0.85 of the
    // configured window. Aiming anywhere below it measures a fill, not a
    // product: the previous shape stopped at 0.88 of the REPORTED window, which
    // is 3 360 tokens short of the limit and would report "never compacted"
    // from a session that was never asked to.
    //
    // The old 0.88 stop survives as the floor for a codex arm with no limit to
    // aim at (no synced window ⇒ F7 writes nothing, by its own gate). It exists
    // because filling to the window itself sends a request the endpoint
    // refuses, and an endpoint 400 is not a compaction measurement — 12% is one
    // filler turn's headroom, measured at ~29 000 tokens per turn against a
    // 228 000 window.
    const codexAutoCompactLimit = which === 'codex'
      ? Math.floor(TEST_WINDOW * CODEX_AUTO_COMPACT_WINDOW_FRACTION)
      : null
    if (codexAutoCompactLimit !== null) {
      run_.observe('the limit F7 writes into codex config.toml', {
        modelAutoCompactTokenLimit: codexAutoCompactLimit,
        ofConfiguredWindow: TEST_WINDOW,
        againstReportedWindow: effectiveWindow,
        percentOfReportedWindow: Math.round((codexAutoCompactLimit / effectiveWindow) * 100),
      })
    }
    const autoTarget = threshold ?? codexAutoCompactLimit ?? Math.floor(effectiveWindow * 0.88)
    // A DROP IS NOT A COMPACTION, and this rig has now watched the difference.
    // 2026-08-15, claude arm: the crossing request was refused upstream
    // (400 — "Requested token count exceeds the model's maximum context length
    // of 262144 tokens… 233764 from the input messages and 32000 for the
    // completion"), the product wrote one error row reading "Unknown Error: An
    // unexpected error occurred", and the runtime then answered the same prompt
    // from a BRAND-NEW conversation whose first entry has `parentUuid: null`.
    // Occupancy fell 204 685 → 87 118 — a bigger fall than any compaction in
    // this case — with nothing summarised and the whole history gone. So the
    // headline check requires the drop AND a clean transcript; the error rows
    // are captured here and reported either way.
    const errorsBeforeAuto = await errorRows(session, key)
    const fill2 = await fillTo(
      session,
      key,
      which,
      run_,
      'auto',
      autoTarget,
      100,
      true,
    )
    let end = await occupancy(session, key, which)
    let autoDropped = fill2.dropped
    // **THE SAME LAG AS THE MANUAL HALF, AND IT COST A RED RUN.** Auto-compaction
    // fires AFTER the assistant message, so the sample taken at the end of the
    // crossing turn is still the pre-compaction figure — the provider has not
    // answered again yet. A run whose sidecar showed the automatic compaction
    // with `tokensBefore: 217353` (above its 206 808 threshold) reported "no
    // drop seen in 4 turns" from that stale sample. One SMALL turn refreshes it,
    // and small matters: another 29 000-token filler here would overrun codex's
    // window instead of reading it.
    if (!autoDropped) {
      run_.observe('occupancy at the end of the crossing turn, before any new turn', {
        tokens: end.inputTokens,
        peak: fill2.peak,
        note: 'sending one small turn so the provider-reported counter refreshes',
      })
      await sendFiller(session, key, 'Reply with exactly: PING')
      end = await occupancy(session, key, which)
      if ((end.inputTokens ?? Infinity) < fill2.peak) autoDropped = true
    }
    const autoErrors = (await errorRows(session, key)).slice(errorsBeforeAuto.length)
    run_.observe('auto-fill', {
      turns: fill2.turns,
      series: fill2.series,
      peak: fill2.peak,
      end: end.inputTokens,
      droppedBy: autoDropped ? fill2.peak - (end.inputTokens ?? 0) : 0,
      errorRowsDuringAutoFill: autoErrors,
    })
    run_.check(
      'auto-compaction fired on its own and the context came down',
      autoDropped && autoErrors.length === 0,
      autoErrors.length > 0
        ? `the occupancy went ${fill2.peak} → ${end.inputTokens}, but the runtime errored on the way: `
          + `${JSON.stringify(autoErrors)} — a drop after an error is a reset, not a compaction`
        : autoDropped
          ? `${fill2.peak} → ${end.inputTokens}`
          : `peak=${fill2.peak}, end=${end.inputTokens} — no drop in ${fill2.turns} turns plus a settling turn`,
    )

    const autoRecord = compactionRecord(which, key)
    run_.observe('compaction records at the end', autoRecord)
    if (which === 'codex') {
      // F7 gave this arm a limit, and the limit gives the run something F5's
      // first sitting could not settle: `model_auto_compact_token_limit_scope`
      // is left at codex's own default, whose value is undocumented, and the
      // two candidates charge different tokens against the same number
      // (`total` = the full active context; `body_after_prefix` = only what
      // grew after the carried prefix). WHERE the drop happens says which one
      // is in force — at the limit means `total`; well above it, or never,
      // means the prefix is not being charged. Still an observation and not an
      // assertion: codex writes no compaction record this rig can read, so the
      // only number available is a sampled peak.
      const peak = fill2.peak
      const limit = codexAutoCompactLimit
      run_.observe('what the drop point says about the limit scope', {
        writtenLimit: limit,
        prePeakSampled: peak,
        droppedTo: end.inputTokens,
        restingBase: base.inputTokens,
        peakOverLimit: limit === null ? null : peak - limit,
        reading: !autoDropped
          ? 'no drop — either the limit is not being charged the way this counter counts, or it was never reached'
          : limit !== null && peak >= limit && peak < limit + 30_000
            ? 'fired at the written limit — consistent with scope `total`, the counter this case reads'
            : 'fired away from the written limit — record the numbers, do not name a scope',
      })
    } else {
      run_.check(
        'the runtime recorded the automatic compaction too',
        autoRecord.count > manualRecord.count,
        `${manualRecord.count} → ${autoRecord.count}`,
      )
      // The threshold assertion reads the runtime's OWN pre-compaction figure
      // where it writes one (Pi's `tokensBefore`). A sampled peak is not the
      // same number: the sample after a turn can already be post-compaction, so
      // a peak below the threshold would look like an early trigger that never
      // happened.
      const before = tokensBefore(autoRecord) ?? fill2.peak
      run_.observe('pre-compaction tokens', { fromRuntimeRecord: tokensBefore(autoRecord), sampledPeak: fill2.peak })
      // `autoRecord.newest` is the newest record of ANY kind, so when no
      // automatic compaction was written it is the MANUAL one — and comparing
      // the manual compaction's own `preTokens` against the automatic threshold
      // prints a third failure line that says "the trigger fired early" about a
      // trigger that never fired at all. One honest failure (no automatic
      // compaction) beats two, one of which describes the wrong event.
      const haveAutomaticRecord = autoRecord.count > manualRecord.count
      if (!haveAutomaticRecord) {
        run_.observe(
          'the threshold assertion',
          'NOT APPLICABLE — no automatic compaction was recorded, so there is no pre-compaction figure to '
          + `compare against the ${threshold} threshold. The only record in this session is the manual one `
          + `(${tokensBefore(autoRecord)} tokens before), and it is not this check's subject.`,
        )
      }
      run_.observe(`manual vs automatic, as ${which} labels them`, {
        field: which === 'pi' ? 'fromHook' : 'compactMetadata.trigger',
        manual: compactionTrigger(manualRecord),
        automatic: haveAutomaticRecord ? compactionTrigger(autoRecord) : null,
      })
      if (haveAutomaticRecord) {
        // **A SECOND RECORD IS NOT YET AN AUTOMATIC ONE.** The manual `/compact`
        // this case sends writes a record of its own, and both runtimes stamp
        // theirs with which side asked for it — so "the count went up" is
        // satisfied by a user typing the command twice. The label is what
        // separates the safety net from the affordance, and F9's re-run is
        // owed exactly that distinction: the SDK's own gate had answered
        // `{kind: "not_needed"}` on every turn while manual compaction worked
        // in the same session.
        //
        // Read, never invented: pi writes `fromHook` (true when its own
        // auto-compaction extension drove it) and the Claude SDK writes
        // `compactMetadata.trigger` ("manual" against anything else). An ABSENT
        // label fails this check on purpose — an unlabelled record cannot tell
        // the two apart, and defaulting it to "automatic" is how a rig reports
        // the event it was hoping for.
        const automaticLabel = compactionTrigger(autoRecord)
        run_.check(
          `${which} labelled the new record automatic, not manual`,
          which === 'pi' ? automaticLabel === true : automaticLabel !== undefined && automaticLabel !== 'manual',
          `${which === 'pi' ? 'fromHook' : 'compactMetadata.trigger'}=${JSON.stringify(automaticLabel)}`
          + ` (the manual compaction in this same session carries ${JSON.stringify(compactionTrigger(manualRecord))})`,
        )
        run_.check(
          'the trigger fired at the threshold, not early',
          threshold !== null && before >= threshold * 0.9,
          `pre-compaction ${before} against a threshold of ${threshold}`,
        )
      }
    }
  } finally {
    // ORDER, not tidiness: the product refuses to delete a connection a session
    // still names (`CONNECTION_IN_USE`, `764ee8662`), so the session goes first.
    if (runSession) sessionDeleted = await deleteRunSession(session, runSession)
    deleted = await deleteConnection(session, slug)
    run_.observe('cleanup', {
      slug,
      sessionDeleted: sessionDeleted?.ok ?? '(no session was created)',
      sessionError: sessionDeleted?.error,
      deleted: deleted.ok,
      connectionsRemaining: deleted.remaining,
      refusal: deleted.refusal,
    })
  }

  run_.check(
    'the run-owned session is gone, which is what lets the connection go',
    // A run that never got as far as creating one has nothing to clean up and
    // nothing to prove; the connection check below still runs.
    runSession === undefined || sessionDeleted?.ok === true,
    runSession === undefined || sessionDeleted?.ok === true
      ? undefined
      : `${runSession.sessionId} is still listed${sessionDeleted?.error ? ` — ${sessionDeleted.error}` : ''}`,
  )
  run_.check(
    'the run-owned connection is gone from the owner\'s profile',
    deleted?.ok === true,
    // Only on failure: `check` prints whatever detail it is given, and a failure
    // sentence printed beside an `ok` is a line that argues with itself.
    deleted?.ok === true
      ? undefined
      : deleted
        ? `${slug} is still listed${deleted.refusal ? ` — the product refused: ${deleted.refusal}` : ''}`
        : 'cleanup never ran',
  )
}

/**
 * `main()`'s default 30 s per-CDP-command timeout is too short for this case and
 * killed a run that had already proven both halves. Not because any single IPC
 * is slow — `getSessions()` over the profile's 383 sessions measures 262 ms —
 * but because this session's transcript reaches a quarter of a million
 * characters and the renderer stalls under its own re-render while a turn lands.
 * The number below is a rendering-stall allowance, not an IPC budget.
 *
 * **Guarded by `import.meta.main` since T21**, which every other case in this
 * directory already does. Without it the module could not be IMPORTED without
 * running the whole 20-minute compaction sitting — so the teardown order above
 * could only be proven by a copy of itself, and a copy is not the thing under
 * test. The two helpers it needs are exported for that reason.
 */
if (import.meta.main) {
  const result = await runCase(ID, TITLE, run, { timeoutMs: 180_000 })
  process.exit(exitCodeFor(result.status))
}

export const meta = { id: ID, title: TITLE }
