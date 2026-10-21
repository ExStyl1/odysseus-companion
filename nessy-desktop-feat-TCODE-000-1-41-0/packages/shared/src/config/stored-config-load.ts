/**
 * DA1.72 — `loadStoredConfig` and its refusal semantics, in a module that
 * imports none of `credentials`, `sessions` or `docs`.
 *
 * ## The measurement this module exists for
 *
 * DA1.67 priced the config graph with three instruments and found the cost is
 * the PAGE CACHE rather than any one module: cold, the graph adds tens of
 * seconds; warm, nothing measurable. What it also found is the STRUCTURAL fact
 * underneath, which no cache can explain away — `config/proxy-env.ts` wants
 * exactly one thing from `storage.ts`, `getNetworkProxySettings`, which is
 * three lines over `loadStoredConfig`, and reaching it dragged the credential
 * manager, the session store and the docs initialiser into every process that
 * asked a settings question. Measured before this split (a transitive
 * runtime-import census, `import type` excluded): `proxy-env.ts` reached
 * **161** files and all three of `credentials/index.ts`, `sessions/index.ts`
 * and `docs/index.ts`.
 *
 * ## Why a MOVE and not a copy
 *
 * DA1.59 refused a leaf that would restate the refusal semantics, and it was
 * right to: this file is the only place that decides when a `config.json` is
 * unsupported, and a second spelling of that decision is the defect
 * {@link UnsupportedStorageLayoutError} exists to prevent — a caller that
 * treats a falsy return as "no config yet" and writes a fresh empty file over
 * a real one. So the code MOVED, byte for byte, and `storage.ts` imports and
 * re-exports it. Every one of the ~27 modules that import
 * `UnsupportedStorageLayoutError` (or `loadStoredConfig`) from `storage.ts`
 * still does, unchanged.
 *
 * ## What may be added here, and what may not
 *
 * The rule is the import list at the top of this file: `node:fs`, `node:path`,
 * and config/workspace leaves. **Nothing here may import `credentials`,
 * `sessions`, `docs` or anything that reaches them** — that is the whole
 * property, and the census in
 * `config/__tests__/stored-config-load-leaf.test.ts` fails when it is broken.
 * A reader that needs one of those three belongs in `storage.ts`, which is
 * where the rest of the file's mutators already live.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { debug } from '../utils/debug.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { z } from 'zod';
import { CONFIG_DIR, STORAGE_LAYOUT_VERSION } from './paths.ts';
import { assertStorageId } from '../workspaces/paths.ts';
import type { StoredConfig } from './storage.ts';
import type { NetworkProxySettings } from './types.ts';

/**
 * DA1.72 — the strict envelope, MOVED HERE FROM `config/validators.ts`, beside
 * the refusal that enforces it.
 *
 * AGENTS.md rule 19 is unchanged word for word — every settings key any reader
 * names MUST be in `StoredConfigKnownFields` AND in `StoredConfigSchema`, in
 * the same commit as the reader and the guard's fixture — and only the FILE
 * moved. `validators.ts` re-exports both names and still spreads this map into
 * `StoredConfigSchema`, so no importer changed.
 *
 * It moved because it is the half that CAN: every member is
 * `z.unknown().optional()` (or `z.never().optional()`), so it needs nothing but
 * zod, while `validators.ts` reaches `agent/permissions-config.ts` and
 * `automations/index.ts` — 158 files each, including all three of
 * `credentials/index.ts`, `sessions/index.ts` and `docs/index.ts`. Importing
 * the envelope from there put that whole graph behind every settings read in
 * the product.
 */
export const StoredConfigKnownFields = {
  storageLayoutVersion: z.unknown().optional(),
  workspaces: z.never().optional(),
  llmConnections: z.unknown().optional(),
  defaultLlmConnection: z.unknown().optional(),
  defaultThinkingLevel: z.unknown().optional(),
  // The `model-config.md#adjust-effort-level` effort hold, as two persisted facts.
  // DECLARED because the envelope below is strict — an undeclared key written
  // by our own writer would throw UnsupportedStorageLayoutError and cost the
  // user every setting in config.json. Unknown-tolerant like their peers: a
  // malformed value must read as "no hold in force", i.e. pre-upgrade behaviour.
  defaultThinkingLevelExplicit: z.unknown().optional(),
  heldThinkingLevelModelId: z.unknown().optional(),
  // I2.5 — the tier-2 per-model effort memory. Declared for exactly the reason
  // its two neighbours above are: the envelope is strict, and an undeclared key
  // written by our own setter would throw `UnsupportedStorageLayoutError` and
  // cost the user every setting in `config.json`. Unknown-tolerant like its
  // peers: a malformed map must read as "no per-model memory", i.e. the
  // behaviour before the key existed.
  modelThinkingLevels: z.unknown().optional(),
  // P6.307 — `code-review.md:327`'s cross-session review effort. Declared for the
  // same reason its two neighbours above are: the envelope is strict and an
  // undeclared key written by our own writer would cost the user every setting.
  lastReviewEffortLevel: z.unknown().optional(),
  // UB6.1 (DA1.72) — the decision layer's settings object. DECLARED because the
  // envelope below is strict: an undeclared key written by our own setter
  // (`storage.ts` `setDecisionLayerSettings`) would throw
  // UnsupportedStorageLayoutError and cost the user every setting in config.json.
  // Unknown-tolerant like its peers: the value is normalized by
  // `decisions/settings.ts` `normalizeDecisionLayerSettings`, so a malformed
  // object reads as "layer off with defaults", i.e. pre-upgrade behaviour.
  decisionLayer: z.unknown().optional(),
  outputStyleId: z.unknown().optional(),
  workspaceRefs: z.unknown().optional(),
  activeWorkspaceId: z.unknown().optional(),
  activeSessionId: z.unknown().optional(),
  notificationsEnabled: z.unknown().optional(),
  notificationTiming: z.unknown().optional(),
  notificationPermissionAlerts: z.unknown().optional(),
  notificationQuestionAlerts: z.unknown().optional(),
  retentionDays: z.unknown().optional(),
  // The sweep's off switch. Nessy-only: `cleanupPeriodDays` has no documented
  // disabled value, and overloading `retentionDays` with 0 would make this
  // validator report a user's deliberate choice as an invalid config.
  retentionSweepEnabled: z.unknown().optional(),
  // P6.502 · the first-class never-persist setting. DECLARED because the
  // envelope below is strict: an undeclared key written by our own setter
  // refuses the whole config.json and costs the user every other setting in it.
  neverPersistSessions: z.unknown().optional(),
  // P6.182 (i) · the user rung of `crossSessionInbound`. Unknown-tolerant on the
  // load path like its peers, so a value the reader drops cannot refuse the file.
  crossSessionInbound: z.unknown().optional(),
  colorTheme: z.unknown().optional(),
  zoomFactor: z.unknown().optional(),
  dismissedUpdateVersion: z.unknown().optional(),
  autoCapitalisation: z.unknown().optional(),
  sendMessageKey: z.unknown().optional(),
  spellCheck: z.unknown().optional(),
  keepAwakeWhileRunning: z.unknown().optional(),
  richToolDescriptions: z.unknown().optional(),
  browserToolEnabled: z.unknown().optional(),
  allowRemoteEvaluate: z.unknown().optional(),
  memoryEnabled: z.unknown().optional(),
  // P6.272 · `settings-reference.md#filecheckpointingenabled`, host-side.
  fileCheckpointingEnabled: z.unknown().optional(),
  // P6.390(2) · `settings-reference.md#automemorydirectory` and
  // `#plansdirectory`. Unknown-tolerant like every neighbour on this list:
  // `config/storage.ts` owns the strict parse for both (an absolute or
  // `~/`-prefixed path for the first, project-root-contained for the second)
  // and reports a bad value as a rejected layer rather than failing the load.
  autoMemoryDirectory: z.unknown().optional(),
  plansDirectory: z.unknown().optional(),
  // T5 (2026-08-12): the bypassPermissions responsibility acknowledgment
  // (permission-modes.md). DECLARED for the same reason every neighbour on
  // this list is: the envelope below is `.strict()`, and an undeclared
  // top-level key throws UnsupportedStorageLayoutError on load — costing the
  // user every OTHER setting in config.json, not just this one.
  bypassPermissionsAcknowledged: z.unknown().optional(),
  macosSeatbeltBashSandboxEnabled: z.unknown().optional(),
  mcpChannelPushEnabled: z.unknown().optional(),
  autoCompactEnabled: z.boolean().optional(),
  // Unknown-tolerant here so a bad value cannot brick startup; the strict
  // parser (parseAskUserQuestionTimeout) reads anything invalid as "never",
  // which is the safe direction — a question that waits, not one that
  // auto-answers. Enum-validated in StoredConfigSchema for validateConfig().
  askUserQuestionTimeout: z.unknown().optional(),
  sandbox: z.unknown().optional(),
  worktree: z.unknown().optional(),
  workflow: z.unknown().optional(),
  sessionMirror: z.unknown().optional(),
  // Source connection timing (T10, plugin-install plan § 9b):
  // `sources.connectOnStartup` (default true = Claude parity). Deep parsing
  // stays with config/source-startup-settings.ts, tolerant like its peers.
  sources: z.unknown().optional(),
  // Per-server on/off for the built-in dp set (A7). Unknown-tolerant here on
  // purpose: an unrecognised SERVER NAME inside the block must be ignored, not
  // reported, so a map written by a newer release cannot fail the load. Deep
  // parsing stays with config/builtin-dp-mcp-settings.ts.
  builtinDpMcpServers: z.unknown().optional(),
  // `skills.md:663`'s per-skill visibility map (R61). DECLARED because the
  // envelope below is `.strict()` and `storage.ts` throws
  // `UnsupportedStorageLayoutError` on any undeclared top-level key — a user who
  // copies the documented snippet would otherwise lose every setting in
  // config.json instead of hiding one skill. Unknown-tolerant for the same
  // reason `builtinDpMcpServers` is: an unrecognised STATE written by a newer
  // release must land the skill on the documented default (`"on"`), and deep
  // parsing stays with config/skill-overrides.ts.
  skillOverrides: z.unknown().optional(),
  // `settings-reference.md#disablebundledskills` — "Claude Code removes bundled
  // skills and workflows entirely, while built-in commands such as `/init` stay
  // typable but are hidden from the model." Its READER has always been
  // wired (`bundledSkillsDisabledBySetting` → `storage.ts`), but the key was
  // missing from this object while the envelope below is `.strict()` — so a
  // user who set the documented key did not merely get it ignored, their whole
  // `config.json` was REFUSED with `UnsupportedStorageLayoutError`. Declaring
  // it is what makes the shipped reader reachable at all. Unknown-tolerant like
  // its neighbours: the reader tests `=== true`, so a malformed value resolves
  // off instead of bricking startup.
  disableBundledSkills: z.unknown().optional(),
  // P6.384's two skill gates, declared for exactly the reason the neighbour
  // above records: the envelope is `.strict()`, so an undeclared key does not
  // get ignored — it REFUSES the whole `config.json` with
  // `UnsupportedStorageLayoutError`. `disableSkillShellExecution` is the
  // vendor's own key (it is in the vendored `sdk.d.ts` settings schema and the
  // shipped binary reads it from both tiers), so a user copying the documented
  // snippet must not lose every other setting they have; `disableSkills` is
  // ours, because the binary has no counterpart — see `config/skill-gates.ts`
  // for both measurements. Unknown-tolerant like their neighbours: both readers
  // test `=== true`, so a malformed value resolves OFF rather than bricking
  // startup, which is the safe direction for a restriction that is not set.
  disableSkillShellExecution: z.unknown().optional(),
  disableSkills: z.unknown().optional(),
  // P6.361's saved actions, declared for the third time for the same reason the
  // two comments above record — and this one was found by trying to READ the
  // store rather than by reasoning about it. `workspaceActions` is the ONLY
  // place an action can be declared, and until this line a user who declared one
  // did not get an ignored key: the `.strict()` envelope below REFUSED their
  // whole `config.json` with `UnsupportedStorageLayoutError`, so the feature was
  // unreachable by construction and cost every other setting they had. Deep
  // parsing stays with `config/workspace-actions.ts`, which refuses rather than
  // defaults; `getUserWorkspaceActions` catches that refusal and reports the
  // layer, exactly like `worktree` and `sandbox` beside it.
  workspaceActions: z.unknown().optional(),
  additionalDirectories: z.unknown().optional(),
  // C3.178 — WHICH of the attached folders above is primary, as a choice rather
  // than a derivation. Declared for the reason every neighbour on this list is:
  // the envelope below is `.strict()`, so a key our own setter writes but this
  // object does not declare throws `UnsupportedStorageLayoutError` and costs the
  // user every OTHER setting in config.json. Unknown-tolerant like its
  // neighbours: `resolveSessionPrimaryRoot` (`config/primary-directory.ts`)
  // refuses anything that is not an absolute path naming an already-attached
  // folder and falls back to the derivation, so a malformed value resolves to
  // today's behaviour rather than bricking startup — and, because the resolver
  // can only ever return a member of the set it was given, no value of this key
  // can widen what a session may read or write.
  primaryDirectory: z.unknown().optional(),
  // `claudeMdExcludes` and our own spelling of it. BOTH are declared because
  // both are read (`agent/memory/instruction-excludes.ts` merges the two
  // spellings, and `large-codebases.md:155` merges across scopes on top of
  // that). Unknown-tolerant here for the usual reason: a malformed entry must
  // not brick startup, and the matcher already ignores anything that is not a
  // usable string. Typed in StoredConfigSchema so validateConfig() reports it.
  instructionExcludes: z.unknown().optional(),
  claudeMdExcludes: z.unknown().optional(),
  // DECLARED, and PERMANENTLY REFUSED at every user-writable scope.
  //
  // `env-vars.md#in-settings-files` documents an `env` block in a settings file
  // — "Add variables under the `env` key in a `settings.json` file, creating the
  // file if it doesn't exist." — and the strict envelope below rejects the whole
  // FILE on an undeclared key
  // (`loadStoredConfig` throws `UnsupportedStorageLayoutError` on a failed
  // parse), so one documented-but-undeclared key costs the user every setting in
  // config.json. Declaring it is what removes that, and nothing else.
  //
  // **The park is CLOSED. Owner decision 2026-09-05 (sitting §1.2), option (A):
  // refuse user-scope `env` permanently and DISCLOSE the divergence from the
  // page** — rather than leave a schema key that reads as supported. Option (B),
  // a name allowlist, was declined: the standing 2026-08-12/13 decision that OS
  // isolation is off and not coming back forecloses the containment route, so an
  // allowlist would have been the ONLY containment against a threat model whose
  // worst item is `PATH`.
  //
  // So this is no longer "pending" and nobody is waiting for an answer. Do not
  // "finish" it by writing the block into `process.env`;
  // `packages/shared/src/config/__tests__/user-env-block-park.test.ts` is the
  // runnable pin that goes red if anyone does. The threat model, the disclosure
  // and the three-scope record live on `reportUnhonouredUserEnvBlock` in
  // `config/storage.ts`.
  env: z.unknown().optional(),
  extendedPromptCache: z.unknown().optional(),
  // P6.202 — the read-side working-directory fence. Declared for the reason
  // every neighbour on this list is: the envelope below is `.strict()`, so a
  // key our own reader names but this object does not declare throws
  // `UnsupportedStorageLayoutError` and costs the user every OTHER setting in
  // config.json. Unknown-tolerant: `getBlockReadsOutsideWorkingDirectories`
  // fires only on a literal `true`, so anything else leaves the fence down —
  // which is what the page calls the unset behaviour.
  blockReadsOutsideWorkingDirectories: z.unknown().optional(),
  // P6.370 — the user's control over the vendored SDK's `switchModelsOnFlag`,
  // which decides whether a flagged turn is silently re-run on a different
  // model. Declared for the reason every neighbour on this list is: the
  // envelope below is `.strict()`, so a key our own reader names but this
  // object does not declare throws `UnsupportedStorageLayoutError` and costs
  // the user every OTHER setting in config.json. Unknown-tolerant:
  // `getClaudeSwitchModelsOnFlag` reads anything that is not a boolean as
  // unset, which is the vendor's own default and today's behaviour.
  claudeSwitchModelsOnFlag: z.unknown().optional(),
  // P6.313 — the user's control over the runtime's own
  // `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS`, which decides whether Explore and
  // Plan are in a claude session's roster. Declared for the reason every
  // neighbour on this list is: the envelope below is `.strict()`, so a key our
  // own reader names but this object does not declare throws
  // `UnsupportedStorageLayoutError` and costs the user every OTHER setting in
  // config.json. Unknown-tolerant: `getClaudeExplorePlanAgentsEnabled` reads
  // anything that is not a boolean as unset, which is the vendor's own default
  // and today's behaviour.
  claudeExplorePlanAgentsEnabled: z.unknown().optional(),
  // P6.515 — the operator's system-prompt APPEND, the one additive channel
  // offered on all three runtimes. Declared for the reason every neighbour on
  // this list is: the envelope below is `.strict()`, so a key our own reader
  // names but this object does not declare throws
  // `UnsupportedStorageLayoutError` and costs the user every OTHER setting in
  // config.json. Unknown-tolerant: `getSystemPromptAppend` reads a non-string
  // as unset, which composes byte-identical prompt bytes to a build from before
  // the row.
  systemPromptAppend: z.unknown().optional(),
  // P6.912 — P6.217's session tool universe, moved here from
  // `config-defaults.json`'s `workspaceDefaults`, where it could not survive a
  // launch. Declared for the reason every neighbour on this list is: the
  // envelope below is `.strict()`, so a key our own reader names but this
  // object does not declare throws `UnsupportedStorageLayoutError` and costs
  // the user every OTHER setting in config.json. Unknown-tolerant:
  // `getSessionToolUniverse` reads a non-array as no restriction.
  sessionAllowedTools: z.unknown().optional(),
  sessionDisallowedTools: z.unknown().optional(),
  // P6.312 — the agent a session runs AS. Declared for the reason every
  // neighbour on this list is: the envelope below is `.strict()`, so a key our
  // own reader names but this object does not declare throws
  // `UnsupportedStorageLayoutError` and costs the user every OTHER setting in
  // config.json. Unknown-tolerant: `getSessionAgentName` reads a non-string as
  // unset, which spawns byte-identically to a build from before the row.
  sessionAgent: z.unknown().optional(),
  // P6.500 — the reopen compact-or-keep trigger. Declared for the reason every
  // neighbour on this list is: the envelope below is `.strict()`, so a key our
  // own reader names but this object does not declare throws
  // `UnsupportedStorageLayoutError` and costs the user every OTHER setting in
  // config.json. Unknown-tolerant: `getReopenCompactPromptTokens` reads a
  // non-number as the documented default, which is today's behaviour.
  reopenCompactPromptTokens: z.unknown().optional(),
  // P6.378 — `prompt-caching.md`'s two per-bucket TTL settings, step 3 of its
  // precedence chain. Declared for the same reason as `env` above: the envelope
  // below is strict, and a documented key the user writes but we never declared
  // throws `UnsupportedStorageLayoutError` and costs them every OTHER setting in
  // config.json. Unlike `env`, these two ARE read — by
  // `interceptor-common.ts`'s `resolvePromptCacheTtl`, which validates the value
  // itself (`5m` / `1h`, anything else ignored, exactly as the page says Claude
  // Code does) rather than widening this schema.
  promptCacheTtl: z.unknown().optional(),
  subagentPromptCacheTtl: z.unknown().optional(),
  // F1.1241 — a tolerated LEGACY key: the Extended context switch is gone and nothing reads it
  // (each model's own window decides), but config.json files written before keep it, and this
  // envelope is strict, so dropping the declaration would refuse every other setting with it.
  enable1MContext: z.unknown().optional(),
  rtkEnabled: z.unknown().optional(),
  // UB7.4 (DA1.72) — the rtk exclusion list: base commands never routed
  // through `rtk rewrite` (`getRtkExcludeCommands` reads it; a non-array reads
  // as the empty list). Declared because the envelope below is strict and an
  // undeclared key would refuse the whole config.json.
  rtkExcludeCommands: z.unknown().optional(),
  guardianEnabled: z.unknown().optional(),
  guardianJudgeModelId: z.unknown().optional(),
  guardianJudgeModels: z.unknown().optional(),
  // P3.2 — declared so a config.json written with codex auto-review settings
  // survives the strict envelope below; an undeclared key throws
  // UnsupportedStorageLayoutError and costs the user every setting in the file.
  codexAutoReviewEnabled: z.unknown().optional(),
  codexAutoReviewPolicy: z.unknown().optional(),
  // C3.109 — declared for the same reason: an undeclared key throws
  // UnsupportedStorageLayoutError and costs the user every setting in the file.
  codexSubagentsEnabled: z.unknown().optional(),
  // P2.1 — declared so a config.json written by setAdvisorEnabled() /
  // setAdvisorModelId() survives the strict envelope. Undeclared keys throw
  // UnsupportedStorageLayoutError and cost the user every setting in the file.
  advisorEnabled: z.unknown().optional(),
  advisorModel: z.unknown().optional(),
  useAutoModeDuringPlan: z.unknown().optional(),
  // `settings-reference.md#respondtobashcommands` — "**Default**: `true`", and
  // "Set this key to `false` to add the output to context without a reply, so
  // you can run several commands and ask about them together." Declared so a
  // config.json written by setRespondToBashCommands() survives the strict
  // envelope; getRespondToBashCommands() reads anything but `false` as ON.
  respondToBashCommands: z.unknown().optional(),
  // P6.564 — where a browser-pane download lands, and whether Electron asks.
  // P6.360 shipped the behaviour as two environment variables and said in its
  // own docblock why it stopped there: this envelope is `.strict()`, so an
  // undeclared top-level key throws `UnsupportedStorageLayoutError` and costs
  // the user every OTHER setting in config.json. Declaring it is what makes a
  // user-settable form possible at all. Unknown-tolerant like its neighbours:
  // `getBrowserDownloadSettings` re-checks the root is absolute and the switch
  // is a boolean, so a malformed value resolves to today's behaviour — the
  // session-scoped directory, no dialog — instead of bricking startup.
  browserDownload: z.unknown().optional(),
  networkProxy: z.unknown().optional(),
  gitBashPath: z.unknown().optional(),
  // P6.719 — the FOURTH occurrence of the class this envelope keeps producing,
  // and the first one found by a structure rather than by a user or a sweep:
  // `config/unattended-approval.ts` reads `unattendedApprovalFallback` out of
  // `loadStoredConfig()` (`codex-agent.ts` is the caller) and
  // `describeUnattendedApprovalRefusal()` NAMES it to the person who met the
  // refusal — "Set `unattendedApprovalFallback` to "allow" to approve uncovered
  // calls on unattended turns instead." Until this line, following our own
  // sentence threw `UnsupportedStorageLayoutError` and cost them every other
  // setting in config.json. Unknown-tolerant like its neighbours; the reader
  // resolves anything unrecognised to `deny`, which is the safe direction for a
  // restriction. `__tests__/stored-config-envelope-guard.test.ts` is what now
  // makes a fifth occurrence impossible to ship.
  unattendedApprovalFallback: z.unknown().optional(),
  setupDeferred: z.unknown().optional(),
  serverConfig: z.unknown().optional(),
} as const;

/**
 * Production load envelope: exact top-level setting names plus the new boolean
 * knob. Deeper setting parsers retain ownership of their existing contracts.
 */
export const StoredConfigTopLevelSchema = z.object(StoredConfigKnownFields).strict();

/** The basename, so `pruneCorruptedConfigCopies` matches on names rather than paths. */
export const CONFIG_FILE_NAME = 'config.json';
export const CONFIG_FILE = join(CONFIG_DIR, CONFIG_FILE_NAME);

/**
 * How many old copies of this one file are worth keeping — shared by the dated
 * `config.json.bak-<date>` backups in `storage.ts` and by the
 * `.corrupted.<timestamp>` copies below, because it is the same question with
 * the same answer.
 */
export const MAX_CONFIG_BACKUPS = 3;

/**
 * Thrown by loadStoredConfig() when config.json exists but is not a supported
 * v2 storage layout (unparseable, missing storageLayoutVersion === 2, or
 * missing the workspaces array). This is a fail-closed guard: before this
 * error existed, an unsupported config made loadStoredConfig() return null,
 * and callers such as ensureGlobalConfigExists() (packages/server-core) and
 * the first-run check in apps/electron's main process treat a falsy return as
 * "no config yet" and write a fresh, empty config in its place — destroying a
 * real legacy config.json. Throwing here makes those callers crash instead of
 * silently overwriting user data. Only a genuinely absent file still returns
 * null (fresh init remains allowed).
 */
export class UnsupportedStorageLayoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UnsupportedStorageLayoutError';
  }
}

/**
 * One `.corrupted.<timestamp>` copy of a refused `config.json` per process.
 *
 * A latch, not an optimisation. `loadStoredConfig` is called from many readers
 * — `getUserSandboxSettings`, `getUserWorktreeSettings`, the retention sweep,
 * every settings getter — and with a corrupt file each of them takes the same
 * refusal path, so without this a broken install would litter its own config
 * directory with one copy per read.
 */
let corruptedConfigCopyPath: string | undefined | null = null;

/**
 * Copy a refused `config.json` beside itself as `.corrupted.<timestamp>` and
 * return the path — P6.438(3).
 *
 * `settings.md#fix-a-broken-settings-file`, the third tier, verbatim: "Claude
 * Code copies the broken file to
 * `~/.claude/backups/.claude.json.corrupted.<timestamp>` and asks whether to
 * exit and fix it by hand or reset to the default configuration". `~/.claude.json`
 * is that product's app-state file; ours is `config.json`, which is why this
 * hangs off the storage-layout refusal rather than off a settings LAYER — the
 * page's other two tiers (Settings Error, Settings Warning) are about
 * `settings.json`, a different file with a different disposition.
 *
 * **A COPY, and only a copy.** The refusal's whole point is that it neither
 * loads nor overwrites the file (see {@link UnsupportedStorageLayoutError}); the
 * copy preserves the evidence for whoever repairs the install, without touching
 * the original. The half of the page's sentence deliberately NOT taken is the
 * choice it offers — exit and fix by hand, or reset to defaults — because that
 * is a product posture needing a user surface this product does not have yet.
 * Taking the copy now is what makes that later choice recoverable: a user who
 * hand-repairs the file first would otherwise have destroyed the only artefact
 * that says why it was refused.
 *
 * Best-effort in every direction: a failure is debug-logged and swallowed,
 * exactly as {@link backupConfigFile} treats its own. A diagnostic that could
 * block startup would be worse than the gap it closes. `wx` so a same-instant
 * sibling is never overwritten.
 */
function copyCorruptedConfigOnce(): string | undefined {
  if (corruptedConfigCopyPath !== null) return corruptedConfigCopyPath;
  corruptedConfigCopyPath = undefined;
  try {
    // Colons are illegal in a Windows filename and awkward everywhere else, so
    // the ISO stamp is flattened rather than used raw.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${CONFIG_FILE}.corrupted.${stamp}`;
    writeFileSync(target, readFileSync(CONFIG_FILE), { flag: 'wx' });
    corruptedConfigCopyPath = target;
    pruneCorruptedConfigCopies();
  } catch (error) {
    debug('[config] corrupted-config copy failed:', error instanceof Error ? error.message : error);
  }
  return corruptedConfigCopyPath;
}

/**
 * Keep only the newest {@link MAX_CONFIG_BACKUPS} `.corrupted.<timestamp>`
 * copies — P6.438(3), the half the latch could not cover.
 *
 * The latch above is per-PROCESS, which is the right scope for the defect it
 * was written for (every settings getter calls `loadStoredConfig`, so an
 * uncapped per-call copy would litter the directory during ONE launch). It says
 * nothing about the next launch: a user who leaves the file broken gets one
 * more copy every time the app starts, and a corrupt config is exactly the
 * state a user restarts into repeatedly. Unbounded growth in the config
 * directory is not evidence preservation, it is the same litter one restart
 * later.
 *
 * Three, and the same constant the dated backups use, because it is the same
 * question with the same answer — how many old copies of this one file are
 * worth keeping. The stamp is an ISO timestamp with its punctuation flattened,
 * so a lexical sort is chronological and the NEWEST (including the one just
 * written) survive.
 *
 * Best-effort in every direction, exactly as {@link backupConfigFile} treats its
 * own cleanup: a pruning failure must never turn a diagnostic into a crash.
 */
function pruneCorruptedConfigCopies(): void {
  try {
    const prefix = `${CONFIG_FILE_NAME}.corrupted.`;
    const copies = readdirSync(CONFIG_DIR).filter(name => name.startsWith(prefix)).sort();
    for (const stale of copies.slice(0, Math.max(0, copies.length - MAX_CONFIG_BACKUPS))) {
      try { rmSync(join(CONFIG_DIR, stale)); } catch { /* ignore individual cleanup errors */ }
    }
  } catch (error) {
    debug('[config] corrupted-config prune failed:', error instanceof Error ? error.message : error);
  }
}

/**
 * Reset the per-process latch. Tests only — a suite driving two corrupt files in
 * one process would otherwise see the second silently skipped and conclude the
 * copy does not happen.
 */
export function resetCorruptedConfigCopyLatchForTests(): void {
  corruptedConfigCopyPath = null;
}

/**
 * The two routes out of a refused `config.json`, named in the refusal itself —
 * P6.438(1), in the only form this product can honestly offer today.
 *
 * `settings.md#fix-a-broken-settings-file`, third tier, verbatim: Claude Code
 * "asks whether to exit and fix it by hand or reset to the default
 * configuration". We do the first half of that sentence — the process stops —
 * and we do NOT perform either repair, because resetting an app-state file
 * discards the user's workspaces and connections and is a product posture, not
 * plumbing (the offer itself is proposed as its own row).
 *
 * What was missing is smaller and is entirely ours: the user met a refusal that
 * never said what to do next. `apps/electron/src/main/boot-fatal.ts`
 * interpolates this message verbatim into the boot dialog's `detail`, beside a
 * single **Quit** button, so a sentence here is the difference between "Nessy
 * cannot start" and a repair the user can actually carry out. Both routes the
 * page names are stated; neither is taken on the user's behalf.
 *
 * English, like every other string reaching that dialog's `detail`: the dialog's
 * own chrome is localised in `boot-fatal.ts` and the typed error message beside
 * it has always been English. Translating half of one line would be worse than
 * either whole.
 */
const STORAGE_LAYOUT_REPAIR_ROUTES =
  'Nessy did not modify it: repair the file by hand, or move it aside to start from the default configuration.';

/**
 * Refuse the stored layout, naming the file, the preserved copy when one was
 * taken, and what the user can do about it.
 *
 * Everything is APPENDED to the caller's sentence rather than replacing it:
 * those sentences are what the callers and their tests match on, and each
 * addition is further information about the same refusal.
 *
 * The absolute path is named even though the boot dialog prints the config
 * directory separately — a user who set `NESSY_CONFIG_DIR` reads "config.json"
 * and looks in the wrong place, and the refusal travels to `boot.log`, a
 * terminal and a bug report, none of which carry that other field.
 */
function refuseStorageLayout(message: string, options?: { cause?: unknown }): never {
  const copy = copyCorruptedConfigOnce();
  throw new UnsupportedStorageLayoutError(
    [
      message,
      `The refused file is ${CONFIG_FILE}.`,
      copy === undefined ? undefined : `A copy of the refused file was kept at ${copy}.`,
      STORAGE_LAYOUT_REPAIR_ROUTES,
    ].filter((part): part is string => part !== undefined).join(' '),
    options,
  );
}

export function loadStoredConfig(): StoredConfig | null {
  if (!existsSync(CONFIG_FILE)) {
    return null;
  }

  let config: StoredConfig;
  try {
    config = readJsonFileSync<StoredConfig>(CONFIG_FILE);
  } catch (error) {
    // Narrow race: the file was removed between existsSync() and the read.
    // Treat that the same as "absent" — everything else (bad JSON) is a
    // genuine legacy/corrupt config and must fail closed.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    refuseStorageLayout(
      `config.json exists but is not valid JSON — refusing to load or overwrite it: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (config.storageLayoutVersion !== STORAGE_LAYOUT_VERSION) {
    refuseStorageLayout(
      `config.json has storageLayoutVersion ${JSON.stringify(config.storageLayoutVersion ?? null)}, but this build only supports v${STORAGE_LAYOUT_VERSION}. Refusing to load or overwrite a legacy config.`,
    );
  }

  if ('workspaces' in (config as unknown as Record<string, unknown>)) {
    refuseStorageLayout('config.json contains the retired workspaces registry. Refusing to load it.');
  }

  if (!Array.isArray(config.workspaceRefs)) {
    refuseStorageLayout(
      'config.json has storageLayoutVersion 2 but is missing a valid workspaceRefs array. Refusing to load or overwrite it.',
    );
  }
  const seenWorkspaceIds = new Set<string>();
  for (const ref of config.workspaceRefs) {
    if (
      !ref
      || Object.keys(ref).sort().join(',') !== 'id,lastAccessedAt'
      || typeof ref.id !== 'string'
      || !Number.isInteger(ref.lastAccessedAt)
      || ref.lastAccessedAt < 0
    ) {
      refuseStorageLayout('config.json has an invalid workspace ref. Refusing to load it.');
    }
    let workspaceId: string;
    try {
      workspaceId = assertStorageId('workspace', ref.id);
    } catch {
      refuseStorageLayout('config.json has an invalid workspace ref. Refusing to load it.');
    }
    if (seenWorkspaceIds.has(workspaceId)) {
      refuseStorageLayout('config.json has duplicate workspace refs. Refusing to load it.');
    }
    seenWorkspaceIds.add(workspaceId);
  }

  if (config.activeWorkspaceId !== null && !seenWorkspaceIds.has(config.activeWorkspaceId)) {
    refuseStorageLayout('config.json activeWorkspaceId is not registered. Refusing to load it.');
  }

  const topLevel = StoredConfigTopLevelSchema.safeParse(config);
  if (!topLevel.success) {
    refuseStorageLayout(
      `config.json has an unknown or invalid top-level setting. Refusing to load it: ${topLevel.error.issues[0]?.message ?? 'invalid setting'}`,
      { cause: topLevel.error },
    );
  }

  return config;
}

/**
 * DA1.72 — three lines over {@link loadStoredConfig}, and the ONLY thing
 * `config/proxy-env.ts` ever wanted from `storage.ts`.
 *
 * It lives here rather than there for exactly that reason: leaving it behind
 * would have left the import that this split exists to remove, and copying it
 * would have been the second spelling DA1.59 refused. `storage.ts` re-exports
 * it, so every existing caller is unchanged.
 */
export function getNetworkProxySettings(): NetworkProxySettings | undefined {
  const config = loadStoredConfig();
  return config?.networkProxy;
}
