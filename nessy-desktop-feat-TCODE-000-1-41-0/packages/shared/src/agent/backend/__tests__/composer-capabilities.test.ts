import { describe, expect, test } from 'bun:test'
import type { LlmConnection } from '../../../config/llm-connections.ts'
import type { ModelProvider } from '../../../config/models.ts'
import { NESTOR_CLI_BASE_PREFIX } from '../../../auth/nestor.ts'
import {
  pluginWorkflowCommandId,
  workflowSlashCommandId,
} from '../../../slash-commands/custom-commands.ts'
import { PERMISSION_MODE_ORDER } from '../../mode-types.ts'
import { resolveComposerCapabilities } from '../composer-capabilities.ts'

const BASE_COMPAT: LlmConnection = {
  slug: 'custom',
  name: 'Custom',
  providerType: 'pi_compat',
  authType: 'api_key_with_endpoint',
  baseUrl: 'http://localhost:8080',
  customEndpoint: { api: 'openai-completions' },
  createdAt: 1,
}

describe('resolveComposerCapabilities', () => {
  test('anthropic defaults: vision yes, full reasoning, steer mid-stream', () => {
    const conn = {
      slug: 'anthropic',
      name: 'Anthropic',
      providerType: 'anthropic',
      authType: 'api_key',
      createdAt: 1,
    } satisfies LlmConnection

    const caps = resolveComposerCapabilities({ provider: 'anthropic', connection: conn })

    expect(caps.attachments.images).toBe('yes')
    expect(caps.reasoning.levels.length).toBeGreaterThan(3)
    // Was `queue`. Flipped 2026-08-17 once both arms of Claude's hook-based steer
    // were driven in the app — including the undelivered one, which was losing the
    // correction rather than merely wasting the turn's tokens.
    expect(caps.submit.steer).toBe(true)
    expect(caps.submit.queue).toBe(false)
  })

  test('no connection falls back to steer (legacy behavior)', () => {
    const caps = resolveComposerCapabilities({ provider: 'pi' })

    expect(caps.submit.steer).toBe(true)
    expect(caps.permissions.modes).toEqual(PERMISSION_MODE_ORDER)
    expect(caps.contextUsage).toMatchObject({
      kind: 'fresh-local',
      refresh: true,
      compact: { manual: true, auto: true },
    })
  })

  // The composer's submit button reads this: a codex session now labels a
  // mid-stream send "steer", because `CodexAgent.redirect` wires the
  // app-server's own `turn/steer`. A connection carrying an explicit 'queue'
  // still gets the queue label — the second half of this case.
  test('codex-runtime connection defaults submit to steer, and honours an explicit queue', () => {
    const conn = {
      slug: 'codex-runtime',
      name: 'Codex Runtime',
      providerType: 'codex-runtime',
      authType: 'none',
      createdAt: 1,
    } satisfies LlmConnection

    const caps = resolveComposerCapabilities({ provider: 'codex-runtime', connection: conn })

    expect(caps.submit.steer).toBe(true)
    expect(caps.submit.queue).toBe(false)

    const queued = resolveComposerCapabilities({
      provider: 'codex-runtime',
      connection: { ...conn, midStreamBehavior: 'queue' },
    })
    expect(queued.submit.queue).toBe(true)
    expect(queued.submit.steer).toBe(false)
  })

  // T7 — `claude-runtime` collapses onto the 'anthropic' AgentProvider
  // (factory.ts:providerTypeToAgentProvider), so an AgentProvider-keyed lookup
  // alone hands it api.anthropic.com's capabilities. The composer must describe
  // the endpoint the session actually talks to, not the SDK it uses.
  describe('claude-runtime overrides the anthropic AgentProvider defaults', () => {
    const claudeRuntime = (models?: LlmConnection['models']): LlmConnection => ({
      slug: 'claude-gateway',
      name: 'Claude Code (Nessy Gateway)',
      providerType: 'claude-runtime',
      authType: 'api_key_with_endpoint',
      baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
      models,
      createdAt: 1,
    })

    test('reasoning stops at high — the adapter collapses every larger budget onto it', () => {
      // anthropic/composer-capabilities would offer xhigh and max; the vendored
      // `effortForThinkingBudget` ladder maps 20k/26k/32k all to "high", so the
      // three top levels are indistinguishable on this route.
      const caps = resolveComposerCapabilities({ provider: 'anthropic', connection: claudeRuntime() })

      expect(caps.reasoning.levels).toEqual(['off', 'low', 'medium', 'high'])
    })

    test('images resolve per-model and the seeded gateway catalog says no', () => {
      const caps = resolveComposerCapabilities({
        provider: 'anthropic',
        connection: claudeRuntime([{ id: 'tgpt/qwen35-397b-a17b-fp8', supportsImages: false } as never]),
        model: 'tgpt/qwen35-397b-a17b-fp8',
      })

      expect(caps.attachments.images).toBe('no')
    })

    // Owner ruling 2026-08-28 — carry the modality, let the ENDPOINT refuse.
    // This expected `'no'` on the recorded reason that the local adapter dropped
    // images anyway; `30628c7d0` killed that reason (`to-chat.ts` `toChatContent`
    // now emits the chat `image_url` part), so an undeclared BYO model on a
    // vision-capable upstream stops being denied a capability that works. The
    // DECLARED case above is untouched: a declaration is still authoritative.
    test('an undeclared model is not gated — nothing of ours denies it', () => {
      const caps = resolveComposerCapabilities({
        provider: 'anthropic',
        connection: claudeRuntime(['some-byo-model']),
        model: 'some-byo-model',
      })

      expect(caps.attachments.images).toBe('yes')
    })

    test('a direct anthropic connection is untouched by the override', () => {
      const conn = {
        slug: 'anthropic',
        name: 'Anthropic',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: 1,
      } satisfies LlmConnection

      const caps = resolveComposerCapabilities({
        provider: 'anthropic',
        connection: conn,
        model: 'claude-opus-4-8',
      })

      expect(caps.attachments.images).toBe('yes')
      expect(caps.reasoning.levels).toContain('max')
    })

    test('keeps folders, and takes the Claude backend\'s steer mid-stream default', () => {
      const caps = resolveComposerCapabilities({ provider: 'anthropic', connection: claudeRuntime() })

      expect(caps.attachments.folders).toBe(true)
      expect(caps.submit.steer).toBe(true)
      expect(caps.submit.queue).toBe(false)
    })
  })

  test('nestor-cloud-agent defaults submit to queue with files/folders and no images', () => {
    const conn = {
      slug: 'nestor-cloud-agent',
      name: 'Nestor Cloud Agent',
      providerType: 'nestor-cloud-agent',
      authType: 'none',
      createdAt: 1,
    } satisfies LlmConnection

    const caps = resolveComposerCapabilities({ provider: 'nestor-cloud-agent', connection: conn })

    expect(caps.submit.queue).toBe(true)
    expect(caps.submit.steer).toBe(false)
    expect(caps.attachments.files).toBe(true)
    expect(caps.attachments.folders).toBe(true)
    expect(caps.attachments.images).toBe('no')
    expect(caps.permissions.modes).toEqual(['plan', 'default'])
    expect(caps.permissions.modeOptions?.map(({ mode, label, remoteModeId }) => ({ mode, label, remoteModeId }))).toEqual([
      { mode: 'plan', label: 'Plan', remoteModeId: 'plan' },
      { mode: 'default', label: 'Act', remoteModeId: 'act' },
    ])
    expect(caps.contextUsage).toMatchObject({
      kind: 'unavailable',
      reason: 'remote-not-reported',
      refresh: false,
      compact: { manual: false, structured: false },
    })
  })

  test('codex-runtime offers manual compaction and no context snapshot', () => {
    const caps = resolveComposerCapabilities({ provider: 'codex-runtime' })
    expect(caps.contextUsage).toMatchObject({
      // `thread/compact/start` is in the bundled app-server's client-request
      // method table, so `/compact` is a real request rather than a prose turn.
      compact: { manual: true },
      // Codex reports token counts but no occupancy snapshot, and `kind` gates
      // the renderer's tokenUsage fallback — claiming fresh-local here would
      // blank the readout instead of improving it.
      kind: 'unavailable',
    })
    // Neither claimed nor denied: `model_auto_compact_token_limit` exists in
    // codex, and nothing here has a source to derive it from.
    expect(caps.contextUsage?.compact?.auto).toBeUndefined()
  })

  // R36 — `/btw` and `/recap` ride the tool-less queryLlm/mini-completion
  // route, and NestorCloudAgent's queryLlm throws by design, so the composer
  // must not offer them there. Every other provider keeps the full set.
  test('nestor-cloud-agent excludes btw/recap; other providers do not', () => {
    const excludes = (provider: ModelProvider, commandId: string): boolean =>
      Boolean(resolveComposerCapabilities({ provider }).slash.excludedCommandIds?.includes(commandId))

    for (const commandId of ['btw', 'recap']) {
      expect(excludes('nestor-cloud-agent', commandId), commandId).toBe(true)
      for (const provider of ['pi', 'anthropic', 'codex-runtime'] as const) {
        expect(excludes(provider, commandId), `${provider}/${commandId}`).toBe(false)
      }
    }
  })

  // P3.71 · `/subtask` needs a conversation fork, and `PiAgent.requestSubtaskFork`
  // → `subtask_start` is the only fork mechanism in the product. The seam has
  // refused it off Pi since P2.298; the MENU went on offering it, so the only
  // thing a user could do with the row was be told it is unavailable.
  //
  // The gate reads `runtimeForksConversations`, the same predicate
  // `BaseAgent.canForkConversation()` is tied to — never a re-spelled
  // `provider === 'pi'`.
  test('subtask is offered only where the runtime can fork the conversation', () => {
    const excludes = (provider: ModelProvider): boolean =>
      Boolean(resolveComposerCapabilities({ provider }).slash.excludedCommandIds?.includes('subtask'))

    expect(excludes('pi')).toBe(false)
    for (const provider of ['anthropic', 'codex-runtime', 'nestor-cloud-agent'] as const) {
      expect(excludes(provider), provider).toBe(true)
    }
  })

  // P2.217 · `/approve` overrules the CODEX auto-review guardian, and nothing
  // else runs one — off codex `BaseAgent.approveGuardianDenial` answers with
  // exactly that sentence. Before this the command was offered NOWHERE (neither
  // menu nor `/help`), so the row is two changes: announce it, and announce it
  // only where it can do something.
  test('approve is offered only on codex, which is the only runtime with a guardian to overrule', () => {
    const excludes = (provider: ModelProvider): boolean =>
      Boolean(resolveComposerCapabilities({ provider }).slash.excludedCommandIds?.includes('approve'))

    expect(excludes('codex-runtime')).toBe(false)
    for (const provider of ['pi', 'anthropic', 'nestor-cloud-agent'] as const) {
      expect(excludes(provider), provider).toBe(true)
    }
  })

  // P2.279 · a saved workflow recipe is offered as `/<name>` with an id minted
  // per session (`custom:workflow:<name>`), so the menu family can only be named
  // by its PREFIX. `BaseAgent.chat` has refused a `workflowInvocation` off Pi
  // since P2.212 and the plugin half left the catalog in P3.34; this is the
  // native half of the same withdrawal.
  test('workflow command families are offered only where a recipe can dispatch', () => {
    const prefixes = (provider: ModelProvider): string[] =>
      resolveComposerCapabilities({ provider }).slash.excludedCommandIdPrefixes ?? []

    expect(prefixes('pi')).toEqual([])
    for (const provider of ['anthropic', 'codex-runtime', 'nestor-cloud-agent'] as const) {
      // Both id builders' prefixes, so a renderer that only ever sees native
      // recipes and one that also sees plugin recipes agree.
      expect(prefixes(provider), provider).toEqual(['custom:workflow:', 'custom:plugin-workflow:'])
      // The real ids the builders mint must actually be caught by the prefixes
      // this hands the renderer — a prefix that no longer matches its family
      // would read as a fix while offering the row.
      expect(prefixes(provider).some(prefix => workflowSlashCommandId('ship').startsWith(prefix))).toBe(true)
      expect(prefixes(provider).some(prefix => pluginWorkflowCommandId('acme', 'ship').startsWith(prefix))).toBe(true)
    }
  })

  // Found by P3.71's own enumeration of the menu, and it is the third instance
  // of the same shape rather than a new one: the remote agent DECLARES
  // `compact: { manual: false }` and `dispatchSlashCommandAction` obeys the
  // declaration — so the row was listed and picking it did nothing at all. The
  // exclusion reads that same resolved declaration rather than naming the
  // runtime, so the menu and the renderer's gate cannot disagree.
  test('compact is withdrawn from the menu wherever manual compaction is declared unavailable', () => {
    for (const provider of ['pi', 'anthropic', 'codex-runtime', 'nestor-cloud-agent'] as const) {
      const caps = resolveComposerCapabilities({ provider })
      expect(
        Boolean(caps.slash.excludedCommandIds?.includes('compact')),
        provider,
      ).toBe(caps.contextUsage?.compact?.manual === false)
    }
    // Positive control in both directions: the rule has a true case and a false
    // case, so an emptied exclusion list cannot pass by vacuum.
    expect(resolveComposerCapabilities({ provider: 'nestor-cloud-agent' })
      .slash.excludedCommandIds).toContain('compact')
    expect(resolveComposerCapabilities({ provider: 'pi' })
      .slash.excludedCommandIds ?? []).not.toContain('compact')
  })

  // P6.264 · `/context` renders a per-category breakdown when the snapshot
  // carries `categories`, and falls back to per-bucket totals when it does not.
  // On codex neither exists — the totals it does report are not bucketed — so
  // the overlay resolves to one "unattributed" row holding every token, and the
  // menu entry promises a breakdown the runtime cannot produce.
  test('context is withdrawn on codex, the runtime with no breakdown to draw', () => {
    const excludes = (provider: ModelProvider): boolean =>
      Boolean(resolveComposerCapabilities({ provider }).slash.excludedCommandIds?.includes('context'))

    expect(excludes('codex-runtime')).toBe(true)
    // Deliberately NOT derived from `contextUsage.kind === 'unavailable'`, and
    // P6.264 is why the two must stay pinned apart rather than merged. The
    // anthropic arm reported exactly that until 2026-09-07, while the vendored
    // SDK published a full `SDKContextUsage` this host fetched and discarded;
    // withdrawing `/context` there would have removed the richest breakdown
    // available. `ClaudeAgent.requestContextUsage` now returns it mapped, so
    // the arm is `fresh-local` — and the exclusion still is not derived from
    // the kind, because the reason codex is withdrawn is that it has no
    // breakdown, not that a field says so.
    expect(resolveComposerCapabilities({ provider: 'anthropic' }).contextUsage?.kind)
      .toBe('fresh-local')
    for (const provider of ['pi', 'anthropic', 'nestor-cloud-agent'] as const) {
      expect(excludes(provider), provider).toBe(false)
    }
  })

  // T17 — `/quota` reads `GET /api/v1/quota`, which only the Nestor gateway
  // serves, so every OTHER provider excludes it. Spelled as an exclusion, not
  // as a `commandIds` allowlist: the array form of `commandIds` is typed and
  // honoured but no production call site has ever passed one, while the
  // exclusion path is the one with end-to-end coverage.
  test('quota is offered on nestor-cloud-agent and excluded everywhere else', () => {
    const excludes = (provider: ModelProvider): boolean =>
      Boolean(resolveComposerCapabilities({ provider }).slash.excludedCommandIds?.includes('quota'))

    expect(excludes('nestor-cloud-agent')).toBe(false)
    for (const provider of ['pi', 'anthropic', 'codex-runtime'] as const) {
      expect(excludes(provider), provider).toBe(true)
    }
  })

  // T19 — the gate is CONNECTION-shaped, not provider-shaped. The same daily
  // budget that `/api/v1/quota` reports meters the CLI-proxy routes the built-in
  // Pi Nessy Gateway card talks through (`cli_proxy_handler.go:109,:205,:286-298`),
  // so that connection can answer the command — the Pi card at T19, and the
  // claude and codex gateway cards since F1.6. A connection pointed anywhere
  // else (BYOK) has no Nestor budget to report and must not offer it.
  //
  // The discriminator is the repo's established CONNECTION rule — normalised
  // whole-URL equality with the chat base
  // (`backend/internal/drivers/upstream-target.ts` symbol
  // `isNessyGatewayBaseUrl`, the same rule that decides whether the dp JWT is a
  // connection's credential of record) — never a second spelling.
  test('quota follows the CONNECTION on every local runtime: the gateway offers it, BYOK and connectionless do not', () => {
    const offers = (provider: ModelProvider, connection?: LlmConnection): boolean => {
      const slash = resolveComposerCapabilities({ provider, ...(connection ? { connection } : {}) }).slash
      if (slash.commandIds !== 'all' && !slash.commandIds.includes('quota')) return false
      return !slash.excludedCommandIds?.includes('quota')
    }
    const gateway: LlmConnection = {
      ...BASE_COMPAT,
      slug: 'nessy-gateway',
      baseUrl: `${NESTOR_CLI_BASE_PREFIX}openai-like/v1`,
    }
    const byok: LlmConnection = { ...BASE_COMPAT, slug: 'byok', baseUrl: 'https://api.deepseek.com/v1' }
    // DA1.44 — a BYO endpoint ON the gateway HOST, under the `…/api/v1/cli/`
    // prefix but not at a named gateway endpoint. The old `isNestorCliBaseUrl`
    // discriminator accepted it and offered `/quota`, while DA1.10 measured that
    // such a connection receives no dp JWT at all. `api.deepseek.com` cannot
    // catch this: it fails every predicate in the family.
    const onPrefixByo: LlmConnection = {
      ...BASE_COMPAT,
      slug: 'on-prefix-byo',
      baseUrl: `${NESTOR_CLI_BASE_PREFIX}personal/v1`,
    }
    // Review R1, 2026-09-17 — the arm NO control covered, and the reason the one
    // above is not enough. `onPrefixByo` is a CLI-prefix SIBLING of the chat
    // base, which `isNestorGatewayCredentialUrl` already rejected, so it passed
    // against the defect. THIS one is a SUBPATH of the chat base, the shape that
    // predicate's third arm (`startsWith(<chat base>/)`) accepts — right for a
    // REQUEST url, wrong for a CONNECTION. It was offered `/quota` at DA1.44 and
    // must not be.
    const chatBaseSubpathByo: LlmConnection = {
      ...BASE_COMPAT,
      slug: 'chat-base-subpath-byo',
      baseUrl: `${NESTOR_CLI_BASE_PREFIX}openai-like/v1/pi_compat`,
    }

    // Fixture control: the new negative must really BE a subpath of the positive
    // fixture's URL, or it proves nothing about the arm it exists to cover.
    expect(chatBaseSubpathByo.baseUrl?.startsWith(`${gateway.baseUrl}/`)).toBe(true)

    expect(offers('pi', gateway)).toBe(true)
    // Negative controls, every direction of the rule.
    expect(offers('pi', byok)).toBe(false)
    expect(offers('pi')).toBe(false)
    expect(offers('pi', onPrefixByo)).toBe(false)
    expect(offers('pi', chatBaseSubpathByo)).toBe(false)
    // F1.6 (origin D1.77) FLIPPED this control, on purpose and with its reason.
    // It pinned the Claude gateway card OUT ("its runtime has no `/quota` path"),
    // and DA1.17 left it standing because widening was an open owner posture.
    // OWNER 2026-09-18 ~16:40 item 3 took it: a non-BYO gateway card reads the
    // gateway budget, host-side, through the same read the Pi card makes — so
    // the claude AND codex gateway cards are now offered the row, and the two
    // overrides that answer it read the budget instead of pointing at the Pi
    // card (`agent/__tests__/gateway-quota-pointer.test.ts`, same commit).
    const claudeGateway: LlmConnection = { ...gateway, slug: 'claude-gateway', providerType: 'claude-runtime' }
    const codexGateway: LlmConnection = { ...gateway, slug: 'codex-gateway', providerType: 'codex-runtime' }
    expect(offers('anthropic', claudeGateway)).toBe(true)
    expect(offers('codex-runtime', codexGateway)).toBe(true)
    // …and still ONLY on the gateway: the same BYO shapes that keep Pi out keep
    // both of these out, in every direction DA1.44 and R1 found.
    for (const provider of ['anthropic', 'codex-runtime'] as const) {
      for (const byoShape of [byok, onPrefixByo, chatBaseSubpathByo]) {
        expect(offers(provider, byoShape), `${provider}/${byoShape.slug}`).toBe(false)
      }
      expect(offers(provider), `${provider}/no connection`).toBe(false)
    }
    // The remote agent is unchanged by the widening.
    expect(offers('nestor-cloud-agent')).toBe(true)
  })

  test('the built-in Pi gateway card keeps btw/recap while gaining quota', () => {
    // The two gates are independent: `/btw` and `/recap` ride Pi's own
    // `queryLlm`, which works on the gateway card, so widening the quota gate
    // must not subtract them.
    const caps = resolveComposerCapabilities({
      provider: 'pi',
      connection: { ...BASE_COMPAT, baseUrl: `${NESTOR_CLI_BASE_PREFIX}openai-like/v1` },
    })

    expect(caps.slash.commandIds).toBe('all')
    // `approve` is codex-only (P2.217) and this is a Pi connection, so it is
    // the one expected member. Asserted as the WHOLE list rather than with a
    // `not.toContain` pair, because the row's point is that widening the quota
    // gate subtracted nothing else.
    expect(caps.slash.excludedCommandIds ?? []).toEqual(['approve'])
  })

  test('nestor-cloud-agent uses live AgentCard modes when provided', () => {
    const caps = resolveComposerCapabilities({
      provider: 'nestor-cloud-agent',
      cloudModes: [
        {
          mode: 'plan',
          label: 'Design',
          shortLabel: 'Design',
          description: 'Remote design mode',
          iconMode: 'plan',
          remoteModeId: 'design',
        },
        {
          mode: 'default',
          label: 'Review',
          shortLabel: 'Review',
          description: 'Remote review mode',
          iconMode: 'default',
          remoteModeId: 'review',
        },
      ],
    })

    expect(caps.permissions.modes).toEqual(['plan', 'default'])
    expect(caps.permissions.modeOptions?.map(({ mode, label, remoteModeId }) => ({ mode, label, remoteModeId }))).toEqual([
      { mode: 'plan', label: 'Design', remoteModeId: 'design' },
      { mode: 'default', label: 'Review', remoteModeId: 'review' },
    ])
  })

  test('per-model image resolution for pi compat endpoints', () => {
    const conn: LlmConnection = {
      ...BASE_COMPAT,
      customEndpoint: { api: 'openai-completions', supportsImages: true },
      models: [{ id: 'text-only-model', supportsImages: false } as never],
    }

    const caps = resolveComposerCapabilities({
      provider: 'pi',
      connection: conn,
      model: 'text-only-model',
    })

    expect(caps.attachments.images).toBe('no')
  })

  test('unknown provider gets conservative defaults', () => {
    const caps = resolveComposerCapabilities({ provider: 'unknown' as never })

    expect(caps.submit.steer).toBe(true)
    expect(caps.reasoning.levels).toEqual([])
  })

  // P2.124 — the context-usage arm used to be an if-chain whose CATCH-ALL was
  // the `anthropic` answer, so a provider nobody had described inherited
  // `thresholdKind: 'formula-claude'`: a compaction warning computed from a
  // context window only the Claude SDK reports. A fabricated number presented as
  // a measurement is worse than no number, so the unknown case now makes no
  // claim. (The chain is an exhaustive one now; a runtime added to the union
  // fails the typecheck instead of reaching this line at all.)
  test('an unknown provider inherits no threshold arithmetic from Claude', () => {
    const unknown = resolveComposerCapabilities({ provider: 'unknown' as never }).contextUsage
    expect(unknown?.thresholdKind).toBe('none')
    // Negative control: `anthropic` really does declare the formula, so this is
    // a difference between two answers and not a field that is 'none' for all.
    expect(resolveComposerCapabilities({ provider: 'anthropic' }).contextUsage?.thresholdKind)
      .toBe('formula-claude')
  })

  // The composer asks the SERVER whether this session may move, instead of
  // guessing from the transcript length as the renderer used to.
  test('every local runtime reports itself switchable, and names itself', () => {
    expect(resolveComposerCapabilities({ provider: 'pi' }).connection)
      .toEqual({ switchable: true, activeRuntime: 'pi' })
    expect(resolveComposerCapabilities({ provider: 'anthropic' }).connection)
      .toEqual({ switchable: true, activeRuntime: 'anthropic' })
    expect(resolveComposerCapabilities({ provider: 'codex-runtime' }).connection)
      .toEqual({ switchable: true, activeRuntime: 'codex-runtime' })
  })

  // Negative subject for the flag: `nestor-cloud-agent` is out of scope as a
  // switch target AND as a source. Without this, a field hard-coded to `true`
  // would pass the test above.
  test('the remote agent is not switchable', () => {
    const caps = resolveComposerCapabilities({ provider: 'nestor-cloud-agent' })
    expect(caps.connection.switchable).toBe(false)
    expect(caps.connection.activeRuntime).toBe('nestor-cloud-agent')
  })

  // P6.940 — the composer's `@X`, reported only where the pin lands. Two arms
  // since P6.961: clause (1) built claude's, clause (2) built Pi's projection.
  test('names the pinned session agent on claude and on Pi, and on nobody else', () => {
    // POSITIVE: claude has a main-thread agent option and this host sets it
    // (`pinClaudeMainThreadAgent`, P6.312), so the badge names a fact.
    expect(resolveComposerCapabilities({ provider: 'anthropic', sessionAgent: 'reviewer' }).sessionAgent)
      .toBe('reviewer')
    // POSITIVE, the second arm (P6.961): Pi has no main-session-agent option, so
    // clause (2) composes the projection in the host — `resolvePiSessionAgentPin`
    // feeds `piSessionAgentPrompt`, the intersected tool universe and the
    // one-shot initial prompt. The session BEHAVES as the agent, so saying
    // nothing about it was the same lie with the sign flipped.
    expect(resolveComposerCapabilities({ provider: 'pi', sessionAgent: 'reviewer' }).sessionAgent)
      .toBe('reviewer')
    // NEGATIVE, and it is the whole reason the field is resolved server-side
    // rather than read from the setting by the renderer: the key is app-wide,
    // the pin is not. codex layers role config for SPAWNED agents only, so a
    // badge there would name an agent the session is not running as.
    for (const provider of ['codex-runtime', 'nestor-cloud-agent'] as const) {
      expect(
        resolveComposerCapabilities({ provider, sessionAgent: 'reviewer' }).sessionAgent,
        provider,
      ).toBeUndefined()
    }
    // And an unpinned claude session carries no field at all, so an ordinary
    // session is byte-identical to one built before this row.
    const unpinned = resolveComposerCapabilities({ provider: 'anthropic' })
    expect('sessionAgent' in unpinned).toBe(false)
  })

  // P6.951 built the arm on two runtimes; P6.963 turned Pi's on once the note
  // had a route to the model there; P6.864 widened the field to BOTH answers,
  // which is why the flag is `answerNote` and not `denialNote`.
  test('offers the answer note on all three coding runtimes, and on nobody else', () => {
    // POSITIVE. The denial half is native by three mechanisms — claude's deny
    // branch carries `message`, codex's `buildApprovalResponse` takes a
    // `rejection`, Pi's host permission service writes the receipt `reason` —
    // and the approval half is native on NONE of them, so all three take the
    // host queue instead (`BaseAgent.recordPermissionAnswerNote`). One boolean
    // stays honest because a runtime carries both halves or neither.
    for (const provider of ['anthropic', 'pi', 'codex-runtime'] as const) {
      expect(resolveComposerCapabilities({ provider }).answerNote, provider).toBe(true)
    }
    // NEGATIVE: the remote agent has no such channel, and the field is ABSENT
    // rather than false — the card draws nothing and the wire is unchanged.
    const remote = resolveComposerCapabilities({ provider: 'nestor-cloud-agent' })
    expect('answerNote' in remote).toBe(false)
  })

  // UB14.34 (R4-14) — the pasted-snippet "Run in background" offer, gated on the runtime's OWN
  // background shell (claude's Bash `run_in_background`, Pi's bash `run_in_background`), never a
  // providerType in the renderer. The env is passed so the host's own env cannot decide the arm.
  test('UB14.34 — backgroundShell on claude (incl. claude-runtime) and Pi; absent on codex and the remote agent', () => {
    const on = {} as Record<string, string | undefined>
    // POSITIVE: both runtimes whose own tool backgrounds a command, the gateway claude card included.
    for (const provider of ['anthropic', 'pi'] as const) {
      expect(resolveComposerCapabilities({ provider, env: on }).backgroundShell, provider).toBe(true)
    }
    const claudeGateway = resolveComposerCapabilities({
      provider: 'anthropic',
      connection: { slug: 'claude-gateway', name: 'Claude Code', providerType: 'claude-runtime', authType: 'api_key_with_endpoint', baseUrl: 'http://localhost:9', createdAt: 1 },
      env: on,
    })
    expect(claudeGateway.backgroundShell).toBe(true)
    // NEGATIVE: codex (unmeasured until UB14.19) and the remote agent carry NO field — absent, not false.
    for (const provider of ['codex-runtime', 'nestor-cloud-agent'] as const) {
      expect('backgroundShell' in resolveComposerCapabilities({ provider, env: on }), provider).toBe(false)
    }
  })

  test('UB14.34 — the background-task off switch withdraws backgroundShell on BOTH runtimes that have it', () => {
    // NEGATIVE: NESSY_DISABLE_BACKGROUND_TASKS=1 is the one predicate every detach site reads (Pi refuses
    // run_in_background on it; claude gets it projected as CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).
    for (const provider of ['anthropic', 'pi'] as const) {
      const off = resolveComposerCapabilities({ provider, env: { NESSY_DISABLE_BACKGROUND_TASKS: '1' } })
      expect('backgroundShell' in off, provider).toBe(false)
    }
    // BOUNDARY: '0' is not "off" — the field is back, so the arm above can fail.
    expect(resolveComposerCapabilities({ provider: 'pi', env: { NESSY_DISABLE_BACKGROUND_TASKS: '0' } }).backgroundShell).toBe(true)
  })

  // UB12.77 — `externalFooter` kept its footer-era name (every 1.x renderer reads `externalFooter.gitBranch`
  // unguarded) and now answers only what something reads: the toolbar branch chip.
  test('UB12.77 — externalFooter answers gitBranch on every provider, and no longer carries the unread workingDir', () => {
    for (const provider of ['pi', 'anthropic', 'codex-runtime', 'nestor-cloud-agent'] as const) {
      const footer = resolveComposerCapabilities({ provider }).externalFooter
      // POSITIVE: the branch chip's gate is still answered, and true, on every provider (unchanged since 1.0.1).
      expect({ provider, gitBranch: footer.gitBranch }).toEqual({ provider, gitBranch: true })
      // NEGATIVE: the retired half is gone from the wire, not merely false.
      expect({ provider, workingDir: 'workingDir' in footer }).toEqual({ provider, workingDir: false })
    }
  })
})
