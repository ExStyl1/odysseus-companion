import { CodedError, RPC_CHANNELS, type ConnectionInUseData, type LlmConnectionSetup } from '@nessy-agent/shared/protocol'
import { isNonGatewayConnectionRefused, resolveCodexModelProvider, getLlmConnections, getLlmConnection, addLlmConnection, updateLlmConnection, deleteLlmConnection, getDefaultLlmConnection, setDefaultLlmConnection, touchLlmConnection, isCompatProvider, isAnthropicProvider, getDefaultModelsForConnection, getDefaultModelForConnection, type LlmConnection, type LlmConnectionWithStatus, toBedrockNativeId, deriveBedrockRegionPrefix, readBedrockRegionPrefixOverride, BEDROCK_REGION_PREFIX_ENV_VAR, BEDROCK_REGION_PREFIX_OVERRIDE_VALUES } from '@nessy-agent/shared/config'
import { describeBedrockRegion, resolveBedrockRegion, resolveCodexBedrockCardRegion } from '@nessy-agent/shared/agent/bedrock-region'
import { getCredentialManager } from '@nessy-agent/shared/credentials'
import { createLogger } from '@nessy-agent/shared/utils'
import { setSetupDeferred } from '@nessy-agent/shared/config/storage'
import {
  isGatewayBackedConnection,
  isNessyGatewayBaseUrl,
  resolveSetupTestConnectionHint,
  testBackendConnection,
  validateStoredBackendConnection,
} from '@nessy-agent/shared/agent/backend'
import { getModelRefreshService } from '@nessy-agent/server-core/model-fetchers'
import { parseTestConnectionError, createBuiltInConnection, validateModelList, validateMiniModel, piAuthProviderDisplayName, validateSetupTestInput, setupTestRequiresApiKey, resolveCustomEndpointSetup, resolveAdapterRuntimeAuthType, resolveSetupTestApiKey, maskApiKey, isMaskedApiKey } from '@nessy-agent/server-core/domain'
import { getWorkspaceOrThrow, buildBackendHostRuntimeContext } from '@nessy-agent/server-core/handlers'
import { pushTyped, type RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { randomUUID } from 'node:crypto'
import { CLIENT_OPEN_EXTERNAL } from '@nessy-agent/server-core/transport'

/**
 * DA1.58 — the sink the CREDENTIAL-LIFECYCLE lines of this handler use, and why
 * it is not `deps.platform.logger`.
 *
 * Measured 2026-09-17 on the packaged 1.39.0 (lane SIT, RS-41): the DA1.13
 * migration RAN — the store held a masked key before the card re-run and `null`
 * after — and neither its own sentence nor its sibling *"Saved API key to LLM
 * connection"*, fired seconds earlier by the same handler, was anywhere in the
 * app's captured output, while `[ws-rpc-server]`, `[dp-auth]` and
 * `[ConfigWatcher]` lines from the same run were.
 *
 * The cause is not this file. In the Electron host `deps.platform.logger` is
 * `electron-log` (`apps/electron/src/main/platform.ts` symbol
 * `createElectronPlatform` takes it from `main/index.ts`), and
 * `apps/electron/src/main/logger.ts` sets BOTH `log.transports.file.level` and
 * `log.transports.console.level` to `false` whenever `isDebugMode` is false —
 * which a packaged build is unless launched with `-- --debug` (F1.767; Node
 * claims a bare `--debug` and the app exits, `scripts/cdp/lib/runtime-session-log.ts`
 * symbol `DEBUG_LEVER`). That silence is the app's DELIBERATE posture, not a
 * defect: AGENTS.md records it, and the auto-update log exists precisely because
 * of it. The headless host is unaffected — `platform-headless.ts` supplies a
 * console logger that always writes.
 *
 * So the repair is not to reopen that sink. It is to put the lines an operator
 * needs when they are diagnosing an auth problem on the sink this repo already
 * has for exactly that, and that the neighbours above use: `createLogger`, gated
 * by `NESSY_DEBUG=1`, which writes to stderr AND mirrors into `electron-log` in
 * the main process, so a dev build keeps them in `main.log` as before.
 *
 * SCOPE, stated rather than left to be guessed: only the credential-lifecycle
 * decisions of `setupLlmConnection` move here — what this setup did with the
 * credential. The rest of the handler's `platform.logger` calls stay where they
 * are, and `testLlmConnectionSetup`'s especially: those log up to 1 000
 * characters of a raw upstream error body, and moving THEM to a sink an operator
 * can switch on is a disclosure change rather than a repair.
 */
const credentialLog = createLogger('llm-connections')

/**
 * DA1.60 — the refusal this handler answers with when a caller sends a
 * credential for the Nessy Gateway's own endpoint.
 *
 * It is the FORM's own verdict token
 * (`apps/electron/src/renderer/components/apisetup/byo-runtime.ts` returns
 * `{ valid: false, field: 'baseUrl', error: 'endpointIsGateway' }`, which
 * `components/onboarding/ByoRuntimeStep.tsx` maps to
 * `onboarding.byoRuntime.errorEndpointIsGateway`), deliberately spelled the same
 * on both doors so ONE sentence can serve them.
 *
 * A token rather than a wire `ErrorCode`: adding a member to `ErrorCode`
 * (`packages/shared/src/protocol/types.ts`) also obliges the iOS mirror
 * (`WireError.swift`, which has a round-trip guard) and a renderer translation
 * with its locale keys — an M-sized change across three lanes for a backstop the
 * form already refuses in front of. A renderer that wants the sentence reuses
 * the map it already has for this exact token; until it does, the raw token is
 * what a non-form caller (the CDP harness, the iOS client) sees, which is the
 * right audience for a backstop.
 */
const GATEWAY_ENDPOINT_REFUSAL = 'endpointIsGateway'

/**
 * The placeholder an edit form sends back for a credential it never saw.
 *
 * One spelling, two readers (the DA1.60 refusal above and the credential branch
 * of `setupLlmConnection`), because a refusal that disagreed with the store
 * about what "masked" means would reject a user's ordinary re-save. Since UB3.4
 * the spelling IS shared: this alias is `isMaskedApiKey` from
 * connection-setup-logic, the same predicate the placeholder resolution runs.
 */
const isMaskedCredential = isMaskedApiKey

// Local OAuth state
let copilotOAuthAbort: AbortController | null = null

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.llmConnections.LIST,
  RPC_CHANNELS.llmConnections.LIST_WITH_STATUS,
  RPC_CHANNELS.llmConnections.GET,
  RPC_CHANNELS.llmConnections.GET_API_KEY,
  RPC_CHANNELS.llmConnections.SAVE,
  RPC_CHANNELS.llmConnections.DELETE,
  RPC_CHANNELS.llmConnections.TEST,
  RPC_CHANNELS.llmConnections.SET_DEFAULT,
  RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT,
  RPC_CHANNELS.llmConnections.REFRESH_MODELS,
  RPC_CHANNELS.chatgpt.START_OAUTH,
  RPC_CHANNELS.chatgpt.COMPLETE_OAUTH,
  RPC_CHANNELS.chatgpt.CANCEL_OAUTH,
  RPC_CHANNELS.chatgpt.GET_AUTH_STATUS,
  RPC_CHANNELS.chatgpt.LOGOUT,
  RPC_CHANNELS.copilot.START_OAUTH,
  RPC_CHANNELS.copilot.CANCEL_OAUTH,
  RPC_CHANNELS.copilot.GET_AUTH_STATUS,
  RPC_CHANNELS.copilot.LOGOUT,
  RPC_CHANNELS.settings.SETUP_LLM_CONNECTION,
  RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP,
  RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS,
  RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL,
  RPC_CHANNELS.pi.GET_PROVIDER_MODELS,
] as const

/**
 * C3.368 · at most this many names per kind in the in-use refusal.
 *
 * The refusal is one line in a toast. A connection held by forty chats renders
 * as a wall without a bound, and a wall is the same "cannot act on it" the
 * counts-only message had.
 */
const CONNECTION_HOLDER_NAME_LIMIT = 5

/**
 * The names behind `CONNECTION_IN_USE`, sessions first and automations second —
 * the same order the sentence in front of them counts.
 *
 * Deliberately NO English labels of its own: the sentence already says "N
 * session(s) and M automation(s)", and the names themselves are user-authored
 * text. That keeps the one part a renderer cannot translate separable from the
 * one part it must.
 */
function describeConnectionHolders(
  sessionNames: readonly string[],
  automationNames: readonly string[],
): string {
  const list = (names: readonly string[]): string => {
    const shown = names.slice(0, CONNECTION_HOLDER_NAME_LIMIT).map(name => `"${name}"`).join(', ')
    const rest = names.length - CONNECTION_HOLDER_NAME_LIMIT
    return rest > 0 ? `${shown} and ${rest} more` : shown
  }
  return [
    ...(sessionNames.length > 0 ? [list(sessionNames)] : []),
    ...(automationNames.length > 0 ? [list(automationNames)] : []),
  ].join('; ')
}

/**
 * D1.150 — the same two lists as DATA, for the renderer that cannot translate
 * the sentence above.
 *
 * The English string stays exactly as it is: it is what a log, a headless
 * client and the onboarding surface (which prints the server's message verbatim)
 * still read. This is the second reading of the same two arrays, taken at the
 * same moment from the same inputs, so the sentence and the payload can never
 * name different chats — the same rule the model-target derivation states for
 * its own pair.
 *
 * The BOUND is applied here rather than left to the renderer, because the bound
 * exists to stop a wall of names crossing the wire at all, and a renderer that
 * decided it would be a second policy.
 */
function connectionHolderData(
  sessionNames: readonly string[],
  automationNames: readonly string[],
): ConnectionInUseData {
  return {
    sessions: sessionNames.slice(0, CONNECTION_HOLDER_NAME_LIMIT),
    automations: automationNames.slice(0, CONNECTION_HOLDER_NAME_LIMIT),
    moreSessions: Math.max(0, sessionNames.length - CONNECTION_HOLDER_NAME_LIMIT),
    moreAutomations: Math.max(0, automationNames.length - CONNECTION_HOLDER_NAME_LIMIT),
  }
}

/**
 * Fire-and-forget model-list refresh after a credential change (setup, re-auth,
 * validation) — UB3.5 / H20, upstream #820. Re-auth can switch to an account
 * with different model entitlements, so the cached list from the previous
 * account must be replaced. Never throws into the caller — a failed refresh
 * must not fail the credential flow that triggered it. (Exported for the unit
 * test; production binds the refresh service and this handler's logger.)
 */
export function createModelRefreshInBackground(
  getService: () => { refreshNow(slug: string): Promise<void> },
  warn: (message: string) => void,
): (slug: string, context: string) => void {
  return (slug: string, context: string) => {
    try {
      getService().refreshNow(slug).catch(err => {
        warn(`Model refresh after ${context} failed for ${slug}: ${err instanceof Error ? err.message : err}`)
      })
    } catch (err) {
      warn(`Model refresh service unavailable after ${context} for ${slug}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

export function registerLlmConnectionsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const refreshModelsInBackground = createModelRefreshInBackground(
    () => getModelRefreshService(),
    (message) => deps.platform.logger?.warn(message),
  )
  const { sessionManager } = deps

  // Unified handler for LLM connection setup
  server.handle(RPC_CHANNELS.settings.SETUP_LLM_CONNECTION, async (_ctx, setup: LlmConnectionSetup): Promise<{ success: boolean; error?: string }> => {
    try {
      const manager = getCredentialManager()

      // P6.498 — the operator's gateway-only lock, refused HERE because this is
      // the one door every card's submit goes through: the four one-click
      // gateway cards, the API-key form, the OAuth flows and the BYO endpoint
      // form all land on this handler, so a refusal here cannot be routed
      // around by a client that never drew the card.
      //
      // Delegated decision Q-den 15 = option A. Runtime-BLIND on purpose:
      // `isNonGatewayConnectionRefused` takes no provider term, so the refusal
      // is identical on Pi, claude and codex — which is the whole reason the
      // lock is not claude's own `forceLoginMethod` (which our tier cannot
      // carry anyway; measured, and recorded in `DOCUMENTED_UNENFORCED_KEYS`).
      //
      // A THROWN CodedError, for `CONNECTION_IN_USE`'s reason further down this
      // file: the renderer translates the refusal instead of printing an
      // English server string.
      // Read from the EXISTING record where there is one and from the submitted
      // base URL otherwise, because a new connection has no record yet and an
      // edit must be judged on the endpoint it is being pointed AT, not the one
      // it currently has.
      const setupTarget = getLlmConnection(setup.slug)
      if (isNonGatewayConnectionRefused({
        providerType: setupTarget?.providerType ?? null,
        baseUrl: setup.baseUrl ?? setupTarget?.baseUrl ?? null,
      })) {
        throw new CodedError(
          'CONNECTION_GATEWAY_ONLY',
          `"${setup.slug}" is not a gateway connection, and this install requires the gateway sign-in`,
        )
      }

      // DA1.60 — the form's `endpointIsGateway` rule, on the door every client
      // shares. BEFORE the connection is persisted, because a refusal after the
      // write leaves the connection behind.
      //
      // Measured 2026-09-17 on the packaged 1.39.0 (lane SIT, RS-40): a
      // `setupLlmConnection` carrying the EXACT gateway URL and a key answered
      // `success: true` and produced a connection, because the only enforcement
      // point was `validateByoRuntimeForm` / `validateMergedEndpointForm` — a
      // renderer FORM rule — and the shipped ADD form renders no endpoint input
      // at all (`#byo-base-url` and `#base-url` both absent).
      //
      // ## Why the CREDENTIAL and not the URL alone
      //
      // The row asked for the exact gateway URL to be refused. It cannot be,
      // and the reason is worth reading before someone widens this: the
      // one-click cards submit through THIS handler with THAT url —
      // `buildGatewaySetup('pi', …)` produces
      // `{slug:'pi-api-key', baseUrl:<the gateway url>, customEndpoint:{api:'openai-completions'}, …}`,
      // which is byte-for-byte the shape a custom-endpoint form submit would
      // have. There is no server-visible marker separating the two, so an
      // unconditional refusal would take the whole gateway feature away (the
      // DA1.13 suite next door says so in one line: `PI_CARD_SETUP` expects
      // `success: true`).
      //
      // What IS separable is the credential, and it is also the whole harm the
      // form's own docblock names: a key sent for that URL is silently ignored,
      // because a `{kind:'nestor'}` upstream authenticates with the dp JWT and
      // never reads the connection credential
      // (`upstream-target.ts` symbol `attachUpstreamCredential`). DA1.13 made
      // that drop SILENT; this makes it a refusal with the code the form
      // already uses, so one vocabulary serves both doors. No card is affected:
      // none of the three sends a credential, and DA1.32 removed the prefill
      // that used to put a live JWT into the form field.
      //
      // RESIDUE, stated rather than hidden: a caller that sends the gateway URL
      // with NO credential still creates a connection. That is the card's own
      // shape and refusing it is what would break the feature; a duplicate
      // gateway card is the worst it can produce.
      //
      // The gateway-HOST non-gateway URL stays ACCEPTED with its key intact —
      // per AGENTS.md it is an ordinary custom endpoint — which is why the
      // predicate here is the whole-URL `isNessyGatewayBaseUrl` and never the
      // host-class one.
      if (
        setup.credential
        && !isMaskedCredential(setup.credential)
        && isNessyGatewayBaseUrl(setup.baseUrl ?? setupTarget?.baseUrl ?? undefined)
      ) {
        return { success: false, error: GATEWAY_ENDPOINT_REFUSAL }
      }

      // Ensure connection exists in config
      let connection = getLlmConnection(setup.slug)
      let isNewConnection = false
      if (!connection) {
        // Reauth guard: if updateOnly is set, the connection must already exist.
        // Clean up any orphaned credentials from a preceding OAuth flow.
        if (setup.updateOnly) {
          await manager.deleteLlmCredentials(setup.slug).catch(() => {})
          deps.platform.logger?.warn(`[SETUP_LLM_CONNECTION] updateOnly rejected for missing slug: ${setup.slug}`)
          return { success: false, error: 'Connection not found. Cannot re-authenticate a non-existent connection.' }
        }
        // Create connection with appropriate defaults based on slug
        connection = createBuiltInConnection(setup.slug, setup.baseUrl)
        isNewConnection = true
      }

      const updates: Partial<LlmConnection> = {}
      const hasConfiguredBaseUrl = !!setup.baseUrl?.trim()
      if (setup.baseUrl !== undefined) {
        updates.baseUrl = setup.baseUrl?.trim() || undefined

        // Only mutate providerType for API key connections (not OAuth connections)
        if (isAnthropicProvider(connection.providerType) && connection.authType !== 'oauth') {
          if (hasConfiguredBaseUrl) {
            updates.providerType = 'pi_compat'
            updates.authType = 'api_key_with_endpoint'
            updates.customEndpoint = { api: 'anthropic-messages' }
          } else {
            updates.providerType = 'anthropic'
            updates.authType = 'api_key'
            updates.models = getDefaultModelsForConnection('anthropic')
            updates.defaultModel = getDefaultModelForConnection('anthropic')
          }
        }

        // Pi API key flow: store baseUrl on the connection (Pi SDK doesn't use it yet,
        // but it's persisted for future backend support)

      }

      if (setup.defaultModel !== undefined) {
        updates.defaultModel = setup.defaultModel ?? undefined
      }
      if (setup.models !== undefined) {
        updates.models = setup.models ?? undefined
      }
      if (setup.modelSelectionMode !== undefined) {
        updates.modelSelectionMode = setup.modelSelectionMode
      }
      // The daily-metadata-refresh enrollment marker (C2). A number enrolls the
      // connection, `null` withdraws it, omitted leaves it as persisted.
      if (setup.modelsSyncedAt !== undefined) {
        updates.modelsSyncedAt = setup.modelsSyncedAt
      }
      // The utility-model slot (E1). Applied here, VALIDATED after the merge —
      // an edit payload may carry `miniModel` without `models`, so checking it
      // against `setup.models` alone would reject every such edit. Blank clears
      // it, which is how the form's free-text escape gets back to the
      // heuristic.
      if (setup.miniModel !== undefined) {
        updates.miniModel = setup.miniModel.trim() || undefined
      }

      const customEndpoint = hasConfiguredBaseUrl ? setup.customEndpoint : undefined
      const isCustomEndpointCompat = !!customEndpoint
      if (customEndpoint) {
        updates.customEndpoint = customEndpoint
        updates.providerType = 'pi_compat'
        const branch = resolveCustomEndpointSetup({
          baseUrl: setup.baseUrl ?? undefined,
          credential: setup.credential ?? undefined,
          customEndpointApi: customEndpoint.api,
        })
        updates.authType = branch.authType
        if (branch.name !== undefined) updates.name = branch.name
        if (branch.piAuthProvider !== undefined) updates.piAuthProvider = branch.piAuthProvider

        // Brand-name override on first setup only (user-renamed connections aren't clobbered on re-save).
        if (isNewConnection && !updates.name && setup.baseUrl?.toLowerCase().includes('manifest.build')) {
          updates.name = 'Manifest'
        }
      } else if (setup.baseUrl !== undefined) {
        // Base URL was explicitly updated without custom protocol config.
        // Treat this as non-custom mode and clear stale custom endpoint metadata.
        // Only downgrade existing connections — new ones already have the correct
        // providerType from createBuiltInConnection().
        updates.customEndpoint = undefined
        if (connection.providerType === 'pi_compat' && connection.authType !== 'oauth' && !isNewConnection) {
          updates.providerType = 'pi'
          updates.authType = 'api_key'
        }
      }

      // Explicit auth type from the BYO endpoint form (C3). Applied after the
      // branches above so it wins, and scoped by `resolveAdapterRuntimeAuthType`
      // to the two adapter-runtime provider types — the reason lives there.
      const requestedAuthType = resolveAdapterRuntimeAuthType(
        updates.providerType ?? connection.providerType,
        setup.authType,
      )
      if (requestedAuthType) {
        updates.authType = requestedAuthType
      }

      // Pi API key flow: set piAuthProvider from setup data (e.g. 'anthropic', 'google', 'openai').
      // Skip when custom endpoint protocol is driving routing.
      if (setup.piAuthProvider && !isCustomEndpointCompat) {
        updates.piAuthProvider = setup.piAuthProvider
        // Update connection name to show the actual provider (e.g. "Nessy Backend (Google AI Studio)")
        const providerName = piAuthProviderDisplayName(setup.piAuthProvider)
        if (providerName) {
          updates.name = `Nessy Backend (${providerName})`
        }
        // Only set default models when using standard Pi provider AND user didn't pick explicit models
        if (!hasConfiguredBaseUrl && !setup.models?.length) {
          updates.models = getDefaultModelsForConnection('pi', setup.piAuthProvider)
          updates.defaultModel = getDefaultModelForConnection('pi', setup.piAuthProvider)
          updates.modelSelectionMode ??= 'automaticallySyncedFromProvider'
        }
      }

      // Pi+Bedrock auth method override — set authType for IAM or environment auth.
      // providerType stays 'pi' (Bedrock routes through Pi SDK).
      if (setup.bedrockAuthMethod) {
        updates.authType = setup.bedrockAuthMethod
      }

      // Resolved Anthropic OAuth identity (issue #838). Threaded through SETUP so
      // it persists on both the new-connection path (addLlmConnection) and the
      // re-auth path (updateLlmConnection) via the shared pendingConnection/updates
      // flow below. Fail-soft: only stamp when at least one identity block arrived.
      const oauthIdentity = setup.oauthIdentity
      if (oauthIdentity?.account || oauthIdentity?.organization) {
        // Set only fields that are actually present, so `updates` never carries an
        // explicit `undefined` (matches the guarded-assignment style used above and
        // keeps the update intent clean). Missing sub-fields are simply not touched;
        // on re-auth the storage allowlist then preserves any prior value.
        if (oauthIdentity.account?.uuid) updates.oauthAccountUuid = oauthIdentity.account.uuid
        if (oauthIdentity.account?.emailAddress) updates.oauthAccountEmail = oauthIdentity.account.emailAddress
        if (oauthIdentity.organization?.uuid) updates.oauthOrganizationUuid = oauthIdentity.organization.uuid
        if (oauthIdentity.organization?.name) updates.oauthOrganizationName = oauthIdentity.organization.name
        updates.oauthProfileVerifiedAt = Date.now()
      }

      const effectiveProviderType = updates.providerType ?? connection.providerType
      if (effectiveProviderType === 'pi') {
        const isBedrockPi = (updates.piAuthProvider ?? connection.piAuthProvider) === 'amazon-bedrock'
        // For Pi+Bedrock, normalize bare Anthropic IDs to Bedrock-native before adding pi/ prefix
        // so that resolvePiModel() can find them in the amazon-bedrock registry.
        // Use the configured AWS region to select the correct inference profile prefix,
        // unless the operator has chosen one with ANTHROPIC_BEDROCK_REGION_PREFIX (P6.375).
        //
        // P6.457 — the region is RESOLVED first, through the same chain
        // `buildAwsEnv` hands the Pi subprocess (connection credential →
        // `AWS_REGION` → `AWS_DEFAULT_REGION`), and the prefix is derived from
        // that. Reading the form field alone made an empty field silently yield
        // `us` while the environment the subprocess inherits said `eu-west-1` —
        // the model id and the endpoint disagreeing, with nothing said. When the
        // chain answers nothing the AWS SDK's own remaining steps (the active
        // profile, then instance metadata) decide, and `us` stays the fallback
        // it has always been; the log line below says which of those happened
        // rather than leaving the prefix unexplained.
        const resolvedRegion = isBedrockPi ? resolveBedrockRegion(setup.awsRegion) : undefined
        const regionPrefix = isBedrockPi ? deriveBedrockRegionPrefix(resolvedRegion?.region) : undefined
        if (isBedrockPi) {
          deps.platform.logger?.info(
            `${describeBedrockRegion(resolvedRegion)} — Bedrock inference-profile prefix "${regionPrefix}"`,
          )
          // A setting that looks applied and is not is the failure this fork keeps
          // finding, so a value outside the page's list is NAMED here rather than
          // dropped. The derivation has already fallen back to the region table —
          // the safe direction — so this is a report, not a refusal.
          const override = readBedrockRegionPrefixOverride()
          if (override.kind === 'rejected') {
            deps.platform.logger?.warn(
              `${BEDROCK_REGION_PREFIX_ENV_VAR}="${override.value}" is not one of `
              + `${BEDROCK_REGION_PREFIX_OVERRIDE_VALUES.join(', ')}; ignoring it and `
              + `deriving "${regionPrefix}" from the AWS region instead`,
            )
          } else if (override.kind === 'accepted') {
            deps.platform.logger?.info(
              `${BEDROCK_REGION_PREFIX_ENV_VAR}="${override.prefix}" overrides the region-derived `
              + 'Bedrock inference-profile prefix',
            )
          }
        }
        const toPiModelId = (id: string) => {
          const bare = id.startsWith('pi/') ? id.slice(3) : id
          const normalized = isBedrockPi ? toBedrockNativeId(bare, regionPrefix) : bare
          return `pi/${normalized}`
        }
        if (updates.models) {
          updates.models = updates.models.map(m => typeof m === 'string' ? toPiModelId(m) : { ...m, id: toPiModelId(m.id) })
        }
        if (updates.defaultModel) {
          updates.defaultModel = toPiModelId(updates.defaultModel)
        }
        // Same normalization as the default: the form submits a bare id, and a
        // miniModel left unprefixed could never match the `pi/`-prefixed list
        // it is validated against — it would be rejected here, or silently
        // never resolve if it were not.
        if (updates.miniModel) {
          updates.miniModel = toPiModelId(updates.miniModel)
        }
      }

      const pendingConnection: LlmConnection = {
        ...connection,
        ...updates,
      }

      if (pendingConnection.providerType === 'pi') {
        const modelIds = (pendingConnection.models ?? []).map(m => typeof m === 'string' ? m : m.id)
        deps.platform.logger?.info('Pi setup pending connection snapshot', {
          slug: pendingConnection.slug,
          piAuthProvider: pendingConnection.piAuthProvider,
          modelSelectionMode: pendingConnection.modelSelectionMode,
          defaultModel: pendingConnection.defaultModel,
          modelCount: modelIds.length,
          modelsFirst5: modelIds.slice(0, 5),
          setupModelCount: setup.models?.length,
          setupDefaultModel: setup.defaultModel,
        })
      }

      if (pendingConnection.providerType === 'pi' && pendingConnection.piAuthProvider && !pendingConnection.modelSelectionMode) {
        const inferredMode = setup.models?.length
          ? 'userDefined3Tier'
          : 'automaticallySyncedFromProvider'
        pendingConnection.modelSelectionMode = inferredMode
        updates.modelSelectionMode = inferredMode
      }

      if (updates.models && updates.models.length > 0) {
        const validation = validateModelList(updates.models, pendingConnection.defaultModel)
        if (!validation.valid) {
          return { success: false, error: validation.error }
        }
        if (validation.resolvedDefaultModel) {
          pendingConnection.defaultModel = validation.resolvedDefaultModel
          updates.defaultModel = validation.resolvedDefaultModel
        }
      }

      // miniModel ∈ the POST-MERGE model list. `pendingConnection` is
      // `{...connection, ...updates}`, so this sees the list the save will
      // actually persist — including an edit that changed only the miniModel,
      // and one that changed only the models out from under an existing one.
      const miniValidation = validateMiniModel(pendingConnection.miniModel, pendingConnection.models)
      if (!miniValidation.valid) {
        return { success: false, error: miniValidation.error }
      }

      if (isCompatProvider(pendingConnection.providerType) && !pendingConnection.defaultModel) {
        return { success: false, error: 'Default model is required for compatible endpoints.' }
      }

      if (isNewConnection) {
        const added = addLlmConnection(pendingConnection)
        if (!added) {
          deps.platform.logger?.error(`Failed to persist LLM connection: ${setup.slug} (config may be inaccessible)`)
          return { success: false, error: 'Failed to save connection. Check server logs for details.' }
        }
        deps.platform.logger?.info(`Created LLM connection: ${setup.slug}`)
      } else if (Object.keys(updates).length > 0) {
        const updated = updateLlmConnection(setup.slug, updates)
        if (!updated) {
          deps.platform.logger?.error(`Failed to update LLM connection: ${setup.slug}`)
          return { success: false, error: 'Failed to update connection. Check server logs for details.' }
        }
        deps.platform.logger?.info(`Updated LLM connection settings: ${setup.slug}`)
      }

      // Store credential if provided (skip masked placeholders from GET_API_KEY)
      const isMasked = isMaskedCredential(setup.credential)
      // DA1.13 — THE RULE, and this handler is the one place it can be enforced.
      //
      // A one-click Nessy Gateway card's credential of record is the shared dp
      // JWT in `~/.nessy/dp_auth_creds.json`, read live per turn. The card used
      // to ALSO snapshot that JWT into this store at creation — and at every
      // re-run of the card, which upserts through this same handler — where it
      // had no lifecycle at all: no re-mint refreshed it, Reconnect did not
      // touch it, and nothing expired it. What it could still do was leave:
      // `pi-agent.ts` symbol `getPiAuth` falls back to the stored key when the
      // live creds are gone, and `unified-network-interceptor.ts` turns a Bearer
      // on the gateway into `Nestor-Token`, so a months-old JWT went out as the
      // corporate credential and came back as the gateway's own parse 401.
      //
      // So: REFUSE the write, and DELETE anything an older install left behind.
      // The delete is the migration — every card re-run passes through here — and
      // it is safe to run on a card that has none (`deleteLlmApiKey` answers
      // false). It is scoped by `isGatewayBackedConnection`, the STRICT
      // whole-URL predicate, so a BYO endpoint that merely lives on the gateway
      // host keeps its own key.
      //
      // Nothing reads what is deleted: the claude and codex cards resolve to
      // `kind: 'nestor'`, which never reaches a connection credential
      // (`attachUpstreamCredential`), and the Pi card now refuses a stored
      // credential outright (`isUsablePiStoredCredential`).
      const gatewayBacked = isGatewayBackedConnection(pendingConnection)
      if (gatewayBacked) {
        const discarded = await manager.deleteLlmApiKey(setup.slug).catch(() => false)
        if (discarded) {
          // DA1.58: `credentialLog`, not `deps.platform.logger` — see its docblock.
          credentialLog.info(
            `Discarded the stored credential snapshot on gateway connection "${setup.slug}" — `
            + 'the Nessy Gateway credential of record is the live dp sign-in',
          )
        }
      } else if (setup.credential && !isMasked) {
        const authType = pendingConnection.authType
        if (authType === 'oauth') {
          await manager.setLlmOAuth(setup.slug, { accessToken: setup.credential })
          credentialLog.info('Saved OAuth access token to LLM connection')
        } else {
          await manager.setLlmApiKey(setup.slug, setup.credential)
          credentialLog.info('Saved API key to LLM connection')
        }
      }

      // Pi+Bedrock IAM credentials — stored separately from API keys
      if (setup.iamCredentials) {
        await manager.setLlmIamCredentials(setup.slug, {
          ...setup.iamCredentials,
          region: setup.awsRegion,
        })
        credentialLog.info('Saved IAM credentials to LLM connection')
      }

      // Set as default only if no default exists yet (first connection)
      if (!getDefaultLlmConnection()) {
        setDefaultLlmConnection(setup.slug)
        deps.platform.logger?.info(`Set default LLM connection: ${setup.slug}`)
      }

      // Fetch available models before returning to the UI.
      // Always refresh for auto-synced connections (e.g. Copilot, Bedrock) — the static
      // catalog from setup is just a seed that needs replacing with live API data
      // filtered by the user's policy. For user-defined connections, only refresh
      // when no models were populated during setup.
      // Awaited so the model selector shows real available models immediately.
      const pendingModels = Array.isArray(pendingConnection.models) ? pendingConnection.models : []
      const isAutoSynced = pendingConnection.modelSelectionMode === 'automaticallySyncedFromProvider'
      if (!pendingModels.length || isAutoSynced) {
        try {
          await getModelRefreshService().refreshNow(setup.slug)
        } catch (err) {
          deps.platform.logger?.warn(`Model refresh after setup failed for ${setup.slug}: ${err instanceof Error ? err.message : err}`)
        }
      }

      // Reinitialize auth for the connection that was just created/updated,
      // not the global default (which may be a different connection).
      await sessionManager.reinitializeAuth(setup.slug)
      deps.platform.logger?.info('Reinitialized auth after LLM connection setup')

      // Clear "Setup later" flag now that user has configured a provider
      setSetupDeferred(false)

      return { success: true }
    } catch (error) {
      // P6.498 — the gateway-only refusal must reach the wire as a CODE, and
      // this catch would otherwise flatten it into the result object's `error`
      // string where the renderer can only print it. Same line, same reason, as
      // the DELETE handler's `CONNECTION_IN_USE` re-throw further down.
      if (error instanceof CodedError) throw error
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger?.error('Failed to setup LLM connection:', message)
      return { success: false, error: message }
    }
  })

  // Unified connection test — uses the agent factory to spawn a real agent subprocess
  // and validate credentials via runMiniCompletion(). Same code path as actual chat.
  server.handle(RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP, async (_ctx, params: import('@nessy-agent/shared/protocol').TestLlmConnectionParams): Promise<import('@nessy-agent/shared/protocol').TestLlmConnectionResult> => {
    const { provider, apiKey, baseUrl, model, piAuthProvider, customEndpoint, runtimeProviderType } = params
    const allowEmptyApiKey = !setupTestRequiresApiKey(baseUrl)

    // The edit form echoes the stored key back as the GET_API_KEY placeholder;
    // resolve it to the real credential instead of testing the bullets (UB3.4,
    // OSS #1048). Our wire field is `slug` (upstream names it `connectionSlug` —
    // same purpose; ours predates this row on the model-catalog path).
    const keyResolution = await resolveSetupTestApiKey(
      { apiKey, connectionSlug: params.slug, allowEmptyApiKey },
      (slug) => getCredentialManager().getLlmApiKey(slug),
    )
    if (!keyResolution.ok) {
      return { success: false, error: keyResolution.error }
    }
    if (keyResolution.source === 'stored') {
      deps.platform.logger?.info(`[testLlmConnectionSetup] Using the stored API key of ${params.slug}`)
    }
    const trimmedKey = keyResolution.apiKey

    // Catalog + entitlement probes answer from the fetcher directly. They are
    // NOT connection tests: no agent subprocess, no 45s budget.
    if (params.fetchModels || params.validateModels) {
      if (!baseUrl?.trim()) {
        return { success: false, error: 'A base URL is required to read models from an endpoint' }
      }
      const { fetchOpenAiCompatModels, probeOpenAiCompatModel } = await import('../../model-fetchers/openai-compat')
      // EDIT PATH: since UB3.4 the slug resolution lives in resolveSetupTestApiKey
      // above — a masked or empty key with a slug arrives here already resolved to
      // the stored credential; an explicit key still wins (that is the create
      // path, where nothing is stored yet), and a slug with no stored credential
      // resolves to undefined, which is exactly right for a keyless loopback
      // endpoint.
      const catalogKey = trimmedKey || undefined
      try {
        const models = params.fetchModels
          ? (await fetchOpenAiCompatModels(
              { baseUrl: baseUrl.trim() } as Parameters<typeof fetchOpenAiCompatModels>[0],
              { apiKey: catalogKey },
            )).models
          : undefined
        const modelProbes = params.validateModels?.length
          ? await Promise.all(params.validateModels.map(async id => {
              const probe = await probeOpenAiCompatModel(baseUrl.trim(), catalogKey, id)
              return { id, verdict: probe.verdict, ...(probe.wire ? { wire: probe.wire } : {}) }
            }))
          : undefined
        return { success: true, ...(models ? { models } : {}), ...(modelProbes ? { modelProbes } : {}) }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        deps.platform.logger?.info(`[testLlmConnectionSetup] model catalog request failed: ${msg.slice(0, 300)}`)
        return { success: false, error: parseTestConnectionError(msg) }
      }
    }

    // (UB3.4: the empty-key check now lives in resolveSetupTestApiKey above, so a
    // masked placeholder is resolved to the stored credential before this point.)

    const setupValidation = validateSetupTestInput({ provider, baseUrl, piAuthProvider })
    if (!setupValidation.valid) {
      return { success: false, error: setupValidation.error }
    }

    const hint = resolveSetupTestConnectionHint({ provider, baseUrl, piAuthProvider, customEndpoint, runtimeProviderType })
    deps.platform.logger?.info(`[testLlmConnectionSetup] Testing: provider=${provider}${piAuthProvider ? ` piAuth=${piAuthProvider}` : ''}${baseUrl ? ` baseUrl=${baseUrl}` : ''} hasCustomEndpoint=${!!customEndpoint} hintProvider=${hint.providerType}`)

    const startedAt = Date.now()
    try {
      const testModel = model || getDefaultModelForConnection(provider, piAuthProvider)
      deps.platform.logger?.info(`[testLlmConnectionSetup] Resolved model: ${testModel}`)
      const result = await testBackendConnection({
        provider,
        apiKey: trimmedKey,
        allowEmptyApiKey,
        model: testModel,
        baseUrl,
        timeoutMs: 45000,
        hostRuntime: buildBackendHostRuntimeContext(deps.platform),
        connection: hint,
      })
      const elapsed = Date.now() - startedAt

      if (!result.success) {
        deps.platform.logger?.info(`[testLlmConnectionSetup] Elapsed: ${elapsed}ms, success=false`)
        deps.platform.logger?.info(`[testLlmConnectionSetup] Raw error: ${(result.error || '').slice(0, 1000)}`)
        return { success: false, error: parseTestConnectionError(result.error || 'Unknown error') }
      }
      deps.platform.logger?.info(`[testLlmConnectionSetup] Elapsed: ${elapsed}ms, success=true`)
      return { success: true }
    } catch (error) {
      const elapsed = Date.now() - startedAt
      const msg = error instanceof Error ? error.message : String(error)
      deps.platform.logger?.info(`[testLlmConnectionSetup] Elapsed: ${elapsed}ms, threw: ${msg.slice(0, 1000)}`)
      return { success: false, error: parseTestConnectionError(msg) }
    }
  })

  // ============================================================
  // Pi Provider Discovery (main process only — Pi SDK can't run in renderer)
  // ============================================================

  server.handle(RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS, async () => {
    const { getPiApiKeyProviders } = await import('@nessy-agent/shared/config')
    return getPiApiKeyProviders()
  })

  server.handle(RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL, async (_ctx, provider: string) => {
    const { getPiProviderBaseUrl } = await import('@nessy-agent/shared/config')
    return getPiProviderBaseUrl(provider)
  })

  server.handle(RPC_CHANNELS.pi.GET_PROVIDER_MODELS, async (_ctx, provider: string) => {
    const { getModels } = await import('@earendil-works/pi-ai/compat')
    try {
      const models = getModels(provider as Parameters<typeof getModels>[0])
      const sorted = [...models].sort((a, b) => b.cost.output - a.cost.output || b.cost.input - a.cost.input)
      return {
        models: sorted.map(m => ({
          id: m.id.startsWith('pi/') ? m.id : `pi/${m.id}`,
          name: m.name,
          costInput: m.cost.input,
          costOutput: m.cost.output,
          contextWindow: m.contextWindow,
          reasoning: m.reasoning,
        })),
        totalCount: models.length,
      }
    } catch {
      return { models: [], totalCount: 0 }
    }
  })

  // ============================================================
  // LLM Connections (provider configurations)
  // ============================================================

  // List all LLM connections (includes built-in and custom)
  server.handle(RPC_CHANNELS.llmConnections.LIST, async (): Promise<LlmConnection[]> => {
    return getLlmConnections()
  })

  // List all LLM connections with authentication status
  server.handle(RPC_CHANNELS.llmConnections.LIST_WITH_STATUS, async (): Promise<LlmConnectionWithStatus[]> => {
    const connections = getLlmConnections()
    const credentialManager = getCredentialManager()
    const defaultSlug = getDefaultLlmConnection()
    // F1.979 — the codex Bedrock card shows the region codex's own provider will
    // pick (owner decision 2026-09-26: keep the vendor's selection, show it). Read
    // from THIS process's env, which is what a codex child inherits at spawn
    // (`CodexRuntimeManager.spawn` spreads `process.env`), and the AWS config file.
    const { readFileSync } = await import('node:fs')
    const readTextFile = (path: string): string | undefined => {
      try { return readFileSync(path, 'utf-8') } catch { return undefined }
    }

    return Promise.all(connections.map(async (conn): Promise<LlmConnectionWithStatus> => {
      // Check if credentials exist for this connection.
      // DA1.13 — `providerType` + `baseUrl` are what let the presence check see
      // a gateway card, which keeps NO stored credential now that the shared dp
      // JWT is the credential of record. Without them all three one-click cards
      // would report `isAuthenticated: false`, which disables the row in the
      // model switcher (`ConnectionRow.tsx`) and labels it "Not authenticated".
      const hasCredentials = await credentialManager.hasLlmCredentials(
        conn.slug,
        conn.authType,
        conn.providerType,
        conn.baseUrl,
      )
      const codexBedrockRegion = resolveCodexBedrockCardRegion(resolveCodexModelProvider(conn), process.env, readTextFile)
      return {
        ...conn,
        isAuthenticated: conn.authType === 'none' || hasCredentials,
        isDefault: conn.slug === defaultSlug,
        ...(codexBedrockRegion ? { codexBedrockRegion } : {}),
      }
    }))
  })

  // Get a specific LLM connection by slug
  server.handle(RPC_CHANNELS.llmConnections.GET, async (_ctx, slug: string): Promise<LlmConnection | null> => {
    return getLlmConnection(slug)
  })

  // Get stored API key for an LLM connection (masked — for edit form display only)
  server.handle(RPC_CHANNELS.llmConnections.GET_API_KEY, async (_ctx, slug: string): Promise<string | null> => {
    const manager = getCredentialManager()
    const key = await manager.getLlmApiKey(slug)
    if (!key) return null
    // Show provider prefix (first 7 chars) + last 4 chars, mask the middle —
    // the shared maskApiKey (UB3.4): one producer of masked values, so the
    // server-side placeholder resolution agrees with what the form echoes.
    return maskApiKey(key)
  })

  // Save (create or update) an LLM connection
  // If connection.slug exists and is found, updates it; otherwise creates new
  //
  // C3.366 · `apiKey` is an inline widening of the payload, not a field of
  // `LlmConnection`, and it never reaches the store.
  //
  // R6a measured a card saved this way listing and deleting correctly while
  // `getLlmConnectionApiKey` answered nothing, and the cause had two faces:
  // `LlmConnectionSchema` ends in `.passthrough()` and `addLlmConnection`
  // spreads the payload, so a CREATE wrote the credential into `config.json` in
  // plain text; `updateLlmConnection` rebuilds from a hardcoded allowlist, so an
  // UPDATE dropped it and stored it nowhere. Both answer the credential manager
  // — the single reader — with nothing.
  //
  // The credential is routed to that manager here, through `setLlmApiKey`, the
  // same call the setup handler above makes; it is destructured OUT of the
  // payload first so neither store path can persist it. Accepting it rather than
  // refusing it is the smaller change of the two the row offered: the field is
  // already accepted today (that is the leak), the app owns exactly one
  // credential seam, and a refusal would also have to except the renderer's own
  // edit round-trips, which spread a stored connection back verbatim.
  server.handle(RPC_CHANNELS.llmConnections.SAVE, async (_ctx, payload: LlmConnection & { apiKey?: string }): Promise<{ success: boolean; error?: string }> => {
    try {
      const { apiKey: inlineApiKey, ...rest } = payload
      const connection = rest as LlmConnection
      // Check if this is an update or create
      const existing = getLlmConnection(connection.slug)
      if (existing) {
        // Update existing connection (can't change slug)
        const { slug: _slug, ...updates } = connection
        const success = updateLlmConnection(connection.slug, updates)
        if (!success) {
          return { success: false, error: 'Failed to update connection' }
        }
      } else {
        // Create new connection
        const success = addLlmConnection(connection)
        if (!success) {
          return { success: false, error: 'Connection with this slug already exists' }
        }
      }
      // Store the credential before anything reads it — `reinitializeAuth`
      // below resolves it. The masked-placeholder guard is the setup handler's,
      // for the same reason: `GET_API_KEY` prefills the edit form with
      // `sk-xxx••••••••1234`, and storing that string would destroy the real
      // credential with one no endpoint accepts.
      if (inlineApiKey && !inlineApiKey.includes('••')) {
        await getCredentialManager().setLlmApiKey(connection.slug, inlineApiKey)
        deps.platform.logger?.info(`Saved API key to LLM connection: ${connection.slug}`)
      }
      deps.platform.logger?.info(`LLM connection saved: ${connection.slug}`)
      // Push runtime updates (e.g. supportsImages toggle) to live sessions on
      // this connection. Detached so SAVE doesn't block on the per-session
      // 15s `update_runtime_config` timeout when subprocesses are slow or
      // wedged. SessionManager serializes the refresh with the next send via
      // its per-session mutex, and the lazy `getOrCreateAgent` refresh remains
      // the correctness backstop if the detached push fails.
      sessionManager.refreshConnectionRuntime(connection.slug).catch(error => {
        deps.platform.logger?.warn(
          `Detached runtime push failed for ${connection.slug}: ${error instanceof Error ? error.message : error}`,
        )
      })
      // Reinitialize auth if the saved connection is the current default
      // (resolves and logs it; nothing reaches process.env — each session applies its own, F1.963)
      const defaultSlug = getDefaultLlmConnection()
      if (defaultSlug === connection.slug) {
        await sessionManager.reinitializeAuth()
      }
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to save LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Delete an LLM connection (at least one connection must remain)
  server.handle(RPC_CHANNELS.llmConnections.DELETE, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const connection = getLlmConnection(slug)
      if (!connection) {
        return { success: false, error: 'Connection not found' }
      }
      // Refuse while anything still names this connection.
      //
      // Deleting it out from under a live session fails nowhere: the slug stops
      // resolving, the orphan clear in `loadSessionsFromDisk` drops it on the
      // next restore, and the session comes back on the workspace default — a
      // different runtime, with no confirmation and no notice. That is exactly
      // the move `switchSessionRuntime` gates behind a tiered dialog, arriving
      // through the Settings page instead. Automations are the second, quieter
      // door: they resolve their connection at fire time and fall through to
      // the default when it is gone.
      //
      // A THROWN CodedError rather than `{ success: false, error }`: the
      // renderer has to translate this refusal rather than print an English
      // server string, which is the same reason `MODEL_RESTRICTED_BY_POLICY`
      // throws from `settings.ts:202`. The handler's result shape stays for
      // outcomes the renderer does not explain.
      const boundSessions = sessionManager.sessionsUsingConnection(slug)
      const boundAutomations = sessionManager.listAutomationsUsingConnection(slug)
      if (boundSessions.length > 0 || boundAutomations.length > 0) {
        // C3.368 · NAME them. The counts alone told a user that something holds
        // the connection and left them to find it by opening every chat — and
        // the count is the one part they could already see, since the refusal
        // only ever appears when a delete they just attempted failed. The names
        // are user-authored text, so they are the part no translation can
        // supply and the part worth carrying on the wire.
        //
        // Bounded at five per kind: this is one line in a toast, and a
        // connection held by forty chats would otherwise render as a wall. An
        // unnamed session falls back to its id rather than to nothing, because
        // "and one more you cannot identify" is the failure this row is closing.
        // D1.150 — the names on the WIRE beside the sentence. Read once into a
        // local and handed to both, so the two cannot disagree.
        const holderNames = boundSessions.map(session => session.name ?? session.sessionId)
        throw new CodedError(
          'CONNECTION_IN_USE',
          `${boundSessions.length} session(s) and ${boundAutomations.length} automation(s) still use "${slug}"`
          + `: ${describeConnectionHolders(holderNames, boundAutomations)}`,
          connectionHolderData(holderNames, boundAutomations),
        )
      }
      // deleteLlmConnection handles the "at least one must remain" check
      const success = deleteLlmConnection(slug)
      if (success) {
        // Stop any periodic model refresh timer for this connection
        getModelRefreshService().stopConnection(slug)
        // Also delete associated credentials
        const credentialManager = getCredentialManager()
        await credentialManager.deleteLlmCredentials(slug)
        deps.platform.logger?.info(`LLM connection deleted: ${slug}`)
      }
      return { success }
    } catch (error) {
      // The in-use refusal must reach the wire as a CODE. This catch predates
      // it and would otherwise flatten it into the result object's `error`
      // string, where the renderer can only print it.
      if (error instanceof CodedError) throw error
      deps.platform.logger?.error('Failed to delete LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Test an LLM connection (validate credentials and connectivity with actual API call)
  server.handle(RPC_CHANNELS.llmConnections.TEST, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = await validateStoredBackendConnection({
        slug,
        hostRuntime: buildBackendHostRuntimeContext(deps.platform),
      })

      if (!result.success) {
        return { success: false, error: result.error }
      }

      touchLlmConnection(slug)

      if (result.shouldRefreshModels) {
        // UB3.5 — the same fire-and-forget hook the sign-in flows use.
        refreshModelsInBackground(slug, 'validation')
      }

      deps.platform.logger?.info(`LLM connection validated: ${slug}`)
      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      deps.platform.logger?.info(`[LLM_CONNECTION_TEST] Error for ${slug}: ${msg.slice(0, 500)}`)
      const { parseValidationError } = await import('@nessy-agent/shared/config')
      return { success: false, error: parseValidationError(msg) }
    }
  })

  // Set global default LLM connection
  server.handle(RPC_CHANNELS.llmConnections.SET_DEFAULT, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const success = setDefaultLlmConnection(slug)
      if (success) {
        deps.platform.logger?.info(`Global default LLM connection set to: ${slug}`)
        // Reinitialize auth for the new default: resolved and logged, never written to process.env (F1.963)
        await sessionManager.reinitializeAuth()
      }
      return { success, error: success ? undefined : 'Connection not found' }
    } catch (error) {
      deps.platform.logger?.error('Failed to set default LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Set workspace default LLM connection
  server.handle(RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT, async (_ctx, workspaceId: string, slug: string | null): Promise<{ success: boolean; error?: string }> => {
    try {
      getWorkspaceOrThrow(deps.workspaceService, workspaceId)

      // Validate connection exists if setting (not clearing)
      if (slug) {
        const connection = getLlmConnection(slug)
        if (!connection) {
          return { success: false, error: 'Connection not found' }
        }
      }

      if (slug) {
        await deps.workspaceService!.updateSettings(workspaceId, {
          defaults: { defaultLlmConnection: slug },
        })
      } else {
        await deps.workspaceService!.updateSettings(workspaceId, {
          clearDefaults: ['defaultLlmConnection'],
        })
      }
      deps.platform.logger?.info(`Workspace ${workspaceId} default LLM connection set to: ${slug}`)
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to set workspace default LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Refresh available models for a connection (dynamic model discovery)
  server.handle(RPC_CHANNELS.llmConnections.REFRESH_MODELS, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const connection = getLlmConnection(slug)
      if (!connection) {
        return { success: false, error: 'Connection not found' }
      }

      await getModelRefreshService().refreshNow(slug)
      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger?.error(`Failed to refresh models for ${slug}: ${msg}`)
      return { success: false, error: msg }
    }
  })

  // ============================================================
  // ChatGPT OAuth (for Codex chatgptAuthTokens mode)
  // Server-owned: prepare + exchange happen here, browser + callback on client.
  // ============================================================

  interface PendingChatGptFlow {
    flowId: string
    state: string
    codeVerifier: string
    connectionSlug: string
    ownerClientId: string
    createdAt: number
  }
  const pendingChatGptFlows = new Map<string, PendingChatGptFlow>()
  const CHATGPT_FLOW_TTL_MS = 5 * 60 * 1000

  function cleanupExpiredChatGptFlows() {
    const now = Date.now()
    for (const [state, flow] of pendingChatGptFlows) {
      if (now - flow.createdAt > CHATGPT_FLOW_TTL_MS) {
        pendingChatGptFlows.delete(state)
      }
    }
  }

  // chatgpt:startOAuth — prepare PKCE + auth URL, store flow, return to client
  server.handle(RPC_CHANNELS.chatgpt.START_OAUTH, async (ctx, connectionSlug: string): Promise<{
    authUrl: string
    state: string
    flowId: string
  }> => {
    cleanupExpiredChatGptFlows()
    const { prepareChatGptOAuth } = await import('@nessy-agent/shared/auth')

    const prepared = prepareChatGptOAuth()
    const flowId = randomUUID()

    pendingChatGptFlows.set(prepared.state, {
      flowId,
      state: prepared.state,
      codeVerifier: prepared.codeVerifier,
      connectionSlug,
      ownerClientId: ctx.clientId,
      createdAt: Date.now(),
    })

    deps.platform.logger?.info(`[ChatGPT OAuth] Flow started for ${connectionSlug} (flow=${flowId})`)
    return { authUrl: prepared.authUrl, state: prepared.state, flowId }
  })

  // chatgpt:completeOAuth — exchange code for tokens and store credentials
  server.handle(RPC_CHANNELS.chatgpt.COMPLETE_OAUTH, async (ctx, args: {
    flowId: string
    code: string
    state: string
  }): Promise<{ success: boolean; error?: string }> => {
    const { flowId, code, state } = args
    const flow = pendingChatGptFlows.get(state)

    if (!flow) throw new Error('Unknown or expired ChatGPT OAuth flow')
    if (flow.flowId !== flowId) throw new Error('Flow ID mismatch')
    if (flow.ownerClientId !== ctx.clientId) throw new Error('OAuth flow owned by different client')
    if (Date.now() - flow.createdAt > CHATGPT_FLOW_TTL_MS) {
      pendingChatGptFlows.delete(state)
      throw new Error('ChatGPT OAuth flow expired')
    }

    try {
      const { exchangeChatGptTokens } = await import('@nessy-agent/shared/auth')
      const credentialManager = getCredentialManager()

      const tokens = await exchangeChatGptTokens(code, flow.codeVerifier)

      await credentialManager.setLlmOAuth(flow.connectionSlug, {
        accessToken: tokens.accessToken,
        idToken: tokens.idToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      })

      pendingChatGptFlows.delete(state)
      deps.platform.logger?.info(`[ChatGPT OAuth] Flow complete for ${flow.connectionSlug}`)
      // UB3.5 — a re-auth can switch to an account with different model
      // entitlements; replace the cached list from the previous account.
      refreshModelsInBackground(flow.connectionSlug, 'ChatGPT auth')
      return { success: true }
    } catch (error) {
      pendingChatGptFlows.delete(state)
      deps.platform.logger?.error('[ChatGPT OAuth] Token exchange failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Token exchange failed',
      }
    }
  })

  // Cancel ongoing ChatGPT OAuth flow
  server.handle(RPC_CHANNELS.chatgpt.CANCEL_OAUTH, async (ctx, args?: { state?: string }): Promise<{ success: boolean }> => {
    if (args?.state) {
      const flow = pendingChatGptFlows.get(args.state)
      if (flow && flow.ownerClientId === ctx.clientId) {
        pendingChatGptFlows.delete(args.state)
        deps.platform.logger?.info(`[ChatGPT OAuth] Flow cancelled for ${flow.connectionSlug}`)
      }
    }
    return { success: true }
  })

  // Get ChatGPT authentication status
  server.handle(RPC_CHANNELS.chatgpt.GET_AUTH_STATUS, async (_ctx, connectionSlug: string): Promise<{
    authenticated: boolean
    expiresAt?: number
    hasRefreshToken?: boolean
  }> => {
    try {
      const credentialManager = getCredentialManager()
      const creds = await credentialManager.getLlmOAuth(connectionSlug)

      if (!creds) {
        return { authenticated: false }
      }

      // Check if expired (with 5-minute buffer)
      const isExpired = creds.expiresAt && Date.now() > creds.expiresAt - 5 * 60 * 1000

      return {
        authenticated: !isExpired || !!creds.refreshToken, // Can refresh if has refresh token
        expiresAt: creds.expiresAt,
        hasRefreshToken: !!creds.refreshToken,
      }
    } catch (error) {
      deps.platform.logger?.error('Failed to get ChatGPT auth status:', error)
      return { authenticated: false }
    }
  })

  // Logout from ChatGPT (clear stored tokens)
  server.handle(RPC_CHANNELS.chatgpt.LOGOUT, async (_ctx, connectionSlug: string): Promise<{ success: boolean }> => {
    try {
      const credentialManager = getCredentialManager()
      await credentialManager.deleteLlmCredentials(connectionSlug)
      deps.platform.logger?.info('ChatGPT credentials cleared')
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to clear ChatGPT credentials:', error)
      return { success: false }
    }
  })

  // ============================================================
  // GitHub Copilot OAuth
  // ============================================================

  // Start GitHub Copilot OAuth flow (device flow via Pi SDK)
  server.handle(RPC_CHANNELS.copilot.START_OAUTH, async (ctx, connectionSlug: string): Promise<{
    success: boolean
    error?: string
  }> => {
    try {
      const { loginGitHubCopilotCredential } = await import('@nessy-agent/shared/agent/backend/pi/copilot-oauth')
      const credentialManager = getCredentialManager()

      // Cancel any previous in-flight flow
      copilotOAuthAbort?.abort()
      copilotOAuthAbort = new AbortController()

      deps.platform.logger?.info(`Starting GitHub Copilot OAuth device flow for connection: ${connectionSlug}`)

      // Use Pi SDK's login flow — this handles the device code flow AND
      // the critical Copilot token exchange that determines the correct
      // API endpoint for the user's subscription tier (individual/business/enterprise).
      const credentials = await loginGitHubCopilotCredential({
        onDeviceCode: ({ userCode, verificationUri }) => {
          deps.platform.logger?.info(`[GitHub OAuth] Device code: ${userCode}`)
          pushTyped(server, RPC_CHANNELS.copilot.DEVICE_CODE, { to: 'client', clientId: ctx.clientId }, {
            userCode,
            verificationUri,
          })
          // Open GitHub device code page on the client's machine
          server.invokeClient(ctx.clientId, CLIENT_OPEN_EXTERNAL, verificationUri).catch(err => {
            deps.platform.logger?.warn(`Failed to open browser for GitHub OAuth: ${err}`)
          })
        },
        onPrompt: async () => {
          // Pi SDK asks for GitHub Enterprise domain — return empty for github.com
          return ''
        },
        onProgress: (message) => {
          deps.platform.logger?.info(`[GitHub OAuth] ${message}`)
        },
        signal: copilotOAuthAbort.signal,
      })

      copilotOAuthAbort = null

      // Store the full OAuth credential:
      // - accessToken = Copilot API token (contains proxy-ep for correct endpoint)
      // - refreshToken = GitHub access token (used to refresh the Copilot token)
      // - expiresAt = Copilot token expiry (short-lived, ~1 hour)
      await credentialManager.setLlmOAuth(connectionSlug, {
        accessToken: credentials.access,
        refreshToken: credentials.refresh,
        expiresAt: credentials.expires,
      })

      deps.platform.logger?.info('GitHub Copilot OAuth completed successfully')
      // UB3.5 — same re-auth rule as the ChatGPT flow above.
      refreshModelsInBackground(connectionSlug, 'Copilot auth')
      return { success: true }
    } catch (error) {
      copilotOAuthAbort = null
      deps.platform.logger?.error('GitHub Copilot OAuth failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'OAuth authentication failed',
      }
    }
  })

  // Cancel ongoing GitHub OAuth flow
  server.handle(RPC_CHANNELS.copilot.CANCEL_OAUTH, async (): Promise<{ success: boolean }> => {
    if (copilotOAuthAbort) {
      copilotOAuthAbort.abort()
      copilotOAuthAbort = null
      deps.platform.logger?.info('GitHub Copilot OAuth cancelled')
    }
    return { success: true }
  })

  // Get GitHub Copilot authentication status
  server.handle(RPC_CHANNELS.copilot.GET_AUTH_STATUS, async (_ctx, connectionSlug: string): Promise<{
    authenticated: boolean
  }> => {
    try {
      const credentialManager = getCredentialManager()
      const creds = await credentialManager.getLlmOAuth(connectionSlug)

      return {
        authenticated: !!creds?.accessToken,
      }
    } catch (error) {
      deps.platform.logger?.error('Failed to get GitHub auth status:', error)
      return { authenticated: false }
    }
  })

  // Logout from Copilot (clear stored tokens)
  server.handle(RPC_CHANNELS.copilot.LOGOUT, async (_ctx, connectionSlug: string): Promise<{ success: boolean }> => {
    try {
      const credentialManager = getCredentialManager()
      await credentialManager.deleteLlmCredentials(connectionSlug)
      deps.platform.logger?.info('Copilot credentials cleared')
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to clear Copilot credentials:', error)
      return { success: false }
    }
  })
}
