/**
 * ## Where the citations in this file point, and what they are worth
 *
 * **Stated per page, never as one claim.** This file cites five upstream pages
 * and they are not in the same condition.
 *
 * `settings.md` — RE-HUNG 2026-08-25 (P2.170), because the page was SPLIT and
 * every one of this file's 56 `settings.md:<line>` anchors was dead at the PAGE
 * level, not the line level: today `settings.md` is 804 lines about scope,
 * precedence and how to edit a settings file, and its first ~460 lines are a
 * React component. Not one of those anchors landed on the material it named. The
 * managed-tier contract this file enforces went to **`managed-settings.md`**
 * ("Deploy managed settings", 300 lines) and the key-by-key reference went to
 * **`settings-reference.md`** (5 474 lines). Both were absent from
 * `scripts/claude-doc-pages.tsv` until the same change added them.
 *
 * The anchors are now the pages' own SECTION anchors, which are part of their
 * published link contract — `managed-settings.md#invalid-entries-in-managed-settings`
 * is an explicit `<span id>` three pages of the corpus link to — so they do not
 * decay when content shifts, as a line number does within days. Continuations
 * that used to read `` `:194`/`:199` `` now name the KEY whose row they mean,
 * for the same reason: a key name outlives a row position.
 *
 * **The quoted WORDING here is dated, and the date is per quote.** A section
 * anchor is a link contract; a quoted sentence is not, and this file has now
 * watched the same pages reword twice. RE-MEASURED 2026-08-29 (P2.191) against a
 * fresh fetch of the eighteen `code.claude.com/docs/en/<page>.md` pages this file
 * cites, matched after markdown links are reduced to their link text, with a
 * negative control (an invented sentence: absent) and a positive one
 * (`"Treated as `true`."`: live on `managed-settings.md`) on the SAME fetch.
 *
 * What that fetch found, and the direction matters: `settings-reference.md` had
 * grown 5 474 → 5 669 lines since 2026-08-25 and had rewritten most of its
 * per-key opening sentences. So the drift is not a one-off from the split — it
 * is the ordinary rate of this corpus, and a quoted sentence here should be read
 * as "what the page said on the date beside it", never as today's text.
 *
 * **REPAIRED in this pass — the four `P2.191` phantom quotes, at every site**
 * (a phantom quote is text in quotation marks that no fetchable revision of any
 * cited page contains). Each is now the live sentence, and its page carries it
 * on 2026-08-29:
 *
 *  1. the strip rule, quoted here for years as "Claude Code strips that entry,
 *     records a warning, and enforces every remaining valid policy" — 4 sites;
 *  2. "a single typo cannot disable the rest of your organization's policy" — 4
 *     sites, and this one is an ABSENCE rather than a rewording: even the
 *     fragment "single typo" is on no page of the eighteen. The RULE survives in
 *     the live sentence's "keeps enforcing every remaining valid key"; the
 *     sentence that made it quotable is gone, so the claim is no longer made in
 *     this file's voice as if the page still made it;
 *  3. the version-gate fail-open sentence — 3 sites, reworded stripped→dropped
 *     and cannot→can't, and now attributed to `#keys-that-fail-closed`, which is
 *     where it actually lives;
 *  4. `availableModels`' "Restrict which models users can select …" — 2 sites.
 *
 * Three co-located neighbours in the same docblocks were phantom too and are
 * repaired with them, under `P2.69`'s bounded-neighbour rule (re-measure the
 * neighbours that share the anchor's PAGE, not every citation in the file):
 * `requiredMinimumVersion`'s opening sentence, and `availableModels`' two
 * fail-closed clauses.
 *
 * **NOT repaired, counted rather than swept:** the same fetch found roughly
 * twenty further phantom quotes in this file, all of them `settings-reference.md`
 * per-key opening sentences reworded since 2026-08-25 — `enabledPlugins` (×7
 * across three docblocks), `extraKnownMarketplaces`, `suggestedMarketplaces`,
 * `allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`,
 * `strictPluginOnlyCustomization` (×2), `permissions.defaultMode`'s second
 * sentence, `cleanupPeriodDays`, and the `managed-mcp.md` and `model-config.md`
 * entry sentences. Their SECTION anchors were all re-probed and are live; it is
 * the sentences that moved. They are named here rather than left as "the rest"
 * so the next pass has a worklist and not a re-derivation.
 *
 * **CORRECTION 2026-08-25 (P2.183): four of this file's section anchors were
 * still wrong, and the rule that produced them was inverted.** A dotted key
 * slugifies with its dots turned into HYPHENS, not deleted:
 * `settings-reference` renders `id="permissions-defaultmode"` and
 * `id="strictpluginonlycustomization-skills"`, and carries no dot-stripped id at
 * all — measured against the rendered HTML, which is the only non-circular
 * source, heading by heading over nine pages (666 of 666 resolve). The three
 * citations here that had dropped their dots are fixed, as is a fourth,
 * `#keys-that-fail-closed-200`, whose `-200` suffix survived a line re-hang. The two hook keys moved page as well: they are
 * cited on `settings-reference.md` now, because `settings.md` keeps
 * `#hook-configuration` only as one of ~40 stacked `<span id>` redirect stubs at
 * the top of the page, above the prose — the anchor resolves and lands on
 * nothing, which no anchor guard can see.
 *
 * `server-managed-settings.md` — NOT re-measured. Its anchors are left as
 * `server-managed-settings.md:<line>` and are a dated pointer, not a live one.
 * `managed-mcp.md`, `plugin-marketplaces.md`, `hooks.md`, `model-config.md` —
 * likewise NOT re-measured. Scoping the
 * claim per page is deliberate: a provenance header that implied all five had
 * been checked would be the same defect one layer up.
 *
 * `learn.chatgpt.com/docs/enterprise/manage-app-updates.md` is the fifth, and it
 * is listed apart from the four above because it is NOT A CLAUDE PAGE (P2.377).
 * It sat in that list as a bare `enterprise/manage-app-updates.md`, which reads
 * as one — and measured 2026-09-03 it 404s on `code.claude.com/docs/en/` and is
 * in none of the pages of `scripts/claude-doc-pages.tsv`, while the codex host
 * serves it 200. A bare page name is only unambiguous inside ONE corpus and this
 * fork cites two, so every citation of a codex page carries its host from here
 * on. It is also weak evidence by the two-tier rule in the root `AGENTS.md`:
 * intent, not behaviour.
 */
import { parsePermissionMode, type PermissionMode } from '../mode-types.ts'
import {
  collectingDropSink,
  reasonOf,
  sanitizeSettingsDiagnostic,
  STRICT_DROP_SINK,
  tolerate,
  toleratedList,
  type ManagedDropSink,
  type ManagedPolicyDropV1,
} from '../../config/managed-drops.ts'
import { MANAGED_VERSION_PATTERN } from '../../config/managed-version-gate.ts'
import { normalizeManagedEnabledPluginKey } from '../../plugins/managed-plugin-key.ts'
import {
  expandConfigVariables,
  referencesConfigVariable,
} from '../../mcp/server-config-values.ts'
import {
  isModelInManagedAllowlist,
  matchesManagedModelEntry,
} from '../../config/managed-model-allowlist.ts'
import {
  evaluateManagedMcpServer,
  managedMcpEntryNames,
  parseManagedMcpEntryList,
  type ManagedMcpEntryV1,
  type ManagedMcpServerIdentityV1,
} from './managed-mcp-entries.ts'
import {
  MANAGED_MARKETPLACE_NAME,
  parseBlockedMarketplaceEntryList,
  parseDeliveredMarketplaceEntryList,
  parseManagedMarketplaceEntryList,
  type DeliveredMarketplaceEntryV1,
  type ManagedMarketplaceEntryV1,
} from './managed-marketplace-entries.ts'
import { GUARDIAN_BUILT_IN_AUTO_MODE_DEFAULTS } from '../../prompts/guardian.ts'
import { parseManagedSandboxSettingsV1, type SandboxSettingsV1 } from '../../config/sandbox-settings.ts'
import { parseWorkflowSettingsV1, type WorkflowSettingsV1 } from '../../config/workflow-settings.ts'
import { parseClaudeRuleString } from './claude-permission-rules.ts'
import { PERMISSION_RULE_TOOL_NAMES } from './harness-tool-descriptor.ts'
import {
  NESSY_PERMISSION_DSL_VERSION,
  parsePermissionDslV1,
  type PermissionDslRuleV1,
  type PermissionDslV1,
} from './permission-dsl.ts'

export { normalizeManagedPermissionMode } from '../mode-types.ts'

/**
 * The MCP entry schema, re-exported beside the policy that carries it so a
 * consumer of `allowedMcpServers`/`deniedMcpServers` imports one module.
 */
export {
  blockedMarketplaceEntryFor,
  isManagedMarketplaceAllowed,
  managedMarketplaceSourceIdentity,
  matchesBlockedMarketplaceEntry,
  matchesManagedMarketplaceEntry,
  parseBlockedMarketplaceEntryList,
  parseDeliveredMarketplaceEntryList,
  parseManagedMarketplaceEntryList,
} from './managed-marketplace-entries.ts'
export type {
  DeliveredMarketplaceEntryV1,
  ManagedMarketplaceEntryV1,
  ManagedMarketplaceGithubEntryV1,
  ManagedMarketplaceHostPatternEntryV1,
  ManagedMarketplacePathPatternEntryV1,
  ManagedMarketplaceSourceIdentityV1,
  ManagedMarketplaceUrlEntryV1,
} from './managed-marketplace-entries.ts'
export {
  evaluateManagedMcpServer,
  managedMcpEntryNames,
  matchesManagedMcpEntry,
  matchesManagedMcpUrlPattern,
  parseManagedMcpEntryList,
} from './managed-mcp-entries.ts'
export type {
  ManagedMcpCommandEntryV1,
  ManagedMcpEntryV1,
  ManagedMcpListKind,
  ManagedMcpNameEntryV1,
  ManagedMcpServerIdentityV1,
  ManagedMcpTransportV1,
  ManagedMcpUrlEntryV1,
} from './managed-mcp-entries.ts'

/**
 * The four customization surfaces `strictPluginOnlyCustomization` can lock,
 * verbatim from `settings-reference.md#strictpluginonlycustomization`'s four per-surface keys: `skills`, `agents`, `hooks`,
 * `mcp`. Exactly these four words, in this order, which is also the order the
 * parser normalizes a subset into so two spellings of one policy hash alike
 * (`canonicalPolicyJson` compares arrays positionally).
 */
export type StrictCustomizationSurfaceV1 = 'skills' | 'agents' | 'hooks' | 'mcp'
export const STRICT_CUSTOMIZATION_SURFACES: readonly StrictCustomizationSurfaceV1[] =
  Object.freeze(['skills', 'agents', 'hooks', 'mcp'] as const)

export interface ManagedPiPolicyV1 {
  readonly schemaVersion: 1
  readonly disabledPermissionModes: readonly PermissionMode[]
  readonly permissionDsl?: PermissionDslV1
  readonly allowedPluginKeys?: readonly string[]
  readonly deniedPluginKeys?: readonly string[]
  /**
   * `settings-reference.md#enabledplugins` — "Controls which plugins are enabled. Format:
   * `"plugin-name@marketplace-name": true/false`. A plugin with no entry at any
   * scope falls back to its `defaultEnabled` value."
   *
   * The MANAGED tier of that key, which the same section describes as "Organization-wide
   * policy overrides that block installation at all scopes and hide the plugin
   * from the marketplace", and, in the other direction, as terminal:
   * "Plugins force-enabled by managed settings cannot be disabled this way,
   * since managed settings override local settings."
   *
   * So a managed entry is the TOP of the activation precedence chain in both
   * directions — `true` is a force-enable no user layer can undo, `false` is a
   * block. It is the only key on this policy that ACTIVATES rather than
   * narrows, which is why it is resolved for every provider and for the catalog
   * view rather than only on a Pi capability turn: an activation that the turn
   * honours and the catalog denies is the "declared on one path, enforced on
   * another" defect in its user-visible form.
   *
   * Keys are STORED as OUR `PluginKey`s (`pluginKeyFor` —
   * `enc(marketplaceId).enc(pluginId)`), the same vocabulary
   * {@link allowedPluginKeys} already uses, for the same reason
   * {@link disabledPermissionModes} spells our own mode names: one document must
   * not use two vocabularies for one identifier. That key is
   * marketplace-qualified by construction, which is what `settings-reference.md#what-runs-under-allowmanagedhooksonly` requires of the
   * hook carve-out — "Claude Code matches on the full `plugin@marketplace` ID, so
   * a plugin with the same name from a different marketplace stays blocked".
   *
   * **P3.244 — but that is the STORED spelling, not the only WRITTEN one, and
   * for a month it was both.** The section above documents exactly one spelling
   * for an administrator to type: "Turn individual plugins on or off, keyed by
   * `plugin-name@marketplace-name`". Ours is base64url, in the other order, and
   * nobody types it. Measured on the tolerant parse 2026-09-02: the page's own
   * example parsed to `{}` with two `stripped` drops, and the `false` half of
   * that example is a BLOCK the same section gives teeth ("A plugin set to
   * `false` here is blocked from installation at every scope and hidden from the
   * marketplace") — so the drop failed open. `normalizeManagedEnabledPluginKey`
   * now accepts both and normalizes to the stored one; the reading side is
   * unchanged, and every key that parsed before still parses to itself.
   *
   * Distinct from {@link allowedPluginKeys}, which means "these plugins MAY be
   * used". Force-enabling is the stronger, deliberate act of an administrator
   * saying "I am deploying THIS", and only it feeds
   * {@link areVettedPluginHooksAllowed}.
   */
  readonly enabledPlugins?: Readonly<Record<string, boolean>>
  /**
   * `managed-mcp.md:132` — "`allowedMcpServers` and `deniedMcpServers` are
   * lists of entries. Each entry is an object with a single key that identifies
   * servers by their URL, their command, or their name."
   *
   * A bare string is still read, as `{ serverName: … }`: that is the shape our
   * own deployed policies use.
   *
   * `:140` — unset is not the same as `[]`. Unset imposes no narrowing; `[]`
   * admits nothing. `deniedMcpServers` reads both as "nothing blocked".
   */
  readonly allowedMcpServers?: readonly ManagedMcpEntryV1[]
  readonly deniedMcpServers?: readonly ManagedMcpEntryV1[]
  /**
   * P6.236 — the exclusive-control switch its two siblings already had.
   *
   * `settings-reference.md#allowmanagedmcpserversonly`: *"Make the managed
   * allowlist the only one that applies. Claude Code then reads
   * `allowedMcpServers` from managed settings alone and ignores allowlists in
   * user, project, and local settings; `deniedMcpServers` still merges from
   * every settings scope, so users can still block servers for themselves.
   * Administrators set it so a user's own settings can't broaden what the
   * managed allowlist permits."* Scope `Managed`, default `false`.
   *
   * **Its enforcement is NOT symmetric across the three runtimes, and the
   * asymmetry is measured rather than assumed.**
   *
   *  - **claude** — real and live. We pass `settingSources: ['user','project',
   *    'local']` to the SDK, so the child genuinely reads a user's own
   *    `.claude/settings.json` and merges its `allowedMcpServers` on top of the
   *    managed tier. The vendored `2.1.233` restrictive managed-settings filter
   *    copies this key (`if(e.allowManagedMcpServersOnly===!0)…`, re-extracted
   *    by the anchor method in `claude-managed-settings.ts`'s header), so
   *    carrying it here is a tier-1 native-first answer: the binary enforces it.
   *  - **Pi and codex** — satisfied by construction. This host has NO
   *    user/project/local MCP allowlist at all: `allowedMcpServers` is read
   *    only from this schema (`git grep -aln` over packages+apps, 2026-09-06 —
   *    the non-test readers are this file, `managed-mcp-entries.ts`,
   *    `managed-policy-resolution.ts`, `startup-environment.ts`,
   *    `claude-managed-settings.ts` and two prose hits), so there is no other
   *    scope's allowlist for the switch to ignore. Setting it changes nothing
   *    on those two, and that is the honest verdict rather than an unenforced
   *    key.
   *
   * Fail-closed like its siblings: `managed-settings.md#keys-that-fail-closed`
   * names this key by name, so an invalid value reads as `true`.
   */
  readonly allowManagedMcpServersOnly?: boolean
  /**
   * P6.238 — the organization's chosen DEFAULT model, the third member of a
   * family whose other two already landed.
   *
   * `availableModels` (which models may be picked) and `enforceAvailableModels`
   * (whether the allowlist binds the Default option) were both carried here;
   * the value an administrator actually wants every new session to start on was
   * not, so an org could restrict the menu and not set the dish.
   *
   * **The name is the page's, not the row's.** The row that opened this gap
   * called the key `defaultModel`. There is no such settings key: `git grep -n
   * defaultModel` over `settings-reference.md` scores 0, and the documented
   * spelling is plain `model` — *"Set the model every new session uses, so you
   * don't have to pick one with `/model` each time"*, scope
   * `Any file`, type *"string, a model alias or full model ID"*
   * (`settings-reference.md#model`). Inventing `defaultModel` would have given
   * an administrator a key that works in this fork and in no Claude Code, which
   * is the failure the read-don't-invent rule exists to stop.
   *
   * **Precedence is the page's too, and it is the point of the key.**
   * `model-config.md#organization-default-model` lists what outranks an
   * organization default and puts managed settings above the user: *"a `model`
   * value in [managed settings] or supplied through `--settings`"* beats *"a
   * `model` value in your user, project, or local settings, including a model
   * you save with `/model`"*. So a managed `model` OUTRANKS the connection's
   * stored default rather than merely filling in for a missing one — a managed
   * default a user's saved choice silently overrides is not a managed default,
   * it is a suggestion.
   *
   * **What it does NOT claim.** The page's own per-session escape hatches —
   * `--model` and `ANTHROPIC_MODEL` — outrank even a managed `model` for one
   * session, and this fork has no equivalent of either on the desktop path, so
   * there is nothing here to reproduce. And this is a settings key, NOT the
   * claude.ai admin-console *organization default model*, which is read from
   * the account at startup and is unreachable from an SDK-hosted session.
   *
   * Stripped on any defect rather than reinterpreted, like `defaultMode`: there
   * is no tighter reading of a model id, and a repaired one would silently move
   * a fleet onto a model nobody chose.
   */
  readonly model?: string
  /**
   * `plugins/org.md#allowlist-with-strictknownmarketplaces` — "administrators can restrict which plugin
   * marketplaces users are allowed to add using the `strictKnownMarketplaces`
   * setting in managed settings". `:762` — the check "runs on marketplace add and
   * on plugin install, update, refresh, and auto-update", "before any network or
   * filesystem operation".
   *
   * Undefined imposes no restriction; `[]` is `:678`'s complete lockdown. The two
   * are deliberately distinguishable, unlike every other list on this policy.
   */
  readonly strictKnownMarketplaces?: readonly ManagedMarketplaceEntryV1[]
  /**
   * The marketplace sources an administrator BLOCKS. `settings-reference.md`
   * §`blockedmarketplaces` — "Block plugin marketplace sources for your
   * organization. Claude Code checks the blocklist on marketplace add and on
   * plugin install, update, refresh, and auto-update, so a marketplace someone
   * added before you set the policy can't be used to fetch plugins either.
   * Blocked sources are checked before download, so they never touch the
   * filesystem."
   *
   * The other pole of {@link strictKnownMarketplaces}, and the DANGEROUS one:
   * an unenforced allowlist can only narrow what an operator may do, while an
   * unenforced blocklist fails OPEN. P2.467 built the matcher and the four gates
   * (add, upgrade, load, delivery) and proved them with six mutants; this field
   * is the feed, which until P2.481 was a `createPluginRegistrySource` parameter
   * nothing set — so the whole gate was reachable only from tests.
   *
   * Absent and `[]` are the SAME answer here (nothing blocked), unlike
   * {@link strictKnownMarketplaces} where `[]` is a complete lockdown. That
   * asymmetry is the page's, not ours: the lockdown reading belongs to the
   * allowlist because an empty allowlist admits nothing, and an empty blocklist
   * names nothing to refuse.
   *
   * NOT in {@link MANAGED_PI_POLICY_DENY_LIST_KEYS}, and the omission is a
   * decision rather than an oversight. That set exists so a GROWN deny list is
   * adopted mid-turn instead of waiting for a turn boundary, and its only
   * consumer is `SessionManager`'s policy re-read. This key's feed does not run
   * at session time at all: `createStorageRuntime` hands it to
   * `createPluginRegistrySource` once at boot, exactly as it hands
   * {@link strictKnownMarketplaces}. So naming it there could not make this key
   * apply any sooner — it could only make an unrelated simultaneous change adopt
   * mid-turn, which is adoption timing widened for no gain. The residue is that
   * a blocklist edited while the app runs reaches the gate at the next start,
   * uniformly on every runtime and identically to the allowlist's.
   */
  readonly blockedMarketplaces?: readonly ManagedMarketplaceEntryV1[]
  /**
   * `settings-reference.md#extraknownmarketplaces` — "Defines additional marketplaces that should be made
   * available for the repository. Typically used in repository-level settings to
   * ensure team members have access to required plugin sources."
   *
   * The DELIVERY half of the pair whose narrowing half is
   * {@link strictKnownMarketplaces}. Without it an administrator can say which
   * marketplace sources are permitted but cannot supply one, so a mandated
   * plugin (see {@link enabledPlugins}) resolves only after every workstation
   * adds the internal marketplace by hand.
   *
   * Registered through the SAME add path an interactive add takes, so a
   * delivered marketplace passes exactly the gates an added one does — including
   * {@link strictKnownMarketplaces} itself, which still refuses a delivered
   * source it does not admit. A delivery may not widen the narrowing.
   */
  readonly extraKnownMarketplaces?: readonly DeliveredMarketplaceEntryV1[]
  /**
   * `settings-reference.md#pluginsuggestionmarketplaces` — "(Managed settings only) Marketplace names whose plugins
   * can appear as contextual install suggestions. No marketplace-declared
   * suggestions surface without this allowlist ... A name only takes effect when
   * the marketplace is registered on the machine and its registered source is
   * also declared in managed settings, either as the `extraKnownMarketplaces`
   * entry for that name or as an entry of `strictKnownMarketplaces`. A
   * marketplace registered from a different source under an allowlisted name is
   * ignored. The official marketplace is exempt from the source requirement."
   *
   * Only the NAME list lives here. The source-correspondence half — the
   * anti-squatting rule — is enforced where both halves are visible at once, in
   * `marketplace/registry-source.ts:isSuggestionAllowed`.
   *
   * Absent and `[]` mean the same thing (no suggestion surfaces), so unlike
   * {@link strictKnownMarketplaces} this key needs no absent-vs-empty
   * distinction.
   */
  readonly pluginSuggestionMarketplaces?: readonly string[]
  readonly allowPluginHooks?: boolean
  /**
   * `settings-reference.md#allowmanagedhooksonly` — "(Managed settings only) Only managed hooks, SDK hooks,
   * and hooks from plugins force-enabled in managed settings `enabledPlugins`
   * are loaded. User, project, and all other plugin hooks are blocked."
   *
   * We carry no managed hook definitions (`managed-approval.ts:15`), so the
   * "managed hooks" half of that sentence names an empty set here and the lock
   * reduces to its other three clauses. The vetted-plugin carve-out reads
   * {@link enabledPlugins}' force-enabled set and nothing else — see
   * {@link areVettedPluginHooksAllowed} for why substituting
   * {@link allowedPluginKeys} was wider than the document. With no force-enabled
   * plugin nothing is vetted, so plugin hooks go too — the fail-closed reading,
   * and the only one under which the lock's name is true.
   *
   * Distinct from {@link allowPluginHooks}, which is a plugin-only kill switch
   * and says nothing about user or project hooks.
   */
  readonly allowManagedHooksOnly?: boolean
  /**
   * `settings-reference.md#disablecommandpluginsources` — "Block the `command`
   * plugin source, which installs a plugin by running a marketplace-declared
   * command on the user's machine."
   *
   * A THREE-state key, and the third state is the one a Boolean field cannot be
   * allowed to swallow. The page: "**Default**: unset, so Claude Code follows
   * `allowManagedHooksOnly`: an organization that restricts hook execution to
   * managed settings gets command sources disabled too." So `undefined` is not
   * "allowed" — it DELEGATES, and {@link areMarketplaceCommandSourcesAllowed} is
   * the only reader permitted to resolve it.
   *
   * What it blocks, verbatim: "Whenever it blocks command sources, whether you
   * set it to `true` or leave it unset under `allowManagedHooksOnly`, it also
   * blocks marketplace `headersHelper` commands, except for a marketplace that
   * managed settings themselves declare."
   *
   * P3.220 — parsed and read here even though this build runs NEITHER kind of
   * marketplace-declared command: the `command` plugin source is refused at
   * catalog parse, and a `headersHelper` is reported and never executed. It is
   * deliberately NOT inert on that account. The key is what an operator sets to
   * state the posture, and it lands in the same change as the marketplace `url`
   * source's static `headers` — the row's own rule, because the alternative
   * ordering ships a credential path first and its off-switch afterwards. Its
   * live effect today is on what the `headersHelper` refusal SAYS: an
   * administrator who blocked commands is told their key is not the reason the
   * command did not run.
   */
  readonly disableCommandPluginSources?: boolean
  /**
   * `hooks.md:612`/`:614` — "To temporarily disable all hooks without removing
   * them, set `\"disableAllHooks\": true` in your settings file", and "Only
   * `disableAllHooks` set at the managed settings level can disable managed
   * hooks." This is the MANAGED level of that pair: `true` turns every hook
   * off, including hooks the managed tier itself distributes (force-enabled
   * plugin hooks). The user/project settings spelling of the same key lives in
   * the hooks settings files and cannot reach managed-distributed hooks.
   *
   * Distinct from {@link allowPluginHooks} (plugin-only, permanent posture) and
   * {@link allowManagedHooksOnly} (which keeps managed hooks and drops the
   * rest — the opposite tail of this switch).
   */
  readonly disableAllHooks?: boolean
  /**
   * D1.107 — `settings-reference.md#disablesideloadflags`, verbatim: "Reject the
   * `--plugin-dir`, `--plugin-url`, `--agents`, and `--mcp-config` CLI flags at
   * startup, which users could otherwise pass to bypass
   * `strictKnownMarketplaces` for a single run. Claude Code exits with an error
   * naming the rejected flags". Scope `Managed`, Type Boolean, Default `false`.
   *
   * OF THOSE FOUR NAMES THIS PRODUCT SHIPS EXACTLY ONE, `--agents`. The other
   * three are refused by the CLI's unknown-flag gate, which refuses every
   * unrecognised dash-leading token before anything is spawned, and
   * `apps/cli/src/sideload-flags-tripwire.test.ts` pins that property rather
   * than the three names. So the enforcement this key buys here is one flag
   * wide, and that is a measurement of our surface, not a narrowing of the key.
   *
   * The reader is `isManagedSideloadFlagsDisabled`, consumed by the CLI's
   * startup gate. Nothing else reads it, and nothing accepts a sideload path.
   */
  readonly disableSideloadFlags?: boolean
  /**
   * `settings-reference.md#allowmanagedpermissionrulesonly` — "(Managed settings only) Prevent user and project
   * settings from defining `allow`, `ask`, or `deny` permission rules. Only
   * rules in managed settings apply."
   *
   * Enforced over the permission DSL, which is the surface those three verbs
   * live on: our own `permissionDsl` documents, the managed `claudeRules` this
   * parser folds into them, and the `.claude/settings.json` allow/ask/deny
   * blocks `claudeSettingsPermissionDsl` compiles. Session rules a
   * `PermissionRequest` hook added are NOT settings and are not dropped.
   */
  readonly allowManagedPermissionRulesOnly?: boolean
  /**
   * `settings-reference.md#strictpluginonlycustomization` — "**Managed settings only**: blocks skills, agents,
   * hooks, and MCP servers from user and project sources, so they can only come
   * from plugins or managed settings", and the same section: "For each locked surface,
   * Claude Code skips user-level and project-level sources and loads only
   * plugin-provided and managed sources." Also `permissions.md:507` and
   * `admin-setup.md:91`'s "Customization lockdown" row.
   *
   * NORMALIZED by the parser: the documented `true` becomes all four surfaces,
   * so no reader ever sees the `true | array` union. Carrying that union past the
   * parser is the "read at one call site and forgotten at the next" failure
   * {@link isManagedPermissionRulesOnly}'s comment names, and this key has four
   * enforcement sites rather than one.
   *
   * Each surface maps onto OUR directories, not Claude's — `~/.claude/skills`
   * and `.claude/agents` are not tiers this fork reads. `skills` and `agents`
   * cover the global (`<CONFIG_DIR>/skills`, `<CONFIG_DIR>/agents`, the portable
   * `~/.agents/skills`), workspace and trusted-project tiers; `mcp` covers
   * `<CONFIG_DIR>/mcp.json`, `.mcp.json`, `<project>/.nessy-agent/mcp.json` and
   * MCP Sources. All of them are enforced in one place — the discovered-record
   * filter in `storage-runtime.ts` — because that is the single point every
   * native tier passes through. Bundled skills are exempt: `settings-reference.md#strictpluginonlycustomization-skills` keeps them
   * under a locked `skills` — it "keeps loading plugin skills, bundled skills,
   * and skills in the managed policy directory" (fetched 2026-08-25).
   *
   * `hooks` is enforced through the SAME gate as {@link allowManagedHooksOnly}
   * rather than by dropping hook records here: the lock has to keep READING a
   * user document (its `disableAllHooks` key is honoured even where its hooks are
   * blocked — `runtime-automations.ts`), so removing the record would take away a
   * documented read as well as the hooks.
   */
  readonly strictPluginOnlyCustomization?: readonly StrictCustomizationSurfaceV1[]
  /**
   * `settings-reference.md#permissions-defaultmode`'s `defaultMode` — "Set the
   * permission mode new sessions start in" (fetched 2026-08-25; the older
   * "Default permission mode when opening Claude Code" is on no fetchable
   * revision of the page, so it was a phantom quote as well as a dead anchor).
   *
   * The CONCEPT already ships as `defaults.permissionMode`, resolved
   * session > trusted project `.nessy-agent/config.toml` > workspace > global.
   * What was missing is the managed tier: an administrator could forbid modes
   * with {@link disabledPermissionModes} but could not choose the one a session
   * opens in. This key supplies the floor those four tiers resolve against.
   *
   * Spelled with OUR mode names, not Claude's, for the same reason
   * `disabledPermissionModes` is: this is a Nessy `managed-policy.json`, and one
   * document must not use two vocabularies for one enum. `allow-all` is
   * `bypassPermissions`; `ask` is `default`/`manual`.
   *
   * It sets a default, never a ceiling: `settings-reference.md#permissions-defaultmode` has the
   * `--permission-mode` flag override it for a single session, so an explicit
   * per-session request still wins and {@link disabledPermissionModes} remains
   * the key that actually forbids.
   */
  readonly defaultMode?: PermissionMode
  /**
   * Master switch for MCP channel push (a connected server steering a live
   * turn). `false` is terminal: no workspace or user setting can turn it back
   * on. `true` grants nothing on its own — the user switch still has to be on.
   */
  readonly channelsEnabled?: boolean
  /**
   * The operator's OFF SWITCH for background agents — P6.237.
   *
   * `admin-setup.md#decide-what-to-enforce` is the page; the SDK's own
   * `Settings` carries the same name (`sdk.d.ts`: "Disable agent view (`claude
   * agents`, `--bg`, /background, the on-demand daemon). Typically set in
   * managed settings. Equivalent to `CLAUDE_CODE_DISABLE_AGENT_VIEW=1`."), so
   * the spelling is the runtime's and not ours to invent.
   *
   * The ENFORCING pole is `true`, which is why it is spelled as a disable
   * rather than an enable: an invalid value reads as `true`, and absent means
   * background sessions are allowed. Enforced host-side at
   * `ChildSessionService.start()` — the single admission point every background
   * surface reaches — so it binds Pi, claude and codex alike. It is deliberately
   * NOT projected into the claude SDK's policy tier: measured at `2.1.233`, the
   * filter that tier passes through does not carry this key, so a projection
   * would be a silent drop (`claude-managed-settings.ts`, `CLAUDE_MANAGED_GAPS`).
   */
  readonly disableAgentView?: boolean
  /**
   * What an UNATTENDED turn answers when no rule and no floor covered the call
   * — P6.531's residue, registered here so the setting is SCORED for enforcement
   * like every other managed key rather than being an operator control no
   * administrator can reach.
   *
   * The vocabulary is the setting's own
   * ({@link UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY} in
   * `config/unattended-approval.ts`, Q-den 68 = A + C): `deny` and `allow`, and
   * nothing else. The ENFORCING pole is `deny`, so an unrecognised managed value
   * reads as `deny` — a typo in a restriction must not silently open it, which is
   * the same direction the user-scope parser takes for the same reason.
   *
   * NARROWS ONLY, which is why the composition is a one-way test rather than a
   * precedence chain: a managed `deny` cannot be widened by a user's or an
   * operator's `allow`, while a managed `allow` grants nothing on its own and
   * leaves the settings/env answer standing. A floor that hands capability out is
   * not a floor — the rule this schema already applies to `channelsEnabled`.
   *
   * NOT projected into the claude SDK's policy tier: the filter that tier passes
   * through carries no such key, and there is no vendor key to carry it under, so
   * a projection would be a silent drop (`claude-managed-settings.ts`,
   * `CLAUDE_MANAGED_GAPS`). Enforcement is host-side, and today the only runtime
   * that reaches the uncovered-call case with no human is codex — Pi and claude
   * already refuse there.
   */
  readonly unattendedApprovalFallback?: 'deny' | 'allow'
  /**
   * MCP source names permitted to push on the channel. Absent means the managed
   * policy imposes no per-source narrowing, matching how `allowedMcpServers`
   * already reads. Keyed on the SOURCE name, not a plugin key, because the
   * pool's channel gate is per connected source.
   */
  readonly allowedChannelServers?: readonly string[]
  /**
   * Admin-owned sandbox settings. Composed as the host-owned FLOOR of
   * `resolveSandboxSettings`, which makes its denies a minimum, its grants a
   * maximum, and `allowUnsandboxedCommands: false` an unbreakable lock.
   */
  readonly sandbox?: SandboxSettingsV1
  /**
   * Admin-owned workflow governance. `workflows.md` §Turn workflows off names
   * managed settings as the org-wide switch, so `disableWorkflows` must reach
   * this tier. Composed tighter-wins by `resolveWorkflowSettings`: an org that
   * turns workflows off cannot be overridden by a user or env layer.
   */
  readonly workflow?: WorkflowSettingsV1
  /**
   * Wildcard URL allowlist for plugin `http` hooks — the counterpart of
   * Claude's managed `allowedHttpHookUrls`
   * (`settings-reference.md#allowedhttphookurls`: Claude Code "runs an HTTP hook
   * only if its URL matches one of the patterns and blocks the rest without
   * running them; an empty array blocks every HTTP hook" — fetched 2026-08-25,
   * replacing a quote about "silently blocked" that is on no fetchable revision).
   * Hostname match is case-insensitive, a trailing FQDN dot is ignored, and `*`
   * matches one hostname segment — all three still stated there. Absent = no URL
   * constraint. This is the SSRF containment for the http hook type.
   */
  readonly allowedHttpHookUrls?: readonly string[]
  /**
   * Env-var names http hooks may interpolate into headers — the counterpart of
   * Claude's managed `httpHookAllowedEnvVars`
   * (`settings-reference.md#httphookallowedenvvars`: "a hook can use a variable
   * only if both its own `allowedEnvVars` and this key name it" — fetched
   * 2026-08-25). Absent = no managed narrowing. This is the secret-exfiltration
   * containment for the http hook type.
   */
  readonly httpHookAllowedEnvVars?: readonly string[]
  /**
   * Claude permission-rule strings (permissions.md), compiled at load into
   * DSL rules appended to `permissionDsl` — same evaluation, same receipts,
   * with generated ids `claude-<action>-<index>`.
   *
   * R1 parsed this FAIL-CLOSED, on the reasoning that "an admin's rule that
   * silently does nothing is worse than a crash": an entry that parsed to an
   * inert form or could not be enforced aborted startup like every other
   * malformed key. R25a REVERSED that for the managed tier. The reasoning was
   * sound about silence and wrong about the remedy — the crash it chose was a
   * whole fleet refusing to start on one typo, which `managed-settings.md#invalid-entries-in-managed-settings` rules
   * out — it "drops any top-level key whose value still fails and keeps
   * enforcing every remaining valid key" (fetched 2026-08-29; the older quote
   * here, "a single typo cannot disable the rest of your organization's policy",
   * is on no page of that fetch). The entry is now STRIPPED and recorded as a drop, so it is
   * neither silent nor fatal. The strict entry point still aborts, and
   * user/project/local settings still use it (`managed-settings.md#invalid-entries-in-managed-settings`).
   *
   * (The hook `if` consumer uses the SAME parser with the documented fail-open
   * posture; see `claude-permission-rules.ts:evaluateClaudeHookIfFilter`.)
   */
  readonly claudeRules?: ManagedClaudeRulesV1
  /**
   * Instruction/rule files to skip when loading memory — Claude's
   * `claudeMdExcludes` at the MANAGED scope.
   *
   * `large-codebases.md:155` puts the key at every scope and merges the arrays:
   * "Managed policy CLAUDE.md files cannot be excluded, so organization-wide
   * instructions always apply. You can set `claudeMdExcludes` at any settings
   * scope: user, project, local, or managed. Arrays merge across scopes, so a
   * team can set project-level defaults while individuals add local overrides."
   *
   * Note the two halves of that first sentence, which are easy to conflate: the
   * managed POLICY's own CLAUDE.md files stay un-excludable, while the managed
   * SCOPE may still set the key. Only the second half is this field.
   *
   * RESTRICT-direction, so deliberately NOT in
   * {@link MANAGED_PI_POLICY_WIDENING_KEYS}: the key drops files from context
   * and adding it can only narrow. Its cross-scope composition is a UNION for
   * the same reason — see `agent/memory/instruction-excludes.ts`.
   */
  readonly claudeMdExcludes?: readonly string[]
  /**
   * P6.245 — `settings-reference.md#plugintrustmessage`, verbatim: "Add your
   * organization's own text to the plugin trust warning Claude Code shows
   * before installation, for example to confirm that plugins from your internal
   * marketplace are vetted." Scope `Managed`, type string, "Default: unset, so
   * Claude Code shows the standard warning alone".
   *
   * The vendored runtime renders it in the CLI's own UI, which this fork never
   * shows — the host owns every plugin chrome surface here — so this is a tier-2
   * key: the host supplies the surface once for all three runtimes. It is
   * carried as the administrator's OWN text and rendered verbatim; the host
   * contributes only the label that says whose text it is.
   *
   * Deliberately NOT in {@link MANAGED_PI_POLICY_WIDENING_KEYS}. It is neither a
   * grant nor a restriction — it adds no permission and takes none away — and
   * the immediate-adoption side is the right one for a message an administrator
   * has just published: holding it for a turn boundary would delay the sentence
   * and change nothing about what the session may do.
   *
   * Stripped on any defect rather than repaired, exactly like `model`: a
   * half-parsed sentence shown beside a trust decision is worse than the
   * standard warning alone.
   */
  readonly pluginTrustMessage?: string
  /**
   * P6.245 — `settings-reference.md#companyannouncements`, verbatim: "Show your
   * organization's announcements to users at startup. When you list more than
   * one, Claude Code picks one at random for each session; on a person's very
   * first launch it shows the first entry." Scope `Any file`, type array of
   * strings, "Default: unset, so no announcement shows".
   *
   * `server-managed-settings.md` names it as a key of the DELIVERED document —
   * "shows your `companyAnnouncements` on it" — which is why the carrier is this
   * policy rather than a settings file: an organization must be able to say a
   * control is on and why, through the same channel that turned it on.
   *
   * Same tier-2 reading and the same non-widening judgement as
   * `pluginTrustMessage` above. The page's selection rule (random per session,
   * first entry on a first launch) belongs to whoever renders it, not here:
   * this field carries the administrator's list unchanged.
   *
   * The page states no length limit and none is invented here; an entry must
   * only be non-empty once trimmed.
   */
  readonly companyAnnouncements?: readonly string[]
  /**
   * Org-declared context for the auto-mode classifier — our guardian judge.
   *
   * Entries are PROSE, not regex or tool patterns: the judge reads them as
   * natural-language rules, written the way you would describe your
   * infrastructure to a new engineer. There is deliberately nothing here to
   * match against, so nothing here decides anything on its own.
   *
   * NOT a policy boundary, and it must not be presented as one. The four sets
   * combine ADDITIVELY across scopes, and because `allow` acts as an exception
   * to `soft_deny` inside the judge, a developer-added `allow` entry can
   * override an organization `soft_deny` entry. An admin who needs a real
   * boundary uses a managed `permissionDsl` deny rule, which our deterministic
   * gate applies BEFORE the judge is consulted at all.
   */
  readonly autoMode?: ManagedAutoModePolicyV1
  /**
   * Managed retention window in days — Claude's `cleanupPeriodDays`.
   *
   * Two jobs, both from `settings.md`. It is the top-precedence retention value
   * ("managed settings … can't be overridden by anything"), and it is the one
   * key that overrides the unreadable-settings PAUSE: "unless managed settings
   * provide `cleanupPeriodDays`, in which case the sweep runs at the managed
   * value." An admin can therefore keep a destructive sweep running through a
   * broken user settings file, which is the point.
   *
   * Minimum 1, integer, and `0` is a validation error — the documented schema.
   * R22 parsed this fail-closed to stay consistent with the rest of the file;
   * R25a made the whole file tolerant instead, so an invalid value is now
   * STRIPPED. It is not one of `managed-settings.md#keys-that-fail-closed`'s security-enforcement
   * fields, so there is no tighter value to reinterpret it as — a retention
   * window is not a boundary, and guessing one would delete sessions no admin
   * asked to delete.
   */
  readonly cleanupPeriodDays?: number
  /**
   * Admin floor for automatic compaction. `false` is terminal; `true` grants
   * nothing if the user or process environment disables it.
   */
  readonly autoCompactEnabled?: boolean
  /**
   * Admin switch for connecting a workspace's enabled servers at session
   * start (T10, plugin-install plan § 9b — owner § 0b-4 flipped the default
   * to Claude's `mcp.md` contract: "At session startup, Claude Code connects
   * the servers for enabled plugins automatically").
   *
   * `false` restores the bank's connect-by-intent posture fleet-wide — the
   * session-start connect path is not entered at all, which is the
   * byte-identical pre-T10 behaviour. `true` grants nothing on its own: a
   * user's `sources.connectOnStartup: false` still turns it off (same
   * every-layer-can-narrow composition as {@link autoCompactEnabled} — see
   * `config/source-startup-settings.ts:resolveConnectSourcesOnStartup`).
   * Presence therefore never widens, so it is not a widening key.
   */
  readonly connectSourcesOnStartup?: boolean
  /**
   * The managed kill switch for the desktop host's OWN in-app updater —
   * `config/managed-in-app-updates.ts`'s `MANAGED_IN_APP_UPDATES_KEY`, whose
   * codex spelling is the `[features]` `in_app_updates = false` entry of a
   * deployed `requirements.toml`
   * (`learn.chatgpt.com/docs/enterprise/manage-app-updates.md#turn-off-in-app-updates`,
   * which opens "Create a managed policy that disables the desktop app's own
   * updater" and whose step 5 adds a `[features]` table carrying
   * `in_app_updates = false`; the host prefix is P2.377 — that page is codex's,
   * not Claude's).
   *
   * P2.10 shipped the ENFORCEMENT — every updater entry point asks
   * `areInAppUpdatesManagedDisabled()` — and shipped it with no writer: the key
   * had no field here, so `refuseUnknownKeys` stripped `disableInAppUpdates`
   * out of a host-owned `managed-policy.json` and recorded it as an unknown
   * key. An administrator could deploy the documented switch and watch the app
   * keep updating itself. This field is that hole closed (P2.7 clause (d)), and
   * it is a PRECONDITION of the rest of the row: without it the codex tier is
   * the only writer the switch has ever had.
   *
   * ## Why an invalid value is STRIPPED and not read at an enforcing pole
   *
   * Every neighbouring admin lock here (`allowManagedHooksOnly`,
   * `disableAllHooks`, `allowManagedPermissionRulesOnly`) reads a malformed
   * value at its enforcing pole, because the tighter reading of those keys costs
   * a capability. The tighter reading of THIS key costs a security-update
   * channel, which is the one direction `managed-settings.md#invalid-entries-in-managed-settings`'s general strip rule
   * and `config/managed-in-app-updates.ts`'s own reasoning both refuse: "a
   * malformed managed value must not silently disable a security-update
   * channel, and it must not silently enable one either, so it decides nothing
   * at all." Same posture as `cleanupPeriodDays` and the two version bounds —
   * the keys on this policy that are not boundaries.
   *
   * RESTRICT-direction all the same, so deliberately NOT in
   * {@link MANAGED_PI_POLICY_WIDENING_KEYS}: `true` takes a capability away and
   * absent is today's behaviour.
   */
  readonly disableInAppUpdates?: boolean
  /**
   * The managed kill switch for the desktop host's OWN built-in browser —
   * `config/managed-in-app-browser.ts`'s `MANAGED_IN_APP_BROWSER_KEY`, whose
   * codex spelling is the `[features]` `in_app_browser = false` entry of a
   * deployed `requirements.toml` (*"Disable the desktop app's built-in
   * browser"*).
   *
   * P2.373 measured that NOTHING enforced it — not codex (the flag has no
   * consumer in `codex-rs/features/src/feature_configs.rs`), not us — and made
   * the report say so. P2.399 built the gate: `main/browser-pane-manager.ts`
   * refuses to open a pane and closes any pane already open. This field is the
   * gate's HOST tier, and it was that gate's ONLY fed writer for exactly as long
   * as P2.399's commit stood alone: P2.463 bound the codex tier
   * (`recordCodexInAppBrowserRequirement`, called from `agent/codex-agent.ts`
   * inside the `requirementAnswered` guard), so BOTH tiers are fed now. They
   * compose the way the twin's do — TIGHTEST WINS, and only in the disabling
   * direction, so this field being absent does not re-enable a browser a codex
   * `requirements.toml` disabled, and vice versa.
   *
   * ## Why an invalid value is STRIPPED and not read at an enforcing pole
   *
   * Deliberately NOT the twin's reasoning, and the difference is worth stating
   * because the two keys look identical. The twin fails open because its
   * enforcing pole costs a SECURITY-UPDATE CHANNEL, which
   * `managed-settings.md#invalid-entries-in-managed-settings`'s general strip
   * rule refuses to reach by accident. This key's enforcing pole costs a
   * BROWSER, which is a capability like `allowPluginHooks` — so the
   * fail-closed argument is genuinely available here. It is still not taken: a
   * malformed value is a typo, and a typo silently removing a shipped surface
   * the user can see is the failure this row exists to prevent. The
   * administrator gets a `stripped` diagnostic naming the key instead, which is
   * actionable; a silently disabled browser is not.
   *
   * RESTRICT-direction all the same, so deliberately NOT in
   * {@link MANAGED_PI_POLICY_WIDENING_KEYS}: `true` takes a capability away and
   * absent is today's behaviour.
   */
  readonly disableInAppBrowser?: boolean
  /**
   * P6.338 — the GRADED half of the switch above, and the vendor's own key.
   *
   * `settings-reference.md#disablebrowserexternalnavigation`, fetched
   * 2026-09-07: *"Turn off external browsing in the desktop app's Browser pane
   * for people and Claude alike. Localhost dev server previews keep working."*
   * Type: *"Boolean; only the JSON Boolean `true` takes effect"*; scope
   * `Managed`; default unset, so external browsing is on.
   *
   * `disableInAppBrowser` above is all-or-nothing — it takes the pane away. An
   * operator who wants people to keep previewing their own dev server while no
   * navigation leaves the machine had no key at all before this one, which is
   * the unbounded egress path this row names.
   *
   * **Host-side for all three runtimes, by measurement rather than by
   * preference.** The key is absent from the vendored `2.1.233` bundle
   * (documented-only, bundle lag) and the page says of it *"The desktop app
   * reads this key; the terminal CLI ignores it"* — every claude child we spawn
   * IS that CLI. So there is no native mechanism to enable; our own pane is the
   * only enforcer, and it enforces identically on Pi, claude and codex.
   *
   * `optionalBoolean`, not `securitySwitch`, for `disableInAppBrowser`'s stated
   * reason and for the page's: *"a value that isn't a Boolean … logs a
   * warning"* — a warning, not a tightened reading.
   */
  readonly disableBrowserExternalNavigation?: boolean
  /**
   * P6.765 — the CDP lock's administrator key, and the reason the lock existed
   * without one.
   *
   * P6.536 built the gate: `registerManagedBrowserCdpDisabledProvider` and
   * `isBrowserCdpManagedDisabled` in `config/managed-in-app-browser.ts`, whose
   * own docblock states the requirement verbatim — *"an administrator can lock
   * CDP off SEPARATELY from the pane"*. Measured at HEAD: the provider had no
   * production caller (4 hits, the definition plus one test) and this list
   * carried no CDP key at all, so the gate was ARMED AND UNFED. Every
   * administrator who wrote the obvious thing got nothing, silently, which is
   * the exact defect class this family keeps producing.
   *
   * OURS, with no vendor spelling to defer to. Probed 2026-09-08:
   * `settings-reference.md` and `desktop.md` publish no CDP, DevTools or
   * remote-debugging key at all. codex publishes `browser_use_full_cdp_access`
   * in the vendored `packages/codex-protocol/schema/config-schema.json`, and the
   * CDP seam deliberately has no codex tier for the reason its docblock records
   * — P2.373 measured that codex does not act on its own `in_app_browser` flag,
   * and the pane is OUR Electron surface, so a codex tier would be a second
   * opinion about a debugger codex never attaches.
   *
   * `optionalBoolean` rather than `securitySwitch`, matching every sibling in
   * this family: only an explicit `true` disables, so a deployment that spells
   * the key `false` stays on the same path as an unmanaged one.
   *
   * The pane switch still dominates and it is enforced by CONSTRUCTION rather
   * than by a rule here: the attach gate runs inside a pane, and a pane
   * `disableInAppBrowser` forbids never opens.
   */
  readonly disableBrowserCdp?: boolean
  /**
   * P6.338 — the allowlist between "all external browsing" and "none".
   *
   * OURS, and the one field in this family with no vendor spelling to defer to.
   * `desktop.md#restrict-external-browsing-for-your-organization` (fetched
   * 2026-09-07) says the vendor's Browser *"follows the same site allowlist and
   * blocklist controls as the Claude in Chrome extension"* — an Anthropic admin
   * console this fork has no account on and cannot read — and
   * `disableBrowserExternalNavigation` *"blocks all external navigation …
   * including sites on your organization's allowlist"*. So the vendor has an
   * allowlist and it is not a managed-settings key; there is nothing to project
   * and nothing to alias.
   *
   * The NAME and the SEMANTICS are taken from the nearest documented host-side
   * allowlist this vendor does publish, `desktop.md#restrict-which-ssh-hosts-users-can-connect-to`'s
   * `sshHostAllowlist`: *"users can only connect to hosts whose resolved
   * hostname matches one of the patterns. Set it to an empty array to disable
   * SSH sessions entirely."* Read here exactly the same way — patterns match the
   * URL's hostname, an empty array admits no external host at all, and an absent
   * key is no constraint.
   *
   * A GRANT list under `managed-settings.md#keys-that-fail-closed`'s allowlist
   * row, so a wholly invalid value is enforced as an EMPTY allowlist: a typo
   * costs external browsing and says so, rather than silently admitting the
   * internet. Localhost is exempt on every path, because both vendor keys in
   * this family exempt it in the same words.
   */
  readonly browserHostAllowlist?: readonly string[]
  /**
   * P6.338 — the vendor's key for the AGENT's half of the same pane.
   *
   * `settings-reference.md#browserexternalpagetools`, fetched 2026-09-07:
   * *"Stop Claude from using its tools to read or act on external pages in the
   * desktop app's Browser pane. People in your organization can still open
   * external sites themselves, and local dev server previews keep working with
   * Claude's tools."* Type: *"string, `\"disabled\"`; the desktop app also
   * accepts `\"disable\"`, in either case"*; scope `Managed`; default unset.
   *
   * Stored as the normalised `'disabled'` so exactly one spelling reaches every
   * reader — the page's two accepted spellings are an input tolerance, not two
   * states. *"Any other value leaves Claude's tools on, and a non-empty string
   * that isn't one of the two accepted values logs a warning"*, which is
   * `stripped` plus the value's own drop line, not a tightened reading.
   *
   * This build CAN tell the two actors apart, which is why the key is carried
   * rather than refused by name: the browser pane already tracks
   * `instance.agentControl.active`, so a navigation the agent drives is
   * distinguishable from one the person drives at the single gate both use.
   */
  readonly browserExternalPageTools?: 'disabled'
  /**
   * P6.537 — the operator's own model PRICE TABLE, and the reason it is
   * `unknown` rather than a typed shape.
   *
   * `settings-reference.md#modelpricing`, scope `Managed`: *"Deploy the key
   * through server-managed settings, an MDM policy, a `managed-settings.json`
   * file, or a policy helper."* Owner decision 2026-09-05 D11 = option A: a
   * host-side table read identically by Pi, claude and codex, operator-supplied
   * and never bundled by us, with every priced figure carrying M10's basis
   * label so a managed price is visibly a managed price.
   *
   * **Deliberately `unknown`.** `config/managed-model-prices.ts` owns the whole
   * validation and RETURNS its rejections rather than throwing, so the doctor
   * surface can name a mistyped rate. If this loader typed and validated the
   * block too, one bad rate inside a large table would either fail the whole
   * document or be dropped by a second parser that has to be kept in step with
   * the first — and the accepted cost of D11 is already that a wrong entry
   * produces a confidently wrong figure, which is exactly the case that must
   * stay legible.
   *
   * Host-side, and **the reason this sentence used to give is dead** (C3.252,
   * 2026-09-12). It read: "the key requires Claude Code v2.1.242, the vendored
   * SDK self-reports 2.1.233, and `grep -aoF modelPricing sdk.mjs` returns 0
   * with `Cookie` -> 5 and `git-subdir` -> 4 as the controls. The bundle lags
   * the contract". At `0.3.247` / `2.1.247` it was already past v2.1.242, and
   * `modelPricing` re-measured on the same rig scored **2 lines / 10
   * occurrences** in `sdk.mjs` and 8/28 in the native binary, with `Cookie`
   * 4/5 and `git-subdir` 1/4 in `sdk.mjs` as the same two controls (2026-09-12;
   * read the two self-reports for TODAY). The verdict stands on REACHABILITY, and the
   * measurement for it is written out once on
   * `claude-managed-settings.ts`'s `modelPricing` entry (P7.16): the key is
   * honoured from managed sources only, `Options.settings` IS the `--settings`
   * tier the doc excludes, and the restrictive managed filter does not copy it.
   * The guard stays derived from the PAGE.
   */
  readonly modelPricing?: unknown
  /**
   * P6.498 — "gateway sign-in only", and it is OURS because no vendor key can
   * do it here.
   *
   * Delegated decision 2026-09-05, Q-den 15 = option A: host-side enforcement
   * that hides and refuses every non-gateway connection card. `true` locks;
   * `false` and absent are both "no constraint".
   *
   * **Native mechanism, and why it is not enough — measured, not assumed.**
   * claude publishes `forceLoginMethod` and it is a real key in the shipped
   * bundle. It cannot ride OUR tier: the SDK's restrictive managed-settings
   * filter, re-extracted from the vendored `2.1.233`, copies
   * `forceLoginOrgUUID` and **not** `forceLoginMethod`, so a projection would
   * be a silent no-op. And even a working projection would enforce on ONE
   * runtime of three — Pi and codex have no login-method gate at all — which is
   * the silent divergence the native-first rule exists to prevent. The host
   * owns credential selection for all three, so the host is the seam. The
   * refusal for the vendor key is recorded by name in
   * {@link DOCUMENTED_UNENFORCED_KEYS}.
   *
   * `optionalBoolean`, not `securitySwitch`: the enforcing pole of this key is
   * "no connection can be added at all", and a typo that reached that pole
   * would lock a fleet out of its own product. An administrator gets a
   * `stripped` diagnostic naming the key instead, which is actionable.
   */
  readonly disableNonGatewayConnections?: boolean
  /**
   * Admin-delivered environment variables — Claude's managed `env` block.
   *
   * Every entry applies at startup EXCEPT, when the block arrives from the
   * server-fetched cache, the transport, routing and credential categories
   * `server-managed-settings.md#fetch-and-caching-behavior` withholds until a
   * fresh fetch confirms the payload — "Claude Code withholds several categories
   * of variables in the cached `env` block until the server confirms the payload
   * for the session." `config/managed-env.ts` owns that classification and
   * explains why it exists; nothing here decides it, because the same block
   * delivered through the host-owned policy FILE is not withheld at all: "The
   * hardening applies only to the server-fetched settings cache: endpoint-managed
   * settings deployed through MDM or `managed-settings.json` are unaffected."
   *
   * Values are secrets as often as not — a proxy URL with an embedded
   * password, an API key. Drop reasons for this block therefore name the KEY
   * and never the value, because drops are rendered by the startup dialog and
   * by `doctor`.
   */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Fail-closed startup — `server-managed-settings.md#enforce-fail-closed-startup`.
   *
   * "When this setting is active in a session that fetches server-managed
   * settings, the CLI blocks at startup until remote settings are freshly
   * fetched. If the fetch fails, the CLI exits rather than proceeding without
   * the policy." Self-perpetuating: "once delivered from the server, it is also
   * cached locally so that subsequent startups enforce the same behavior even
   * before the first successful fetch of a new session" — which falls out of the
   * cache storing the salvaged payload, with no special case needed.
   *
   * The same section makes it an EXCEPTION to the precedence rule: "In Claude
   * Code v2.1.191 or later, this flag is an exception to the precedence rule
   * above: Claude Code honors it when any admin-controlled managed source sets
   * it, even if a cached server-managed payload is also present", so an
   * MDM-delivered value is not swallowed by the normal "server-managed wins
   * wholesale" rule. `config/managed-delivery.ts` reads it from both sources for
   * that reason.
   *
   * An invalid value is STRIPPED, not read at its enforcing pole. Every other
   * security switch here tightens on garbage, and this one deliberately does
   * not: the tightened reading of this key is "refuse to start", so a typo in a
   * fleet-wide push would stop every client — the exact failure both
   * `managed-settings.md#invalid-entries-in-managed-settings` ("drops any
   * top-level key whose value still fails and keeps enforcing every remaining
   * valid key") and `managed-settings.md#keys-that-fail-closed`'s version-gate
   * row ("`requiredMinimumVersion` and `requiredMaximumVersion` fail open by
   * design: an invalid value is dropped rather than enforced, so a bad policy
   * push can't prevent Claude Code from starting") rule out. Both fetched
   * 2026-08-29. The `:185`/`:201` line anchors this comment used to carry read as
   * continuations of `server-managed-settings.md` — and neither sentence, nor the
   * words "fail open" or "single typo", is anywhere on that page today
   * (positive control on the same fetch: `forceRemoteSettingsRefresh` ×7). So the
   * page attribution was wrong as well as the line number, which is the failure a
   * bare `:NNN` continuation is built to hide.
   */
  readonly forceRemoteSettingsRefresh?: boolean
  /**
   * Admin version floor — `settings-reference.md#requiredminimumversion`. "Set the
   * oldest Claude Code version your organization allows to start. When the running
   * version is older, Claude Code exits at startup and tells the user to update
   * through your organization's approved method." (fetched 2026-08-29.)
   *
   * Managed-only, and FAIL-OPEN — `managed-settings.md#keys-that-fail-closed` names
   * both bounds: "`requiredMinimumVersion` and `requiredMaximumVersion` fail open
   * by design: an invalid value is dropped rather than enforced, so a bad policy
   * push can't prevent Claude Code from starting." Enforced by
   * `config/managed-version-gate.ts`, which fails open again on an unparseable
   * running version.
   */
  readonly requiredMinimumVersion?: string
  /** Admin version ceiling — `settings-reference.md#requiredmaximumversion`. Same fail-open rule. */
  readonly requiredMaximumVersion?: string
  /**
   * Model allowlist — `settings-reference.md#availablemodels`. "Restrict which models
   * people can select for the main session, subagents, skills, and the advisor. A
   * managed list constrains `/model`, `--model`, and the `model` key in a
   * developer's own files; a model outside it can't be selected. On its own this
   * doesn't touch the Default option; pair it with `enforceAvailableModels` for
   * that." (fetched 2026-08-29.)
   *
   * A GRANT list under the `managed-settings.md#keys-that-fail-closed` row, whose whole
   * cell reads "Enforced as an empty allowlist until fixed, so only the Default
   * model is available; a non-string entry is stripped and the valid subset
   * enforced" — so a wholly invalid value costs every model but Default, and one
   * bad entry costs only itself.
   *
   * **Cross-SCOPE composition: there is none to specify, measured 2026-09-06
   * (P6.250 / denominator B35).** The sweep asked whether a managed list and a
   * project-scope list merge or replace. This key has **no non-managed reader**:
   * every settings-key occurrence of `availableModels` under `packages/**` and
   * `apps/**` is this managed key or a test of it (the renderer's
   * `CompactModelSelector` hit is a local variable of the same name, not a
   * setting). Its two page-siblings under the same combination rule are not
   * settings keys here AT ALL — `fallbackModel` is a CLI flag plus an env var
   * (`apps/cli/src/index.ts`), and every `modelPicker` hit is an i18n key
   * (`chat.modelPicker.*`) or the `enableCompactModelPicker` prop. Positive
   * control on the same search: `permissions.allow` DOES have both a managed and
   * a project-scope reader, so the question is answerable for a key that has one.
   * The managed tier is the only tier, so nothing can merge or replace, and a
   * composition rule written here would be a control this repo states and does
   * not have.
   */
  readonly availableModels?: readonly string[]
  /**
   * Extend {@link ManagedPiPolicyV1.availableModels} to the Default model —
   * `settings-reference.md#enforceavailablemodels`. A security switch whose enforcing pole is `true`
   * (`managed-settings.md#keys-that-fail-closed`: "Treated as `true`").
   */
  readonly enforceAvailableModels?: boolean
}

/** Claude rule strings per action, as an admin writes them. */
export interface ManagedClaudeRulesV1 {
  readonly allow?: readonly string[]
  readonly ask?: readonly string[]
  readonly deny?: readonly string[]
}

/**
 * One scope's contribution to the auto-mode sets. Field names are the
 * documented wire keys, snake_case included, because this is a config contract
 * an admin writes by hand.
 */
export interface ManagedAutoModePolicyV1 {
  /** What is INSIDE the boundary — context, trust and sensitivity slots. */
  readonly environment?: readonly string[]
  /** Unconditional. Neither user intent nor an `allow` entry applies. */
  readonly hard_deny?: readonly string[]
  /** Destructive. User intent and an `allow` entry can clear these. */
  readonly soft_deny?: readonly string[]
  /** Exceptions to `soft_deny`. */
  readonly allow?: readonly string[]
  /**
   * `auto-mode-config.md:226` — "Set `autoMode.classifyAllShell` to `true` to
   * suspend every Bash and PowerShell allow rule while auto mode is active, so
   * the classifier evaluates every shell command regardless of your allow
   * list."
   *
   * The fifth documented field, and the only one that is not prose: it is a
   * BAND control, deciding which actions reach the judge rather than what the
   * judge is told. It is parsed and carried; the band that would honour it does
   * not exist yet (our auto-mode gate consults the judge only for a result that
   * already reached `prompt`), so today the key is accepted and inert. That is
   * the same posture `auto-mode-config.md:241` describes for a client older
   * than v2.1.193 — "Earlier versions ignore the key and continue to carry
   * narrow shell allow rules into auto mode" — and it is strictly better than
   * the previous behaviour, which REFUSED the key and took the admin's valid
   * `allow` prose down with it.
   */
  readonly classifyAllShell?: boolean
}

/** Every autoMode set, resolved to concrete prose with no sentinels left. */
export interface ResolvedAutoModePolicyV1 {
  readonly environment: readonly string[]
  readonly hard_deny: readonly string[]
  readonly soft_deny: readonly string[]
  readonly allow: readonly string[]
}

/** The four PROSE sets — the sets the judge's policy section is built from. */
const AUTO_MODE_KEYS = ['environment', 'hard_deny', 'soft_deny', 'allow'] as const

/**
 * The two sets a USER scope may contribute — P6.493, decided 2026-09-05 (Q-den 2,
 * option C). Both can only ever NARROW: a `hard_deny` or `soft_deny` entry adds a
 * boundary the judge must respect, and no entry in either set can clear one.
 *
 * `auto-mode-config.md#where-the-classifier-reads-configuration` lists a user
 * scope (`~/.claude/settings.json`) as one of three, and says of it: *"Entries
 * from each scope are combined. A developer can extend `environment`, `allow`,
 * `soft_deny`, and `hard_deny` with personal entries but can't remove entries
 * that managed settings provide. Because allow rules act as exceptions to soft
 * block rules inside the classifier, a developer-added `allow` entry can
 * override an organization `soft_deny` entry: the combination is additive, not
 * a hard policy boundary."* (fetched 2026-09-07.)
 *
 * That last clause is the whole reason we take only two of the four. The page's
 * own sentence concedes that its "can't remove" guarantee does not hold for
 * `allow` — an additive user `allow` IS a removal of an org `soft_deny`, by a
 * different route. We refuse it here rather than reproduce it.
 */
export const USER_SCOPE_AUTO_MODE_KEYS = ['hard_deny', 'soft_deny'] as const

/**
 * The two sets managed settings own outright — the other half of P6.493.
 *
 * `allow` grants: it is the documented exception channel to `soft_deny`, so a
 * user-writable `allow` makes a safety judge's trust boundary user-writable.
 * `environment` is not a rule at all — it tells the judge what "inside the
 * boundary" MEANS (which repos, buckets, domains and identities are ours), so a
 * user entry there does not add a boundary, it moves one. Both stay
 * administrator-only, and a user block carrying either is refused BY NAME —
 * {@link refusedUserAutoModeKeys}.
 */
export const MANAGED_ONLY_AUTO_MODE_KEYS = ['environment', 'allow'] as const
/** Every key the block accepts, prose sets plus the band control. */
const AUTO_MODE_BLOCK_KEYS = [...AUTO_MODE_KEYS, 'classifyAllShell'] as const

/**
 * The documented splice sentinel. Present: the scope EXTENDS the defaults.
 * Absent: the scope REPLACES them — which the docs flag with a Danger callout,
 * because dropping it silently discards every default entry.
 */
export const AUTO_MODE_DEFAULTS_SENTINEL = '$defaults'

/** Prose entries are bounded, but far longer than an identifier key. */
const AUTO_MODE_ENTRY_MAX = 512
const AUTO_MODE_ENTRIES_MAX = 64
/**
 * C0 controls (CR/LF/TAB/ESC included), DEL and C1 controls. A prose rule is
 * ONE line: rejecting the whole class here is what makes it structurally
 * impossible for an entry to forge a `Human:`/`Assistant:` turn boundary or an
 * extra section header once it is rendered into the judge's task, and it stops a
 * terminal escape from riding along into a log. Rejected at parse time rather
 * than mangled at render time, so an admin sees the error instead of silently
 * losing half a rule.
 */
const AUTO_MODE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/**
 * Every key the policy schema accepts. Exported because two invariants outside
 * the parser are stated over the whole key set: the delivered-vs-file
 * composition (`config/managed-composition.ts`) and the reachability property
 * that pins every field as deliverable. A new field added here without being
 * added to those fails them, which is the point.
 *
 * ## Before adding a key: ask whether the managed `env` block already reaches
 * the reader (D1.190, from D1.36's evidence)
 *
 * A new key here is not one line. It costs a `CLAUDE_MANAGED_GAPS` row, a
 * widening-keys entry, a parser arm and an entry in the every-key fixture — and
 * it is the wrong instrument whenever the thing an administrator wants to pin is
 * already an environment variable some reader consults.
 *
 * D1.36 is the measured case, and it closed with NO key. An organisation wanting
 * tool search kept on looked like a policy-key gap; at HEAD it is not, because
 * `classifyManagedEnvVar` answers `immediate` for any name outside its table and
 * `isRefusedManagedEnvVar` refuses exactly one name, so a managed `env` block may
 * carry the switch; `applyManagedEnv` writes it OVER the ambient value and
 * records managed origin; and both hosts run `startManagedDeliveryEnvApplication()`
 * at boot, long before any manifest is read. The administrator already outranked
 * the developer switch, and the row's real residue was that the refusal was
 * SILENT — a diagnostic, not a key.
 *
 * So the question is the ordering, not a preference: **does the reader consult
 * an env var, and does the managed `env` block reach it before the reader runs?**
 * If yes, `env` costs nothing and this list stays as short as the surfaces that
 * genuinely have no other channel. If no, add the key — and add it to all four
 * sites in the same commit, for the reason the anchor below gives.
 */
export const MANAGED_PI_POLICY_KEYS = [
  'schemaVersion',
  'disabledPermissionModes',
  'permissionDsl',
  'allowedPluginKeys',
  'deniedPluginKeys',
  'enabledPlugins',
  'allowedMcpServers',
  'deniedMcpServers',
  'allowPluginHooks',
  'allowManagedHooksOnly',
  'disableCommandPluginSources',
  'disableAllHooks',
  'disableSideloadFlags',
  'allowManagedPermissionRulesOnly',
  'allowManagedMcpServersOnly',
  'model',
  'strictPluginOnlyCustomization',
  'defaultMode',
  'channelsEnabled',
  'disableAgentView',
  'unattendedApprovalFallback',
  'allowedChannelServers',
  'sandbox',
  'workflow',
  'allowedHttpHookUrls',
  'httpHookAllowedEnvVars',
  'claudeRules',
  'claudeMdExcludes',
  'pluginTrustMessage',
  'companyAnnouncements',
  'autoMode',
  'cleanupPeriodDays',
  'autoCompactEnabled',
  'connectSourcesOnStartup',
  'disableInAppUpdates',
  'disableInAppBrowser',
  'disableBrowserExternalNavigation',
  'disableBrowserCdp',
  'browserHostAllowlist',
  'browserExternalPageTools',
  'modelPricing',
  'disableNonGatewayConnections',
  'env',
  'forceRemoteSettingsRefresh',
  'requiredMinimumVersion',
  'requiredMaximumVersion',
  'availableModels',
  'enforceAvailableModels',
  'strictKnownMarketplaces',
  'blockedMarketplaces',
  'extraKnownMarketplaces',
  'pluginSuggestionMarketplaces', 'managedMcpServers', // F1.593: declared at the file end
] as const satisfies readonly (keyof ManagedPiPolicyV1)[]

/**
 * The list is tied to the interface in BOTH directions — P6.873.
 *
 * The `satisfies` clause above rejects an entry the interface does not declare:
 * a stale spelling left behind by a rename, which would otherwise sit in the
 * list forever and be iterated by every site.
 *
 * This anchor is the other direction, and it is the one that hurts. Every
 * whole-key-set invariant is stated over the ARRAY — the parser's allow-set,
 * the delivered-vs-file composition, the reachability property, the every-key
 * fixture — so an interface field with no array entry is invisible to all of
 * them at once: the schema declares it, nothing delivers it, and no test says
 * so. `Exclude<…>` is `never` when the list is complete, making this
 * `Record<never, never>`, which `{}` satisfies; a forgotten field makes it
 * `Record<'thatField', never>` and the compiler error NAMES the field.
 *
 * Both directions bind at `bun run typecheck:shared`, not at `bun test` —
 * `bun test` does not typecheck, and an anchor that binds nowhere is a shape
 * this repo has already shipped (`runtime-vocabulary.ts` carries the same pair
 * for the runtime unions, with the same reason written down).
 */
export const MANAGED_PI_POLICY_KEYS_ARE_EXHAUSTIVE: Record<
  Exclude<keyof ManagedPiPolicyV1, (typeof MANAGED_PI_POLICY_KEYS)[number]>,
  never
> = {}

/**
 * The keys whose PRESENCE widens rather than constrains.
 *
 * Almost every key in this schema is an administrator's restriction, and an
 * ABSENT key means "no managed constraint" — the app's own default applies. So
 * adding a key can only narrow, which is what {@link isManagedPolicyTightening}
 * relies on. These are the exceptions, each of which hands something OUT:
 *
 *  - `extraKnownMarketplaces` adds marketplaces a user may install from;
 *  - `pluginSuggestionMarketplaces` hands a surface OUT: its presence lets a
 *    marketplace's own `relevance` declarations pin plugins in front of the
 *    user, which nothing does without it;
 *  - `enabledPlugins` force-enables plugins, and `settings-reference.md#what-runs-under-allowmanagedhooksonly` makes a
 *    force-enabled plugin's hooks load even under `allowManagedHooksOnly`;
 *  - `env` sets environment variables in the agent's process;
 *  - `defaultMode` can name a MORE permissive mode than the app's default;
 *  - `autoCompactEnabled` is a product preference, not a restriction;
 *  - `workflow` carries `sizeGuideline` alongside `disableWorkflows`, so its
 *    presence is not purely restrictive;
 *  - `availableModels` widens unless `enforceAvailableModels` rides with it,
 *    which is a two-key relationship this predicate deliberately does not try
 *    to reason about.
 */
const MANAGED_PI_POLICY_WIDENING_KEYS: ReadonlySet<string> = new Set([
  'extraKnownMarketplaces',
  'pluginSuggestionMarketplaces',
  'enabledPlugins',
  'env',
  'defaultMode',
  'autoCompactEnabled',
  'workflow',
  'availableModels', 'managedMcpServers', // F1.593: it hands servers OUT
])

/**
 * The keys that are DENY LISTS: every entry is one more thing refused, so a
 * SUPERSET of the previous value can only narrow what is permitted.
 *
 * They need naming because the plain "an added key constrains" rule below
 * cannot see them. `disabledPermissionModes` is REQUIRED and starts as `[]`, so
 * an administrator disabling `allow-all` after an incident — the single most
 * ordinary tightening there is — reads as a CHANGED key rather than an added
 * one, and would have waited for a turn boundary for no reason.
 *
 * Allow lists are deliberately absent: for `allowedMcpServers`,
 * `allowedPluginKeys`, `allowedChannelServers`, `allowedHttpHookUrls`,
 * `httpHookAllowedEnvVars` and `availableModels`, a superset is a WIDENING, and
 * a subset is the tightening — the opposite direction, which the strict rule
 * already holds for a turn boundary.
 */
const MANAGED_PI_POLICY_DENY_LIST_KEYS: ReadonlySet<string> = new Set([
  'disabledPermissionModes',
  'deniedPluginKeys',
  'deniedMcpServers',
])

/** Order-independent structural equality, for comparing two policy values. */
function canonicalPolicyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPolicyJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = value as Record<string, unknown>
    return `{${Object.keys(entries).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalPolicyJson(entries[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Whether two policies enforce exactly the same thing. */
export function managedPolicyEquals(a: ManagedPiPolicyV1, b: ManagedPiPolicyV1): boolean {
  return canonicalPolicyJson(a) === canonicalPolicyJson(b)
}

/**
 * The policy keys whose value differs between two policies — NAMES ONLY —
 * P6.463.
 *
 * Derived from {@link MANAGED_PI_POLICY_KEYS} rather than from either policy's
 * own key set, so a key added to the schema is compared from the day it exists
 * and a key present in one policy and absent from the other is still reported.
 * The comparison is {@link canonicalPolicyJson}'s, the same one
 * {@link managedPolicyEquals} uses, so "the policies differ" and "these keys
 * differ" can never disagree.
 *
 * **Names, never values, and that is a security property rather than a
 * convenience.** The one consumer is a `ConfigChange` hook payload, and a
 * `ConfigChange` hook is arbitrary shell an administrator declared. A managed
 * `env` block routinely holds a credential, so putting policy VALUES on that
 * input would hand a secret to a user-declared command — the same rule
 * `config/managed-delivery.ts` states at its own report site ("Values never
 * travel").
 */
export function changedManagedPolicyKeys(
  previous: ManagedPiPolicyV1,
  next: ManagedPiPolicyV1,
): readonly string[] {
  const changed: string[] = []
  for (const key of MANAGED_PI_POLICY_KEYS) {
    const before = (previous as unknown as Record<string, unknown>)[key]
    const after = (next as unknown as Record<string, unknown>)[key]
    if (canonicalPolicyJson(before) !== canonicalPolicyJson(after)) changed.push(key)
  }
  return Object.freeze(changed)
}

/**
 * Whether moving from `previous` to `next` can only ever NARROW what is
 * permitted — the question a running fleet has to answer before it applies a
 * policy change mid-session.
 *
 * A tightening is applied AT ONCE: an administrator who denies an MCP server
 * after an incident must not wait for every desktop in the fleet to be
 * restarted. Anything else waits for a turn boundary, because a widening that
 * lands between the gate's decision and the next tool call of the same turn is
 * a security event rather than a convenience, and because the model's tool
 * surface for a turn is pinned to one capability generation — quietly widening
 * underneath it makes the manifest and the policy disagree.
 *
 * The test is deliberately CONSERVATIVE and structural rather than semantic:
 * only an added constraining key counts as a tightening. A key removed, a key's
 * value changed, or any {@link MANAGED_PI_POLICY_WIDENING_KEYS} key touched all
 * answer `false` — including changes that a per-key reading would call a
 * narrowing. The cost of a false `false` is one turn of delay; the cost of a
 * false `true` is a widening applied mid-turn, so the asymmetry decides the
 * shape.
 */
export function isManagedPolicyTightening(
  previous: ManagedPiPolicyV1,
  next: ManagedPiPolicyV1,
): boolean {
  for (const key of MANAGED_PI_POLICY_KEYS) {
    const before = (previous as unknown as Record<string, unknown>)[key]
    const after = (next as unknown as Record<string, unknown>)[key]
    if (canonicalPolicyJson(before) === canonicalPolicyJson(after)) continue
    // A deny list that only GREW refuses strictly more than it did.
    if (MANAGED_PI_POLICY_DENY_LIST_KEYS.has(key) && isDenyListSuperset(before, after)) continue
    // Otherwise: only a newly-ADDED constraining key narrows.
    if (before !== undefined) return false
    if (MANAGED_PI_POLICY_WIDENING_KEYS.has(key)) return false
  }
  return true
}

/** Whether `after` keeps every entry `before` had, and is a list at all. */
function isDenyListSuperset(before: unknown, after: unknown): boolean {
  if (before === undefined) return Array.isArray(after)
  if (!Array.isArray(before) || !Array.isArray(after)) return false
  const kept = new Set(after.map(canonicalPolicyJson))
  return before.every(entry => kept.has(canonicalPolicyJson(entry)))
}

const DISABLEABLE_MODES = new Set<PermissionMode>(['default', 'acceptEdits', 'auto', 'bypassPermissions'])

/**
 * Parse `disabledPermissionModes` accepting EVERY spelling the shared alias
 * table resolves (internal, Claude's, legacy) — this parser used to demand the
 * internal spellings verbatim, so a policy written in Claude's vocabulary
 * dropped the whole list. Same strictness otherwise: not a ≤4-entry string
 * array, a spelling that does not resolve, a mode outside
 * {@link DISABLEABLE_MODES}, or two spellings resolving to the SAME mode all
 * still throw (and the tolerant caller then drops the restricting list, per
 * `managed-settings.md#keys-that-fail-closed`).
 */
function disabledPermissionModeList(value: unknown): readonly PermissionMode[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error('invalid managed Pi policy list')
  const seen = new Set<PermissionMode>()
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('invalid managed Pi policy list')
    const mode = parsePermissionMode(entry)
    if (!mode || !DISABLEABLE_MODES.has(mode) || seen.has(mode)) {
      throw new Error('invalid managed Pi policy list')
    }
    seen.add(mode)
  }
  return Object.freeze([...seen])
}
const PLUGIN_KEY = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const MCP_SERVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** A URL-shaped pattern: explicit scheme, bounded, no whitespace or controls. */
const HTTP_HOOK_URL_PATTERN = /^https?:\/\/\S{1,2048}$/
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/**
 * One `browserHostAllowlist` entry — P6.338.
 *
 * A hostname, or a `*.` LABEL wildcard in front of one, which is the exact
 * shape `desktop.md#restrict-which-ssh-hosts-users-can-connect-to` shows for
 * `sshHostAllowlist` (`"*.devboxes.example.com"`). No scheme, no port, no path:
 * the value matched against it is a URL's hostname, and admitting a longer
 * spelling here would produce an entry that silently never matches.
 *
 * A BARE `*` is deliberately not accepted. It reads as "allow everything",
 * which is what an ABSENT key already means, and an operator who writes it into
 * an allowlist has almost certainly not meant to hand out the internet.
 */
const BROWSER_HOST_PATTERN = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/
/**
 * A model identifier as an admin writes it: an alias (`sonnet`), a full id
 * (`claude-opus-4-5-20260101`), or a vendor-prefixed Pi/gateway id
 * (`tgpt/qwen35-397b-a17b-fp8`). Deliberately permissive about the character
 * set and strict about the shape — a validator that rejected an unusual but
 * real id would silently narrow an admin's allowlist, and `managed-settings.md#keys-that-fail-closed`
 * makes a narrowed allowlist the ENFORCED outcome.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,255}$/
/**
 * One `claudeMdExcludes` entry: a glob or an absolute path.
 *
 * `large-codebases.md:137` — "Patterns use glob syntax matched against absolute
 * file paths, so start relative-style patterns with `**\/` to match anywhere in
 * the tree" — so the character set has to stay open (`*`, `?`, `[]`, `{}`, drive
 * letters, spaces). Only the shapes that could not be a path are refused:
 * emptiness, control characters, and anything past a length bound.
 */
const INSTRUCTION_EXCLUDE_PATTERN = /^[^\0\r\n\t]{1,1024}$/

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export type {
  ManagedDropSink,
  ManagedPolicyDropDispositionV1,
  ManagedPolicyDropV1,
} from '../../config/managed-drops.ts'

/**
 * The drop-list READERS, re-exported beside the drop type so a consumer never
 * has to reach into `config/managed-drops.ts` for one half of the pair.
 *
 * `formatManagedPolicyDrop` is the `/doctor` seam — `managed-settings.md#find-entries-claude-code-dropped` requires
 * that listing to carry "each invalid entry with its source and field", which
 * is exactly this line. R30b renders one per drop; nothing else about the
 * listing is decided here.
 */
export {
  formatManagedPolicyDrop,
  formatManagedPolicyDropSummary,
  reportManagedPolicyDrops,
} from '../../config/managed-drops.ts'

export interface ManagedPiPolicyParseV1 {
  readonly policy: ManagedPiPolicyV1
  readonly drops: readonly ManagedPolicyDropV1[]
}

/**
 * Keys this schema does not carry that are nonetheless REAL, documented Claude
 * Code managed settings — so the drop must not call them invalid (P2.467).
 *
 * `invalid managed Pi policy key: <key>` is the right sentence for a typo and the
 * wrong one for a key an administrator read off
 * `settings-reference.md`: it sends them to look for a misspelling that is not
 * there, and it hides the actual state, which is that this build does not enforce
 * the control. A blocklist is the case where that matters most — an unenforced
 * blocklist fails OPEN, and "invalid key" reads as "fix your JSON" rather than
 * "nothing is blocked".
 *
 * Deliberately NOT a general register of every unimplemented Claude key: an entry
 * here is a claim that someone has measured this key's status in this fork, and
 * one such measurement is what P2.467 is.
 *
 * EMPTY BETWEEN P2.481 AND P3.290, and kept through that gap rather than
 * deleted. Its first entry was `blockedMarketplaces`, which now IS in
 * {@link MANAGED_PI_POLICY_KEYS} and is therefore never reached by
 * {@link refuseUnknownKeys} — a register entry saying "this build does not read
 * the key" beside a schema field that reads it is the admin-facing falsehood the
 * register exists to prevent. The mechanism stayed because the next
 * measured-but-unimplemented key wanted exactly this seam, and because an empty
 * register keeps the typo sentence as the default, which the positive control in
 * `blocked-marketplaces.test.ts` pins. `managedSourcesBehavior` is that next key.
 */
const DOCUMENTED_UNENFORCED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  /**
   * P3.290 — REFUSED BY NAME rather than honoured, and this string is the whole
   * of the refusal, so it has to carry the state an administrator needs.
   *
   * `settings-reference.md#managedsourcesbehavior` (anchor read off the rendered
   * page, 2026-09-03) makes this a real key with two values: *"`"first-wins"`:
   * the highest-priority source that carries a policy key supplies the policy,
   * and lower sources contribute only the keys Claude Code reads from every
   * admin source"* and *"`"merge"`: every admin source you deliver contributes
   * its keys, combined by the rules below"*, with *"**Default**:
   * `"first-wins"`"*. `config/managed-composition.ts` implements the default
   * exactly — that is what its winner-takes-all rule IS — so an administrator
   * who writes `"first-wins"` here is asking for what already happens, and only
   * `"merge"` asks for something this build does not do.
   *
   * WHY NOT HONOUR IT, since native-first says to prefer the vendor's own
   * switch. The switch is not reachable natively on this path: the vendor's
   * mechanism combines the FOUR sources the claude binary reads for itself,
   * while our two managed sources are composed by the host and handed down as
   * one already-resolved policy. Honouring `"merge"` therefore means
   * re-implementing the vendor's per-kind algebra —
   * `managed-settings.md#compose-every-managed-source` gives six rules (lists
   * combine, locks take the strictest, restriction allowlists are taken whole
   * from the highest source that sets one, a named set is read from the highest
   * source only, `env` merges per variable, everything else takes the highest
   * source that sets it) plus two per-key conditions — inside the host, for a
   * key the page dates *"Requires Claude Code v2.1.242 or later"*. (That clause
   * used to end "against a vendored 2.1.233"; the bundle was already 2.1.247 by
   * 2026-09-12, PAST that line — read its two self-reports for today — so the
   * version is no longer part of the reason. The reason is the per-kind algebra,
   * which is the same host code either way. C3.252.) The honest thing is to say so.
   *
   * AND THE DIRECTION IS SAFE, which is what makes refusing defensible rather
   * than merely cheap: `"merge"` is a WIDENING, in the page's own words —
   * *"Set `"merge"` only where every source ranked below your highest one is
   * under an administrator's control, because Claude Code then adds entries from
   * a lower source, such as `permissions.allow` rules, to the policy."* Ignoring
   * it leaves the stricter, first-wins composition in force. The one arm that is
   * NOT strictly safe is a lock set only in the lower source, which `"merge"`
   * would apply and first-wins drops — except for the cross-source lock keys,
   * which `managed-composition.ts` already honours from either source in both
   * directions under both values of this key. That residue is named there.
   *
   * The key must NOT be added to {@link MANAGED_PI_POLICY_KEYS} to make this
   * message nicer: the page defines a *"policy key"* as *"any settings key other
   * than the two control keys, `wslInheritsWindowsSettings` and
   * `managedSourcesBehavior`"*, and a source carrying only those *"doesn't
   * count, and Claude Code moves on to the next source"*. A schema field here
   * would make `carriesManagedSettings` count it, and a delivered payload
   * carrying nothing but this key would then win the whole tier and erase a
   * valid file policy. Refusing it at parse keeps that divergence vacuous, which
   * is where `managed-composition.ts` records it.
   */
  managedSourcesBehavior:
    'managedSourcesBehavior is a real Claude Code managed setting and this build does not implement it: '
    + 'the two managed sources are always composed first-wins, which is the documented default. '
    + 'A value of "first-wins" therefore matches what already happens; "merge" is ignored, so the '
    + 'highest-priority source that carries a setting supplies the policy and the other contributes '
    + 'only the cross-source keys.',
  /**
   * P6.242 — the documented channel-push allowlist, whose UNIT we do not share.
   *
   * `settings-reference.md#allowedchannelplugins`, read off the page 2026-09-06:
   * *"Choose which channel plugins can push messages into sessions in your
   * organization. When you set it, Claude Code uses your list in place of the
   * default Anthropic allowlist; each entry names a plugin and the marketplace
   * it comes from."* Type: *"array of objects, each with `marketplace` and
   * `plugin` strings"*. Scope: `Managed`.
   *
   * **Why the alias branch of the row is not taken: there is no mapping to
   * make.** Our twin enforces the same IDEA in a different unit — a list of MCP
   * SERVER slugs (`allowedChannelServers`, `:2254`, wired through
   * `resolveManagedChannelPolicy` to `mcp-pool.isChannelPermitted`) — and a
   * channel PLUGIN survives in this fork only as an external plugin kind
   * (`format-adapters/claude.ts`), never projected into a server we could name.
   * A `{marketplace, plugin}` pair therefore cannot be resolved to a slug, and
   * inventing one would be a rule that silently admits or refuses the wrong
   * source.
   *
   * **Nor can it be handed to the child, and that was measured rather than
   * assumed.** In the vendored native binary (`2.1.233`) the key is read as
   * `dn("policySettings")?.allowedChannelPlugins` — the POLICY tier only, not
   * the merged settings cascade — so the flag tier cannot carry it; and the
   * restrictive filter our `Options.managedSettings` slice passes through
   * (transcribed in `claude-managed-settings.ts`) has no branch for it, so a
   * managed projection would be dropped inside the SDK without a word. Six
   * occurrences in the binary, control `nessyNotARealSdkKey` -> 0.
   *
   * So the honest outcome is the row's own second branch: refused BY NAME, with
   * the unit difference and the actual state stated. An administrator who wrote
   * this key must learn that their channel restriction is not in force here —
   * the same fail-open direction the register's docblock above names as the
   * case that matters most.
   */
  /**
   * P6.338 — the third key of the graded browser family, and the one with NO
   * SUBJECT in this build.
   *
   * `settings-reference.md#disablemobilesimulatortools`, fetched 2026-09-07:
   * *"Block Claude's tools for the desktop app's iOS Simulator pane. People keep
   * manual use of the pane; only Claude's access is removed."*
   *
   * **Measured, not assumed:** `git grep -ai simulator` over
   * `:(glob)packages/**` `:(glob)apps/electron/**` returns THREE hits, all three
   * inside plugin-adapter test fixtures, and no pane, no tool and no IPC channel.
   * This fork has no iOS Simulator surface for the key to govern, and
   * `apps/ios` is a Swift CLIENT of this server rather than a simulator pane the
   * agent drives.
   *
   * So the honest outcome is the branch `allowedChannelPlugins` below already
   * takes: refused BY NAME, with the actual state stated. Carrying a schema
   * field for it would produce the exact defect this plan keeps finding — a
   * policy that reads as enforced and enforces nothing. Its two siblings in the
   * same page section DO have a subject here and are real fields
   * (`disableBrowserExternalNavigation`, `browserExternalPageTools`).
   */
  /**
   * P6.498 — the vendor's own login-method lock, refused BY NAME because our
   * tier cannot carry it and a one-runtime lock would be worse than none.
   *
   * `settings-reference.md#forceloginmethod`: *"Restrict which kind of account
   * people can log in with … Administrators set it in managed settings."*
   *
   * TWO measurements, and either one alone settles it. (1) The SDK's
   * restrictive managed-settings filter — the one `Options.managedSettings`
   * passes through, re-extracted from the vendored `2.1.233` — copies
   * `forceLoginOrgUUID` and NOT `forceLoginMethod`, so emitting it from here
   * would be a silent drop inside the SDK. (2) The page scopes the `"gateway"`
   * value further still: *"Claude Code honors `\"gateway\"` only from a managed
   * source on the machine: `managed-settings.json`, the macOS plist or Windows
   * HKLM registry, or a policy helper"* — none of which is an embedding host's
   * slice.
   *
   * And it would enforce on ONE runtime of three, which is the divergence the
   * delegated decision refused. `disableNonGatewayConnections` is the key that
   * does the job here, on all three.
   */
  forceLoginMethod:
    'forceLoginMethod is a real Claude Code managed setting and this build cannot carry it: the SDK\'s '
    + 'restrictive managed-settings filter copies forceLoginOrgUUID and not this key, so a projection '
    + 'would be dropped inside the runtime without a word — and it would govern the claude runtime alone '
    + 'while Pi and codex have no login-method gate at all. Set disableNonGatewayConnections: true '
    + 'instead, which requires the built-in gateway sign-in identically on all three runtimes.',
  disableMobileSimulatorTools:
    'disableMobileSimulatorTools is a real Claude Code managed setting and this build has nothing for '
    + 'it to govern: there is no iOS Simulator pane in this app, so no tool of Claude\'s can reach one. '
    + 'Nothing is lost by the key being dropped — it is not restricting something that is happening. '
    + 'The browser keys in the same section DO apply here: disableBrowserExternalNavigation, '
    + 'browserHostAllowlist and browserExternalPageTools.',
  allowedChannelPlugins:
    'allowedChannelPlugins is a real Claude Code managed setting and this build does not enforce it: '
    + 'its unit is a {marketplace, plugin} pair and this host gates channels by MCP SERVER name '
    + 'instead, through allowedChannelServers, so the two lists cannot be translated into each other. '
    + 'Nothing in this document is restricting which channel plugins may push: set '
    + 'allowedChannelServers to the server names you allow, or channelsEnabled: false to stop channel '
    + 'pushes entirely.',
})

/**
 * Unknown keys are the common tolerance case: a policy authored for a NEWER
 * client must still load here, so an unrecognised key is stripped with a
 * warning rather than failing the document.
 */
function refuseUnknownKeys(value: Record<string, unknown>, sink: ManagedDropSink): void {
  const allowed = new Set<string>(MANAGED_PI_POLICY_KEYS)
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue
    sink.drop(key, DOCUMENTED_UNENFORCED_KEYS[key] ?? `invalid managed Pi policy key: ${key}`, 'stripped')
  }
}

/**
 * A managed security switch. `managed-settings.md#keys-that-fail-closed` reads an invalid
 * `allowManagedMcpServersOnly` or `enforceAvailableModels` as `true`; both are
 * phrased so that `true` ENFORCES. Our switches are phrased the other way —
 * `allowPluginHooks: false` and `channelsEnabled: false` are the enforcing
 * values — so `enforcing` carries the pole rather than a literal `true`, which
 * is the same rule and not the same constant.
 */
function securitySwitch(
  sink: ManagedDropSink,
  field: string,
  value: unknown,
  reason: string,
  enforcing: boolean,
): boolean | undefined {
  if (value === undefined || typeof value === 'boolean') return value as boolean | undefined
  sink.drop(field, reason, 'tightened')
  return enforcing
}

/**
 * A version bound. Stripped on any defect, never reinterpreted — that table's fail-open sentence names
 * these two keys as the fail-open case, so there is no "tighter" reading to
 * fall back to: the tighter reading of a version bound is refusing to start.
 */
function versionBound(
  sink: ManagedDropSink,
  field: string,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && MANAGED_VERSION_PATTERN.test(value)) return value
  sink.drop(field, `invalid managed Pi policy ${field}`, 'stripped')
  return undefined
}

/** A non-security key: stripped, never reinterpreted. */
function optionalBoolean(
  sink: ManagedDropSink,
  field: string,
  value: unknown,
  reason: string,
): boolean | undefined {
  if (value === undefined || typeof value === 'boolean') return value as boolean | undefined
  sink.drop(field, reason, 'stripped')
  return undefined
}

/**
 * `strictPluginOnlyCustomization` (`settings-reference.md#strictpluginonlycustomization`), which is neither a
 * switch nor a list and therefore goes through neither {@link securitySwitch} nor
 * {@link list}.
 *
 * `true` → all four surfaces. An array → the valid subset, in canonical order.
 * `false` and an empty array → no lock, which is what both plainly mean.
 *
 * Two defect classes, handled differently, because the page rules on one of them
 * and `managed-settings.md#invalid-entries-in-managed-settings` rules on the other:
 *
 *  - An unrecognised SURFACE NAME is IGNORED and records NOTHING. That section, in full:
 *    "Surface names that a Claude Code version doesn't recognize are ignored
 *    rather than failing the settings file, so you can add new surface names
 *    before all clients have updated." The second half is the reason a drop would
 *    be wrong — an administrator writing tomorrow's surface name is doing the
 *    documented thing, and `doctor` must not report a finding for it. This is
 *    also why the field cannot reuse {@link list}, which throws on any entry it
 *    does not accept and would fail the whole key.
 *  - A MALFORMED entry (a number, an object, `null`) is not a surface name at
 *    all, so `managed-settings.md#invalid-entries-in-managed-settings`'s general
 *    managed rule applies: Claude Code "first skips the individual entries it can
 *    repair, such as one invalid permission rule, with a warning for each, then
 *    drops any top-level key whose value still fails and keeps enforcing every
 *    remaining valid key" (fetched 2026-08-29).
 *
 * A wholly invalid VALUE (neither boolean nor array) is stripped with the drop
 * recorded, NOT read at the enforcing pole the way {@link allowManagedHooksOnly}
 * and its two neighbours are. The page states no reading for it, and the poles
 * are not comparable: those three are booleans whose `true` enforces one switch,
 * whereas this key's enforcing pole withdraws every user and project skill,
 * agent and MCP server at once. Guessing a fleet-wide outage out of a typo is a
 * fail-closed pole nothing documented asks for (plan
 * `2026-08-04-doc-sweep-parity-wave.md` § R31, constraint 4). The drop keeps the
 * defect visible: `nessy-general-agent doctor` names the field and the strip.
 */
function strictCustomizationSurfaces(
  sink: ManagedDropSink,
  value: unknown,
): readonly StrictCustomizationSurfaceV1[] | undefined {
  if (value === undefined || value === false) return undefined
  if (value === true) return STRICT_CUSTOMIZATION_SURFACES
  if (!Array.isArray(value)) {
    sink.drop(
      'strictPluginOnlyCustomization',
      'invalid managed Pi policy strictPluginOnlyCustomization',
      'stripped',
    )
    return undefined
  }
  const named = new Set<string>()
  for (const entry of value) {
    if (typeof entry === 'string') {
      // Recognised or not, a string is a surface name: that same sentence ignores the ones
      // this version does not know, silently and by design.
      named.add(entry)
      continue
    }
    sink.drop(
      'strictPluginOnlyCustomization',
      'invalid managed Pi policy strictPluginOnlyCustomization entry',
      'stripped',
    )
  }
  const locked = STRICT_CUSTOMIZATION_SURFACES.filter(surface => named.has(surface))
  return locked.length > 0 ? Object.freeze(locked) : undefined
}

function list(
  value: unknown,
  validate: (entry: string) => boolean,
  max = 128,
): readonly string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('invalid managed Pi policy list')
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !validate(entry) || seen.has(entry)) {
      throw new Error('invalid managed Pi policy list')
    }
    seen.add(entry)
  }
  return Object.freeze([...value])
}

/**
 * Parse one scope's autoMode block, ENTRY BY ENTRY.
 *
 * The block used to be all-or-nothing: any key it did not recognise threw, and
 * under the managed tier's tolerance the `tolerate(...)` wrapper then stripped
 * the whole block. So an admin who wrote the documented `classifyAllShell`
 * alongside four sets of carefully written `allow` prose lost all of it, and
 * the drop list said only `autoMode`. That is precisely the outcome
 * `managed-settings.md#invalid-entries-in-managed-settings` forbids — it "first skips
 * the individual entries it can repair … then drops any top-level key whose value
 * still fails and keeps enforcing every remaining valid key" (fetched 2026-08-29).
 *
 * Now the sink travels in: an unrecognised key inside the block costs that key,
 * a malformed set costs that set, and a malformed entry costs that entry. A
 * non-object block still costs the block, because there are no entries in it to
 * keep. The STRICT sink throws at the first defect exactly as before, which is
 * `managed-settings.md#invalid-entries-in-managed-settings`'s posture for the user, project and local tiers.
 *
 * A malformed set is STRIPPED rather than emptied. These are not the grant and
 * restrict lists of the `managed-settings.md#keys-that-fail-closed` table — an autoMode set is
 * prose for the judge and decides nothing on its own — and stripping leaves the
 * built-in defaults in place, while emptying would REPLACE them (see
 * `resolveAutoModeList`, where an absent set means "defaults" and an empty one
 * means "clean slate").
 */
function parseAutoModePolicyV1(value: unknown, sink: ManagedDropSink): ManagedAutoModePolicyV1 {
  const root = record(value)
  if (!root) throw new Error('invalid managed Pi policy autoMode')
  const allowed = new Set<string>(AUTO_MODE_BLOCK_KEYS)
  for (const key of Object.keys(root)) {
    if (allowed.has(key)) continue
    if (!sink.tolerant) throw new Error('invalid managed Pi policy autoMode')
    sink.drop(`autoMode.${key}`, `invalid managed Pi policy autoMode key: ${key}`, 'stripped')
  }
  const prose = (entry: string) => (
    entry.trim().length > 0
    && entry.length <= AUTO_MODE_ENTRY_MAX
    && !AUTO_MODE_FORBIDDEN.test(entry)
  )
  const set = (key: typeof AUTO_MODE_KEYS[number]) => (
    root[key] === undefined
      ? undefined
      : toleratedList(
        sink,
        `autoMode.${key}`,
        root[key],
        candidate => list(candidate, prose, AUTO_MODE_ENTRIES_MAX),
        'restrict',
      )
  )
  const environment = set('environment')
  const hard_deny = set('hard_deny')
  const soft_deny = set('soft_deny')
  const allow = set('allow')
  const classifyAllShell = optionalBoolean(
    sink,
    'autoMode.classifyAllShell',
    root.classifyAllShell,
    'invalid managed Pi policy autoMode classifyAllShell',
  )
  return Object.freeze({
    ...(environment === undefined ? {} : { environment }),
    ...(hard_deny === undefined ? {} : { hard_deny }),
    ...(soft_deny === undefined ? {} : { soft_deny }),
    ...(allow === undefined ? {} : { allow }),
    ...(classifyAllShell === undefined ? {} : { classifyAllShell }),
  })
}

/**
 * Parse an `autoMode` block that arrived from a NON-managed settings file.
 *
 * P6.493's reader half. `resolveAutoMode` has taken a `user` scope and narrowed
 * it to {@link USER_SCOPE_AUTO_MODE_KEYS} since `e473ec877`, but nothing built a
 * user-scope block to hand it — the one production caller passes `managed`
 * alone, so the narrowing guarded a path no document could reach. This is the
 * entry point a reader of `~/.claude/settings.json` needs; the narrowing itself
 * stays where it was, in `resolveAutoMode`, so there is still exactly one place
 * the trust boundary is decided.
 *
 * STRICT, and deliberately: a defect throws instead of being stripped. That is
 * this parser's own recorded posture for the user, project and local tiers
 * (see {@link parseAutoModePolicyV1}'s comment) — the tolerant sink exists for
 * the managed document, where dropping one key and enforcing the rest is what
 * `managed-settings.md#invalid-entries-in-managed-settings` requires. A user's
 * own malformed block contributes nothing and the caller says so.
 */
export function parseUserScopeAutoModePolicyV1(value: unknown): ManagedAutoModePolicyV1 | undefined {
  if (value === undefined || value === null) return undefined
  return parseAutoModePolicyV1(value, STRICT_DROP_SINK)
}

/**
 * A fleet policy names plugins one at a time; nothing legitimate approaches this
 * many, and an unbounded map is a parse-time denial-of-service surface on a
 * document that arrives over the network.
 */
const MANAGED_ENABLED_PLUGINS_MAX_ENTRIES = 256

/**
 * Parse the managed `enabledPlugins` map.
 *
 * Entry-level tolerance, like every other collection here (`managed-settings.md#invalid-entries-in-managed-settings`):
 * one malformed entry is stripped and the rest of the map applies. The map is
 * MIXED-polarity — a `true` grants and a `false` blocks — so neither the
 * `emptied` nor the `tightened` reading of that table's `availableModels` and `deniedMcpServers` rows transfers: emptying it
 * would silently drop an administrator's block, and there is no "tighter"
 * reading of a force-enable that does not invent an activation nobody wrote.
 * `stripped` is `managed-settings.md#invalid-entries-in-managed-settings`'s own default and the only disposition that cannot
 * fabricate a decision in either direction.
 *
 * A key is reported by INDEX, never verbatim, because an unvalidated key is
 * arbitrary attacker-influenced text and drops are rendered to a terminal.
 *
 * P3.244 — TWO spellings are accepted and normalized to one stored key by
 * `plugins/managed-plugin-key.ts`: the documented `plugin-name@marketplace-name`
 * and our own `enc(marketplaceId).enc(pluginId)`. Before that, only the second
 * parsed, so `settings-reference.md#enabledplugins`'s own example was stripped
 * whole — measured, `{"code-formatter@team-tools": true,
 * "experimental-features@personal": false}` parsed to `{}` with two drops.
 */
function parseManagedEnabledPluginsV1(
  value: unknown,
  sink: ManagedDropSink,
): Readonly<Record<string, boolean>> {
  const root = record(value)
  if (!root) throw new Error('invalid managed Pi policy enabledPlugins')
  const keys = Object.keys(root)
  if (keys.length > MANAGED_ENABLED_PLUGINS_MAX_ENTRIES) {
    throw new Error('invalid managed Pi policy enabledPlugins')
  }
  const entries: Record<string, boolean> = {}
  // P3.244 — the normalized keys already taken. Two WRITTEN spellings
  // (`plugin-name@marketplace-name` and `enc(marketplaceId).enc(pluginId)`)
  // normalize to one stored key, so one plugin can appear twice in one document.
  const taken = new Set<string>()
  keys.forEach((key, index) => {
    const normalized = key.length > 256 ? undefined : normalizeManagedEnabledPluginKey(key)
    if (!normalized) {
      if (!sink.tolerant) throw new Error('invalid managed Pi policy enabledPlugins key')
      sink.drop(`enabledPlugins[${index}]`, 'invalid managed Pi policy enabledPlugins key', 'stripped')
      return
    }
    if (typeof root[key] !== 'boolean') {
      if (!sink.tolerant) throw new Error(`invalid managed Pi policy enabledPlugins value: ${key}`)
      sink.drop(`enabledPlugins.${key}`, `invalid managed Pi policy enabledPlugins value: ${key}`, 'stripped')
      return
    }
    const value = root[key] as boolean
    if (taken.has(normalized)) {
      // The same plugin under both spellings. Identical values are harmless and
      // collapse silently; OPPOSING values are a document error, and neither
      // direction may be invented here — a fabricated `true` grants and a
      // fabricated `false` blocks. `managed-settings.md#invalid-entries-in-managed-settings`'s
      // own default disposition is `stripped`, so the LATER entry is dropped and
      // reported: the surviving decision is the one written first, which is a
      // rule an administrator can read off their own file.
      if (entries[normalized] !== value) {
        if (!sink.tolerant) throw new Error('invalid managed Pi policy enabledPlugins duplicate')
        sink.drop(
          `enabledPlugins[${index}]`,
          'invalid managed Pi policy enabledPlugins duplicate: the same plugin is set twice with opposing values',
          'stripped',
        )
      }
      return
    }
    taken.add(normalized)
    entries[normalized] = value
  })
  return Object.freeze(entries)
}

const MANAGED_ENV_MAX_ENTRIES = 128
const MANAGED_ENV_VALUE_MAX = 4096

/**
 * Parse the managed `env` block.
 *
 * Entry-level tolerance, like every other list here: one malformed variable is
 * stripped and the rest of the block applies. An env block is neither a grant
 * nor a restriction — it names no boundary — so a wholly invalid block is
 * STRIPPED rather than reinterpreted; there is no tighter reading of "set these
 * variables" that does not invent values nobody delivered.
 *
 * NO drop reason here contains a VALUE. A managed env block routinely carries
 * an API key or a proxy URL with an embedded password, and drops are rendered
 * by the startup dialog and by `doctor`. A malformed KEY is reported by index
 * for the same reason — an arbitrary key is attacker-chosen text.
 */
function parseManagedEnvBlockV1(
  value: unknown,
  sink: ManagedDropSink,
): Readonly<Record<string, string>> {
  const root = record(value)
  if (!root) throw new Error('invalid managed Pi policy env')
  const keys = Object.keys(root)
  if (keys.length > MANAGED_ENV_MAX_ENTRIES) throw new Error('invalid managed Pi policy env')
  const entries: Record<string, string> = {}
  keys.forEach((key, index) => {
    if (!ENV_VAR_NAME.test(key)) {
      if (!sink.tolerant) throw new Error('invalid managed Pi policy env name')
      sink.drop(`env[${index}]`, 'invalid managed Pi policy env name', 'stripped')
      return
    }
    const entry = root[key]
    // A NUL truncates the variable at the exec boundary, so a value carrying
    // one would set something other than what the admin wrote. Everything else
    // a shell accepts passes: env values legitimately carry spaces, commas and
    // URLs.
    if (typeof entry !== 'string'
      || entry.length > MANAGED_ENV_VALUE_MAX
      || entry.includes('\u0000')) {
      if (!sink.tolerant) throw new Error(`invalid managed Pi policy env value: ${key}`)
      sink.drop(`env.${key}`, `invalid managed Pi policy env value: ${key}`, 'stripped')
      return
    }
    entries[key] = entry
  })
  return Object.freeze(entries)
}

const CLAUDE_RULE_ACTIONS = ['allow', 'ask', 'deny'] as const

interface ParsedManagedClaudeRules {
  claudeRules: ManagedClaudeRulesV1
  rules: PermissionDslRuleV1[]
}

/**
 * Parse and compile the `claudeRules` block.
 *
 * An entry whose parse yields no enforceable rule (inert form, unanchored allow
 * glob, garbage), and a `/path` source-anchored rule that a managed policy has
 * no settings-source root to resolve, are both refused. Under the STRICT sink
 * that is still a throw. Under the managed tier's tolerant sink the entry is
 * STRIPPED and the remaining rules compile, per `managed-settings.md#invalid-entries-in-managed-settings` — including
 * the source-root case, which becomes a strip reason rather than an abort.
 *
 * Rule ids stay keyed to the entry's index in the ORIGINAL list, so stripping
 * one entry does not renumber the receipts of the rules around it.
 */
function parseManagedClaudeRulesV1(value: unknown, sink: ManagedDropSink): ParsedManagedClaudeRules {
  const root = record(value)
  if (!root) throw new Error('invalid managed Pi policy claudeRules')
  const allowed = new Set<string>(CLAUDE_RULE_ACTIONS)
  for (const key of Object.keys(root)) {
    if (allowed.has(key)) continue
    if (!sink.tolerant) throw new Error('invalid managed Pi policy claudeRules')
    sink.drop(`claudeRules.${key}`, 'invalid managed Pi policy claudeRules', 'stripped')
  }
  const rules: PermissionDslRuleV1[] = []
  const claudeRules: Record<string, readonly string[]> = {}
  for (const action of CLAUDE_RULE_ACTIONS) {
    if (root[action] === undefined) continue
    const entries = toleratedList(
      sink,
      `claudeRules.${action}`,
      root[action],
      candidate => list(candidate, entry => entry.trim().length > 0 && entry.length <= 2048),
      // A rule list carries allow AND deny entries, so neither direction of the
      // grant/restrict pair of `managed-settings.md#keys-that-fail-closed` fits it. Dropping the key is the honest fallback: an
      // empty rule list decides nothing either way.
      'restrict',
    )
    if (entries === undefined) continue
    // Only the entries that actually compiled are reported back on the policy:
    // a rule string left in `claudeRules` would claim to be enforced when it
    // enforces nothing.
    const kept: string[] = []
    entries.forEach((entry, index) => {
      const refuse = (reason: string): void => {
        sink.drop(`claudeRules.${action}[${index}]`, reason, 'stripped')
      }
      const parsed = parseClaudeRuleString(entry, action, { knownToolNames: PERMISSION_RULE_TOOL_NAMES })
      if (!parsed.rule) {
        refuse(`invalid managed Pi policy claude rule (${parsed.warning?.code ?? 'unparseable'}): ${entry}`)
        return
      }
      // permissions.md's typo warning arrives ALONGSIDE a rule — the rule
      // installs and matches no tool — so it has to be read independently of
      // `parsed.rule`, which is what made it unreachable. This loader's stated
      // posture is that "an admin rule that silently does nothing is worse than
      // a crash" (`claude-permission-rules.ts`), and a `deny` naming no known
      // tool is exactly that, so it refuses rather than reporting an enforced
      // rule that enforces nothing.
      //
      // ONLY that code. `claude_rule.end_conversation_guarded` also rides
      // alongside a rule, and that rule is enforceable — it carries a
      // consumer-side exception, not a dead match. Refusing on any warning
      // would delete an administrator's `deny EndConversation`.
      if (parsed.warning?.code === 'claude_rule.unknown_tool') {
        refuse(`managed Pi policy claude rule (${parsed.warning.code}): ${parsed.warning.message}`)
        return
      }
      // EVERY matcher that can carry the anchor, not just `pathGlob`: `Cd(/x)`
      // compiles to a `cdPath` with the same anchor, and letting one through
      // throws at compile, which fails the WHOLE layer closed — one unsupported
      // rule turning into a deny of every tool.
      if (parsed.rule.match.anchor === 'source') {
        refuse(`invalid managed Pi policy claude rule (no settings-source root): ${entry}`)
        return
      }
      kept.push(entry)
      // P2.445 — the administrator's own rule string. The id is positional
      // (`claude-deny-0`), so a refusal that named only it would tell the user
      // nothing they could take to whoever wrote the policy. Re-validated by
      // `parsePermissionDslV1` below, which accepts `text` and carries it.
      rules.push({ id: `claude-${action}-${index}`, action, match: parsed.rule.match, text: entry })
    })
    claudeRules[action] = Object.freeze(kept)
  }
  return { claudeRules: Object.freeze(claudeRules), rules }
}

/**
 * Splice the defaults into one scope's list at the sentinel's position.
 *
 * An absent sentinel REPLACES the defaults — the documented Danger case, kept
 * verbatim rather than "helpfully" re-adding them, because an admin who wants a
 * clean slate has no other way to ask for one.
 */
export function resolveAutoModeList(
  entries: readonly string[] | undefined,
  defaults: readonly string[],
): readonly string[] {
  if (entries === undefined) return [...defaults]
  return entries.flatMap(entry => entry === AUTO_MODE_DEFAULTS_SENTINEL ? [...defaults] : [entry])
}

/**
 * Compose the autoMode sets the judge is told about.
 *
 * `project` is accepted and DISCARDED on purpose. Both project settings files
 * live in the repo directory, so a checked-in repo or a build step could
 * otherwise inject its own allow rules into the judge's policy — a
 * supply-chain hole. Taking the parameter and dropping it is deliberate: it
 * makes the exclusion testable and stops a caller from "fixing" the omission.
 *
 * Managed entries come first and cannot be removed by a later scope, only
 * extended. That ordering is presentational, not a boundary — see
 * {@link ManagedPiPolicyV1.autoMode}.
 *
 * `user` is accepted and NARROWED: only {@link USER_SCOPE_AUTO_MODE_KEYS}
 * (`hard_deny`, `soft_deny`) travel from it. {@link MANAGED_ONLY_AUTO_MODE_KEYS}
 * (`environment`, `allow`) are dropped, so a developer can tighten the judge and
 * can never loosen it. This is a deliberate narrowing of
 * `auto-mode-config.md#where-the-classifier-reads-configuration`, whose own
 * combination rule concedes that "a developer-added `allow` entry can override
 * an organization `soft_deny` entry". Callers that want to TELL the user which
 * keys were refused ask {@link refusedUserAutoModeKeys}.
 */
export function resolveAutoMode(
  scopes: {
    managed?: ManagedAutoModePolicyV1
    user?: ManagedAutoModePolicyV1
    /** Read by nobody. Present so the exclusion is explicit and pinned by a test. */
    project?: ManagedAutoModePolicyV1
  },
  defaults: Partial<ResolvedAutoModePolicyV1> = GUARDIAN_BUILT_IN_AUTO_MODE_DEFAULTS,
): ResolvedAutoModePolicyV1 {
  // The defaults splice EXACTLY ONCE, in the managed scope. `auto-mode-config.md`
  // gives `"$defaults"` a per-section operand, and the user scope resolves against
  // `[]` on purpose: passing the built-ins there too would duplicate every rule in
  // any section a user extends.
  //
  // P6.493 — THE USER SCOPE CAN ONLY EVER NARROW. It contributes to
  // `hard_deny`/`soft_deny` and to nothing else; a user `allow` or `environment`
  // is dropped here even if a caller passes one, and named by
  // `refusedUserAutoModeKeys`. This is the ONE place the asymmetry is decided:
  // a second guard in the parser would be two things to keep in sync, and the
  // trust boundary belongs where the sets are actually combined.
  const userMay = new Set<string>(USER_SCOPE_AUTO_MODE_KEYS)
  const compose = (key: typeof AUTO_MODE_KEYS[number]): readonly string[] => Object.freeze([
    ...resolveAutoModeList(scopes.managed?.[key], defaults[key] ?? []),
    ...(userMay.has(key) ? resolveAutoModeList(scopes.user?.[key], []) : []),
  ])
  return Object.freeze({
    environment: compose('environment'),
    hard_deny: compose('hard_deny'),
    soft_deny: compose('soft_deny'),
    allow: compose('allow'),
  })
}

/**
 * The managed-only `autoMode` keys a user-scope block carried, in page order.
 *
 * Empty for a well-formed user block. Non-empty means the developer wrote a set
 * that this fork keeps administrator-only, and the caller owes them a
 * diagnostic naming the key and naming managed settings as its only home —
 * silence would be the failure this row exists to fix, because the entries
 * simply would not apply and nothing would say so.
 *
 * A key present but EMPTY still counts: writing `"allow": []` is a statement
 * about the allow set, and answering it with silence is the same defect.
 */
export function refusedUserAutoModeKeys(
  user: ManagedAutoModePolicyV1 | undefined,
): readonly string[] {
  if (!user) return Object.freeze([])
  return Object.freeze(MANAGED_ONLY_AUTO_MODE_KEYS.filter(key => user[key] !== undefined))
}

/**
 * Whether any set carries an entry worth handing to the judge.
 *
 * The four PROSE sets only. `classifyAllShell` is a band control — it changes
 * which actions reach the judge, not what the judge is told — so a policy that
 * sets nothing but that key still hands the judge no org policy section.
 */
export function hasAutoModePolicy(policy: ResolvedAutoModePolicyV1 | undefined): boolean {
  return policy !== undefined && AUTO_MODE_KEYS.some(key => policy[key].length > 0)
}

/**
 * The band control, composed across scopes — `auto-mode-config.md:226`.
 *
 * Boolean-OR, which is the TIGHTER direction for this key: `true` routes more
 * commands through the classifier, so a managed `true` cannot be turned off by
 * a user scope and a user may opt into more scrutiny than the org requires.
 * That is the same "tighter side wins" rule `allowUnsandboxedCommands` follows
 * in the opposite direction, because that key grants and this one restricts.
 *
 * Kept OFF `ResolvedAutoModePolicyV1` on purpose: that type is handed to the
 * judge as its org policy section (`prompts/guardian.ts:257`), and a band
 * control has no business in a prompt. The band consumer reads this instead.
 */
export function resolveAutoModeClassifyAllShell(scopes: {
  managed?: ManagedAutoModePolicyV1
  user?: ManagedAutoModePolicyV1
}): boolean {
  return scopes.managed?.classifyAllShell === true || scopes.user?.classifyAllShell === true
}

export const DEFAULT_MANAGED_PI_POLICY: ManagedPiPolicyV1 = Object.freeze({
  schemaVersion: 1 as const,
  disabledPermissionModes: Object.freeze([] as PermissionMode[]),
})

const NO_DISABLED_MODES = Object.freeze([] as PermissionMode[])

/**
 * Whether a parsed policy carries any SETTING at all.
 *
 * This is `server-managed-settings.md#settings-precedence`'s test — "Within the
 * managed tier, Claude Code by default uses the first source that delivers at
 * least one policy key, checking server-managed settings first and then
 * endpoint-managed settings, apart from the exception keys covered next" —
 * applied to the parsed form rather than the raw document, so a document whose
 * every key was stripped reads as empty here just as it does on the wire.
 *
 * `schemaVersion` is the STAMP, not a setting, and an EMPTY
 * `disabledPermissionModes` is exactly what {@link DEFAULT_MANAGED_PI_POLICY}
 * carries — the key is mandatory in this schema, so a document that omits it
 * still parses with the default and counting it would read every empty policy
 * as a delivery.
 */
export function carriesManagedSettings(policy: ManagedPiPolicyV1): boolean {
  return Object.keys(policy).some(key => (
    key !== 'schemaVersion'
    && !(key === 'disabledPermissionModes' && policy.disabledPermissionModes.length === 0)
  ))
}

/**
 * The process-scoped reader for the COMPOSED managed policy.
 *
 * Composition lives in `server-core` (`bootstrap/managed-policy-resolution.ts`),
 * which `packages/shared` cannot import — the same wall
 * `registerManagedRetentionDaysProvider`, `registerManagedSandboxEnabledProvider`
 * and `registerManagedInAppUpdatesDisabledProvider` already climb with a
 * registered reader instead of an import. This is the fourth, and the first that
 * hands over the whole document rather than one key, because its consumer is a
 * MAPPING rather than a single decision: `claude-managed-settings.ts` projects
 * the policy into the SDK's `Settings` shape for `Options.managedSettings`, and
 * a per-key bridge would need one registration per mapped key.
 *
 * Re-resolved on every read, like its three siblings: a delivered payload that
 * lands after registration is seen by the next claude spawn, and a policy this
 * run cannot resolve yields no floor rather than taking the spawn down.
 *
 * Unregistered means "no managed policy" — every non-managed install, and every
 * test that never calls this.
 */
let managedPiPolicyProvider: (() => ManagedPiPolicyV1 | undefined) | undefined

/** Register the composed-policy reader for this process. */
export function registerManagedPiPolicyProvider(
  provider: (() => ManagedPiPolicyV1 | undefined) | undefined,
): void {
  managedPiPolicyProvider = provider
}

/**
 * What the managed layer enforces right now, or `undefined` when it says
 * nothing. A throwing provider is tolerated rather than propagated, for the
 * reason `resolveManagedInAppUpdatesDisabled` gives: an unreadable policy file
 * must not take a session start down with it.
 */
export function resolveManagedPiPolicyFloor(): ManagedPiPolicyV1 | undefined {
  try {
    return managedPiPolicyProvider?.()
  } catch {
    return undefined
  }
}

/**
 * The process-scoped reader for the PINNED policy-expansion environment —
 * P2.410, the second half of P2.396.
 *
 * `managed-mcp.md#how-policy-entries-expand`: "The server's configured value
 * expands from the live process environment, like the rest of `.mcp.json`. A
 * policy entry expands from a pinned environment instead, so a variable set by
 * a project or user settings file can't change what an allowlist entry means."
 *
 * P2.396 threaded that pinned environment through `CapabilityInputsV2Deps` to
 * the four gate call sites inside `server-core`'s storage runtime, and could
 * not reach the two in `mcp/runtime-pool-servers.ts` — the fold that actually
 * starts a built-in dp server and the one that starts a plugin stdio server.
 * Those two are in `packages/shared`, which cannot import the `server-core`
 * bootstrap module that owns the startup snapshot. So they went on expanding an
 * administrator's entry through the LIVE environment, which is the very defect
 * P2.396 closed, surviving at the two sites that are the last gate before a
 * server is spawned.
 *
 * This is the fifth registered reader climbing that wall, and it is the same
 * one {@link registerManagedPiPolicyProvider} climbs, deliberately: the two are
 * read together at both call sites, and a bridge with a different shape is a
 * bridge one of them can be wired through and the other forgotten.
 *
 * There is exactly ONE pinned environment per process by construction — a
 * module-scope snapshot of `process.env` taken at first import, plus the
 * composed managed `env` block — so nothing is lost by making it ambient rather
 * than an argument. What a caller may NOT take from here is the live half: the
 * SERVER's configured value still expands from `process.env`, and pinning both
 * sides is a fail-OPEN regression (see {@link isManagedMcpServerAllowed}).
 *
 * Re-resolved on every read, like its four siblings: a delivered payload whose
 * `env` block lands after registration is seen by the next fold.
 *
 * Unregistered means "no pinned environment" — every non-managed install, and
 * every test that never registers one. The gate then keeps its pre-P2.396
 * single-environment behaviour, which is what those callers already had.
 */
let managedPolicyExpansionEnvironmentProvider:
  (() => Readonly<Record<string, string | undefined>> | undefined) | undefined

/** Register the pinned policy-expansion environment for this process. */
export function registerManagedPolicyExpansionEnvironmentProvider(
  provider: (() => Readonly<Record<string, string | undefined>> | undefined) | undefined,
): void {
  managedPolicyExpansionEnvironmentProvider = provider
}

/**
 * The environment a managed policy ENTRY expands from in this process, or
 * `undefined` when nothing registered one.
 *
 * Never throws, for the reason {@link resolveManagedPiPolicyFloor} gives. A
 * throwing provider yields `undefined`, and `undefined` is the pre-P2.396
 * behaviour rather than a denial — a policy whose pin cannot be read is still
 * enforced, just through the live environment, which is strictly what it did
 * before this bridge existed.
 */
export function resolveManagedPolicyExpansionEnvironment():
  Readonly<Record<string, string | undefined>> | undefined {
  try {
    return managedPolicyExpansionEnvironmentProvider?.()
  } catch {
    return undefined
  }
}

/**
 * A permission-DSL document under the managed tier's tolerance. Shaped like
 * `managed-settings.md#keys-that-fail-closed`'s `sandbox.credentials` row, which is the doc's only
 * nested-document case: an individual invalid rule is stripped and the valid
 * subset is enforced, while a wholly invalid document is dropped.
 *
 * Each candidate is re-validated against the subset kept so far, so duplicate
 * ids and the 128-rule cap are attributed to the rule that breaks them instead
 * of failing the document. A document stamped for another DSL version is NOT
 * salvaged — reading v2 rules with the v1 parser would invent a policy nobody
 * wrote.
 */
function tolerantPermissionDsl(
  sink: ManagedDropSink,
  field: string,
  value: unknown,
): PermissionDslV1 | undefined {
  if (!sink.tolerant) return parsePermissionDslV1(value)
  try {
    return parsePermissionDslV1(value)
  } catch (error) {
    const document = record(value)
    if (!document
      || document.version !== NESSY_PERMISSION_DSL_VERSION
      || !Array.isArray(document.rules)) {
      sink.drop(field, reasonOf(error), 'stripped')
      return undefined
    }
    const kept: unknown[] = []
    for (const [index, rule] of (document.rules as unknown[]).entries()) {
      try {
        parsePermissionDslV1({ version: NESSY_PERMISSION_DSL_VERSION, rules: [...kept, rule] })
        kept.push(rule)
      } catch (ruleError) {
        sink.drop(`${field}.rules[${index}]`, reasonOf(ruleError), 'stripped')
      }
    }
    return tolerate(
      sink,
      field,
      'stripped',
      () => parsePermissionDslV1({ version: NESSY_PERMISSION_DSL_VERSION, rules: kept }),
      undefined,
    )
  }
}

/**
 * P6.422 — the two documented marketplace-settings aliases.
 *
 * `settings-reference.md#marketplace-key-aliases`, read off the page 2026-09-06:
 * *"On Claude Code v2.1.232 or later, you can write `extraKnownMarketplaces` as
 * `additionalMarketplaces` and `strictKnownMarketplaces` as
 * `allowedMarketplaces`."* We vendor `2.1.233`, so this is a live spelling of a
 * key we already implement, not a future one — and until now an administrator
 * who used it had the whole entry stripped by {@link refuseUnknownKeys} with a
 * "invalid managed Pi policy key" line, which reads as *this key does not
 * exist* rather than *you spelled a key we support another way*.
 *
 * The inverse of the usual gap: we implement the CANONICAL keys and not their
 * aliases, so a settings file written to the page is the one that fails.
 *
 * Two of the page's four rules are the whole implementation, and both are
 * quoted rather than inferred:
 *
 *  - *"In any settings file that accepts the canonical key, Claude Code reads
 *    the alias exactly as it reads the canonical key."* — so the alias is
 *    folded onto the canonical name BEFORE any parsing, and every downstream
 *    reader, diagnostic and projection is untouched.
 *  - *"If you set both spellings in one file, Claude Code uses the canonical
 *    value and ignores the alias."*
 *
 * The other two are not ours to implement: earlier versions ignoring the alias
 * is a statement about older clients, and *"Claude Code may rewrite
 * `additionalMarketplaces` to `extraKnownMarketplaces` when it updates the
 * file"* is about a file the vendor's own client owns — this fork never
 * rewrites an administrator's managed document.
 *
 * **The both-spellings case does NOT go through the strict sink's throw.** That
 * document is LEGAL by the page, and `STRICT_DROP_SINK.drop` rejects the whole
 * policy; refusing a document the vendor accepts would be a fork-only failure
 * dressed as validation. A tolerant sink still records the ignored alias, so an
 * administrator reading the drops learns which spelling won.
 */
const CLAUDE_MARKETPLACE_KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  additionalMarketplaces: 'extraKnownMarketplaces',
  allowedMarketplaces: 'strictKnownMarketplaces',
})

function normalizeMarketplaceKeyAliases(
  root: Record<string, unknown>,
  sink: ManagedDropSink,
): Record<string, unknown> {
  let normalized: Record<string, unknown> | undefined
  for (const [alias, canonical] of Object.entries(CLAUDE_MARKETPLACE_KEY_ALIASES)) {
    if (!(alias in root)) continue
    // Copied rather than mutated: `record()` hands back the CALLER's object, and
    // a parser that edits its input would rewrite the document a delivery cache
    // or a second reader still holds.
    normalized ??= { ...root }
    delete normalized[alias]
    if (canonical in root) {
      if (sink.tolerant) {
        sink.drop(
          alias,
          `${alias} is an accepted alias of ${canonical} and this document sets both spellings; `
          + `the canonical ${canonical} value is used and ${alias} is ignored`,
          'stripped',
        )
      }
      continue
    }
    normalized[canonical] = root[alias]
  }
  return normalized ?? root
}

/**
 * P6.531 residue — the managed reading of `unattendedApprovalFallback`.
 *
 * Reports the drop rather than swallowing it, so an administrator who wrote
 * `"Allow"` or `true` learns that the key was refused instead of discovering
 * later that their pipeline stops. The refusal is at the ENFORCING pole, which
 * is the direction {@link ManagedPiPolicyV1.unattendedApprovalFallback} explains.
 */
function unattendedFallback(sink: ManagedDropSink, value: unknown): 'deny' | 'allow' {
  if (value === 'allow' || value === 'deny') return value
  sink.drop(
    'unattendedApprovalFallback',
    'invalid managed Pi policy unattendedApprovalFallback: expected "deny" or "allow"',
    // `tightened`, not `stripped`, and the distinction is the one `securitySwitch`
    // draws four functions up: the key is not removed, it is REINTERPRETED at the
    // enforcing pole, so an administrator reading the drop report sees that their
    // policy got stricter rather than that it got ignored.
    'tightened',
  )
  return 'deny'
}

function parsePolicy(value: unknown, sink: ManagedDropSink): ManagedPiPolicyV1 {
  const rawRoot = record(value)
  if (!rawRoot) {
    // C3.39 (owner answer QB6 = A, 2026-09-11): a root that is not an object
    // REFUSES on both tiers, where the tolerant tier used to record one drop and
    // hand back {@link DEFAULT_MANAGED_PI_POLICY} — i.e. no restrictions at all.
    // The two branches of one predicate fell in opposite directions: an
    // unparsable policy file failed CLOSED while a parsable `[]`, `42`, `"x"`,
    // `true` or `null` failed OPEN, and an administrator cannot be expected to
    // know which of those two their typo produced.
    //
    // Tolerance is for a document with a bad ENTRY in it —
    // `managed-settings.md#invalid-entries-in-managed-settings`: "Claude Code
    // first skips the individual entries it can repair, such as one invalid
    // permission rule, with a warning for each, then drops any top-level key
    // whose value still fails and keeps enforcing every remaining valid key."
    // A non-object root carries no entries to skip and no remaining key to
    // enforce, so there is nothing for that rule to apply to.
    //
    // DEFENCE IN DEPTH, and stated plainly rather than sold as a live hole:
    // both production entry points already guard the shape ahead of this
    // function — `packages/server-core/src/pi-harness/managed-policy-loader.ts`
    // symbol `isPolicyObject` (P6.246(b), `2713cafcc`) fails the base file
    // closed, and `packages/shared/src/config/managed-delivery.ts` symbol
    // `salvageDeliveredPayload` classifies a non-object payload as `empty` —
    // so what this branch closes is the parser's OWN posture for any future
    // caller, not a reachable fail-open today.
    //
    // The drop-in FRAGMENT asymmetry is deliberate and untouched: it lives in
    // that loader, which strips a non-object fragment with a drop naming the
    // file and keeps the administrator's base policy. One bad drop-in must not
    // delete the policy; a base document that is not a policy at all must not
    // be silently replaced by an empty one.
    //
    // The message is byte-identical to the one {@link STRICT_DROP_SINK} threw
    // here, so the strict tier's observable behaviour is unchanged.
    throw new Error('invalid managed Pi policy')
  }
  // Before `refuseUnknownKeys`, so a documented alias never reaches the
  // unknown-key path that used to strip it by name.
  const root = normalizeMarketplaceKeyAliases(rawRoot, sink)
  refuseUnknownKeys(root, sink)
  if (root.schemaVersion !== 1) {
    // ONE ENTRY, not the document. `managed-settings.md#invalid-entries-in-managed-settings`,
    // fetched 2026-08-29: "Claude Code first skips the individual entries it can
    // repair, such as one invalid permission rule, with a warning for each, then
    // drops any top-level key whose value still fails and keeps enforcing every
    // remaining valid key." `schemaVersion` is an entry like any other, and a
    // stamp that fails validation costs exactly itself.
    //
    // This reverses the earlier reading, which returned the built-in policy on
    // any stamp but `1`. That reading defended against reinterpreting a v2
    // document key by key — but nothing is reinterpreted here: every key is
    // parsed by the SAME strict v1 parser it always was, so a key whose shape
    // changed between schema versions fails that parser and is stripped on its
    // own terms. What the old reading actually bought was the failure
    // `managed-settings.md#invalid-entries-in-managed-settings` rules out: one wrong digit in a fleet-wide push silently discarding every
    // deny rule, every sandbox lock and the retention window with it.
    //
    // The fail-open sentence in the same section is the same rule from the other side — it makes the two
    // version-shaped keys fail OPEN, "so a bad policy push cannot prevent
    // Claude Code from starting". Dropping the stamp and enforcing the rest is
    // that posture; dropping the policy is not.
    //
    // The STRICT sink is unchanged and still throws, because
    // `managed-settings.md#invalid-entries-in-managed-settings` keeps user, project and local files whole-file strict.
    sink.drop('schemaVersion', 'invalid managed Pi policy version', 'stripped')
  }
  // A restricting list: an invalid value is DROPPED (`managed-settings.md#keys-that-fail-closed`), which
  // for this key is the empty list its type requires. Disabling every mode a
  // broken value never named is exactly what that table's `deniedMcpServers` row refuses to do.
  //
  // Guarded on `undefined` like every neighbouring key. This call used to be
  // unconditional, so a policy that simply OMITTED the key fed `undefined` to
  // the strict list parser, which threw, and the sink recorded a drop — and
  // `doctor` then listed an "invalid managed entry" the administrator never
  // wrote (`managed-settings.md#invalid-entries-in-managed-settings` makes that listing the thing an admin trusts).
  // An absent entry is not an invalid one.
  const disabledPermissionModes = root.disabledPermissionModes === undefined
    ? NO_DISABLED_MODES
    : toleratedList(
      sink,
      'disabledPermissionModes',
      root.disabledPermissionModes,
      disabledPermissionModeList,
      'restrict',
    ) ?? NO_DISABLED_MODES
  let permissionDsl = root.permissionDsl === undefined
    ? undefined
    : tolerantPermissionDsl(sink, 'permissionDsl', root.permissionDsl)
  const parsedClaudeRules = root.claudeRules === undefined
    ? undefined
    : tolerate(sink, 'claudeRules', 'stripped', () => parseManagedClaudeRulesV1(root.claudeRules, sink), undefined)
  if (parsedClaudeRules && parsedClaudeRules.rules.length > 0) {
    // Re-validate the combined document through the strict DSL parser so the
    // 128-rule cap and id uniqueness hold across admin DSL + claudeRules. The
    // combination can only fail on those two whole-document rules, so under
    // tolerance the OVERFLOW is stripped rather than the whole layer.
    permissionDsl = tolerantPermissionDsl(sink, 'permissionDsl', structuredClone({
      version: NESSY_PERMISSION_DSL_VERSION,
      rules: [...(permissionDsl?.rules ?? []), ...parsedClaudeRules.rules],
    }))
  }
  // `managed-settings.md#keys-that-fail-closed`'s `allowedMcpServers` vs `deniedMcpServers` rows, the pair that reacts to the same defect in
  // OPPOSITE directions. `allowedMcpServers` invalid → an EMPTY allowlist, so
  // no server is admitted until it is fixed. `deniedMcpServers` invalid → the
  // field is DROPPED, "since denying every server would block servers the
  // policy never named". Every other list here is classified by which of those
  // two it is, not by its name.
  const grant = (field: string, validate: (entry: string) => boolean) => (
    root[field] === undefined
      ? undefined
      : toleratedList(sink, field, root[field], value => list(value, validate), 'grant')
  )
  const restrict = (field: string, validate: (entry: string) => boolean) => (
    root[field] === undefined
      ? undefined
      : toleratedList(sink, field, root[field], value => list(value, validate), 'restrict')
  )
  const allowedPluginKeys = grant('allowedPluginKeys', value => value.length <= 256 && PLUGIN_KEY.test(value))
  const deniedPluginKeys = restrict('deniedPluginKeys', value => value.length <= 256 && PLUGIN_KEY.test(value))
  // A RESTRICTING list under `managed-settings.md#keys-that-fail-closed`, so a wholly invalid value is
  // DROPPED rather than emptied — an exclusion list nobody wrote must not start
  // hiding instruction files. `toleratedList(..., 'restrict')` also strips one
  // bad ENTRY and enforces the valid subset, which is what keeps a single typo'd
  // glob from costing the admin the rest of the exclusions.
  const claudeMdExcludes = restrict('claudeMdExcludes', value => INSTRUCTION_EXCLUDE_PATTERN.test(value))
  // P6.245 — the two operator-authored strings. Neither grants nor restricts;
  // both are the administrator's own words, carried unchanged.
  //
  // `pluginTrustMessage` is stripped on any defect for `model`'s reason: there
  // is no tighter reading of a sentence, and a repaired one would put words the
  // administrator did not write beside a trust decision.
  const pluginTrustMessage = typeof root.pluginTrustMessage === 'string'
    && root.pluginTrustMessage.trim().length > 0
    ? root.pluginTrustMessage.trim()
    : undefined
  if (root.pluginTrustMessage !== undefined && pluginTrustMessage === undefined) {
    sink.drop(
      'pluginTrustMessage',
      'invalid managed Pi policy pluginTrustMessage: expected a non-empty string',
      'stripped',
    )
  }
  // `companyAnnouncements` hands a surface OUT (text the user is shown), so it
  // takes the GRANT direction: a wholly invalid value grants nothing rather than
  // being dropped back to "no managed opinion", and one malformed entry costs
  // that entry instead of the whole list.
  const companyAnnouncements = grant('companyAnnouncements', value => value.trim().length > 0)
  const enabledPlugins = root.enabledPlugins === undefined
    ? undefined
    : tolerate(
      sink,
      'enabledPlugins',
      'stripped',
      () => parseManagedEnabledPluginsV1(root.enabledPlugins, sink),
      undefined,
    )
  // F1.593 — the organisation's servers, per entry: a bad entry costs that entry.
  const managedMcpServers = root.managedMcpServers === undefined
    ? undefined
    : tolerate(sink, 'managedMcpServers', 'stripped', () => parseManagedMcpServersV1(root.managedMcpServers, sink), undefined)
  // The two MCP lists do NOT go through `grant`/`restrict`: their entries are
  // documented objects rather than strings, and the denylist's defect handling
  // is not a plain strip. `managed-mcp-entries.ts` owns both, and applies the
  // same `availableModels`-vs-`deniedMcpServers` polarity at the whole-field level.
  const mcpEntries = (field: 'allowedMcpServers' | 'deniedMcpServers', kind: 'allow' | 'deny') => (
    root[field] === undefined
      ? undefined
      : parseManagedMcpEntryList(root[field], { list: kind, field, sink })
  )
  const allowedMcpServers = mcpEntries('allowedMcpServers', 'allow')
  const deniedMcpServers = mcpEntries('deniedMcpServers', 'deny')
  const allowPluginHooks = securitySwitch(
    sink, 'allowPluginHooks', root.allowPluginHooks, 'invalid managed Pi policy hooks', false,
  )
  const channelsEnabled = securitySwitch(
    sink, 'channelsEnabled', root.channelsEnabled, 'invalid managed Pi policy channels', false,
  )
  // P6.237 — the enforcing pole is `true` here, the mirror of `channelsEnabled`,
  // because the key is spelled as a DISABLE: a typo must leave background
  // sessions refused rather than quietly permitted.
  const disableAgentView = securitySwitch(
    sink, 'disableAgentView', root.disableAgentView, 'invalid managed Pi policy disableAgentView', true,
  )
  // P6.531 residue — a two-value RESTRICTION, so it takes neither `securitySwitch`
  // (boolean) nor the tolerant string parsers: anything that is not the exact
  // widening value reads as the enforcing pole `deny`, and only an ABSENT key
  // leaves the managed layer silent. Written as one expression so "absent" and
  // "unrecognised" cannot drift apart the way a two-step parse lets them.
  const unattendedApprovalFallback = root.unattendedApprovalFallback === undefined
    ? undefined
    : unattendedFallback(sink, root.unattendedApprovalFallback)
  // Both admin locks read an invalid value at their ENFORCING pole, like
  // `allowManagedMcpServersOnly` at `managed-settings.md#keys-that-fail-closed`. Neither appears in the
  // table of that section, so the general strip rule above it would strip them instead —
  // the ambiguity is real and this is the deliberate resolution: a lock that a
  // typo silently switches OFF is the exact "declared on one path, enforced on
  // another" failure this series keeps finding, and both are switches whose
  // `true` enforces, which is the whole shape the table covers. The choice is
  // never silent: the drop is recorded with disposition `tightened`, so
  // `nessy-general-agent doctor` names the field and the reading it took.
  const allowManagedHooksOnly = securitySwitch(
    sink, 'allowManagedHooksOnly', root.allowManagedHooksOnly,
    'invalid managed Pi policy allowManagedHooksOnly', true,
  )
  // Same admin-lock polarity as the two switches above: an administrator who
  // wrote the key meant to reach for the kill switch, so an invalid value reads
  // at the ENFORCING pole (hooks stay off) and the drop is recorded as
  // `tightened` for `doctor`. Absent stays absent — the omission sweep pins it.
  const disableAllHooks = securitySwitch(
    sink, 'disableAllHooks', root.disableAllHooks,
    'invalid managed Pi policy disableAllHooks', true,
  )
  // Same admin-lock polarity again, with one difference that matters: this key's
  // documented default is DELEGATION, not `false`, so an invalid value must not
  // land on `undefined` — that would silently hand the decision to
  // `allowManagedHooksOnly` when the administrator had written an opinion here.
  // `true` is both the enforcing pole and the only reading that cannot be
  // mistaken for the absent state.
  const disableCommandPluginSources = securitySwitch(
    sink, 'disableCommandPluginSources', root.disableCommandPluginSources,
    'invalid managed Pi policy disableCommandPluginSources', true,
  )
  // D1.107. Same admin-lock polarity as the switches above: the documented
  // default is `false`, so an administrator who wrote the key meant to reach for
  // the refusal, and an invalid value reads at the enforcing pole with the drop
  // recorded `tightened` for `doctor`.
  const disableSideloadFlags = securitySwitch(
    sink, 'disableSideloadFlags', root.disableSideloadFlags,
    'invalid managed Pi policy disableSideloadFlags', true,
  )
  const allowManagedPermissionRulesOnly = securitySwitch(
    sink, 'allowManagedPermissionRulesOnly', root.allowManagedPermissionRulesOnly,
    'invalid managed Pi policy allowManagedPermissionRulesOnly', true,
  )
  // P6.236 — `managed-settings.md#keys-that-fail-closed` names this key, so a
  // malformed value reads as the enforcing pole exactly like its two siblings.
  const allowManagedMcpServersOnly = securitySwitch(
    sink, 'allowManagedMcpServersOnly', root.allowManagedMcpServersOnly,
    'invalid managed Pi policy allowManagedMcpServersOnly', true,
  )
  // P6.238 — `settings-reference.md#model`: "string, a model alias or full
  // model ID". Stripped on any defect; a repaired model id would move a fleet
  // onto a model nobody chose.
  const managedModel = typeof root.model === 'string' && root.model.trim().length > 0
    ? root.model.trim()
    : undefined
  if (root.model !== undefined && managedModel === undefined) {
    sink.drop('model', 'invalid managed Pi policy model: expected a non-empty model id', 'stripped')
  }
  const strictPluginOnlyCustomization = strictCustomizationSurfaces(
    sink, root.strictPluginOnlyCustomization,
  )
  // Stripped on any defect, never reinterpreted. There is no tighter reading of
  // a DEFAULT: guessing `plan` from a typo would take a fleet out of the mode
  // its administrator actually chose, and `disabledPermissionModes` — which is
  // the key that forbids — still applies on top of whatever survives.
  const defaultMode = tolerate(sink, 'defaultMode', 'stripped', () => {
    if (root.defaultMode === undefined) return undefined
    const parsed = typeof root.defaultMode === 'string' ? parsePermissionMode(root.defaultMode) : null
    if (!parsed) throw new Error('invalid managed Pi policy defaultMode')
    return parsed
  }, undefined)
  const allowedChannelServers = grant('allowedChannelServers', value => MCP_SERVER.test(value))
  const allowedHttpHookUrls = grant('allowedHttpHookUrls', value => HTTP_HOOK_URL_PATTERN.test(value))
  const httpHookAllowedEnvVars = grant('httpHookAllowedEnvVars', value => ENV_VAR_NAME.test(value))
  // `scope: {}` is home-only ON PURPOSE: `~/` and `//` resolve because both are
  // machine-absolute, and a `./` or bare entry is refused by name
  // (`sandbox-<key>-no-scope-root`) instead of being anchored somewhere. A
  // managed policy has no declaring directory on this machine — it can arrive
  // over the wire (`config/managed-delivery.ts`) — which is the same reason
  // `sandbox-permission-rules.ts` skips source-anchored permission rules with a
  // diagnostic rather than guessing a root.
  const sandbox = root.sandbox === undefined
    ? undefined
    : parseManagedSandboxSettingsV1(root.sandbox, { sink, field: 'sandbox', scope: {} })
  const workflow = root.workflow === undefined
    ? undefined
    : tolerate(sink, 'workflow', 'stripped', () => parseWorkflowSettingsV1(root.workflow), undefined)
  const autoMode = root.autoMode === undefined
    ? undefined
    : tolerate(sink, 'autoMode', 'stripped', () => parseAutoModePolicyV1(root.autoMode, sink), undefined)
  const cleanupPeriodDays = root.cleanupPeriodDays === undefined ? undefined : tolerate(
    sink,
    'cleanupPeriodDays',
    'stripped',
    () => {
      if (typeof root.cleanupPeriodDays !== 'number'
        || !Number.isInteger(root.cleanupPeriodDays)
        || root.cleanupPeriodDays < 1) {
        throw new Error('invalid managed Pi policy cleanupPeriodDays')
      }
      return root.cleanupPeriodDays
    },
    undefined,
  )
  const autoCompactEnabled = optionalBoolean(
    sink,
    'autoCompactEnabled',
    root.autoCompactEnabled,
    'invalid managed Pi policy autoCompactEnabled',
  )
  const connectSourcesOnStartup = optionalBoolean(
    sink,
    'connectSourcesOnStartup',
    root.connectSourcesOnStartup,
    'invalid managed Pi policy connectSourcesOnStartup',
  )
  // Deliberately `optionalBoolean`, not `securitySwitch`, even though the three
  // hook locks a few lines up ARE security switches — see the field's own
  // comment: the enforcing pole of this one is "stop taking security updates",
  // so a typo must decide nothing rather than decide that.
  const disableInAppUpdates = optionalBoolean(
    sink,
    'disableInAppUpdates',
    root.disableInAppUpdates,
    'invalid managed Pi policy disableInAppUpdates',
  )
  // `optionalBoolean`, not `securitySwitch` — see the field's own comment. The
  // fail-closed reading IS available for this key (its pole costs a capability,
  // not a security-update channel) and is still declined: a typo must not
  // silently remove a surface the user can see.
  const disableInAppBrowser = optionalBoolean(
    sink,
    'disableInAppBrowser',
    root.disableInAppBrowser,
    'invalid managed Pi policy disableInAppBrowser',
  )
  // P6.338 — `settings-reference.md#disablebrowserexternalnavigation`: "only the
  // JSON Boolean `true` takes effect" and "a value that isn't a Boolean … also
  // logs a warning". A warning is a `stripped` drop, not a tightened reading, so
  // `optionalBoolean` is the page's own posture rather than a house style.
  const disableBrowserExternalNavigation = optionalBoolean(
    sink,
    'disableBrowserExternalNavigation',
    root.disableBrowserExternalNavigation,
    'invalid managed Pi policy disableBrowserExternalNavigation',
  )
  // P6.765 — the CDP lock's key, parsed exactly like its two boolean siblings
  // above: only an explicit `true` disables, and anything else is a `stripped`
  // drop that leaves the debugger permitted. The gate it feeds
  // (`isBrowserCdpManagedDisabled`) reads `=== true` for the same reason.
  const disableBrowserCdp = optionalBoolean(
    sink,
    'disableBrowserCdp',
    root.disableBrowserCdp,
    'invalid managed Pi policy disableBrowserCdp',
  )
  // P6.338 — an ALLOW list, so `managed-settings.md#keys-that-fail-closed`'s
  // allowlist row applies: a wholly invalid value is enforced as an EMPTY
  // allowlist. For this key that costs external browsing and says so, which is
  // the safe direction — the unsafe one would admit the internet on a typo.
  const browserHostAllowlist = grant(
    'browserHostAllowlist',
    value => value.length <= 253 && BROWSER_HOST_PATTERN.test(value),
  )
  // P6.338 — `settings-reference.md#browserexternalpagetools`: the type is the
  // string `"disabled"`, "the desktop app also accepts `\"disable\"`, in either
  // case", and "any other value leaves Claude's tools on … a non-empty string
  // that isn't one of the two accepted values logs a warning". Normalised to the
  // single stored spelling so no reader has to know there were two.
  const browserExternalPageTools = ((): 'disabled' | undefined => {
    const value = root.browserExternalPageTools
    if (value === undefined) return undefined
    if (typeof value === 'string' && ['disabled', 'disable'].includes(value.trim().toLowerCase())) {
      return 'disabled'
    }
    sink.drop(
      'browserExternalPageTools',
      'invalid managed Pi policy browserExternalPageTools: the only value that takes effect is '
      + '"disabled" (the spelling "disable" is accepted too, in either case); anything else leaves '
      + "Claude's tools on external pages",
      'stripped',
    )
    return undefined
  })()
  // P6.537 — carried VERBATIM and validated downstream, for the reason the
  // field's own comment gives: `parseManagedModelPricing` returns its
  // rejections instead of throwing, so one mistyped rate names itself on the
  // doctor surface rather than costing the operator the whole table or the
  // whole document. The only thing checked here is that it is an object at all,
  // because a string or a number is not a table by any reading.
  const modelPricing = root.modelPricing === undefined
    ? undefined
    : (typeof root.modelPricing === 'object' && root.modelPricing !== null
      && !Array.isArray(root.modelPricing))
        ? root.modelPricing
        : (sink.drop(
            'modelPricing',
            'invalid managed Pi policy modelPricing: expected an object of model prices',
            'stripped',
          ), undefined)
  // P6.498 — `optionalBoolean`, not `securitySwitch`, for the field's own
  // stated reason: the enforcing pole is "no connection can be added at all",
  // and a typo must not reach it.
  const disableNonGatewayConnections = optionalBoolean(
    sink,
    'disableNonGatewayConnections',
    root.disableNonGatewayConnections,
    'invalid managed Pi policy disableNonGatewayConnections',
  )
  const env = root.env === undefined
    ? undefined
    : tolerate(sink, 'env', 'stripped', () => parseManagedEnvBlockV1(root.env, sink), undefined)
  // Deliberately `optionalBoolean`, not `securitySwitch` — see the field's own
  // comment. Tightening this key means refusing to start.
  const forceRemoteSettingsRefresh = optionalBoolean(
    sink,
    'forceRemoteSettingsRefresh',
    root.forceRemoteSettingsRefresh,
    'invalid managed Pi policy forceRemoteSettingsRefresh',
  )
  // `managed-settings.md#keys-that-fail-closed`, fetched 2026-08-29 — the two
  // version gates fail OPEN by name: "`requiredMinimumVersion` and
  // `requiredMaximumVersion` fail open by design: an invalid value is dropped
  // rather than enforced, so a bad policy push can't prevent Claude Code from
  // starting". `optionalString`, never `securitySwitch`: the tightened reading of
  // a version bound is "refuse to start", which is the one thing that sentence
  // rules out for these two keys.
  const requiredMinimumVersion = versionBound(sink, 'requiredMinimumVersion', root.requiredMinimumVersion)
  const requiredMaximumVersion = versionBound(sink, 'requiredMaximumVersion', root.requiredMaximumVersion)
  // `managed-settings.md#keys-that-fail-closed` — a GRANT list, whose cell reads
  // "Enforced as an empty allowlist until fixed, so only the Default model is
  // available; a non-string entry is stripped and the valid subset enforced"
  // (fetched 2026-08-29). `toleratedList(..., 'grant')` is exactly that pair.
  const availableModels = grant('availableModels', value => value.length <= 256 && MODEL_ID.test(value))
  // `managed-settings.md#keys-that-fail-closed` — "Treated as `true`", and `true` is the enforcing pole.
  const enforceAvailableModels = securitySwitch(
    sink,
    'enforceAvailableModels',
    root.enforceAvailableModels,
    'invalid managed Pi policy enforceAvailableModels',
    true,
  )
  // `plugins/org.md#allowlist-with-strictknownmarketplaces` — undefined is "No restrictions", `[]` is
  // "Complete lockdown", and a list admits only what matches it. So an absent
  // field and an empty one are DIFFERENT answers and the parser must preserve
  // that distinction, which is why it does not go through `grant`.
  const strictKnownMarketplaces = root.strictKnownMarketplaces === undefined
    ? undefined
    : parseManagedMarketplaceEntryList(root.strictKnownMarketplaces, {
      field: 'strictKnownMarketplaces',
      sink,
    })
  // `settings-reference.md` §`blockedmarketplaces`. The polarity is the OPPOSITE
  // of the allowlist's and was read rather than chosen — see
  // `parseBlockedMarketplaceEntryList`, which drops a wholly invalid value
  // instead of escalating it to block-everything. Absent and `[]` mean the same
  // thing, so unlike `strictKnownMarketplaces` this one needs no absent-vs-empty
  // distinction and the `undefined` guard is only about not calling the parser.
  const blockedMarketplaces = root.blockedMarketplaces === undefined
    ? undefined
    : parseBlockedMarketplaceEntryList(root.blockedMarketplaces, {
      field: 'blockedMarketplaces',
      sink,
    })
  const extraKnownMarketplaces = root.extraKnownMarketplaces === undefined
    ? undefined
    : parseDeliveredMarketplaceEntryList(root.extraKnownMarketplaces, {
      // P3.220 — resolved from THIS document's own two keys, already parsed
      // above, so the delivery parser never re-derives the tri-state.
      commandSourcesAllowed: areMarketplaceCommandSourcesAllowed({
        schemaVersion: 1,
        disabledPermissionModes: [],
        ...(allowManagedHooksOnly === undefined ? {} : { allowManagedHooksOnly }),
        ...(disableCommandPluginSources === undefined ? {} : { disableCommandPluginSources }),
      }),
      field: 'extraKnownMarketplaces',
      sink,
    })
  // `settings-reference.md#pluginsuggestionmarketplaces`. A plain grant list of marketplace NAMES, validated by the
  // same name grammar the delivery key uses. It takes the `availableModels` row's grant polarity —
  // a wholly invalid value EMPTIES rather than widens — because every entry here
  // hands a surface out, and an emptied allowlist is the state the product is in
  // without the key at all.
  const pluginSuggestionMarketplaces = grant(
    'pluginSuggestionMarketplaces',
    value => MANAGED_MARKETPLACE_NAME.test(value),
  )
  return Object.freeze({
    schemaVersion: 1 as const,
    disabledPermissionModes,
    ...(permissionDsl === undefined ? {} : { permissionDsl }),
    ...(allowedPluginKeys === undefined ? {} : { allowedPluginKeys }),
    ...(deniedPluginKeys === undefined ? {} : { deniedPluginKeys }),
    ...(enabledPlugins === undefined ? {} : { enabledPlugins }),
    ...(managedMcpServers === undefined ? {} : { managedMcpServers }),
    ...(allowedMcpServers === undefined ? {} : { allowedMcpServers }),
    ...(strictKnownMarketplaces === undefined ? {} : { strictKnownMarketplaces }),
    ...(blockedMarketplaces === undefined ? {} : { blockedMarketplaces }),
    ...(extraKnownMarketplaces === undefined ? {} : { extraKnownMarketplaces }),
    ...(pluginSuggestionMarketplaces === undefined ? {} : { pluginSuggestionMarketplaces }),
    ...(deniedMcpServers === undefined ? {} : { deniedMcpServers }),
    ...(allowPluginHooks === undefined ? {} : { allowPluginHooks }),
    ...(allowManagedHooksOnly === undefined ? {} : { allowManagedHooksOnly }),
    ...(disableCommandPluginSources === undefined ? {} : { disableCommandPluginSources }),
    ...(disableAllHooks === undefined ? {} : { disableAllHooks }),
    ...(disableSideloadFlags === undefined ? {} : { disableSideloadFlags }),
    ...(allowManagedPermissionRulesOnly === undefined
      ? {}
      : { allowManagedPermissionRulesOnly }),
    ...(allowManagedMcpServersOnly === undefined ? {} : { allowManagedMcpServersOnly }),
    ...(managedModel === undefined ? {} : { model: managedModel }),
    ...(strictPluginOnlyCustomization === undefined ? {} : { strictPluginOnlyCustomization }),
    ...(defaultMode === undefined ? {} : { defaultMode }),
    ...(channelsEnabled === undefined ? {} : { channelsEnabled }),
    ...(disableAgentView === undefined ? {} : { disableAgentView }),
    ...(unattendedApprovalFallback === undefined ? {} : { unattendedApprovalFallback }),
    ...(allowedChannelServers === undefined ? {} : { allowedChannelServers }),
    ...(allowedHttpHookUrls === undefined ? {} : { allowedHttpHookUrls }),
    ...(httpHookAllowedEnvVars === undefined ? {} : { httpHookAllowedEnvVars }),
    ...(parsedClaudeRules === undefined ? {} : { claudeRules: parsedClaudeRules.claudeRules }),
    ...(claudeMdExcludes === undefined ? {} : { claudeMdExcludes }),
    ...(pluginTrustMessage === undefined ? {} : { pluginTrustMessage }),
    ...(companyAnnouncements === undefined ? {} : { companyAnnouncements }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(workflow === undefined ? {} : { workflow }),
    ...(autoMode === undefined ? {} : { autoMode }),
    ...(cleanupPeriodDays === undefined ? {} : { cleanupPeriodDays }),
    ...(autoCompactEnabled === undefined ? {} : { autoCompactEnabled }),
    ...(connectSourcesOnStartup === undefined ? {} : { connectSourcesOnStartup }),
    ...(disableInAppUpdates === undefined ? {} : { disableInAppUpdates }),
    ...(disableInAppBrowser === undefined ? {} : { disableInAppBrowser }),
    ...(disableBrowserExternalNavigation === undefined ? {} : { disableBrowserExternalNavigation }),
    ...(disableBrowserCdp === undefined ? {} : { disableBrowserCdp }),
    ...(browserHostAllowlist === undefined ? {} : { browserHostAllowlist }),
    ...(browserExternalPageTools === undefined ? {} : { browserExternalPageTools }),
    ...(modelPricing === undefined ? {} : { modelPricing }),
    ...(disableNonGatewayConnections === undefined ? {} : { disableNonGatewayConnections }),
    ...(env === undefined ? {} : { env }),
    ...(forceRemoteSettingsRefresh === undefined ? {} : { forceRemoteSettingsRefresh }),
    ...(requiredMinimumVersion === undefined ? {} : { requiredMinimumVersion }),
    ...(requiredMaximumVersion === undefined ? {} : { requiredMaximumVersion }),
    ...(availableModels === undefined ? {} : { availableModels }),
    ...(enforceAvailableModels === undefined ? {} : { enforceAvailableModels }),
  })
}

/**
 * STRICT parse. Every malformed key throws, and the caller must reject the
 * whole file. This is the posture `managed-settings.md#invalid-entries-in-managed-settings` keeps for user, project and
 * local settings — it is deliberately still the default export.
 */
export function parseManagedPiPolicyV1(value: unknown): ManagedPiPolicyV1 {
  return parsePolicy(value, STRICT_DROP_SINK)
}

/**
 * TOLERANT parse, for the managed tier only (`managed-settings.md#invalid-entries-in-managed-settings`): a malformed
 * entry is stripped, recorded, and every remaining valid policy is enforced — the
 * page "drops any top-level key whose value still fails and keeps enforcing every
 * remaining valid key" (fetched 2026-08-29).
 *
 * This overrides the fail-closed posture recorded on
 * {@link ManagedPiPolicyV1.claudeRules}. That comment defended against an
 * admin's rule silently doing nothing; the failure it produced instead was one
 * typo in a fleet-wide push refusing to start every client, which is worse. The
 * drop list is how the rule stops being silent.
 */
export function parseManagedPiPolicyTolerantV1(
  value: unknown,
  options: { source: string },
): ManagedPiPolicyParseV1 {
  const drops: ManagedPolicyDropV1[] = []
  const policy = parsePolicy(value, collectingDropSink(options.source, drops))
  return Object.freeze({ policy, drops: Object.freeze(drops) })
}

/**
 * Whether a plugin may be used at all under the managed lists.
 *
 * `enabledPlugins`'s `false` entries are folded in because `settings-reference.md#enabledplugins`
 * gives that direction two effects, and this predicate is the reader of both:
 * managed entries "block installation at all scopes and hide the plugin from the
 * marketplace". A blocked plugin therefore projects no capability and appears in
 * no listing that filters through here, which is the strongest reading available
 * without an install-time gate (see {@link resolveManagedPluginActivation}).
 */
export function isManagedPluginAllowed(policy: ManagedPiPolicyV1, pluginKey: string): boolean {
  if (policy.deniedPluginKeys?.includes(pluginKey)) return false
  if (policy.enabledPlugins?.[pluginKey] === false) return false
  return policy.allowedPluginKeys === undefined || policy.allowedPluginKeys.includes(pluginKey)
}

/**
 * The plugins a managed policy FORCE-ENABLED (`settings-reference.md#enabledplugins`'s `true`
 * entries). Sorted so a caller can hash or display it deterministically.
 *
 * This is the documented subject of `settings-reference.md#what-runs-under-allowmanagedhooksonly`'s hook carve-out and the
 * only set {@link areVettedPluginHooksAllowed} may read. It is deliberately NOT
 * derived from {@link ManagedPiPolicyV1.allowedPluginKeys}; see that predicate.
 */
export function managedForceEnabledPluginKeys(policy: ManagedPiPolicyV1): readonly string[] {
  const entries = policy.enabledPlugins
  if (!entries) return []
  return Object.keys(entries).filter(key => entries[key] === true).sort()
}

/**
 * The managed activation verdict for one plugin, or `undefined` when the managed
 * tier states no opinion and the user/workspace/project layers decide.
 *
 * `'force-enabled'` is terminal upward (`settings-reference.md#enabledplugins` — "cannot be disabled this way,
 * since managed settings override local settings") and `'blocked'` terminal
 * downward (the same section). Returned as one value rather than two predicates because
 * the precedence rule is that a managed entry OUTRANKS every other layer, and a
 * caller reading one predicate and forgetting the other would implement half of
 * it — which is how {@link ManagedPiPolicyV1.allowManagedHooksOnly} went wrong
 * the first time.
 */
export function resolveManagedPluginActivation(
  policy: ManagedPiPolicyV1,
  pluginKey: string,
): 'force-enabled' | 'blocked' | undefined {
  const entry = policy.enabledPlugins?.[pluginKey]
  if (entry === undefined) return undefined
  return entry ? 'force-enabled' : 'blocked'
}

/**
 * Whether a server passes the managed MCP lists — `managed-mcp.md`
 * § *How a server is evaluated*.
 *
 * Takes the server's IDENTITY, not just its name. `:150` disclaims the name as
 * a security control in terms — "a user can call any server `github`" — so a
 * caller that can see the transport, URL or command must hand them over; the
 * URL and command dimensions are the only ones an administrator can enforce on.
 * A caller with nothing but a name passes `{ name }` and gets name matching
 * only, which is strictly what it can prove.
 *
 * `environment` is the LIVE `${VAR}` expansion environment — the one the
 * SERVER's configured value reads, `managed-mcp.md#how-policy-entries-expand`:
 * "The server's configured value expands from the live process environment,
 * like the rest of `.mcp.json`." It defaults to the process environment, which
 * is what the page specifies and what `.mcp.json` itself reads.
 *
 * `options.policyEnvironment` is the OTHER one, and the whole of P2.396. The
 * same section: "A policy entry expands from a pinned environment instead, so a
 * variable set by a project or user settings file can't change what an
 * allowlist entry means." The table names it — `allowedMcpServers` expands from
 * "The environment Claude Code started with, plus `env` values from managed
 * settings" — and the section closes "Requires Claude Code v2.1.219 or later."
 *
 * Until P2.396 both sides expanded through the live environment, so a variable
 * changed after startup changed what an operator's policy MEANT. Pinning BOTH
 * sides would have been the obvious fix and is a fail-OPEN one: a `${VAR}`
 * server URL steered mid-session onto a denied host would then be judged on its
 * startup value and slip the deny. The page splits them for that reason, and so
 * does this.
 *
 * Omitting `policyEnvironment` keeps the pre-P2.396 single-environment
 * behaviour. **The reason recorded here when P2.396 landed was wrong, and it
 * left a fail-open standing for an hour**: it said the two callers in
 * `mcp/runtime-pool-servers.ts` live outside the host that can capture a
 * startup snapshot, so a required argument there could only ever be filled with
 * `process.env` — the divergence back under a name that reads as fixed. That is
 * true of an IMPORT and false of a registered reader, which is how those two
 * callers already reach the composed policy itself. P2.410 pinned them through
 * {@link resolveManagedPolicyExpansionEnvironment}, the fifth such reader.
 *
 * What the omission is actually for, and all it is for: a process where nothing
 * registered a pinned environment — every non-managed install, and every test
 * that never registers one. Those callers get exactly what they had before
 * P2.396, which is what they are asking for by omitting it.
 */
export function isManagedMcpServerAllowed(
  policy: ManagedPiPolicyV1,
  server: ManagedMcpServerIdentityV1,
  environment?: Record<string, string | undefined>,
  options: { readonly policyEnvironment?: Record<string, string | undefined> } = {},
): boolean {
  const pinned = options.policyEnvironment
  // `undefined` falls through to the matcher's own process-environment default.
  if (pinned === undefined) return evaluateManagedMcpServer(policy, server, environment)
  // The matcher expands the entry and the server through ONE environment, and
  // it is not ours to re-shape (P2.375's two fail-directions live there and
  // must not move). So the SERVER side is resolved first, through the live
  // environment it is documented to read, and the matcher is then handed the
  // pinned one — which the entry needs and the already-resolved server no
  // longer has anything to take from it.
  //
  // The entry itself is passed THROUGH UNTOUCHED. Pre-expanding it would be the
  // symmetric move and would silently disarm P2.375: its guard compares the
  // entry as WRITTEN against the entry as EXPANDED, and an entry handed over
  // already expanded carries no `${VAR}` to notice.
  //
  // Residue, named rather than hidden: a reference the LIVE environment cannot
  // supply survives into the matcher and the pinned environment gets a second
  // attempt at it. That needs a variable set at startup and unset since, and
  // the server's real URL is then the literal `${VAR}` text — an address that
  // reaches nothing — so the direction is inert or fail-closed, never an
  // escape. Closing it exactly requires the two-environment split to move into
  // `managed-mcp-entries.ts` itself.
  return evaluateManagedMcpServer(policy, expandMcpServerIdentity(server, environment), pinned)
}

/**
 * One server identity with its `${VAR}` references already resolved.
 *
 * `name` is deliberately left alone: `managed-mcp.md#match-servers-by-url-command-or-name`
 * — "`serverName` values match literally and never expand."
 */
function expandMcpServerIdentity(
  server: ManagedMcpServerIdentityV1,
  environment: Record<string, string | undefined> | undefined,
): ManagedMcpServerIdentityV1 {
  const live = environment ?? processEnvironment()
  const resolve = (value: string): string => expandConfigVariables(value, live).value
  return {
    ...server,
    ...(server.url === undefined ? {} : { url: resolve(server.url) }),
    ...(server.command === undefined ? {} : { command: server.command.map(resolve) }),
    ...(server.alternateCommands === undefined
      ? {}
      : { alternateCommands: server.alternateCommands.map(argv => argv.map(resolve)) }),
  }
}

function processEnvironment(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
}

/* ------------------------------------------------------------------------- *
 * Retained with a caveat — P2.398
 * ------------------------------------------------------------------------- */

/**
 * What P2.375's expansion guard DID to an entry it kept.
 *
 * {@link ManagedPolicyDropV1} cannot carry either of these and must not be made
 * to: all three of its dispositions mean *not applied*, and neither of these is
 * a drop. One is applied and admits nothing; the other is applied MORE broadly
 * than it was written. Filing them under "N managed settings entries were not
 * applied" would tell an administrator something false about their own policy,
 * which is worse than telling them nothing.
 */
export type ManagedPolicyCaveatDispositionV1 =
  /** On the ALLOWLIST: kept in the list, ignored as a match, admits nothing. */
  | 'retained-admitting-nothing'
  /** On the DENYLIST: still enforced, over a wider span than the text describes. */
  | 'retained-widened'

/**
 * One policy entry that is enforced differently from how it reads.
 *
 * No `source`, and the omission is deliberate rather than an oversight.
 * `settings.md#…` requires a DROP listing to carry "each invalid entry with its
 * source and field" because a drop is attributed to the fragment that wrote it.
 * A caveat describes the ENFORCED policy after composition, and composition is
 * winner-takes-all — there is exactly one source for the whole of it, which the
 * reporting host already names. The `field` path plus the entry as written
 * locates it in any fragment.
 */
export interface ManagedPolicyCaveatV1 {
  /** Indexed path, e.g. `deniedMcpServers[1]`. */
  readonly field: string
  /** The entry exactly as the administrator wrote it, before expansion. */
  readonly entry: string
  readonly disposition: ManagedPolicyCaveatDispositionV1
}

/**
 * Every managed MCP entry P2.375's expansion guard neutralises, in the order
 * they appear in the policy.
 *
 * ## Why the test is "does it reference a variable" and not the guard itself
 *
 * The guard (`urlEntryScopeIsVariableDetermined`, private to
 * `managed-mcp-entries.ts`) is a conjunction: the entry references a
 * `${VAR}`, AND either the reference survives expansion or the expansion moves
 * the entry's scheme, host or path scope. This function evaluates only the
 * first clause — and reads it from `referencesConfigVariable`, the guard's OWN
 * first line, so the two cannot fork on what a reference is.
 *
 * That is not a shortcut, it is the same set. `splitUrl` partitions the whole
 * pattern into authority and path, so for the second clause to be FALSE the
 * expansion would have to leave the text unchanged modulo the authority's case
 * and trailing dots — which requires the variable's value to spell its own
 * reference back, and that case is caught by the guard's other branch (a
 * reference that survives expansion). A `:-default` does not exempt it and an
 * UNSET variable does not either; P2.375 made sure of both, because unsetting
 * would otherwise be the cheapest escape of all.
 *
 * If the two ever do diverge, the direction is over-reporting a caveat on an
 * entry that still means what it says — never staying silent about one that
 * does not. `managed-mcp-caveats.test.ts` pins the equivalence from the
 * outside, through the gate's own verdicts.
 *
 * `serverCommand` and `serverName` are OUT of scope, because the guard is:
 * the page's column names "a URL entry's scheme, host, or path scope" and
 * nothing else, and `serverName` "values match literally and never expand".
 */
export function collectManagedPolicyCaveats(
  policy: ManagedPiPolicyV1,
): readonly ManagedPolicyCaveatV1[] {
  const caveats: ManagedPolicyCaveatV1[] = []
  const scan = (
    field: 'allowedMcpServers' | 'deniedMcpServers',
    disposition: ManagedPolicyCaveatDispositionV1,
  ): void => {
    policy[field]?.forEach((entry, index) => {
      if (!('serverUrl' in entry) || !referencesConfigVariable(entry.serverUrl)) return
      caveats.push(Object.freeze({
        field: `${field}[${index}]`,
        entry: entry.serverUrl,
        disposition,
      }))
    })
  }
  scan('allowedMcpServers', 'retained-admitting-nothing')
  scan('deniedMcpServers', 'retained-widened')
  return Object.freeze(caveats)
}

/**
 * The consequence in an administrator's words, not the enum's.
 *
 * A name in a list cannot carry either of these — P2.373 closed on exactly that
 * point — so each value gets the whole sentence, including the half that is
 * counter-intuitive: an ignored allow entry makes the allowlist NARROWER than
 * it reads, because it still displaces the `serverName` fallback.
 */
const CAVEAT_EFFECT: Readonly<Record<ManagedPolicyCaveatDispositionV1, string>> = Object.freeze({
  'retained-admitting-nothing':
    'a variable decides this entry\'s scheme, host or path scope, so it is kept in the allowlist '
    + 'and admits NOTHING. It still displaces a `serverName` entry, so the allowlist grants less '
    + 'than it reads',
  'retained-widened':
    'a variable decides this entry\'s scheme, host or path scope, so it still matches — over the '
    + 'whole span the variable occupies. This entry blocks MORE than the text describes',
})

/** One caveat as a single line: field, entry, effect. */
export function formatManagedPolicyCaveat(caveat: ManagedPolicyCaveatV1): string {
  return `${sanitizeSettingsDiagnostic(caveat.field, 120)}: `
    + `${sanitizeSettingsDiagnostic(caveat.entry, 200)} — ${CAVEAT_EFFECT[caveat.disposition]}`
}

/**
 * The whole caveat list as a summary block, or `undefined` when there is
 * nothing to report.
 *
 * The heading is deliberately NOT the drop summary's "were not applied": every
 * entry here IS applied, and half of them more broadly than written. It closes
 * on the page's own remedy — `managed-mcp.md#match-servers-by-url-command-or-name`,
 * "use literal URLs and commands for entries you rely on for enforcement" —
 * because a diagnostic an administrator cannot act on is only half a
 * diagnostic.
 */
export function formatManagedPolicyCaveatSummary(
  caveats: readonly ManagedPolicyCaveatV1[],
): string | undefined {
  if (caveats.length === 0) return undefined
  const heading = caveats.length === 1
    ? '1 managed MCP policy entry is enforced differently from how it reads:'
    : `${caveats.length} managed MCP policy entries are enforced differently from how they read:`
  return [
    heading,
    ...caveats.map(caveat => `  - ${formatManagedPolicyCaveat(caveat)}`),
    '  Use literal URLs and commands for entries you rely on for enforcement.',
  ].join('\n')
}

/**
 * Print the summary. Returns the number of caveats reported, so a caller can
 * assert on it without re-deriving the list.
 *
 * `console.warn` for the same reason {@link reportManagedPolicyDrops} uses it:
 * it is stderr in the headless server and the main log in the desktop shell, so
 * one call reaches both hosts.
 */
export function reportManagedPolicyCaveats(
  caveats: readonly ManagedPolicyCaveatV1[],
  options: { write?: (message: string) => void } = {},
): number {
  const summary = formatManagedPolicyCaveatSummary(caveats)
  if (summary === undefined) return 0
  const write = options.write ?? ((message: string) => { console.warn(message) })
  write(`[managed-settings] ${summary}`)
  return caveats.length
}

export function areManagedPluginHooksAllowed(policy: ManagedPiPolicyV1): boolean {
  return policy.allowPluginHooks !== false
}

/**
 * `settings-reference.md#allowmanagedpermissionrulesonly` — whether only managed permission rules apply.
 *
 * Named rather than read inline because the composition site is far from the
 * policy, and an inline `=== true` there is how a lock ends up read at one call
 * site and forgotten at the next.
 */
export function isManagedPermissionRulesOnly(policy: ManagedPiPolicyV1): boolean {
  return policy.allowManagedPermissionRulesOnly === true
}

/** `settings-reference.md#allowmanagedhooksonly` — whether the managed-only hook lock is engaged. */
export function isManagedHooksOnly(policy: ManagedPiPolicyV1): boolean {
  return policy.allowManagedHooksOnly === true
}

/**
 * `settings-reference.md#disablecommandpluginsources` — whether a
 * marketplace-declared COMMAND may run: a `command` plugin source, or a
 * `headersHelper`.
 *
 * The only reader allowed to resolve the key's third state. Unset delegates —
 * "**Default**: unset, so Claude Code follows `allowManagedHooksOnly`: an
 * organization that restricts hook execution to managed settings gets command
 * sources disabled too" — and an explicit `false` is the one thing that
 * overrides that lock: `#what-runs-under-allowmanagedhooksonly` blocks
 * `headersHelper` commands "unless `disableCommandPluginSources` is explicitly
 * set to `false`".
 *
 * Named rather than read inline for the reason {@link isManagedPermissionRulesOnly}
 * gives: a tri-state read at two call sites becomes a two-state read at one of
 * them.
 */
export function areMarketplaceCommandSourcesAllowed(policy: ManagedPiPolicyV1): boolean {
  if (policy.disableCommandPluginSources !== undefined) return !policy.disableCommandPluginSources
  return !isManagedHooksOnly(policy)
}

/**
 * `settings-reference.md#strictpluginonlycustomization` — whether ONE surface is locked to plugin-provided and
 * managed sources.
 *
 * Per-surface rather than a whole-policy boolean because the four surfaces are
 * enforced at four different places, and a caller reading the array itself would
 * have to re-derive "is `hooks` in there" at each of them — the shape that let
 * {@link allowManagedHooksOnly} be implemented as half of its own rule the first
 * time. The parser has already normalized `true` to all four, so this reads one
 * array and never a union.
 */
export function isStrictPluginOnlyCustomizationLocked(
  policy: ManagedPiPolicyV1,
  surface: StrictCustomizationSurfaceV1,
): boolean {
  return policy.strictPluginOnlyCustomization?.includes(surface) === true
}

/**
 * `hooks.md:614` — whether the MANAGED level of `disableAllHooks` is engaged.
 * Only this level can silence managed-distributed hooks; the settings-file
 * spelling of the key stops at the user/project/plugin tiers.
 */
export function isManagedAllHooksDisabled(policy: ManagedPiPolicyV1): boolean {
  return policy.disableAllHooks === true
}

/**
 * D1.107 — whether the administrator has refused the sideload flags
 * (`settings-reference.md#disablesideloadflags`; see the field for the verbatim
 * sentence and for why our surface is one flag wide).
 *
 * The page's own behaviour is the contract: reject AT STARTUP and exit with an
 * error NAMING the rejected flags — not drop the value and continue, which is
 * the shape that would let an operator believe a definition took.
 */
export function isManagedSideloadFlagsDisabled(policy: ManagedPiPolicyV1): boolean {
  return policy.disableSideloadFlags === true
}

/**
 * Whether plugin hooks survive the {@link isManagedHooksOnly} lock.
 *
 * `settings-reference.md#what-runs-under-allowmanagedhooksonly` keeps "Hooks from plugins force-enabled in managed settings
 * `enabledPlugins`", and adds the reason: "This lets administrators distribute
 * vetted hooks through an organization marketplace while blocking everything
 * else."
 *
 * **The carve-out now has its documented subject** ({@link enabledPlugins}), and
 * this predicate reads THAT set and only that set. `93f886f1` closed it to
 * `false` because we had no force-enable and the first implementation had
 * substituted {@link ManagedPiPolicyV1.allowedPluginKeys} for it — a substitution
 * WIDER than the document: the allowlist means "these plugins may be used", and
 * an administrator writing it under that natural reading would silently grant
 * in-process hook execution, arbitrary code on every turn, to every plugin on an
 * organisation allowlist. Two lists that differ in meaning must not be merged
 * because they are the only two we have; reading the allowlist here again is the
 * exact defect that commit removed.
 *
 * This is the "was the view already narrowed" half of the lock, not the
 * per-plugin decision: the narrowing itself is per plugin and happens upstream,
 * where a plugin hook candidate whose plugin is not force-enabled is dropped
 * while the lock is engaged (`storage-runtime.ts`'s `pluginCandidates` filter).
 * So a `true` here says "a force-enabled set exists", and the caller conjoins it
 * with the proof that the upstream filter ran over the snapshot in hand —
 * `capabilities/runtime-automations.ts`'s `resolveVettedPluginHookLock`. That
 * proof used to be spelled `provider === 'pi'` at the call site and went stale
 * when P2.314 widened the upstream gate to every runtime turn (P6.5).
 */
export function areVettedPluginHooksAllowed(policy: ManagedPiPolicyV1): boolean {
  return managedForceEnabledPluginKeys(policy).length > 0
}

/**
 * Whether a model may be selected under the managed allowlist —
 * `settings-reference.md#availablemodels`. An absent list imposes no narrowing; an EMPTY list admits
 * nothing, which is `managed-settings.md#keys-that-fail-closed`'s enforced reading of an invalid value.
 *
 * NAMED selection only. `model-config.md:205`/`:207` keep the Default option
 * reachable through a list this predicate rejects, so a catalog projection must
 * ask both this and {@link resolveManagedDefaultModel} — see
 * `config/managed-models.ts`, which is the one place that combines them.
 *
 * The matcher itself lives in `config/managed-model-allowlist.ts`, which has no
 * imports, because two consumers cannot reach this module: `llm-connections.ts`
 * is bundled into the Vite renderer, and the Pi subprocess spawner holds the
 * allowlist as a manifest field rather than a parsed policy.
 */
export function isManagedModelAllowed(policy: ManagedPiPolicyV1, modelId: string): boolean {
  return isModelInManagedAllowlist(policy.availableModels, modelId)
}

/**
 * The Default option under `enforceAvailableModels` — `settings-reference.md#enforceavailablemodels`.
 *
 * > Extend the `availableModels` allowlist to the Default model. When `true` in
 * > managed settings and `availableModels` is a non-empty array, the Default
 * > option falls back to the first allowlisted entry that is available, but
 * > only when the model Default would resolve to […] is not in the allowlist;
 * > an allowlisted default is kept as-is. Has no effect when `availableModels`
 * > is unset or empty.
 *
 * `availableIds` is the catalog actually reachable for this connection, because
 * "the first allowlisted entry that is AVAILABLE" is not the same as the first
 * entry an admin wrote.
 *
 * `undefined` means "no allowlisted model is reachable" — which
 * `model-config.md:222` resolves as ENFORCEMENT SKIPPED, not as "no model":
 * "When `availableModels` is non-empty but no entry resolves to an allowed and
 * available model, enforcement is skipped and Default resolves to the
 * account-type default." A caller that reads `undefined` as an absent model
 * inverts that sentence and locks the user out of every model, so every caller
 * must fall back to the default it passed in.
 */
export function resolveManagedDefaultModel(
  policy: ManagedPiPolicyV1,
  defaultModelId: string | undefined,
  availableIds: readonly string[],
): string | undefined {
  const allowlist = policy.availableModels
  if (allowlist === undefined || allowlist.length === 0) return defaultModelId
  // `settings-reference.md#availablemodels` — the allowlist "does not affect the Default option unless
  // `enforceAvailableModels` is also set".
  if (policy.enforceAvailableModels !== true) return defaultModelId
  if (defaultModelId !== undefined && isManagedModelAllowed(policy, defaultModelId)) {
    return defaultModelId
  }
  // An entry may be a version prefix rather than a model id (`:147`), so the
  // ENTRY is not itself a selectable model — resolve each entry to the first
  // available id it names, in the administrator's order.
  for (const entry of allowlist) {
    const match = availableIds.find(id => matchesManagedModelEntry(entry, id))
    if (match !== undefined) return match
  }
  return undefined
}

/**
 * Compose the managed channel policy over the host's own switch.
 *
 * One-directional on purpose: managed `false` is terminal, and managed `true`
 * grants nothing a user did not already enable. Allowlists intersect, so
 * whichever layer is narrower wins and neither can widen the other.
 *
 * `deniedMcpServers` is folded in here, which is the one thing the removed
 * `isManagedChannelServerAllowed` did and this did not. An allowlist alone
 * cannot express it: with no layer naming a list, `allowedSources` is
 * `undefined` — "no per-source restriction" — so a server an admin denied
 * outright would still be free to push. The upstream record filter
 * (`storage-runtime.ts`) strips such a server only on a Pi capability turn,
 * so it is not a substitute for the gate. Deny travels as its own list rather
 * than only as a subtraction from the allowlist, for that same reason.
 *
 * Only the `serverName` entries of `deniedMcpServers` reach it. The channel gate
 * is keyed on a source SLUG (`McpClientPool.canPush`), which is the same thing a
 * `serverName` entry names and is not something a `serverUrl` or `serverCommand`
 * entry can be projected onto. So this layer enforces strictly less than the
 * policy states; the load-bearing gate is `isManagedMcpServerAllowed`, which
 * sees the whole server identity and runs before a denied server is ever
 * materialized.
 */
export function resolveManagedChannelPolicy(
  policy: ManagedPiPolicyV1,
  user: { enabled: boolean; allowedSources?: readonly string[] },
): { enabled: boolean; allowedSources?: readonly string[]; deniedSources?: readonly string[] } {
  const enabled = user.enabled && policy.channelsEnabled !== false
  const managed = policy.allowedChannelServers
  const denied = managedMcpEntryNames(policy.deniedMcpServers)
  const intersected = managed === undefined
    ? user.allowedSources
    : user.allowedSources === undefined
      ? managed
      : managed.filter(source => user.allowedSources!.includes(source))
  const allowedSources = intersected !== undefined && denied?.length
    ? intersected.filter(source => !denied.includes(source))
    : intersected
  return {
    enabled,
    ...(allowedSources === undefined ? {} : { allowedSources }),
    ...(denied?.length ? { deniedSources: denied } : {}),
  }
}

/**
 * F1.593 (C4.4, owner answer QB2 = C) — `managedMcpServers`, the ADDITIVE half of
 * organisation-provided MCP servers. `settings-reference.md#managedmcpservers`
 * ("Provide remote MCP servers to every user from managed settings. Users keep the
 * servers they add themselves and can't edit or remove the ones you provide"), and
 * the vendored `sdk.d.ts` at 0.3.267: "keyed by server name, each with the .mcp.json
 * entry shape; only "http" and "sse" servers are accepted (nothing that names a
 * program to run, no ${VAR} references) … deniedMcpServers still applies, and they
 * need no allowedMcpServers entry." Exclusive control (`managed-mcp.json`) stays
 * refused by its own ruling.
 *
 * Declared HERE, by interface merging, rather than inside the interface above:
 * this file is cited by line from the ledgers up to its line 2623, and a field
 * added in the middle would move every one of those anchors (AGENTS.md §Traps).
 *
 * Delivered by the HOST pool on all three runtimes — `foldManagedOrgMcpServers`
 * in `mcp/runtime-pool-servers.ts` — because the claude child cannot be handed it:
 * measured at 2.1.267, `Options.managedSettings.managedMcpServers` (the SDK parent
 * tier, the only managed channel an embedding host has) connects nothing, since
 * the tier's restrictive-only filter copies no additive key.
 */
export interface ManagedPiPolicyV1 {
  readonly managedMcpServers?: Readonly<Record<string, ManagedMcpServerDeliveryV1>>
}

/** One organisation-delivered server: the `.mcp.json` remote shape, and only what this build carries. */
export interface ManagedMcpServerDeliveryV1 {
  readonly type: 'http' | 'sse'
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
}

/** A wire name the pool can key and every runtime can spell as `mcp__<name>__<tool>`. */
const MANAGED_MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/
/** Names an own-property assignment would turn into a prototype write. */
const MANAGED_MCP_SERVER_RESERVED_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])
const MANAGED_MCP_SERVERS_MAX_ENTRIES = 64
const MANAGED_MCP_SERVER_FIELDS: ReadonlySet<string> = new Set(['type', 'url', 'headers'])

/** Why one entry is refused, or `undefined` when it is carried. Every refusal names the documented rule it enforces. */
function managedMcpServerDefect(name: string, value: unknown): string | undefined {
  if (!MANAGED_MCP_SERVER_NAME.test(name) || MANAGED_MCP_SERVER_RESERVED_NAMES.has(name)) {
    return `invalid managed Pi policy managedMcpServers name: ${name} (letters, digits, "_" and "-", at most 64)`
  }
  const entry = record(value)
  if (!entry) return `invalid managed Pi policy managedMcpServers entry: ${name}`
  if (entry.type !== 'http' && entry.type !== 'sse') {
    return `managedMcpServers.${name}: only "http" and "sse" servers are accepted, nothing that names a program to run`
  }
  const extra = Object.keys(entry).filter(key => !MANAGED_MCP_SERVER_FIELDS.has(key))
  if (extra.length > 0) {
    return `managedMcpServers.${name}: this build carries type, url and headers only, and refuses the entry rather than half of it (${extra.join(', ')})`
  }
  if (typeof entry.url !== 'string' || !/^https?:\/\//i.test(entry.url) || !parsesAsUrl(entry.url)) {
    return `managedMcpServers.${name}: url must be an http(s) URL`
  }
  const headers = entry.headers === undefined ? {} : record(entry.headers)
  if (!headers || Object.values(headers).some(header => typeof header !== 'string')) {
    return `managedMcpServers.${name}: headers must map names to strings`
  }
  if ([entry.url, ...Object.keys(headers), ...(Object.values(headers) as string[])].some(referencesConfigVariable)) {
    return `managedMcpServers.${name}: no \${VAR} references are accepted`
  }
  return undefined
}

function parseManagedMcpServersV1(
  value: unknown,
  sink: ManagedDropSink,
): Readonly<Record<string, ManagedMcpServerDeliveryV1>> {
  const root = record(value)
  if (!root) throw new Error('invalid managed Pi policy managedMcpServers')
  const names = Object.keys(root)
  if (names.length > MANAGED_MCP_SERVERS_MAX_ENTRIES) throw new Error('invalid managed Pi policy managedMcpServers')
  const servers: Record<string, ManagedMcpServerDeliveryV1> = {}
  for (const name of names) {
    const defect = managedMcpServerDefect(name, root[name])
    if (defect !== undefined) {
      if (!sink.tolerant) throw new Error(defect)
      sink.drop(`managedMcpServers.${name}`, defect, 'stripped')
      continue
    }
    const entry = root[name] as { type: 'http' | 'sse', url: string, headers?: Record<string, string> }
    servers[name] = Object.freeze({
      type: entry.type,
      url: entry.url,
      ...(entry.headers === undefined ? {} : { headers: Object.freeze({ ...entry.headers }) }),
    })
  }
  return Object.freeze(servers)
}

function parsesAsUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}
