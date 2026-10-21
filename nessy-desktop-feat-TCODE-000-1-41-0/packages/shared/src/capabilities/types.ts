/**
 * Scoped capability model (W6 foundation; extended by W7/W8).
 *
 * W6 emits qualified provenance records for every native source/skill/agent/
 * mcp/hook/automation/instruction/memory/permission layer, keyed by an explicit
 * scope. It never collapses duplicates by short name — W8 owns the final alias
 * policy. Plugin capabilities are added by W7; the `plugin` scope/kind values
 * exist here so the union is stable across phases, but W6 emits no plugin
 * records.
 */

import type { ProjectKey } from '../projects/project-identity.ts';
import type { CredentialId } from '../credentials/types.ts';
import type { ManagedMcpServerIdentityV1 } from '../agent/pi-harness/managed-mcp-entries.ts';
import type { SkillOverrideState } from '../config/skill-overrides.ts';
import type { SourceConnectionStatus } from '../sources/types.ts';

export type CapabilityKind =
  | 'source'
  | 'skill'
  | 'mcp'
  | 'hook'
  | 'automation'
  | 'agent'
  | 'instruction'
  | 'memory'
  | 'permission'
  | 'plugin';

/** Native-scope kinds W6 is allowed to emit. */
export type NativeCapabilityKind = Exclude<CapabilityKind, 'plugin'>;

export type CapabilityScopeKind = 'builtin' | 'global' | 'workspace' | 'project';

/**
 * Explicit provenance for where a capability record came from. Workspace and
 * project scopes always carry the workspace ID; project scope additionally
 * carries the canonical `ProjectKey` (never an absolute path).
 */
export interface CapabilityScopeRef {
  kind: CapabilityScopeKind;
  workspaceId?: string;
  projectKey?: ProjectKey;
}

/**
 * Renderer-safe native icon captured during inventory from one immutable byte
 * read. `contentHash` and `dataUrl` therefore identify the exact same bytes;
 * no filesystem path crosses the safe catalog boundary.
 */
export interface NativeCapabilityIconResource {
  revision: string;
  contentHash: string;
  dataUrl: string;
}

/**
 * Presentation-only connector provenance (K4). A pure display projection of a
 * connector-materialized source's `connectorOrigin` — no secret, no path, never
 * an authorization input. `authTiming` is scheduling metadata, not a grant.
 */
export interface SafeSourceConnectorOrigin {
  pluginKey: string;
  connectorId: string;
  serverName: string;
  authTiming?: 'ON_INSTALL' | 'ON_FIRST_USE';
}

export interface NativeCapabilitySourceRecord {
  /** Fully qualified, collision-free key across all scopes. */
  key: string;
  kind: Extract<
    CapabilityKind,
    | 'source' | 'skill' | 'mcp' | 'hook' | 'automation' | 'agent'
    | 'instruction' | 'memory' | 'permission'
  >;
  scope: CapabilityScopeRef;
  /** Short/logical name (skill slug, agent name, mcp short name, file label). */
  logicalName: string;
  /** Safe Source transport metadata captured with the inventory record. */
  sourceType?: 'api' | 'mcp' | 'local';
  /**
   * SERVER-ONLY MCP transport identity: what the server IS, as distinct from
   * what it is called. Pinned for `kind: 'mcp'` records (a `.mcp.json` entry)
   * and for `sourceType: 'mcp'` Sources.
   *
   * It exists so the managed MCP denylist can match on `serverUrl` and
   * `serverCommand`. `managed-mcp.md:150` disclaims the NAME as a security
   * control — "a user can call any server `github`" — so a filter that saw only
   * `logicalName` could be escaped by renaming the server.
   *
   * Never copied into `SafeCapabilitySummary`: it carries a server URL and an
   * argv, which is the same class of value as {@link sourcePath}.
   */
  mcpServerIdentity?: Omit<ManagedMcpServerIdentityV1, 'name'>;
  /** Persisted Source enabled flag; resolver still applies session selection. */
  sourceEnabled?: boolean;
  /**
   * P3.218 — this record is off because an ADMINISTRATOR's managed policy denies
   * it, not because the user switched it off.
   *
   * Both produce `sourceEnabled: false`, and that is the whole defect: the
   * resolver turned the flag into one `unavailableReason`, `'source-disabled'`,
   * so the detail page reported the user's own OFF wording for a decision they
   * cannot change — and the toggle they were invited to flip reverts. There was
   * nothing for the renderer to key off, because the two facts were the same
   * bit.
   *
   * Set at exactly one site (`bootstrap/storage-runtime.ts`'s managed-MCP fold,
   * beside the `sourceEnabled: false` it accompanies) and read at exactly one
   * (`capabilities/resolver.ts`). Absent means the ordinary case, so every record
   * that is off for the user's own reason is unchanged.
   */
  managedDenied?: boolean;
  /** Non-secret credential address for runtime binding; server-only. */
  credentialId?: CredentialId;
  /** Source slug for preserving Source permission auto-scoping at runtime. */
  permissionSourceSlug?: string;
  /** Marks a path-scoped rule whose frontmatter is inventory-only metadata. */
  memoryFormat?: 'rule';
  /**
   * Memory-only: the instruction file whose `@path` import pulled this one in.
   * Present only on imported records, and it is the documented
   * `parent_file_path` an `InstructionsLoaded` `include` load reports.
   */
  memoryImportParentPath?: string;
  /** Same-scope precedence tier: Nessy-native beats portable compatibility. */
  sourceTier?: 'nessy' | 'portable';
  /**
   * Provenance of a pre-C5 connector-materialized source directory still on
   * disk (K4 shape). Post-C5 its ONLY consumer is the inventory filter that
   * EXCLUDES such records — connector servers ride the capability path, and
   * the on-disk directories are rollback material, never served.
   */
  connectorOrigin?: SafeSourceConnectorOrigin;
  /** Safe user-visible Source/Skill label captured without raw content. */
  displayName?: string;
  /** Safe user-visible description captured without raw content. */
  description?: string;
  /**
   * Skill-only: `alwaysAllow` tool names pinned from the SKILL.md frontmatter
   * (U2). Safe display metadata — tool patterns, never a path or secret. Drives
   * the detail page's permission-mode projection.
   */
  skillAlwaysAllow?: string[];
  /**
   * Skill-only invocation controls pinned from the SKILL.md frontmatter (P7).
   * `disable-model-invocation` keeps the skill out of the model's listing AND
   * makes the model's invocation path refuse it; `user-invocable: false` hides
   * it from the `/` menu; `allowed-tools` is ENFORCED since R17b — it narrows
   * the invoking turn's tool ceiling — and is pinned here so the capability view
   * reports the restriction the runtime is actually applying. Absent means "not
   * stated", so the documented defaults (`false` / `true`) apply.
   */
  skillDisableModelInvocation?: boolean;
  skillUserInvocable?: boolean;
  skillAllowedTools?: string[];
  /**
   * Agent-only: the definition's frontmatter DECLARES a tool grant (P6.551).
   *
   * A boolean and not the list, deliberately. The one consumer is
   * `codexDeclinesAgentToolGrant`, whose condition is presence rather than
   * content — codex has no per-role tool policy, so `tools: Read` and
   * `tools: []` are refused alike — and a record that crosses to the renderer
   * carries as little as the question needs.
   *
   * PRESENCE, including an empty or blank value: the materializer turns a
   * present-but-empty `tools:` into `[]`, which the writer's own truthiness test
   * denies. Absent means the key was not written, which is the only arm that
   * stays `active` on codex.
   *
   * Omitted rather than `false` when there is no grant, so the capability
   * generation does not move for every agent file the first time this is read.
   */
  agentDeclaresToolGrant?: boolean;
  /**
   * Skill-only: the SETTINGS-side visibility state (`skills.md:663`, R61).
   *
   * Server-only, and set on NATIVE skill records only. Plugin skills take their
   * control fields from `pluginSkillInvocationControls` in `resolver.ts`, a
   * different branch that never sets this, which is how `skills.md:689`
   * ("Plugin skills are not affected by `skillOverrides`") holds by
   * construction rather than by a check.
   *
   * Absent means the documented default `"on"` (`skills.md:678`), so the
   * stamping site omits the field for an unoverridden skill rather than writing
   * `'on'` — which also keeps the capability generation from moving for every
   * skill in the catalog the first time this key is read.
   */
  skillOverrideState?: SkillOverrideState;
  /**
   * Skill-only: this record occupies a BUNDLED slot (R78).
   *
   * `skills.md:122` — "A skill at any of these levels also overrides a bundled
   * skill with the same name", with the worked example "a `code-review` skill in
   * your project's `.claude/skills/` replaces the bundled `/code-review`". This
   * fork has no bundled directory at runtime: `skills/seed.ts:ensureBundledSkills`
   * COPIES the packaged skills into the managed skills root, which
   * `native-sources.ts` pushes at `global` scope — so without this field a seeded
   * bundle is indistinguishable from a skill the user wrote, and the
   * global-over-project skill inversion makes it beat a project skill of the same
   * slug, which is the opposite of the page.
   *
   * WHAT IT MEANS: PROVENANCE (a slot), NOT CONTENT. It says "this directory is
   * `<managedSkillsRoot>/<slug>` for a slug the packaged bundle ships". A user
   * who EDITS a seeded skill in place keeps the tag, and a user who authored
   * their own skill at a bundled slug before first run gets it too. That is the
   * SAME identity `settings-reference.md#disablebundledskills`'s off-switch
   * already uses to remove such a skill entirely ("Claude Code removes bundled
   * skills and workflows entirely") and `#strictpluginonlycustomization-skills`'s
   * origin lock already uses to keep it (it "keeps loading plugin skills,
   * bundled skills, and skills in the managed policy directory");
   * a fourth answer to "what is bundled here" would be the defect, not the tag.
   * The consequence is narrow: the record stays in the catalog, stays runnable
   * under its qualified key, and loses only the BARE name, only to a project (or
   * workspace) skill that actually claims it.
   *
   * **The REASON that sentence used to give is now false, and the correction is
   * the whole of P3.208(b).** It read "there is no marker on disk to tell them
   * apart, by the seed's own frozen policy (`seed.ts:9`, seed-once by
   * slug-existence, never overwrite)". Both halves were overtaken by P2.281
   * (`57ca0ef1b`): the seed is no longer seed-once-by-slug-existence — it decides
   * per slug BY CONTENT (absent → seed, identical → nothing, a hash we shipped →
   * refresh, anything else → leave it and record it as `customized`) — and it
   * leaves a marker, `.bundled-skill-seed.json` at the skills root
   * (`skills/seed.ts:BUNDLED_SKILL_SEED_RECEIPT_FILE`).
   *
   * **So the tag CAN now be exact, and making it exact is a posture change rather
   * than the one-liner P3.208(a) expected — measured, not assumed.** The receipt
   * distinguishes exactly the case this docblock accepts: a slug present in
   * `receipt.skills` is content we WROTE, while a user's own directory at a
   * bundled slug is recorded only under `customized` and never gets a `skills`
   * entry. Three things stop that from being a local edit:
   *   - `storage-runtime.ts:isSeededBundledSkill` is ONE predicate with THREE
   *     consumers — the bundled-skills off-switch, the origin lock, and this tag.
   *     Making one of them receipt-exact while the other two stay slug-matched
   *     manufactures the fourth answer this docblock forbids; moving all three
   *     changes what an administrator's "remove bundled skills" deletes, which is
   *     a product posture, not a lane's call.
   *   - A receipt-only predicate REGRESSES every profile that has not yet run a
   *     post-P2.281 seed: an absent receipt reads as empty, so nothing would be
   *     stamped and a seeded bundle would go back to outranking a project skill.
   *   - `customized` states in its own docblock that it is informational and
   *     "never read back into the update decision"; it is a plain file in the
   *     user's profile, so reading it into an alias-precedence decision would
   *     make the ordering user-writable.
   * **The safe intermediate IS now taken — P3.208(a), the actionable form.**
   * `isSeededBundledSkill` unions the receipt's `skills` keys into the slug set
   * it already builds from the bundle, so a slug a previous bundle seeded and
   * the current one no longer ships is now visible to all three consumers at
   * once. A union can only ADD a slug, never withdraw one, so it moves nothing
   * for a profile with no receipt and raises no posture question about what the
   * off-switch deletes. What stays undone is the SUBTRACTION above — declining
   * to stamp a user's own directory at a bundled slug — because that is the half
   * that changes what "remove bundled skills" removes.
   *
   * Orthogonal to {@link NativeCapabilitySourceRecord.sourceTier}: that is the
   * same-scope `nessy` > `portable` tie-break, this is a position in the skill
   * alias SCOPE chain. Absent means "not a bundled slot"; the stamping site omits
   * the field rather than writing a second value, so nothing moves for a record
   * that is not in one.
   */
  skillTier?: 'bundled';
  /**
   * Skill-only: this record came from a skills directory BELOW the working
   * directory, and this is the directory that owns it — `apps/web`, working-
   * directory-relative and POSIX-separated (R79).
   *
   * `skills.md:128` — a nested skill that shares a name "appears under a
   * directory-qualified name, `apps/web:deploy`"; `:132` — "Typing `/deploy`
   * runs the project-root skill. Type the qualified name `/apps/web:deploy` to
   * run the nested variant explicitly." This field is the `<dir>` half of that
   * name, and it is what tells the alias policy to leave the bare name alone.
   *
   * Present ONLY on a nested record. Absence is the normal case and means "no
   * qualified form", so no existing record, fixture or generation moves.
   *
   * NOT hashed separately into the capability generation, and unlike
   * {@link skillTier} that needs no argument: a nested record carries a
   * `nested:<dir>` discriminator inside its `key`, the key IS hashed, and the
   * qualifier is derived from the same string. A nested skill appearing at all
   * therefore moves the generation exactly once, when it appears.
   */
  skillDirectoryQualifier?: string;
  /**
   * `paths` (`skills.md:267`) — glob patterns that limit AUTOMATIC activation.
   * Safe display metadata: a pattern, never a resolved path. Absent means the
   * skill is always eligible.
   */
  skillPaths?: string[];
  /**
   * Source-only: read-only permission-pattern projection pinned from the
   * source's `permissions.json` (U2). Tool/bash/api/mcp rules only; path-based
   * rules are excluded so no absolute path is captured (Safe model).
   */
  sourcePermissions?: Array<{ pattern: string; access: 'allowed' | 'blocked' }>;
  /**
   * UB14.48 — Source-only: the stored `connectionStatus` of the source's config.json, already in the
   * app's vocabulary (`normalizeStoredStatus`: `source_test`'s `error`/`disconnected` read `failed`,
   * any other unknown value `untested`). Absent when the config stores none. Rides to
   * `SafeCapabilitySummary.lastTestStatus`; it moves no generation of its own, because the write that
   * changes it changes config.json, whose `contentHash` the source binding already hashes.
   */
  sourceLastTestStatus?: SourceConnectionStatus;
  /**
   * UB14.48 — Source-only: the stored `connectionError`, reduced by `sanitizeStoredConnectionError`
   * (no URL path or query, no absolute path, no recognised secret). Rides to
   * `SafeCapabilitySummary.connectionError`.
   */
  sourceConnectionError?: string;
  /** Conventional Source/Skill icon pinned with this inventory generation. */
  iconResource?: NativeCapabilityIconResource;
  /** Optional pinned Source guide; server-only and never projected to safe DTOs. */
  guideResource?: {
    sourcePath: string;
    revision: string;
    contentHash: string;
  };
  /** Absolute source path — SERVER-ONLY, never exposed to renderer/RPC DTOs. */
  sourcePath: string;
  /** Cheap change token (mtime-derived) for invalidation. */
  revision: string;
  /** Content identity for dedup/collision detection in W8. */
  contentHash: string;
  /** True when the source is editable in place (native storage). */
  mutable: boolean;
  /**
   * F1.635 — this record IS one of the organisation's `managedMcpServers`
   * (F1.593), mirrored into the catalog so the Sources list shows one read-only
   * row per delivered server. Declared at the interface's END for the same
   * reason `ManagedPiPolicyV1.managedMcpServers` is interface-merged at its
   * file's end: this file is cited by line from the ledgers (up to line 266),
   * and a field added in the middle would move every one of those anchors.
   *
   * PROVENANCE, like `skillTier`: it says the policy delivered this record, and
   * it rides the `builtin` scope (the managed tier's established scope —
   * `native-sources.ts`'s managed instruction/subagent rows) with the scope
   * ambiguity resolved by the KEY (`managed:mcp:<name>` beside the built-in dp
   * set's `builtin:mcp:`). The resolver maps it to `origin: 'managed'` on the
   * wire summary; `mutable` stays `false` — the documented "users keep the
   * servers they add themselves and can't edit or remove the ones you provide".
   * Absent for every other record, so nothing moves for an install with no
   * managed policy.
   */
  managedOrg?: true;
}

/** Persisted trust decision states (plus the implicit `none`). */
export type ProjectTrustDecisionState = 'trusted' | 'blocked';
export type ProjectTrustState = 'none' | ProjectTrustDecisionState;
export type ProjectTrustSource = 'user' | 'inherited' | 'policy';

/**
 * Everything a native-source resolution pass needs about the active Workspace
 * and (optional) project working directory. `projectTrustState` gates every
 * repository-owned layer; folder selection alone never implies trust.
 */
export interface WorkspacePolicyContext {
  workspaceId: string;
  workspaceRootPath: string;
  /** Server-derived session memory file; never accepted from a renderer. */
  sessionMemoryFilePath?: string;
  workingDirectory?: string;
  projectRoot?: string;
  projectKey?: ProjectKey;
  projectTrustState: ProjectTrustState;
  projectTrustRevision: string;
  /**
   * Active setting sources (R28). "Project rules are skipped if you exclude
   * `project` from `--setting-sources`" — when this is present and omits
   * `project`, the project tier contributes no rules. Absent means all sources,
   * which is the CLI default.
   */
  settingSources?: readonly SettingSource[];
  /**
   * EXPLICIT `--add-dir` roots, and nothing else.
   *
   * `--add-dir` loads `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md` and
   * `CLAUDE.local.md` from an additional directory, but only behind
   * `NESSY_ADDITIONAL_DIRECTORIES_MEMORY`. The `additionalDirectories` SETTING
   * must NEVER feed this list: `large-codebases.md` scores it "Never / Never"
   * for memory files, so the two roots-lists stay separate on purpose.
   *
   * ## PRODUCED SINCE P3.339 (owner sitting §1.4 = A). This section said
   * ## "NOTHING PRODUCES THIS TODAY" and no longer does.
   *
   * There is exactly one production producer of a `WorkspacePolicyContext`
   * (`storage-runtime.ts toWorkspacePolicyContext`), and until the owner's
   * answer it set nothing, so `NESSY_ADDITIONAL_DIRECTORIES_MEMORY` was a
   * documented opt-in that could not take effect on any runtime. It now feeds
   * this field from `getConfiguredAdditionalDirectories()` — unconditionally,
   * with the env var left as the single gate at the consumer, so an install that
   * has not set it behaves byte-identically to before.
   *
   * The paragraph above still holds and is not contradicted, because the two
   * `additionalDirectories` are not the same key — see the table and the
   * `permissions.md` quotation below.
   *
   * The two halves of `large-codebases.md`'s table are about DIFFERENT things,
   * and this fork sits across the seam:
   *
   * | source | skills etc. | CLAUDE.md / rules |
   * | --- | --- | --- |
   * | `additionalDirectories` SETTING | Never | Never |
   * | `--add-dir` flag / `/add-dir` | Yes | only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` |
   *
   * — plus, verbatim at `:303`, "The environment variable has no effect on
   * directories listed in the `additionalDirectories` setting."
   *
   * Our config key `additionalDirectories` is NOT the settings key that table's
   * first row is about. `claude-agent.ts` hands it to the SDK as the
   * `additionalDirectories` OPTION, and `permissions.md` says of that option:
   * "The SDK passes each entry to Claude Code as `--add-dir`, so those
   * directories behave like flag-added directories" (P6.34 measured the argv
   * builder in `sdk.mjs` doing exactly that). So on the claude runtime our key
   * IS the flag, and its roots load components at the child; on Pi and codex it
   * is the setting, and loads nothing. One key, two documented meanings.
   *
   * Closing that by feeding this field from `getConfiguredAdditionalDirectories()`
   * makes the host mirror what the claude child already does, behind the existing
   * env opt-in. It is a product posture, which is why W5-e wrote it up rather
   * than taking it; the owner took it on 2026-09-05 (sitting §1.4, option A —
   * "one line of wiring is less code than a deletion plus the three-runtime
   * explanation a deletion owes, and the blast radius is an operator who asked
   * for it"), and W8-w landed it.
   *
   * The honesty half stands beside it: `native-sources.ts` still says once, out
   * loud, when the opt-in is on and no root was supplied — its sentence now names
   * the `additionalDirectories` setting, because with a producer in place an
   * empty list means the operator named no directories rather than that the host
   * populates nothing.
   */
  additionalRuleDirectories?: readonly string[];
}

/** Settings layers a session may draw configuration from. */
export type SettingSource = 'user' | 'project' | 'local';

/**
 * One safe, path-free diagnostic emitted when an untrusted project's
 * repository-owned layers are withheld from the inventory.
 */
export interface BlockedCapabilityLayer {
  scope: 'project';
  reason: 'untrusted-project';
  /** Native kinds that were withheld from the trusted project's cwd. */
  withheldKinds: NativeCapabilityKind[];
  projectKey?: ProjectKey;
}

/**
 * One MCP declaration the inventory scan REFUSED at config-validation time
 * (`headless.md:220`, the `mcp_server_errors` contract). Claude's own categories
 * are `unknown_type`, `url_missing_type`, `invalid_config` and `reserved_name`,
 * and the page tells a consumer to "treat values you don't recognize as a
 * generic skip" — so the vocabulary is open and only the SHAPE is binding.
 *
 * Two properties matter to the CI gate this exists for. It records a REFUSAL,
 * never a degradation: a declaration that loads is absent from this list. And
 * it is computed at INVENTORY time — before any runtime starts — which is why
 * the doc hangs its gate on this array rather than on a connection status that
 * does not exist yet when the init frame is written.
 */
export interface McpConfigSkip {
  /** The declaration's own name — a Source slug, or the config file's basename. */
  name: string;
  /** Skip category. Claude's four spellings where one applies. */
  type: 'invalid_config' | 'unknown_type';
  message: string;
}

/**
 * One ancestor instruction file the walk found and did NOT load (P6.388).
 *
 * `MAX_INSTRUCTION_ANCESTOR_LAYERS` is OUR invention with a stated reason
 * (context cost), not a documented limit — `memory.md#how-claude-md-files-load`
 * says "Claude Code loads `CLAUDE.md` and `CLAUDE.local.md` from your current
 * working directory and every directory above it" and names no cap. A bound we
 * chose is defensible; a bound that hides its own effect is not, and until this
 * existed the cap was a bare `break` that told nobody which layers went
 * missing.
 *
 * Absolute paths live HERE, on the server-side inventory, beside every other
 * `sourcePath` — never on the `CapabilityDiagnostic`, whose `safeArgs` are
 * path-free by contract. The diagnostic carries the COUNT.
 */
export interface DroppedInstructionLayer {
  /** Absolute path of the instruction file that was not loaded. */
  path: string;
  /**
   * Why it was dropped. Two rules, and they are not the same kind of thing:
   * `ancestor-layer-cap` is OURS (a bound on how far the walk climbs), while
   * `over-size-limit` is the page's (P6.389 — a file over 4 MiB is skipped
   * whole). A reader that collapses them reports our invention as the vendor's
   * rule, so the resolver renders one diagnostic per reason.
   */
  reason: 'ancestor-layer-cap' | 'over-size-limit';
  /** The cap that dropped it, so a reader knows which number to argue with. */
  limit: number;
}

/**
 * One `@path` import the walk found and REFUSED because its target resolves
 * outside the containment root (P6.387).
 *
 * The refusal itself is not the defect and does not change: an instruction file
 * outside the project must not enter a trusted project's context because a line
 * inside the project asked for it — that is the containment
 * `projectRealRoot` exists to enforce. `memory.md#import-additional-files`
 * documents the import syntax — "Both relative and absolute paths are allowed.
 * Relative paths resolve relative to the file containing the import, not the
 * working directory." — and states no containment boundary anywhere in the
 * section, so the boundary is OURS, with a stated reason, exactly like the
 * ancestor-layer cap beside it. (Re-anchored P6.661: the page publishes
 * `#import-additional-files`; `#imports` is not a section of it.)
 *
 * What WAS the defect is that it happened in silence, through a bare `return`.
 * The author wrote `@~/.claude/notes.md`, nothing loaded it, and no surface
 * anywhere said why — indistinguishable from a broken import scanner, and the
 * reason this row is titled "vanishes with no record".
 *
 * Both paths are absolute and both stay HERE, on the server-side inventory,
 * beside every other `sourcePath`; the diagnostic built from this set carries
 * the count, because `CapabilityDiagnostic.safeArgs` is path-free by contract.
 */
export interface OutsideProjectImport {
  /** Absolute path the import resolved to, outside the containment root. */
  path: string;
  /** Absolute path of the instruction or memory file whose `@path` line asked for it. */
  importerPath: string;
  reason: 'outside-containment-root';
}

export interface NativeCapabilityInventory {
  records: NativeCapabilitySourceRecord[];
  blockedLayers: BlockedCapabilityLayer[];
  /**
   * MCP declarations skipped by config validation during this scan. Optional so
   * every hand-built inventory (tests, `EMPTY_INVENTORY`) stays valid; the real
   * producer (`buildNativeCapabilityInventory`) always supplies it, empty or not.
   */
  mcpConfigSkips?: McpConfigSkip[];
  /**
   * Ancestor instruction files the layer cap dropped. Optional for the same
   * reason `mcpConfigSkips` is; the real producer always supplies it.
   */
  droppedInstructionLayers?: DroppedInstructionLayer[];
  /**
   * `@path` imports refused for resolving outside the project. Optional for the
   * same reason as its two siblings above.
   */
  refusedProjectImports?: OutsideProjectImport[];
}

/**
 * A single scoped plugin-capability policy record (W7 Step 4). Activation state
 * is stored here — never on the installed-plugin entry — so one immutable
 * install can be enabled differently per global/Workspace/project scope.
 *
 * `enabled: false` is a terminal suppression at its scope (a lower-precedence
 * layer cannot re-enable it). `capabilities` holds per-capability/tool overrides.
 */
export interface CapabilityPolicyRecord {
  scope: CapabilityScopeRef;
  /** Version-less stable plugin key (preferred) … */
  pluginKey?: string;
  /** … or a specific installed instance. */
  pluginInstanceId?: string;
  /** When absent, the record applies to the whole plugin. */
  capabilityId?: string;
  enabled: boolean;
  capabilities?: Record<string, boolean>;
  updatedAt: string;
}

/** Resolved effective activation for one plugin/capability in a context. */
export interface ResolvedCapabilityActivation {
  enabled: boolean;
  /** True when an explicit `enabled:false` terminally suppressed the target. */
  suppressed: boolean;
  capabilities: Record<string, boolean>;
}
