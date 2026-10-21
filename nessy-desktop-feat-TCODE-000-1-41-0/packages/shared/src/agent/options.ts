import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { debug } from "../utils/debug";
import { applyLoopbackProxyExemption, getProxyEnvVars } from "../config/proxy-env.ts";
import { CLAUDE_INHERITED_SESSION_MARKER_ENV_KEYS, CLAUDE_LAUNCHER_ENV_KEYS, CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS, CLAUDE_SDK_STRIPPED_ENV_KEYS } from "../config/claude-provider-routing-env.ts";
import {
    CLAUDE_DEBUG_ENABLE_ENV,
    CLAUDE_DEBUG_LOG_LEVEL_ENV,
    CLAUDE_DEBUG_LOG_PATH_ENV,
    ensureSessionRuntimeDebugLog,
} from "./session-debug-log.ts";
import {
    MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR,
    resolveMaxSubagentSpawnDepth,
} from "../config/subagent-spawn-depth.ts";
import {
    declaredMaxConcurrentSubagents,
    MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV,
} from "../config/subagent-limits.ts";
import { getWorkspaceRootPath } from "../workspaces/paths.ts";
import { ensureSessionJobDir } from "../sessions/storage.ts";
import { getGitBashPath, getMemoryEnabled, loadConfigDefaults } from "../config/storage.ts";
import { TOOL_SEARCH_ENV_VAR, toolSearchMode, type ToolSearchMode } from "../config/tool-search-settings.ts";
import {
    resolveTelemetryIdentity,
    TELEMETRY_IDENTITY_ENV,
    telemetryOptedIn,
    tracingOptedIn,
} from "../telemetry/usage-metrics.ts";
import { PROMPT_CACHE_TTL_ENV, resolvePromptCacheTtl } from "../interceptor-common.ts";
import { isManagedOriginEnvVar } from "../config/managed-env.ts";
import { backgroundTasksDisabled } from "../config/background-task-settings.ts";
import {
    buildClaudeSessionMemoryEnv,
    resolveSessionMemoryScope,
    type SessionMemoryScopeOverride,
} from "./memory/session-memory-scope.ts";
import { officialMarketplaceAutoinstallOffEnv } from "./pi-harness/managed-marketplace-entries.ts";
import {
    SUBAGENT_MODEL_COMPAT_ENV_VAR,
    isSubagentModelOverrideForced,
    resolveSubagentModelOverride,
} from "../config/subagent-model.ts";

declare const NESSY_AGENT_CLI_VERSION: string | undefined;

let customPathToClaudeCodeExecutable: string | null = null;
let claudeConfigChecked = false;

/** Where a Workspace's redirected Claude config dir sits inside its own root. */
const CLAUDE_CONFIG_DIR_NAME = 'claude-config';

/**
 * P6.530 — the vendor's own name for the PowerShell tool switch, and the value
 * we pin it to. Exported so the switch report and its test read the same two
 * strings the child env is built from; the reason lives on
 * `applyPowerShellToolRefusal`.
 */
export const CLAUDE_POWERSHELL_TOOL_ENV_VAR = 'CLAUDE_CODE_USE_POWERSHELL_TOOL';
export const CLAUDE_POWERSHELL_TOOL_REFUSED_VALUE = '0';

/**
 * P6.348 — the Glob ignore knob, and the value that makes claude's Glob agree
 * with Pi's `find` and codex's file search. The reason, the three measurements
 * and why the operator's own value wins live on `applyGlobGitignoreDefault`.
 */
export const CLAUDE_GLOB_NO_IGNORE_ENV_VAR = 'CLAUDE_CODE_GLOB_NO_IGNORE';
export const CLAUDE_GLOB_NO_IGNORE_CONVERGED_VALUE = 'false';

/**
 * P6.539 — every `OTEL_LOG_*` name that turns conversation CONTENT into
 * telemetry, refused for the claude child.
 *
 * Membership rule, one question: *does this name make the exporter emit text the
 * user or the model wrote, rather than a count of it?* Derived from
 * `monitoring-usage.md`'s own environment table and checked against the shipped
 * binary rather than from prose — the enumeration in the row that ordered this
 * strip named FOUR, and the table has FIVE.
 *
 * **The fifth is not a harmless omission.** `monitoring-usage.md`, the
 * `OTEL_LOG_ASSISTANT_RESPONSES` row, verbatim: *"Enable logging of assistant
 * response text on `assistant_response` events (default: disabled). When unset,
 * falls back to the value of `OTEL_LOG_USER_PROMPTS`."* The fallback is why the
 * four-name list LOOKS complete — with `OTEL_LOG_USER_PROMPTS` stripped, an
 * unset `OTEL_LOG_ASSISTANT_RESPONSES` stays disabled — and why it is not: an
 * operator who exported `OTEL_LOG_ASSISTANT_RESPONSES=1` on its own would have
 * kept exporting every assistant turn through a strip that was reported as
 * total. Recorded rather than quietly widened.
 *
 * Bundle probe, re-measured 2026-09-12 on the vendored 2.1.247 (C3.252) with
 * BOTH instruments named, because they disagree on a minified artefact (C3.294)
 * — lines (`grep -acF`) / occurrences (`grep -aoF … | wc -l`):
 * `OTEL_LOG_USER_PROMPTS` 6/8, `OTEL_LOG_TOOL_DETAILS` 4/5,
 * `OTEL_LOG_TOOL_CONTENT` 4/5, `OTEL_LOG_ASSISTANT_RESPONSES` 4/5,
 * `OTEL_LOG_RAW_API_BODIES` 4/4; control `ZZQQNOTAREALNAME` 0/0. All five are
 * still live in the binary we ship. (The superseded reading — 11 / 8 / 8 / 8 / 6
 * at 2.1.233 on 2026-09-07, `grep -aoF` — is kept here as the predecessor, not
 * overwritten: the numbers moved and the membership did not.)
 *
 * `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` (3 in the same probe) is deliberately
 * NOT here: it bounds how much of a content attribute is emitted, so it is a
 * volume knob rather than a channel, and with all five channels closed it can
 * only describe content that is never produced.
 */
/**
 * P3.338 / P6.724 — the switch that opts this session back into the
 * task-tracking tools the shipped binary withholds by MODEL.
 *
 * `tools-reference.md#task-tool-availability`, verbatim (re-read 2026-10-01 for
 * 2.1.274, F1.1220): the five tools *"are available by default only on Claude 3.x
 * models, Opus 4 through 4.7, Sonnet 4 through 4.6, and Haiku 4.5"*, and *"On every
 * other model, Claude Code leaves the tools out unless you opt in."* An ALLOWLIST
 * of older models, then — no per-family threshold, and no remote gate (F1.1213).
 * Our `DEFAULT_MODEL` is outside it, so without this switch all five would be
 * withdrawn while Pi's own checklist keeps working: a switch cost nothing priced.
 *
 * ## The ROUTE, which is the whole of this row
 *
 * The page lists four routes and this is its first, verbatim: *"Export
 * `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` before you start Claude Code, for example
 * `CLAUDE_CODE_ENABLE_TODO_TOOLS=1 claude`. Claude Code then provides the same
 * tools on every model and every provider"*. The name is read by the binary we
 * ship: re-measured 2026-09-12 (C3.252) it scores 4 lines / 4 occurrences in
 * the vendored `claude` at `2.1.247`, against 0/0 for a nonsense control (it
 * read 3 at `2.1.233`, instrument unnamed), and `runtime-switch-costs.ts` records the site —
 * `CLAUDE_CODE_ENABLE_TODO_TOOLS === true` through `qe.bool()`.
 *
 * P3.338 first took the OTHER route, a four-name allow list, on the stated
 * reason that a launch option *"costs no environment variable and therefore no
 * deployment change"*. Measured afterwards (`4ed0f83a3`), that reason does not
 * separate the two: this function writes names into the child itself — it
 * already forces `CLAUDE_CODE_DISABLE_CRON=1` — so no operator exports anything
 * on either route, and both are one line here. What DOES separate them is a
 * price only the allow-list route pays, and the owner took the env route on
 * 2026-09-07 once it was measured:
 *
 *  - An allow list is also an AUTO-APPROVAL list (`sdk.d.ts`: *"List of tool
 *    names that are auto-allowed without prompting for permission."*), so
 *    opting in that way also pre-approved the four.
 *  - The SDK announces exactly that. `sdk.mjs` calls `eq(!!canUseTool,
 *    permissionMode ?? "default", allowedTools)`, whose predicate keeps every
 *    entry that `!r.includes("(")` — every BARE name — and emits
 *    `process.emitWarning(…, { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' })`
 *    reading *"canUseTool will not be invoked for: … Bare allowedTools entries
 *    auto-approve the whole tool before the callback is consulted."* P6.207
 *    subscribes a sink that turns that warning into a PER-SESSION degradation
 *    notice, so every claude session carried one, truthfully.
 *
 * The env variable opts in WITHOUT auto-approving: the four tools come back on
 * the surface and our PreToolUse gate still sees every call. Same opt-in, one
 * price less, and the per-session notice goes back to meaning what it says —
 * that a gate really has been bypassed.
 *
 * `TodoWrite` is not reached by this switch even though the sentence above
 * names it: its gate is the inverse of the other four's on the
 * `CLAUDE_CODE_ENABLE_TASKS` half, which nothing in this fork sets. The page
 * agrees: *"`TodoWrite` … Disabled by default in favor of `TaskCreate`,
 * `TaskGet`, `TaskList`, and `TaskUpdate`."*
 *
 * The price the owner accepted, unchanged by the route: the four tools' schemas
 * and reminders re-enter every claude turn, on models the vendor has decided do
 * better without them.
 */
export const CLAUDE_TODO_TOOLS_OPT_IN_ENV_VAR = 'CLAUDE_CODE_ENABLE_TODO_TOOLS';

/** The page's own spelling — see {@link CLAUDE_TODO_TOOLS_OPT_IN_ENV_VAR}. */
export const CLAUDE_TODO_TOOLS_OPT_IN_VALUE = '1';

/**
 * What the switch buys, named here because the env route names no tools and a
 * reader would otherwise have to reconstruct the set from the page.
 *
 * `TodoWrite` is absent for the reason given at the constant above; these four
 * are what the child's tool list gains on any model outside the allowlist.
 */
export const CLAUDE_TODO_TOOLS_OPT_IN_RESTORED_TOOLS = [
    'TaskCreate',
    'TaskGet',
    'TaskUpdate',
    'TaskList',
] as const;

export const CLAUDE_TELEMETRY_CONTENT_OPT_IN_ENV_KEYS = [
    'OTEL_LOG_USER_PROMPTS',
    'OTEL_LOG_ASSISTANT_RESPONSES',
    'OTEL_LOG_TOOL_DETAILS',
    'OTEL_LOG_TOOL_CONTENT',
    'OTEL_LOG_RAW_API_BODIES',
] as const;

// UTF-8 BOM character — Windows editors/processes sometimes prepend this to files.
// JSON parsers reject BOM, but the file content after BOM may be valid JSON.
const UTF8_BOM = '\uFEFF';

/**
 * Ensure ~/.claude.json exists and contains valid, BOM-free JSON before
 * the SDK subprocess starts.
 *
 * Background: The SDK's Claude Code executable reads this file on startup. If it's missing
 * (with a .backup file present), empty, BOM-prefixed, or contains invalid JSON,
 * the executable writes plain-text error/recovery messages to process.stdout.
 * The SDK transport expects only JSON on stdout, so any plain text causes:
 *   "CLI output was not valid JSON"
 *
 * Known causes of corruption (from claude-code GitHub issues):
 *   - UTF-8 BOM encoding on Windows (#14442) — editors/auth writes add BOM prefix
 *   - Empty file from crash during write (#2593) — CLI truncates before writing
 *   - Race condition with concurrent sessions (#18998) — no file locking
 *   - Missing file with stale .backup — CLI writes recovery instructions to stdout
 *
 * This runs once per process lifetime (not on every message), unless
 * resetClaudeConfigCheck() is called to force a re-check after error recovery.
 */
function ensureClaudeConfig(): void {
    if (claudeConfigChecked) return;
    claudeConfigChecked = true;

    const configPath = join(homedir(), '.claude.json');

    // Clean up stale .backup file — if present and .claude.json is missing,
    // the Claude Code executable writes "A backup file exists at..." to stdout, crashing the SDK.
    // We remove it so the executable sees a clean "missing file" state (which it handles silently).
    const backupPath = `${configPath}.backup`;
    if (existsSync(backupPath)) {
        try {
            unlinkSync(backupPath);
            debug('[options] Removed stale ~/.claude.json.backup');
        } catch (err) {
            debug(`[options] Failed to remove ~/.claude.json.backup: ${err}`);
        }
    }

    // Clean up .corrupted.* files — these accumulate on Windows and signal
    // to Claude Code that a previous corruption was detected, altering its stdout output.
    try {
        const homeDir = homedir();
        const files = readdirSync(homeDir);
        for (const file of files) {
            if (file.startsWith('.claude.json.corrupted.')) {
                try {
                    unlinkSync(join(homeDir, file));
                    debug(`[options] Removed stale ${file}`);
                } catch { /* best effort */ }
            }
        }
    } catch {
        // If we can't read homedir, we'll still try the main repair below
    }

    // If file doesn't exist, create it with minimal valid JSON.
    // The CLI handles truly missing files (no backup) silently, but creating
    // the file is safer — it prevents any future backup-related stdout pollution.
    if (!existsSync(configPath)) {
        debug('[options] ~/.claude.json missing, creating with {}');
        writeConfigSafe(configPath, '{}');
        return;
    }

    // File exists — read and validate
    try {
        const raw = readFileSync(configPath, 'utf-8');

        // Strip UTF-8 BOM if present (common on Windows — see claude-code#14442).
        // The BOM is valid UTF-8 but invalid as a JSON start character, so the CLI
        // rejects the file and writes an error to stdout.
        const content = raw.startsWith(UTF8_BOM) ? raw.slice(1) : raw;
        const hasBom = raw !== content;

        if (content.trim().length === 0) {
            // Empty file (or BOM-only) — write minimal valid JSON
            debug(`[options] ~/.claude.json is empty${hasBom ? ' (had BOM)' : ''}, resetting to {}`);
            writeConfigSafe(configPath, '{}');
            return;
        }

        // Try to parse the (BOM-stripped) content
        JSON.parse(content);

        if (hasBom) {
            // Valid JSON but had BOM prefix — rewrite without BOM to prevent
            // the CLI from rejecting it. Preserves all existing config data.
            debug('[options] ~/.claude.json had UTF-8 BOM, rewriting without BOM');
            writeConfigSafe(configPath, content);
        }
        // else: valid JSON, no BOM — nothing to do
    } catch {
        // File exists but contains invalid JSON — reset to minimal valid state.
        // This loses user's CLI config but prevents the subprocess crash.
        debug('[options] ~/.claude.json is corrupted, resetting to {}');
        writeConfigSafe(configPath, '{}');
    }
}

/**
 * Write content to a config file with retry logic for Windows.
 * On Windows, files can be temporarily locked by antivirus scanners,
 * Windows Search indexer, or other processes — retry once after a brief delay.
 */
function writeConfigSafe(configPath: string, content: string): void {
    try {
        writeFileSync(configPath, content, 'utf-8');
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        // EBUSY = file in use, EPERM = permission denied (often transient on Windows)
        if (process.platform === 'win32' && (code === 'EBUSY' || code === 'EPERM')) {
            debug(`[options] Write failed with ${code}, retrying after 100ms...`);
            // Synchronous sleep — acceptable here since this runs once at startup
            const start = Date.now();
            while (Date.now() - start < 100) { /* busy wait */ }
            try {
                writeFileSync(configPath, content, 'utf-8');
                debug('[options] Retry succeeded');
            } catch (retryErr) {
                debug(`[options] Retry also failed: ${retryErr}`);
            }
        } else {
            debug(`[options] Failed to write ~/.claude.json: ${err}`);
        }
    }
}

/**
 * Reset the once-per-process guard so ensureClaudeConfig() runs again.
 * Called from the error handler when a config corruption crash is detected
 * at runtime — allows auto-repair before retrying the session.
 */
export function resetClaudeConfigCheck(): void {
    claudeConfigChecked = false;
}

/**
 * Override the path to the Claude Code executable.
 *
 * Since SDK 0.2.113 this is the **native** `claude` binary shipped via the
 * platform-specific optional dependency (`@anthropic-ai/claude-agent-sdk-{platform}-{arch}`),
 * not a JS file. Override is only needed when the SDK can't auto-discover the
 * binary — typically packaged Electron builds where module resolution from
 * `sdk.mjs` doesn't find the per-platform package.
 */
export function setPathToClaudeCodeExecutable(path: string) {
    customPathToClaudeCodeExecutable = path;
}

/**
 * Read the currently-configured custom path (set via setPathToClaudeCodeExecutable).
 *
 * Returns `undefined` (not `null`) so callers can pass it directly into SDK option
 * fields typed `string | undefined`. The CLI/dev-runtime path that doesn't go
 * through the custom setter is captured at SDK options-build time in claude-agent.ts.
 */
export function getPathToClaudeCodeExecutable(): string | undefined {
    return customPathToClaudeCodeExecutable ?? undefined;
}

/**
 * The Claude config directory for one Workspace, or `undefined` when there is no
 * Workspace to scope to.
 *
 * `env-vars.md:356` — `CLAUDE_CONFIG_DIR` overrides "the configuration directory
 * (default: `~/.claude`). All settings, session history, and plugins are stored
 * under this path, as are credentials on Linux and Windows; on macOS, credentials
 * are in the system Keychain."
 *
 * Without this, every Workspace's agent subprocess shares one `~/.claude`. The
 * same shape the plugin runtime already uses (`plugins/data-paths.ts` points
 * `CLAUDE_CONFIG_DIR` at the per-Workspace managed data path), applied one level
 * up: the agent subprocess is the last runtime we spawn that still had a global
 * config directory.
 *
 * TWO HAZARDS `:356` NAMES, BOTH CHECKED AND CLEAR:
 *
 * - Credentials. Irrelevant here, because our Claude auth never uses the SDK's
 *   credential store: `ClaudeAgent.postInit` resolves the connection and injects
 *   `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` into the environment. A
 *   redirected config dir therefore cannot cost a Workspace its login.
 * - Settings. This one is a real change, and deliberate rather than incidental:
 *   `settingSources` includes `'user'`, which resolves under `CLAUDE_CONFIG_DIR`,
 *   so a hand-written `~/.claude/settings.json` stops reaching the subprocess. It
 *   is the change the isolation is FOR — a user-scope Claude settings file is a
 *   cross-Workspace policy channel, and a `permissions` entry written there would
 *   apply to every project at once. Nothing in this repo writes that scope: every
 *   `addClaudePermissionRules` caller passes `localSettings` or `projectSettings`,
 *   both of which are project-scoped and unaffected. Reversing the decision is one
 *   constant.
 *
 * `.claude.json` MOVES with it (F1.789, read in the 2.1.274 bundle: `join(CLAUDE_CONFIG_DIR
 * || homedir(), ".claude.json")`), so `~/.claude.json`'s project trust never reaches the
 * child; the host writes the trusted project's entry there (`project-trust-entry.ts`).
 *
 * An invalid Workspace ID THROWS through `getWorkspaceRootPath`'s
 * `assertStorageId` rather than falling back to the shared directory. A silent
 * fallback would put two Workspaces back in one config dir precisely when the
 * identity is untrustworthy, which is the wrong way to fail.
 */
export function workspaceClaudeConfigDir(workspaceId?: string): string | undefined {
    const configDir = workspaceClaudeConfigDirPath(workspaceId);
    if (configDir === undefined) return undefined;
    mkdirSync(configDir, { recursive: true });
    return configDir;
}

/**
 * D1.334 — the SAME path, DERIVED and not created.
 *
 * {@link workspaceClaudeConfigDir} creates the directory it names, and that is
 * its contract: a variable pointing at a directory the child would then fail to
 * write is worse than no variable. But a READ-ONLY reader needs the same answer
 * without the side effect — the settings-provenance view is read-only by
 * construction (owner decision D12, 2026-09-05: *"this handler stats and parses,
 * and writes nothing"*), and `withRuntimeNotices` in the same handler file
 * already short-circuits above the creating call for exactly this reason.
 *
 * So the derivation lives here once and both spellings use it, rather than a
 * reader re-joining `getWorkspaceRootPath` with a directory name it would have
 * to keep in step by hand. Same throw on an invalid Workspace ID, for the same
 * reason the creating sibling gives.
 */
export function workspaceClaudeConfigDirPath(workspaceId?: string): string | undefined {
    if (!workspaceId) return undefined;
    return join(getWorkspaceRootPath(workspaceId), CLAUDE_CONFIG_DIR_NAME);
}

/**
 * P6.535 (claude arm) — the per-session scratch directory the SDK already knows
 * how to use, created and named.
 *
 * NATIVE-FIRST, tier 1: pure configuration. `CLAUDE_JOB_DIR` is in the vendored
 * SDK's own env-var registry (one hit in `bridge.mjs`, one in `sdk.mjs`) and
 * scores ZERO files across `packages` + `apps`, against a control of 35 for
 * `CLAUDE_CONFIG_DIR` — the runtime reads the name and we never wrote it.
 * `agent-view.md#where-state-is-stored`, verbatim: *"Each background session has
 * the `CLAUDE_JOB_DIR` environment variable set to its `~/.claude/jobs/<id>`
 * directory, so shell commands the session runs can write temporary files to
 * `$CLAUDE_JOB_DIR/tmp` without colliding with parallel sessions."*
 *
 * Owner D3 = B: one host-owned job directory per session, outside the workspace,
 * torn down with the session — so it hangs off `getSessionDirPath` rather than
 * `~/.claude/jobs`, and `SessionManager` removes it when the session's agent
 * goes away.
 *
 * THE `tmp/` SUBDIRECTORY IS CREATED HERE, WITH THE VARIABLE, and the two must
 * never be separated: the page's whole promise is that a shell command can write
 * to `$CLAUDE_JOB_DIR/tmp`, and a variable naming a path that does not exist
 * turns that into a failing command with a confusing message. Same shape as
 * `workspaceClaudeConfigDir` above, for the same reason.
 *
 * Derived from the MERGED env rather than at the `envOverrides` call sites,
 * again for the reason that function gives: the defect a second copy reproduces
 * is a forgotten call site. A session whose id never reaches the child — the
 * remote-transfer summary agent is the one such site today — gets no variable
 * and no directory, which is correct: it has no session directory of its own to
 * scratch in.
 *
 * PI AND CODEX NOW HAVE IT TOO, and this paragraph used to say they did not.
 * Their arms landed once `ensureSessionJobDir` existed and once the no-prompt
 * property had moved to the APPROVAL CARD (`6bfd8b318`), which is host-side and
 * therefore already covered all three: `buildPiSubprocessEnv` and
 * `codex-agent.ts`'s spawn env each write `SESSION_JOB_DIR_ENV_VAR`.
 *
 * The residual difference is the MECHANISM, not the behaviour: claude's own
 * runtime reads `CLAUDE_JOB_DIR`, so its arm is native-first tier 1 (pure
 * configuration), while Pi and codex read no name of their own and get a
 * HOST-supplied equivalent — tier 2. Recorded here, and deliberately NOT as a
 * switch-cost row: `runtime-switch-costs.ts`'s own admission rule is *"only a
 * difference a real user would hit and be surprised by"*, and after both arms
 * the directory exists, the writes do not prompt and the environment names it
 * on all three. Whether either runtime's own prompt TELLS the model the
 * directory exists is a separate question and is not measured here.
 */
function claudeSessionJobDir(env: NodeJS.ProcessEnv): string | undefined {
    // The create-then-name pair moved to `ensureSessionJobDir` when the Pi and
    // codex arms landed: three copies of a `mkdir` is three chances to forget
    // it, which is exactly what this row forbids.
    return ensureSessionJobDir(env.NESSY_WORKSPACE_ID, env.NESSY_SESSION_ID);
}

/**
 * Get default SDK options for spawning the Claude Code subprocess.
 *
 * @param envOverrides - Per-session environment variable overrides.
 *   These are spread AFTER process.env so they take precedence.
 *   Used to pass per-session config like ANTHROPIC_BASE_URL — the ONLY source
 *   of that name in the child (F1.966, {@link dropAmbientAnthropicBaseUrl}).
 */
export function buildClaudeSubprocessEnv(
    envOverrides?: Record<string, string>,
    /**
     * P6.390 — this chat's memory override, when it set one. Omitted, every chat
     * follows the app-wide switch, which is what this function did before the
     * per-chat control existed.
     */
    sessionMemoryScopeOverride?: SessionMemoryScopeOverride,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...getProxyEnvVars(),
        ...envOverrides,
        // Propagate debug mode from argv flag OR existing env var
        NESSY_DEBUG: (process.argv.includes('--debug') || process.env.NESSY_DEBUG === '1') ? '1' : '0',
    };
    dropAmbientAnthropicBaseUrl(env, envOverrides); // F1.966 — first: steps below read the name

    // Resolved from the MERGED env rather than from `envOverrides`, so the
    // decision follows whatever workspace identity the subprocess will actually
    // see, and assigned AFTER the overrides so it is authoritative: an ambient
    // `CLAUDE_CONFIG_DIR` in the host's shell must not put two Workspaces back in
    // one directory. Derived here rather than at the two `envOverrides` call sites
    // in `SessionManager` for the reason `credential-deny-roots.ts` gives: the
    // defect a second copy reproduces is a forgotten call site.
    const workspaceConfigDir = workspaceClaudeConfigDir(env.NESSY_WORKSPACE_ID);
    if (workspaceConfigDir) env.CLAUDE_CONFIG_DIR = workspaceConfigDir;
    // C4.23 — the user whose own `CLAUDE_CONFIG_DIR` this overwrites is TOLD so,
    // by `reportOverriddenClaudeConfigDir` in `config/storage.ts`, on the same
    // rejected-layers surface the user-scope `env` refusal uses. The owner kept
    // the overwrite authoritative (2026-09-11) and removed the silence instead:
    // the capability the vendor's spelling names is reachable here through
    // `NESSY_CONFIG_DIR`, which the diagnostic names. Back-pointer rather than a
    // restated claim — if this assignment ever stops being unconditional, that
    // reporter is the other half to change with it.

    // P6.535 — the per-session scratch directory, created before it is named, and assigned after the
    // overrides for the reason `CLAUDE_CONFIG_DIR` is: an ambient value must not put two sessions in one
    // scratch directory (the page's own collision). F1.918: none of ours means NONE — an inherited name is a
    // foreign folder, and the gate's `$CLAUDE_JOB_DIR` answer (`claudeJobDirInShell`) rests on this pair.
    const jobDir = claudeSessionJobDir(env);
    if (jobDir) env.CLAUDE_JOB_DIR = jobDir; else delete env.CLAUDE_JOB_DIR;

    // T3 — suppress the SDK's OWN scheduler in the child.
    //
    // `scheduled-tasks.md:208`: "Set `CLAUDE_CODE_DISABLE_CRON=1` in your
    // environment to disable the scheduler entirely. The cron tools and `/loop`
    // become unavailable, and any already-scheduled tasks stop firing." All
    // three effects are wanted here and none of them touches ours: the host
    // owns the store, the tick and the between-turns delivery gate, and the
    // four tools reach it as `mcp__session__Cron*` from an in-process MCP
    // server this variable has no bearing on. Without it a claude-runtime
    // session would carry TWO schedulers — the child's, writing its own state
    // where nothing of ours reads it, and ours — and a user's `/loop` would land
    // on whichever the model happened to pick.
    //
    // Written here rather than at the spawn sites for the reason the `CLAUDE_CONFIG_DIR`
    // block above gives: every Claude spawn path (the gateway adapter's `envOverrides`,
    // the subscription path, the plugin-env variant) reaches the child through this one
    // function, and the defect a second copy reproduces is a forgotten call site.
    //
    // Assigned AFTER the overrides, so it is authoritative. Deliberately not
    // "unless the operator set it": the only value that keeps the two
    // schedulers from colliding is `1`, and an ambient `0` in the host's shell
    // must not re-arm the child's.
    //
    // Blast radius, accepted and documented rather than papered over: OUR
    // `isCronDisabled()` accepts `CLAUDE_CODE_DISABLE_CRON` as a compat alias
    // and falls back to it whenever `NESSY_DISABLE_CRON` is unset, and this env
    // is the child's, inherited by every
    // process the model launches through `Bash` — so Nessy tooling started
    // INSIDE a claude session (a nested CLI, a headless server) reads the flag
    // as its own and loses ITS cron tools too. Behaviour is unchanged here; a
    // narrower split — suppress the child's scheduler without handing the flag
    // down the process tree — would be its own row.
    env.CLAUDE_CODE_DISABLE_CRON = '1';

    // P6.178 — our own primary telemetry spelling reaches the child.
    //
    // Native-first, and the answer is "configure, do not build": the shipped
    // SDK carries the whole OTLP exporter and it works once configured
    // (P2.423) — it simply does not know our name. Binary probe of the
    // vendored `claude`, re-measured 2026-09-12 at 0.3.247 /
    // `claudeCodeVersion 2.1.247` (C3.252) with both instruments named because
    // they disagree on a minified artefact (C3.294):
    // `CLAUDE_CODE_ENABLE_TELEMETRY` -> 8 lines / 12 occurrences,
    // `NESSY_ENABLE_TELEMETRY` -> 0/0, control `ZZQQNOTAREALNAME` -> 0/0. (It
    // read 10 / 0 / 0 at 2.1.233 by `strings -n 6 | grep -a`, a THIRD
    // instrument again — which is the whole of C3.294.) So the
    // host maps its own name onto the vendor's, and this is the one site every
    // claude spawn passes through — the same reason the two blocks above give
    // for living here rather than at the call sites.
    //
    // BOTH DIRECTIONS, and neither is a new rule: `telemetryOptedIn` already
    // documents the precedence ("the Nessy name wins when both are set"), so
    // `NESSY_ENABLE_TELEMETRY=1` alone turns the child's exporter on and
    // `NESSY_ENABLE_TELEMETRY=0` beside an ambient
    // `CLAUDE_CODE_ENABLE_TELEMETRY=1` turns it off. The two truthiness lists
    // are byte-identical — ours is `1/true/yes/on` and the SDK's own `tr()`
    // reads `["1","true","yes","on"]` (quoted at `claude-agent.ts`'s
    // `isClaudeTelemetryEnabled`) — so no value the SDK would have accepted is
    // dropped by routing it through ours.
    //
    // Assigned AFTER the overrides so it is authoritative, like the two blocks
    // above: an ambient value in the host's shell must not outrank the
    // operator's Nessy setting, in either direction.
    //
    // P6.483 — and the opt-OUT vocabulary is decided now, by owner ruling
    // (2026-09-05, Q13, option 3). The sitting question this comment used to
    // record is answered: `DO_NOT_TRACK=1` DOES silence a claude child.
    //
    // A HARD DISABLE over the opt-in, which is exactly what Pi and codex already
    // do with the same names (`otlp-telemetry.ts:341`, `codex-agent.ts:1451`,
    // both `if (telemetryOptedOut(env)) return`), so one opt-out means one thing
    // on all three runtimes instead of two.
    if (claudeVendorNeutralTelemetryOptOut()) delete env.CLAUDE_CODE_ENABLE_TELEMETRY;
    else if (telemetryOptedIn(env)) env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
    else delete env.CLAUDE_CODE_ENABLE_TELEMETRY;

    // No cloud provider may be routed through the Claude SDK path. Deliberately
    // NOT re-listing the provider names here: this comment used to name five of
    // them (Bedrock/Vertex/Foundry/Anthropic-AWS/Mantle) and the SDK ships
    // SEVEN toggles — the enumeration read as a complete inventory and hid the
    // two missing names for a month. The constant is the single source of truth
    // and carries the measured membership rule; extend it, never this site.
    //
    // authentication.md puts the documented CLAUDE_CODE_USE_* toggles at the
    // TOP precedence tier, above any key we write — and two of the seven are
    // documented nowhere at all, so the constant's guard reads the shipped SDK
    // rather than a page. Generic AWS_* stays untouched so user shell/tooling
    // behavior inside the subprocess remains intact.
    // P3.113 — the same list now also carries
    // `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, which is NOT a provider
    // toggle: it makes the child treat our loopback adapter as
    // `api.anthropic.com`, turning on Anthropic error reporting, first-party
    // request-correlation headers and capability assumptions the gateway
    // cannot honour. The constant's own header carries the measurement.
    for (const key of CLAUDE_SDK_STRIPPED_ENV_KEYS) {
        delete env[key];
    }

    // P3.300 — the corporate-launcher names, dropped ALOUD rather than
    // silently. The binary honours them for its own Bash and stdio MCP; Pi and
    // codex have no counterpart and our own spawn sites consult neither, so
    // passing them through would apply an administrator's launcher policy on
    // one runtime of three with nothing saying so. The constant's header
    // carries the measurement and names P6.9 as the seam that retires this.
    for (const key of CLAUDE_LAUNCHER_ENV_KEYS) {
        if (env[key] === undefined) continue;
        debug(
            `[options] P3.300 — dropped ${key} from the Claude child environment. `
            + 'The Claude binary would honour it and Pi and codex cannot, so honouring it '
            + 'here would be a launcher policy that applies on one runtime of three. '
            + 'A launcher seam for all three is tracked as P6.9.',
        );
        delete env[key];
    }
    dropInheritedClaudeSessionMarkers(env); // F1.825 — a foreign session's markers stay in the host env only

    // P3.310 — the one hardening switch we HONOUR and announce, rather than
    // scrub. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is a master switch, re-measured
    // 2026-09-12 at 6 lines / 11 occurrences in the 2.1.247 binary — the
    // superseded reading was "21 consumers" at 2.1.233 with no instrument
    // stated (C3.252/C3.294) — read through a latch (`qL()` as it minified at
    // 2.1.233, which latches the parsed value
    // for the life of the process): it strips Anthropic and cloud-provider
    // credentials from the child's OWN subprocess environments, forces
    // `permissionMode` to `default` — discarding the CLI mode, an agent's
    // frontmatter mode and `dangerouslySkipPermissions` alike — pins the
    // filesystem policy to `strict`, makes the Bash command parser bail
    // conservatively, and arms per-script call caps.
    //
    // It goes in NEITHER list above, deliberately, and the reason is the one
    // `docs/architecture/runtime-capability-gaps.md` already records against
    // this exact name: it only ever NARROWS, Pi is stricter still in the half
    // that overlaps (its Bash children run under a 29-name allowlist), and
    // scrubbing it would delete a working control an administrator chose. The
    // divergence that is real is the SILENCE: Pi and codex have no counterpart,
    // so on claude alone the mode our picker shows can be unenforced. The
    // binary says so itself on stderr ("Permission mode forced to default …"),
    // and today that line reaches only `debug()` and a failure-only ring
    // buffer — P3.267's shape, and the binding is `claude-agent.ts`'s to make.
    const subprocessEnvScrub = env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
    if (['1', 'true', 'yes', 'on'].includes(String(subprocessEnvScrub ?? '').toLowerCase().trim())) {
        debug(
            '[options] P3.310 — CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set, so the Claude '
            + 'child will force permissionMode to default, pin its filesystem policy to '
            + 'strict, and strip Anthropic and cloud-provider credentials from the '
            + 'subprocesses it spawns. Honoured deliberately: it only narrows. Pi and '
            + 'codex have no counterpart, so the permission mode this session displays '
            + 'may not be the one the claude child enforces.',
        );
    }

    // P2.251 — the loopback exemption, applied to the MERGED env and last,
    // because both halves of the problem are only visible here.
    //
    // The projection above (`getProxyEnvVars`) carries the in-app Settings proxy;
    // the `...process.env` spread carries whatever the host inherited, which on
    // macOS packaged builds is the user's whole login shell. Either half alone is
    // enough to route this child through a proxy, and on a `claude-runtime`
    // session `envOverrides` has just set `ANTHROPIC_BASE_URL` to
    // `http://127.0.0.1:<port>` — the per-session gateway adapter. Measured
    // against the real native binary behind a sink proxy, the turn FAILS in that
    // state and the adapter receives nothing; see the helper's docblock for the
    // four arms, including the one proving non-loopback traffic stays proxied.
    //
    // Last, so it sees the final NO_PROXY: an `envOverrides` entry would
    // otherwise be extended by a rule that had already run.
    applyLoopbackProxyExemption(env);

    applyInteractiveRetryCeiling(env);
    applySubagentSpawnDepth(env);
    applyConcurrentSubagentCeiling(env);
    applySubagentModelOverride(env);
    applyAutoMemoryOffSwitch(env, sessionMemoryScopeOverride);
    applyToolSearchOffSwitch(env);
    applyTodoToolsOptIn(env);
    applyPromptCacheTtl(env);
    applyPromptCachingOffSwitchNotice(env);
    applySessionDiagnosticLog(env);
    applyOfficialMarketplaceAutoinstallOff(env);
    applyTelemetryExporterSelectorGuard(env);
    applyManagedOtlpDestinationLock(env);
    // After both, deliberately: the guard above can DELETE a traces selector
    // whose only value was `console`, and a session with no trace stream must
    // not have propagation turned on for it.
    applyTraceparentPropagation(env);
    applyTelemetryIdentityPin(env);
    applyBuiltinRipgrepSwitch(env);
    applyPowerShellToolRefusal(env);
    applyGlobGitignoreDefault(env);
    applyTelemetryContentOptInRefusal(env);
    applyEnvProxyGate(env);
    applyBackgroundTaskOffSwitch(env);

    // UB4.5 — Windows: point the SDK's Bash tool at the user-configured Git Bash if
    // set. The SDK otherwise falls back to a hardcoded Program Files search that misses
    // per-user installs (e.g. AppData\Local\Programs\Git) → "No bash shell found"
    // (craft-agents-oss#935; ported from upstream v0.15.1 `options.ts`, Apache-2.0).
    // Only fill when unset so a live-validated value (the `gitbash.CHECK` RPC's probe,
    // which writes `process.env` directly) wins. This lives HERE rather than at the CHECK
    // handler because the headless server never runs that RPC unless a renderer asks: a
    // headless Windows host would otherwise spawn every Claude subprocess without the
    // path even when the operator configured it.
    if (process.platform === "win32" && !env.CLAUDE_CODE_GIT_BASH_PATH) {
        const gitBash = getGitBashPath()?.trim();
        if (gitBash) env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
    }

    return env;
}

/**
 * P6.359 (the env half) — our own spelling of the search-backend switch reaches
 * the child.
 *
 * `troubleshooting.md#search-and-discovery-issues`, verbatim: *"Then set
 * `USE_BUILTIN_RIPGREP` to `0`, either in your shell environment or in the `env`
 * block of your `settings.json`"*, and the check that confirms it: *"run `claude
 * doctor` in your terminal and check that the Search line shows the path of your
 * system ripgrep instead of `OK (bundled)`."*
 *
 * The page's FIRST route is the shell environment, which is the one the host
 * owns — so this is a mapping, not a mechanism, and it is the same shape P6.178
 * uses two blocks above for telemetry: the host maps its own name onto the
 * vendor's at the one site every claude spawn passes through.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO:
 *  - It does not touch an ambient `USE_BUILTIN_RIPGREP` the operator set
 *    themselves. That value already reaches the child through the `process.env`
 *    spread and is the page's own documented route; overwriting it with our
 *    absence would take a working control away.
 *  - It does not change which ripgrep the HOST's own search service runs.
 *    `backend/internal/runtime-resolver.ts` carries a deliberate posture —
 *    "Packaged apps must use vendored binary only — never resolve from PATH to
 *    avoid picking up an incompatible system install" — and this row does not
 *    overturn it. The two are different binaries, and the doctor entry W6-i
 *    landed is what makes the host's choice observable.
 *
 * The value is passed through VERBATIM. The page names `0` and the child owns
 * the parsing; re-deriving truthiness here would be a second implementation of
 * a rule we do not own.
 */
function applyBuiltinRipgrepSwitch(env: NodeJS.ProcessEnv): void {
    const ours = env.NESSY_USE_BUILTIN_RIPGREP?.trim();
    if (!ours) return;
    delete env.USE_BUILTIN_RIPGREP;
    env.USE_BUILTIN_RIPGREP = ours;
}

/** The three signals the OTLP variables are spelled per-signal for. */
const OTLP_SIGNALS = ['TRACES', 'METRICS', 'LOGS'] as const;

/**
 * P6.452 M21 — a `console` exporter would write OTLP onto the stream we parse
 * as protocol.
 *
 * `monitoring-usage.md#common-configuration-variables` documents `console` as a
 * value of all three selectors, and
 * `#how-managed-settings-lock-the-otlp-destination` says the selectors "follow
 * normal per-key precedence. A developer's setting can still disable a signal or
 * switch it to the console exporter". On a terminal that is a debugging
 * affordance; here the child is spawned headless and its stdout IS the transport
 * the SDK reads, so an ambient `OTEL_LOGS_EXPORTER=console` in the operator's
 * shell would interleave exporter output with protocol frames.
 *
 * **WHERE THE DOCUMENTATION RUNS OUT, and what was decided.** No page describes
 * a headless child's stdout being the transport, because upstream's `console`
 * exporter goes to a terminal. The corruption is therefore PREDICTED from the
 * two facts above and not observed, so the smallest honest thing is done: the
 * one value that can collide is dropped, every other value — `otlp`,
 * `prometheus`, `none`, empty — passes through untouched, and the drop is
 * announced. `none` in particular is left alone: it is our own
 * `otelExporterDisabled`'s only recognised spelling and an operator's way to
 * turn a signal off.
 *
 * **All THREE selectors, where the row named two.** `OTEL_TRACES_EXPORTER` takes
 * the same `console` value from the same table and writes to the same stdout;
 * covering two of three would have left the row's own reason unserved in a third
 * of cases and no comment able to explain why.
 *
 * The diagnostic names the VARIABLE and never the value, like the launcher-drop
 * notice above it.
 */
function applyTelemetryExporterSelectorGuard(env: NodeJS.ProcessEnv): void {
    for (const signal of OTLP_SIGNALS) {
        const name = `OTEL_${signal}_EXPORTER`;
        const raw = env[name];
        if (!raw) continue;
        const parts = raw.split(',');
        const kept = parts.map(value => value.trim()).filter(value => value.toLowerCase() !== 'console');
        if (kept.length === parts.length) continue;
        delete env[name];
        if (kept.length > 0) env[name] = kept.join(',');
        debug(
            `[options] P6.452 M21 — dropped the \`console\` exporter from ${name} for the Claude child. `
            + 'The child is spawned headless and its stdout is the transport the SDK reads, so a console '
            + 'exporter would interleave telemetry with protocol frames. Every other value, `none` '
            + 'included, is passed through unchanged.',
        );
    }
}

/**
 * P6.538 — the claude child's identity attributes are the HOST's answer, not the
 * vendor's default.
 *
 * ## The hole this closes, and it was ours
 *
 * `monitoring-usage.md#standard-attributes` gives both switches defaulting to
 * TRUE: `session.id` under *"`OTEL_METRICS_INCLUDE_SESSION_ID` (default: true)"*
 * and `user.account_uuid` / `user.account_id` under
 * *"`OTEL_METRICS_INCLUDE_ACCOUNT_UUID` (default: true)"*. This function's own
 * file spreads `process.env` unfiltered, so on any machine where an operator had
 * turned telemetry on, the claude child exported all three BY DEFAULT — while
 * `telemetry/usage-metrics.ts`'s header said *"no per-user or per-session
 * identifier leaves the operator's machine"*. That sentence was true of our two
 * exporters and false of the child sitting beside them, which is the silent
 * divergence the native-first rule exists to prevent.
 *
 * ## Written EXPLICITLY, always, in both directions
 *
 * Not "deleted when off": written as `true` or `false` on every child, which is
 * the same shape `codex-responses-adapter/src/config-writer.ts` uses for
 * `log_user_prompt` and for the same reason — an upstream default flip must not
 * be able to start shipping identity with nothing failing anywhere. Owner
 * decision 2026-09-05 D13 = option B: identity behind the documented toggles,
 * DEFAULT OFF, using the vendor's own switch names.
 *
 * The resolution is {@link resolveTelemetryIdentity}, shared with both host
 * exporters, so an operator who turns identity on gets the same answer from Pi,
 * from claude and from the host's own metrics stream rather than three.
 *
 * ## What this cannot reach
 *
 * `user.id` is *"Always included"* and has no switch; the page describes it as a
 * *"Random anonymous identifier generated on first run"* that *"contains no
 * personal information and is not derived from your Claude account"*.
 * `organization.id`, `user.email` and `terminal.type` are *"Always included when
 * available"* and are populated only on an authenticated first-party session,
 * which this fork's gateway sessions are not. Named here because a reader
 * checking whether identity is fully off deserves the residue rather than the
 * headline.
 */
function applyTelemetryIdentityPin(env: NodeJS.ProcessEnv): void {
    const identity = resolveTelemetryIdentity(env);
    const pin = (name: string, value: boolean): void => {
        // `delete` before assign, per the measured Bun slot trap.
        delete env[name];
        env[name] = value ? 'true' : 'false';
    };
    pin(TELEMETRY_IDENTITY_ENV.sessionId, identity.sessionId);
    pin(TELEMETRY_IDENTITY_ENV.accountUuid, identity.accountUuid);
    if (!identity.sessionId && !identity.accountUuid) return;
    debug(
        '[options] P6.538 — the Claude child will export identity attributes: '
        + `session.id=${identity.sessionId}, user.account_uuid/user.account_id=${identity.accountUuid}. `
        + 'Both are off unless the documented switch is set; this host writes them explicitly in both '
        + 'directions so an upstream default flip cannot start shipping identity silently.',
    );
}

/**
 * P6.459 M30 — the claude child propagates W3C trace context, but only because
 * the host names the SECOND switch.
 *
 * ## Why this line exists and is not the operator's job
 *
 * The mechanism is complete in the shipped binary and this fork broke it by
 * accident. The propagation predicate is
 * `Z9t(){return Mf()||V.CLAUDE_CODE_PROPAGATE_TRACEPARENT}`, where `Mf()` is
 * `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` — a name this fork STRIPS from
 * every claude child for entirely unrelated reasons (it turns on Anthropic
 * error reporting, first-party request correlation and capability assumptions
 * the gateway cannot honour; see `CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS`). So
 * the documented auto-propagation arm is permanently false here, and an
 * operator who did everything the page tells them to would still get no
 * `traceparent` on the agent's shell commands — with nothing to read that says
 * why. The second name is the one that still works, and knowing to set it
 * requires reading the binary.
 *
 * Native-first case (1): the runtime already does the propagating. All this
 * does is name the switch. Binary probe of the vendored `claude`, re-measured
 * 2026-09-12 at `claudeCodeVersion 2.1.247` (C3.252) as lines/occurrences
 * because the two instruments disagree on a minified artefact (C3.294):
 * `CLAUDE_CODE_PROPAGATE_TRACEPARENT` **4/4**, `traceparent` **13/18**,
 * `OTEL_TRACES_EXPORTER` **9/12**, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`
 * **5/5**, control `zzznonsensecontrolzzz` **0/0**. (At 2.1.233 the same four
 * read 4 / 21 / 16 / 5 with no instrument stated.)
 *
 * ## Only when traces are actually being collected, and never over an operator
 *
 * {@link tracingOptedIn} is narrower than the telemetry opt-in on purpose: a
 * trace id pushed into every shell command of a session nobody is tracing is an
 * identifier leaving this process for no collector to read, which is the same
 * privacy question `usage-metrics.ts`'s header answers for session ids. And an
 * operator who set the name themselves — to `0`, or to anything else — is left
 * alone: this fills a hole, it does not overrule a decision.
 */
function applyTraceparentPropagation(env: NodeJS.ProcessEnv): void {
    if (env.CLAUDE_CODE_PROPAGATE_TRACEPARENT !== undefined) return;
    if (!tracingOptedIn(env)) return;
    // `delete` before assign, per the measured Bun slot trap: a name assigned
    // without it can read back by property while being INVISIBLE to the spread
    // that builds the child's environment.
    delete env.CLAUDE_CODE_PROPAGATE_TRACEPARENT;
    env.CLAUDE_CODE_PROPAGATE_TRACEPARENT = '1';
    debug(
        '[options] P6.459 M30 — set CLAUDE_CODE_PROPAGATE_TRACEPARENT for the Claude child, because '
        + 'OTEL_TRACES_EXPORTER selects a trace exporter and the documented auto-propagation arm '
        + '(_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL) is stripped from this child for unrelated reasons. '
        + 'An operator who sets the name themselves is not overruled.',
    );
}

/**
 * P6.452 M38 — an administrator's OTLP destination cannot be half-overridden by
 * a developer's leftover environment.
 *
 * `monitoring-usage.md#how-managed-settings-lock-the-otlp-destination`, the three
 * rules verbatim:
 *
 *  - *"**Endpoints**: when you set `OTEL_EXPORTER_OTLP_ENDPOINT`, Claude Code
 *    removes every developer-set per-signal endpoint."*
 *  - *"**Protocols**: when you set `OTEL_EXPORTER_OTLP_PROTOCOL`, Claude Code
 *    removes every developer-set per-signal protocol."*
 *  - *"**Credentials**: when you set `OTEL_EXPORTER_OTLP_HEADERS`,
 *    `OTEL_EXPORTER_OTLP_CLIENT_KEY`, or
 *    `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE`, Claude Code removes the
 *    developer-set per-signal versions of that variable, plus every
 *    developer-set endpoint variable, generic or per-signal, since those
 *    credentials would otherwise reach a collector the managed settings didn't
 *    choose."*
 *
 * And the exception in the same section: *"Claude Code doesn't remove per-signal
 * variables that you set in managed settings itself … If you set a per-signal
 * credential there, Claude Code removes the developer-set endpoint for that
 * signal."*
 *
 * "Developer-set" is decided by {@link isManagedOriginEnvVar}, which is the
 * host's own record of which names this process took from a managed source —
 * not a guess from the value. That is what makes the managed-settings exception
 * implementable at all: without provenance the two populations are
 * indistinguishable and the rule would delete the administrator's own per-signal
 * routing.
 *
 * The adjacent half — the composition that decides which source WINS a telemetry
 * variable — is `config/managed-env.ts`'s telemetry unit. This function does not
 * re-decide it; it only enforces the removals that follow from the winner.
 *
 * Nothing here reads or logs a VALUE: the variables in question carry
 * credentials.
 */
function applyManagedOtlpDestinationLock(env: NodeJS.ProcessEnv): void {
    const perSignal = (suffix: string): string[] =>
        OTLP_SIGNALS.map(signal => `OTEL_EXPORTER_OTLP_${signal}_${suffix}`);
    const removals = new Set<string>();

    const developerSet = (name: string): boolean =>
        env[name] !== undefined && !isManagedOriginEnvVar(name);

    if (isManagedOriginEnvVar('OTEL_EXPORTER_OTLP_ENDPOINT')) {
        for (const name of perSignal('ENDPOINT')) if (developerSet(name)) removals.add(name);
    }
    if (isManagedOriginEnvVar('OTEL_EXPORTER_OTLP_PROTOCOL')) {
        for (const name of perSignal('PROTOCOL')) if (developerSet(name)) removals.add(name);
    }
    for (const credential of ['HEADERS', 'CLIENT_KEY', 'CLIENT_CERTIFICATE']) {
        if (!isManagedOriginEnvVar(`OTEL_EXPORTER_OTLP_${credential}`)) continue;
        for (const name of perSignal(credential)) if (developerSet(name)) removals.add(name);
        // "plus every developer-set endpoint variable, generic or per-signal" —
        // the generic one included, which is the clause a per-signal-only reading
        // misses and the one that actually lets a credential reach an
        // unapproved collector.
        for (const name of ['OTEL_EXPORTER_OTLP_ENDPOINT', ...perSignal('ENDPOINT')]) {
            if (developerSet(name)) removals.add(name);
        }
    }
    // The per-signal exception: a MANAGED per-signal credential removes the
    // developer-set endpoint for THAT signal only.
    for (const signal of OTLP_SIGNALS) {
        for (const credential of ['HEADERS', 'CLIENT_KEY', 'CLIENT_CERTIFICATE']) {
            if (!isManagedOriginEnvVar(`OTEL_EXPORTER_OTLP_${signal}_${credential}`)) continue;
            const endpoint = `OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`;
            if (developerSet(endpoint)) removals.add(endpoint);
        }
    }

    for (const name of [...removals].sort()) {
        delete env[name];
        debug(
            `[options] P6.452 M38 — removed the developer-set ${name} from the Claude child. `
            + 'Managed settings own this OTLP destination, and a developer-set endpoint or '
            + 'credential beside it would send an administrator\'s credentials to a collector '
            + 'the managed settings did not choose.',
        );
    }
}

/**
 * P6.378 — the two documented per-bucket prompt-cache TTL controls, forwarded
 * to the child.
 *
 * `prompt-caching.md#choose-the-ttl-yourself` gives one precedence chain and two
 * independent buckets; the host resolves it in `interceptor-common.ts` and this
 * is where the answer reaches the claude child.
 *
 * **LIVE since P7.1 (2026-09-10), and this paragraph used to say "inert today,
 * deliberately".** The page says both controls *"require Claude Code v2.1.242 or
 * later"*; the vendored bundle declared `2.1.233` and now declares `2.1.247`, and
 * both names score 6 occurrences each in the native binary against
 * `nessyNotARealSdkKey` -> 0 (0 apiece at `0.3.233`). Nothing here changed — the
 * forwarding was written against the documented spelling and simply started
 * being honoured, which is what native-first looks like when it works.
 *
 * **The tripwire's question, answered (P7.15).** It asked whether this or the
 * wire rewrite should stand down rather than becoming a second implementation of
 * one contract. Measured: on the claude arm there is no second implementation to
 * stand down. `unified-network-interceptor.ts` is preloaded into the **Pi**
 * subprocess with Bun `--preload`, and the SDK's native binary accepts no such
 * flag — `runtime-resolver.ts` states it verbatim: *"Not used for Claude anymore
 * — the new native SDK binary doesn't accept `--preload`"*. So the rewrite has
 * never reached a claude request, this line is the whole claude path, and Pi
 * keeps the rewrite because Pi has no env control of its own. The host goes on
 * RESOLVING for all three, which is rule 2 — one answer, one seam.
 *
 * The SUBAGENT bucket has no other channel at all — no Anthropic request carries
 * a bucket marker, because the page assumes the RUNTIME decides — so this is the
 * only way it will ever be reachable.
 *
 * `delete` before assigning, per the Bun 1.3.14 env-slot trap: introducing a
 * name that was absent at launch leaves it invisible to the spread that builds
 * the child's environment, and the parent still reads the value, so the bug
 * presents as machine-dependent.
 */
function applyPromptCacheTtl(env: NodeJS.ProcessEnv): void {
    for (const bucket of ['conversation', 'subagent'] as const) {
        const name = PROMPT_CACHE_TTL_ENV[bucket];
        const ttl = resolvePromptCacheTtl(bucket);
        delete env[name];
        // `undefined` is step 6 of the chain — "the default for the request's
        // bucket" — which means LEAVE THE RUNTIME'S OWN CHOICE ALONE. Writing a
        // value here would turn an absence into a decision.
        if (ttl) env[name] = ttl;
    }
}

/**
 * P6.385 — the child must not auto-install the official Anthropic marketplace.
 *
 * `data-usage.md#default-behaviors-by-api-provider` states in one sentence both
 * that this needs its own opt-out and that the non-essential-traffic switch we
 * already set does not cover it: *"This variable doesn't affect the WebFetch
 * check or official plugin marketplace auto-install; each has its own opt-out …
 * and `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` for the
 * marketplace."*
 *
 * Why it matters HERE rather than as a preference: the child runs with a
 * per-workspace `CLAUDE_CONFIG_DIR` (see the block at the top of
 * `buildClaudeSubprocessEnv`), so an auto-install lands in a tree the host's
 * plugin policy never reads — outside `strictKnownMarketplaces`, outside
 * `blockedMarketplaces`, and outside every allowlist
 * `pi-harness/managed-marketplace-entries.ts` enforces.
 *
 * NOT conditional on the operator's own value, and that is the same judgement
 * the `CLAUDE_CODE_DISABLE_CRON` block above makes: the only value that keeps
 * the child's plugin surface inside our policy is the opt-out, so an ambient `0`
 * in the host's shell must not re-arm it.
 *
 * The name, the value and the measurement live with the marketplace policy, and
 * the spelling is pinned against the shipped binary by
 * `pi-harness/__tests__/official-marketplace-autoinstall.test.ts`.
 */
function applyOfficialMarketplaceAutoinstallOff(env: NodeJS.ProcessEnv): void {
    for (const [name, value] of Object.entries(officialMarketplaceAutoinstallOffEnv())) {
        delete env[name];
        env[name] = value;
    }
}

/**
 * C3.160 — the six prompt-caching OFF switches are HONOURED, and said aloud.
 *
 * The decision, its measurement and the page's own sentences live with the
 * constant ({@link CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS}); this is the seam that
 * makes it legible. Nothing is written and nothing is deleted: the names reach
 * the child through the `...process.env` spread at the top of
 * `buildClaudeSubprocessEnv`, exactly as the page expects, whether the operator
 * exported them in a shell or an administrator put them in the `env` block of
 * managed settings.
 *
 * It is the P3.300 launcher block with the sign FLIPPED — that one drops an
 * administrator's value and names what it dropped; this one keeps the value and
 * names where it binds. The reason is the same in both directions: a control
 * that takes effect on one runtime of three with nothing saying so is the silent
 * divergence this fork is closing, and an adopted native mechanism with no
 * switch verdict is a new one rather than a closed gap.
 *
 * BY NAME, NEVER BY VALUE, and that is not decoration: the page says *"set one
 * of these environment variables to `1`"* and this fork does not own the
 * truthiness rule the binary applies to them. Re-deriving it here would be a
 * second implementation of a rule we do not own, and the two would drift — the
 * judgement `applyBuiltinRipgrepSwitch` already makes one screen down. So the
 * line reports PRESENCE and lets the child decide what the value means.
 */
/**
 * C3.215 — the claude child's per-session diagnostic file, at a path this
 * product owns and can point a user at.
 *
 * Native-first tier 1 and nothing more: the binary already writes the file,
 * chooses its own level and rotates it. Two of its own variables are enough, and
 * the module that owns them carries the page's sentences, the binary's
 * `logPath()`/`debugFromLaunch` chains, and the two decisions behind this call
 * ({@link ensureSessionRuntimeDebugLog}'s module header) — in one line: the
 * enable switch is `DEBUG_SDK` and never the ecosystem-wide `DEBUG`, and the log
 * exists only while the host is in debug mode, because a plaintext per-session
 * runtime log is a posture rather than a free win.
 *
 * An operator who set the vendor's own path keeps it: this writes the override
 * only when they wrote none, and says which file the session will use either
 * way. The LEVEL is never written — `CLAUDE_CODE_DEBUG_LOG_LEVEL` is theirs, the
 * binary defaults it to `debug`, and re-deriving that rule here would be a
 * second implementation of something this fork does not own.
 *
 * `delete` before assigning, per the Bun 1.3.14 env-slot trap: introducing a
 * name absent at launch otherwise leaves it invisible to the spread that builds
 * the child's environment.
 *
 * **C3.302 then C3.336 — the `debug()` below is the developer's half of a pair,
 * and the user's half now exists on BOTH runtimes.** Pi's C3.274 block calls
 * `BaseAgent.noteSessionNoticeOnce` with `chat.runtimeDiagnostic.path`; the
 * claude arm reads the same fact back off the environment this function just
 * wrote, through {@link claudeSessionDiagnosticPath}, because this is a module
 * function with no agent instance in scope and giving it one would mean a return
 * value threaded through `buildClaudeSubprocessEnv` and `getDefaultOptions` for
 * one string. The locale key is runtime-neutral and takes the path as a value,
 * so the second arm is one call and not a second sentence.
 */
function applySessionDiagnosticLog(env: NodeJS.ProcessEnv): void {
    // The host's own debug switch, resolved at the top of this function from
    // `--debug` or `NESSY_DEBUG`; `'0'` is the ordinary session and gets no file.
    if (env.NESSY_DEBUG !== '1') return;
    const operatorPath = env[CLAUDE_DEBUG_LOG_PATH_ENV]?.trim();
    const hostPath = operatorPath ? undefined : ensureSessionRuntimeDebugLog('claude', env.NESSY_SESSION_ID);
    if (!operatorPath && !hostPath) return;
    delete env[CLAUDE_DEBUG_ENABLE_ENV];
    env[CLAUDE_DEBUG_ENABLE_ENV] = '1';
    if (hostPath) {
        delete env[CLAUDE_DEBUG_LOG_PATH_ENV];
        env[CLAUDE_DEBUG_LOG_PATH_ENV] = hostPath;
    }
    debug(
        `[options] C3.215 — this claude session writes its runtime diagnostic to `
        + `${operatorPath ?? hostPath}`
        + `${operatorPath ? ' (the operator\'s own CLAUDE_CODE_DEBUG_LOGS_DIR, left alone)' : ''}`
        + `, at level ${env[CLAUDE_DEBUG_LOG_LEVEL_ENV]?.trim() || 'debug (the binary\'s default)'}. `
        + 'Written only because the host is in debug mode; Pi takes the same host-owned directory '
        + 'and codex has no per-session debug file of its own.',
    );
}

/**
 * C3.336 — which diagnostic file THIS claude session writes, for the one caller
 * that has to say it out loud.
 *
 * A READ-BACK of {@link applySessionDiagnosticLog}'s own post-state, not a
 * second decision: that function is the only writer of both names on this path,
 * and every arm it can take is represented here. It returns early when the host
 * is not in debug mode (so `NESSY_DEBUG` stays `'0'` and this answers nothing);
 * it returns early when neither an operator path nor a host path exists (so the
 * path name stays empty); and in every arm that does write, it sets the enable
 * switch to `'1'` and leaves the path name holding exactly the file the binary
 * will use — the operator's own when they set one, ours otherwise. Pinned by a
 * test that drives the REAL `buildClaudeSubprocessEnv` in both arms, so the two
 * cannot drift apart without something going red.
 *
 * ONE case is deliberately silent: an operator who sets `DEBUG_SDK` and the path
 * themselves while the host is NOT in debug mode really does get a diagnostic
 * file, and this says nothing about it. That is the safe direction — the copy
 * opens with *"Debug mode is on"*, meaning the HOST's mode, and a notice that
 * said it about someone else's arrangement would be false in its first clause.
 */
export function claudeSessionDiagnosticPath(env: NodeJS.ProcessEnv): string | undefined {
    if (env.NESSY_DEBUG !== '1') return undefined;
    if (env[CLAUDE_DEBUG_ENABLE_ENV] !== '1') return undefined;
    const path = env[CLAUDE_DEBUG_LOG_PATH_ENV]?.trim();
    return path ? path : undefined;
}

function applyPromptCachingOffSwitchNotice(env: NodeJS.ProcessEnv): void {
    const present = CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS.filter(name => env[name] !== undefined);
    if (present.length === 0) return;
    debug(
        `[options] C3.160 — ${present.join(', ')} reached the Claude child and the binary reads `
        + 'it: prompt caching is off for the models that name covers, on THIS runtime only. '
        + 'Pi has no such control and codex speaks Responses and sends no cache_control, so a '
        + 'session switched to either keeps caching on. Honoured deliberately rather than '
        + 'stripped (prompt-caching.md#disable-prompt-caching is the operator\'s documented '
        + 'route, managed settings\' `env` block included); see CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS.',
    );
}

/**
 * P6.539 — an ambient shell variable may not make a session export its whole
 * conversation. Owner decision 2026-09-05 (D14), option A.
 *
 * **This removes a working vendor capability, deliberately.** The claude binary
 * implements every channel in
 * {@link CLAUDE_TELEMETRY_CONTENT_OPT_IN_ENV_KEYS}, they worked, and until this
 * block they reached the child unfiltered because `buildClaudeSubprocessEnv`
 * spreads `process.env` wholesale. So a login-shell `OTEL_LOG_RAW_API_BODIES=1`
 * — *"Bodies include the entire conversation history"*, `monitoring-usage.md` —
 * exported every turn of every claude session off the operator's machine, with
 * no host decision anywhere authorising it and nothing in this product saying it
 * was happening. Option B (honour them on all three behind ONE host setting) was
 * refused; the status quo is the one thing neither option kept.
 *
 * NATIVE-FIRST, and the answer is a refusal rather than a build. The other two
 * runtimes are already the other way: codex is pinned off unconditionally —
 * `log_user_prompt = false` is written into every `[otel]` table by
 * `codex-responses-adapter/src/config-writer.ts` and is not configurable — and
 * Pi and the host implement none of these channels at all, which their own two
 * docblocks record (`server-core/src/pi-harness/otlp-telemetry.ts`,
 * `shared/src/telemetry/usage-metrics.ts`). claude was the only runtime of three
 * where an inherited variable could widen a counts-only export into a content
 * export, so this makes the three agree rather than making claude special.
 *
 * The refusal is itself a switch verdict and is stated as one: a reader who
 * expects Claude's documented content channels to work inside Nessy does not get
 * them, on purpose, and if content export is ever wanted it arrives as option B's
 * explicit host setting and NEVER as an inherited variable.
 *
 * BY NAME, NOT BY VALUE, and that matters for one of the five:
 * `OTEL_LOG_RAW_API_BODIES` accepts *"`1` for inline bodies … or `file:<dir>` for
 * untruncated bodies on disk"*, so a truthiness test would miss the mode that
 * writes the whole conversation to a directory. The `delete` is unconditional
 * and reads no value.
 *
 * ANNOUNCED, the P3.300 pattern: dropping an administrator's deliberate setting
 * silently is the same one-runtime divergence with the sign flipped, so each
 * dropped name gets its own line naming what it would have exported.
 */
function applyTelemetryContentOptInRefusal(env: NodeJS.ProcessEnv): void {
    for (const key of CLAUDE_TELEMETRY_CONTENT_OPT_IN_ENV_KEYS) {
        if (env[key] === undefined) continue;
        debug(
            `[options] P6.539 — dropped ${key} from the Claude child environment. `
            + 'It is a content opt-in: it turns conversation text into telemetry, which no host '
            + 'decision in this product authorises. codex is pinned off unconditionally and Pi '
            + 'implements no such channel, so honouring it here would export content on one '
            + 'runtime of three on an inherited variable. Owner decision 2026-09-05 D14.',
        );
        delete env[key];
    }
}

/**
 * P6.348 (the Glob half of J36) — claude's Glob is the ONLY file search of the
 * three that ignores `.gitignore`, and it is the only one with a knob.
 *
 * The row was written the other way round ("make Glob skip gitignored files on
 * Pi as it already does on claude") and BOTH halves of that are inverted.
 * Measured at HEAD, 2026-09-07:
 *
 * - **claude does NOT skip them.** `env-vars.md`, the
 *   `CLAUDE_CODE_GLOB_NO_IGNORE` row, verbatim: *"Set to `false` to make the
 *   Glob tool respect `.gitignore` patterns. By default, Glob returns all
 *   matching files including gitignored ones."* `tools-reference.md#glob-tool-behavior`
 *   says the same and adds that Glob is the odd one out **within claude itself**:
 *   *"This differs from Grep, which skips gitignored files."*
 * - **Pi already skips them, unconditionally.** Its `find` tool
 *   (`@earendil-works/pi-coding-agent/dist/core/tools/find.js`) describes itself
 *   as *"Find files by glob pattern (respects .gitignore)"* and runs `fd` with
 *   `--no-require-git` precisely so the rules apply outside a repo too. There is
 *   NO knob: `FIND_PARAMETERS` in `pi-agent-server`'s
 *   `local-tools/runtime-backed-tools.ts` exposes `pattern`, `path`, `limit` and
 *   nothing else, so the "flag on the existing walk" the row imagined does not
 *   exist and cannot be added from this side.
 * - **codex skips them too**, and this closes a null the row recorded as "not
 *   read to a conclusion". Read from the source, which for codex outranks the
 *   page — `codex-rs/file-search/src/lib.rs` at `rust-v0.150.1` carries
 *   `pub respect_gitignore: bool` whose `Default` is `true`.
 *
 * So the divergence is real but points the other way, and the native-first
 * answer is one line rather than a mechanism: two runtimes agree by default and
 * cannot be configured, the third disagrees by default and CAN be, so we
 * configure the third. Nothing is built beside anything.
 *
 * THE OPERATOR'S OWN VALUE WINS, unlike the cron/marketplace/PowerShell blocks
 * above, and the difference is deliberate: those three pin a floor that keeps
 * the child inside a policy, so an ambient value must not re-arm them. This one
 * is a default that decides what the model can SEE, with no safety edge — a
 * developer who exports `CLAUDE_CODE_GLOB_NO_IGNORE=true` to search a build
 * directory is making a legitimate choice, and overriding it would replace a
 * documented knob with a hidden one.
 *
 * NOT the same key as `respectGitignore`, and the page says so in the same row:
 * *"Does not affect `@` file autocomplete, which has its own `respectGitignore`
 * setting"*.
 *
 * ## P6.349 (J37), measured here 2026-09-07: that key needs NOTHING built, and
 * the row's premise does not hold.
 *
 * `settings-reference.md#respectgitignore` governs one surface — *"Control
 * whether the `@` file picker leaves out files that match `.gitignore`
 * patterns."* — and its **Default is `true`**, which the vendored `sdk.d.ts`
 * repeats on the key itself (*"Whether file picker should respect .gitignore
 * files (default: true). Note: .ignore files are always respected."*). So the
 * claude arm is already what the row wanted, natively, with no host code.
 *
 * The row then asks for the same behaviour "identically on all three", and that
 * comparison has no subject: `SessionManager.fuzzyFileSearch` returns files only
 * when the agent implements `fuzzyFileSearch`, and **only `codex-agent.ts` does**
 * — Pi and claude sessions get `files: []` and an `@` menu populated from MCP
 * resources alone. codex's own implementation respects `.gitignore` by default
 * anyway (`respect_gitignore: true`, same source file as above). So every file
 * search that exists already honours the key's intent, and the divergence that
 * is REAL is a different and larger one: two of three runtimes have no `@` file
 * picker at all. That is reported as its own row rather than solved here.
 */
/**
 * P6.724 — write the todo-tools opt-in into the child, and never over an answer
 * someone else already gave.
 *
 * See {@link CLAUDE_TODO_TOOLS_OPT_IN_ENV_VAR} for the route. The guard is the point: an
 * operator who exported `0` turned these tools OFF deliberately — and since 2.1.274 that
 * removes them on "every other model" (the page) outside the allowlist, our default included, not
 * only on the families a threshold once named (F1.1220). A default that overwrote it would
 * take a working control away — the treatment `applyBuiltinRipgrepSwitch` gives the
 * ambient value it maps onto, and the shape `applyGlobGitignoreDefault` uses for its own.
 *
 * ONE read is enough here, and that is measured rather than assumed. `env` is
 * `{...process.env, ...getProxyEnvVars(), ...envOverrides}`, so it already
 * carries the operator's export and the caller's explicit choice. The Bun
 * spread trap — a name readable by property and invisible to `{...process.env}`
 * — needs the name to be one Bun pre-creates a slot for, and this one is not:
 * the slots enumerate as `TZ`, `NODE_TLS_REJECT_UNAUTHORIZED`,
 * `BUN_CONFIG_VERBOSE_FETCH` and the six proxy names (measured 2026-09-07 on
 * Bun 1.3.14), and a control assigning `CLAUDE_CODE_ENABLE_TODO_TOOLS` then
 * spreading reads it back. A second `process.env` read would be a guard that
 * can never fire, which is worse than none — it implies a hazard here that the
 * measurement says is elsewhere.
 */
function applyTodoToolsOptIn(env: NodeJS.ProcessEnv): void {
    if (env[CLAUDE_TODO_TOOLS_OPT_IN_ENV_VAR] !== undefined) return;
    env[CLAUDE_TODO_TOOLS_OPT_IN_ENV_VAR] = CLAUDE_TODO_TOOLS_OPT_IN_VALUE;
}

function applyGlobGitignoreDefault(env: NodeJS.ProcessEnv): void {
    if (env[CLAUDE_GLOB_NO_IGNORE_ENV_VAR] !== undefined) return;
    env[CLAUDE_GLOB_NO_IGNORE_ENV_VAR] = CLAUDE_GLOB_NO_IGNORE_CONVERGED_VALUE;
}

/**
 * P6.530 — the name that switches on a SECOND executor inside our permission
 * floor, refused here by name.
 *
 * `tools-reference.md#enable-the-powershell-tool`, verbatim: *"Set
 * `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` in your environment or in
 * `settings.json`"*, and the platform row above it,
 * `tools-reference.md#powershell-tool`: *"**Windows with Git Bash installed**:
 * the tool is on by default for claude.ai and Console accounts; set
 * `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` to enable it in Amazon Bedrock, Google
 * Cloud's Agent Platform, and Microsoft Foundry sessions, or `0` to turn it
 * off."*
 *
 * Why refuse rather than honour: the tool is a second command executor, and the
 * deny surface we advertise does not bind to it. A `Bash(...)` deny rule matches
 * `Bash` calls; the binary routes PowerShell calls through a `PowerShell` tool
 * with its own rule namespace — `tools-reference.md#configure-tools-with-permission-rules-and-hooks`
 * gives `Bash(npm run *)` and `PowerShell(Get-ChildItem *)` two separate rows of
 * one table — and the page says so for hooks in the same breath: *"Match
 * `Bash|PowerShell` in hooks that inspect shell commands; the PowerShell hook
 * input section explains why matching `Bash` alone is not enough."* Pi and codex have no counterpart at
 * all, so honouring the variable would put a whole executor on one runtime of
 * three, outside the floor, on an environment variable no host decision
 * authorises. Delegated decision 2026-09-05 (Q-den 67) took option 2, refuse it
 * by name; option 3 — extend the deny surface, `defaultShell` and skill
 * frontmatter `shell:` — waits for Windows to become a supported deployment.
 *
 * PINNED TO THE DOCUMENTED OFF VALUE RATHER THAN DELETED, and the difference is
 * the whole point on the one platform where PowerShell is native. Deleting the
 * name refuses the tool on macOS, Linux and WSL, where the page requires an
 * explicit `1` (plus a `pwsh` on `PATH`) to enable it — but on Windows with Git
 * Bash the same page says the tool is ON BY DEFAULT, so a strip there would
 * leave enabled exactly the executor this refusal exists to remove, and this
 * repo ships a Windows build (`apps/electron/scripts/build-win.ps1`). `0` is the
 * vendor's own off value, quoted above, not a value invented here. The
 * delete-then-assign is the Bun 1.3.14 spread rule (AGENTS.md §Traps): a plain
 * assignment to a pre-created slot stays invisible to `{...process.env}`, so the
 * child would receive nothing.
 *
 * NOT conditional on the operator's value — the same judgement
 * `CLAUDE_CODE_DISABLE_CRON` and `applyOfficialMarketplaceAutoinstallOff` make
 * two blocks up: the only value that keeps the child's executor set inside our
 * permission floor is the off one, so an ambient `1` in the host's shell must
 * not re-arm it. The override is ANNOUNCED rather than silent, the P3.300
 * pattern, because dropping an administrator's deliberate setting without
 * saying so is the same one-runtime divergence with the sign flipped.
 *
 * ## P6.349 (J39) RESOLVES HERE: `defaultShell` needs nothing built either.
 *
 * That row asked to "build the key here, and let the owner's answer decide
 * whether `powershell` is a legal value". The answer above is that it is not, and
 * the key has exactly two values — the vendored `sdk.d.ts` types it
 * `'bash' | 'powershell'`, with *"Defaults to 'bash' on all platforms (no Windows
 * auto-flip)"*. `settings-reference.md#defaultshell` makes the dependency
 * explicit — *"`\"powershell\"` works only while the PowerShell tool is on"* —
 * and, better, says what happens when it is not: *"`\"powershell\"` falls back to
 * Bash when the PowerShell tool is off"*. So with the refusal above in force the
 * key is not merely inert, it is DOCUMENTED to degrade to the one value we want,
 * and building a host setting whose only reachable value is the default would be
 * a control that cannot control. It is also a narrower thing than the row's
 * comparison assumed: the key picks the shell for the input box's `!` commands,
 * not the shell the Bash TOOL runs, so codex's `shell_environment_policy` (an
 * environment policy) is not its counterpart in the first place.
 *
 * RESIDUE, stated rather than implied: this closes the ENVIRONMENT route only.
 * The page names a second one — an `env` block in `settings.json` — and we pass
 * `settingSources: ['user', 'project', 'local']`, so a project-scoped
 * `.claude/settings.json` can still set the name. Closing that route belongs to
 * the managed-settings layer (`claude-managed-settings.ts` +
 * `pi-harness/managed-policy.ts`, zoned as a pair), not here.
 */
function applyPowerShellToolRefusal(env: NodeJS.ProcessEnv): void {
    const operatorValue = env[CLAUDE_POWERSHELL_TOOL_ENV_VAR];
    if (operatorValue !== undefined && operatorValue !== CLAUDE_POWERSHELL_TOOL_REFUSED_VALUE) {
        debug(
            `[options] P6.530 — refused ${CLAUDE_POWERSHELL_TOOL_ENV_VAR}=${operatorValue} `
            + `and pinned it to ${CLAUDE_POWERSHELL_TOOL_REFUSED_VALUE} in the Claude child environment. `
            + 'The PowerShell tool is a second command executor that our Bash-scoped deny rules do not '
            + 'bind to, and Pi and codex have no counterpart, so honouring it would put a whole executor '
            + 'on one runtime of three outside the permission floor we advertise.',
        );
    }
    delete env[CLAUDE_POWERSHELL_TOOL_ENV_VAR];
    env[CLAUDE_POWERSHELL_TOOL_ENV_VAR] = CLAUDE_POWERSHELL_TOOL_REFUSED_VALUE;
}

/**
 * P6.33. Make the memory toggle mean the same thing on the claude runtime that
 * it means on Pi.
 *
 * `getMemoryEnabled()` is the whole gate on Pi: off, and no `MEMORY.md` block is
 * built and the `remember` tool is gone. On a claude-runtime session it gated
 * only OUR prompt block, while the SDK subprocess kept loading its own auto
 * memory directory at session start — so a user who turned memory off still had
 * memory in context, by a path we neither controlled nor reported. One switch,
 * two meanings, no diagnostic: the shape this plan keeps finding.
 *
 * NATIVE-FIRST, asked before writing anything, and the answer was that there is
 * nothing to build — we had simply never set what already exists. TWO SOURCES,
 * agreeing, which is why this is not a guess about a Beta-marked page:
 *
 *  - THE SHIPPED BINARY (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`,
 *    the native CLI behind SDK 0.3.223 / claudeCodeVersion 2.1.223). Its gate,
 *    extracted with `strings -a` — positive control `claudeMdExcludes` 3 hits,
 *    negative control `nessyNotARealSdkKey` 0:
 *
 *    ```js
 *    function Nm(){ … let e=process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
 *      if(tr(e))return!1;                 // truthy  → memory off
 *      if(ud(e))return!0;                 // "0"     → memory FORCED on
 *      … let t=eo(); if(t.autoMemoryEnabled!==void 0)return t.autoMemoryEnabled;
 *      return!0 }
 *    ```
 *
 *    and beside it the telemetry that names both channels:
 *    `N("tengu_memdir_disabled",{disabled_by_env_var:h, disabled_by_setting:
 *    !h&&eo().autoMemoryEnabled===!1})`.
 *  - THE PAGE, matching it exactly. `memory.md#enable-or-disable-auto-memory`:
 *    "To disable auto memory via environment variable, set
 *    `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`." And `env-vars.md#variables`, this
 *    variable's row: "Set to `1` to disable auto memory. Set to `0` to force
 *    auto memory on even when `--bare` mode or `autoMemoryEnabled: false` would
 *    otherwise disable it. When disabled, Claude does not create or load auto
 *    memory files." `settings-reference.md#automemoryenabled` closes the
 *    precedence: the variable "takes precedence over this key for one session,
 *    in either direction".
 *
 * WHY ONLY ONE DIRECTION IS WRITTEN, and this is the whole design:
 *
 *  - Memory OFF here ⇒ `'1'`, assigned AFTER the overrides so it is
 *    authoritative. Deliberately not "unless the operator set it": an ambient
 *    `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` in the host's login shell would
 *    otherwise re-arm the child's memory and defeat the in-app toggle, which is
 *    exactly the defect this closes. Same reasoning as `CLAUDE_CODE_DISABLE_CRON`
 *    above.
 *  - Memory ON here ⇒ write NOTHING. `'0'` does not mean "allowed"; the page
 *    says it FORCES memory on over `autoMemoryEnabled: false`, `--bare` and safe
 *    mode, and the binary confirms it (`ud(e)` returns before the settings read).
 *    Our toggle being on means "we do not stop memory", not "override the user's
 *    own Claude settings", so the SDK's own resolution — env, then setting, then
 *    its default of on — is left intact.
 *
 * A config that cannot be read decides nothing: `getMemoryEnabled()` reads the
 * stored config, which throws on an unsupported storage layout, and a spawn must
 * not fail because of it. The catch leaves the variable unset, which is the SDK's
 * own default rather than a value we invented.
 */
/**
 * P6.23. Make the one DEFERRED-TOOL-LOADING knob govern both runtimes, in the
 * only direction it can be made to govern them safely.
 *
 * ## The divergence, measured
 *
 * Deferred tool loading exists twice in this product and the two never met.
 * Ours is CLIENT-SIDE — `mcp__tool_search` / `mcp__tool_load` plus a host
 * catalog, decided by `resolveDeferredMcpToolLoading` from
 * `NESSY_ENABLE_TOOL_SEARCH` and `workspaceDefaults.deferredMcpToolLoading`,
 * with a recorded `reason` — and it reaches the Pi manifest and nothing else.
 * The SDK's is its own, and `agent-sdk/tool-search.md` says when it runs:
 * "Tool search is on by default, with the exceptions listed in Configure tool
 * search", and the `(unset)` row — "Tool search is on. Tool definitions are
 * deferred and discovered on demand."
 *
 * So an operator who turned deferral OFF in this app got it off on Pi and, on a
 * claude connection the SDK talks to directly, silently ON — deciding what the
 * model can see, inside a subprocess, through a mechanism whose activations we
 * neither observe nor render. One knob, two runtimes, one of them deaf: the same
 * defect shape as U1's depth knob and P6.16's concurrency knob one surface over.
 *
 * ## Why only the OFF direction is written
 *
 * The same asymmetry `applyAutoMemoryOffSwitch` documents above, for a sharper
 * reason: the ON values are not safe to project through OUR OWN default card.
 * The page's `true` row — "The SDK sends the beta header through proxies, and
 * requests fail on proxies that don't support `tool_reference` blocks." A
 * `claude-runtime` session's `ANTHROPIC_BASE_URL` is `http://127.0.0.1:<port>`,
 * this session's Anthropic-Messages adapter, which translates to the gateway's
 * OpenAI wire and forwards no `tool_reference` block. Left unset, the SDK
 * already does the right thing there by itself — "The SDK also disables tool
 * search when `ANTHROPIC_BASE_URL` points to a non-first-party host, since most
 * proxies don't forward `tool_reference` blocks" — so writing `true` would
 * override a fallback that is protecting us and break the turn.
 *
 * `auto`/`auto:N` are withheld for the same reason and stated rather than
 * silently dropped: the page's `auto` row promises a threshold, not that the
 * platform fallbacks still apply once it fires, and the failure it would buy is
 * the same broken turn on the same default card.
 *
 * `false` cannot break anything. It is strictly narrowing, it is the one value
 * the page gives no exception for, and it is the only value that carries an
 * operator's stated intent across the seam unchanged.
 *
 * Assigned AFTER the overrides and NOT "unless the operator set it", for
 * `CLAUDE_CODE_DISABLE_CRON`'s and auto-memory's reason: an ambient
 * `ENABLE_TOOL_SEARCH=true` in the host's login shell must not re-arm what the
 * in-app toggle turned off. An operator who wants the SDK's own default keeps it
 * by leaving OUR knob alone — that is what the `default`-with-preference-on and
 * `always` arms do here.
 *
 * ## The residue, named because it is invisible otherwise
 *
 * This makes the OFF state uniform. It does not make the ON state observable:
 * when the SDK's tool search runs, its searches and loads happen inside the
 * subprocess, no `/context` category counts them, and no transcript row renders
 * them. That is a real remaining divergence between the runtimes, not a closed
 * one, and the debug line below is the whole of what a reader gets today.
 *
 * A config that cannot be read decides nothing, exactly as above: the catch
 * leaves the variable unset, which is the SDK's own default rather than a value
 * we invented.
 */
/** The three runtimes a deferral verdict has to be given for, separately. */
export type ToolSearchRuntimeId = 'pi' | 'claude' | 'codex';

export interface ToolSearchRuntimeDisposition {
    runtime: ToolSearchRuntimeId;
    /**
     * `ours` — our client-side catalog defers (`mcp__tool_search`/`mcp__tool_load`);
     * `sdk` — the SDK's own API beta defers, inside the child;
     * `upfront` — every tool definition is loaded into context;
     * `unreachable` — the runtime decides on its own and this host has no switch.
     */
    state: 'ours' | 'sdk' | 'upfront' | 'unreachable';
    /** Whether an activation can be counted or rendered on THIS side of the seam. */
    observable: boolean;
    reason: string;
}

/**
 * P6.23's reporting half: say what deferred tool loading is doing on each of the
 * three runtimes, including the runtime this knob cannot reach.
 *
 * The switch below makes the OFF state uniform. It never made the DIFFERENCE
 * legible, and the two hand-written lines it used to emit made it worse: the off
 * line said deferral was "off on both runtimes" — there are three, and one of
 * them was never listening — and the on line said nothing about the fallback
 * that is already deciding for a `claude-runtime` session. A knob whose blast
 * radius is stated wrongly is worse than one stated not at all, because the
 * wrong statement is what the next reader believes.
 *
 * ## The verdicts, and where each comes from
 *
 * **Pi** is ours and client-side, and it is the only observable arm: the
 * deferral decision reaches the signed manifest with a recorded
 * `DeferredMcpToolLoadingReason`, so "why did that tool not load" has an answer.
 *
 * **Claude** splits in two, and the split is the thing nobody was told about.
 * `agent-sdk/tool-search.md`, § Configure tool search: "The SDK also disables
 * tool search when `ANTHROPIC_BASE_URL` points to a non-first-party host, since
 * most proxies don't forward `tool_reference` blocks." Every `claude-runtime`
 * session — the gateway card and BYO alike — runs against `http://127.0.0.1:<port>`,
 * this session's own Anthropic-Messages adapter, so the SDK is ALREADY loading
 * upfront there whatever we do. A direct first-party connection is the arm where
 * the SDK's own tool search actually runs, and the `(unset)` row says what that
 * means: "Tool search is on. Tool definitions are deferred and discovered on
 * demand." That arm is the residue P2.457 pins — the searches and loads happen
 * inside the subprocess, and no `/context` category and no transcript row counts
 * them.
 *
 * The first-party test here is OURS, not the SDK's: the classifier lives in a
 * closed binary and this is a report rather than a control, so it is written the
 * conservative way — unset means first-party (the SDK's own endpoint), an
 * `anthropic.com` host means first-party, and everything else including an
 * unparseable value is reported as non-first-party. If the SDK ever disagrees,
 * the SDK's decision is the one that happens; this line is a reading, and says so.
 *
 * **Codex CANNOT be governed by this knob, and that is a measured refutation
 * rather than a gap** (P2.456): `tool_search` and `tool_search_always_defer_mcp_tools`
 * are `Stage::Removed` in the pinned config schema — "The feature flag is
 * useless but kept for backward compatibility reason" — the config applier
 * matches both keys and `continue`s before the enable arm, and there are zero
 * readers of either. The real gate is
 * `model_info.supports_search_tool && provider.capabilities().namespace_tools`,
 * which no config key reaches, and the models reply that would set it comes from
 * our own loopback adapter (O20). Writing either key would produce an inert,
 * unobservable key shaped like a control.
 *
 * NATIVE-FIRST, stated as the rule requires: on claude the mechanism to use is
 * the SDK's own, and nothing here builds a second one — every projection is a
 * value of the SDK's own variable, taken from the SDK's own table. **This line
 * said "the only projection is `false`, the one value with no documented
 * exception" until P6.529**, which is no longer true and was never quite the
 * reason: the page documents an override for exactly the non-first-party case
 * (*"You can override that default with the `ENABLE_TOOL_SEARCH` environment
 * variable"*), and what stops us taking it is our own loopback rather than the
 * absence of a documented one. So `true` and `auto:N` now cross on a first-party
 * base URL and are declined on the loopback, and the report names which of the
 * two applied. On codex the answer to "does the runtime already have it" is
 * *yes, and it is unreachable from configuration*, so the honest move is to
 * report the difference rather than manufacture a third mechanism beside it.
 */
export function describeToolSearchAcrossRuntimes(input: {
    mode: ToolSearchMode;
    /** `workspaceDefaults.deferredMcpToolLoading`. */
    workspacePreference: boolean;
    /** `ANTHROPIC_BASE_URL` as the SDK child will see it. */
    claudeBaseUrl?: string;
    /**
     * D1.36 — whether `NESSY_ENABLE_TOOL_SEARCH` in force came from the managed
     * `env` block rather than from the developer's own environment.
     */
    managedMode?: boolean;
}): ToolSearchRuntimeDisposition[] {
    const off = input.mode.kind === 'never'
        || (input.mode.kind === 'default' && input.workspacePreference !== true);
    // D1.36 · WHO decided, appended to every runtime's reason.
    //
    // The row this closes was written as "an organisation cannot keep tool
    // search on: both switches are developer-owned and no managed key exists",
    // and the first half is REFUTED at HEAD: the managed policy's `env` block
    // carries arbitrary names (`classifyManagedEnvVar` answers `immediate` for
    // anything not in its table, and only `CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION`
    // is refused outright), `applyManagedEnv` WRITES them over the ambient value
    // — "a managed value overwrites the ambient one" — and both hosts run
    // `startManagedDeliveryEnvApplication()` at boot, long before any manifest
    // is built. An administrator's `true` therefore lands as mode `always`,
    // which is the one arm of `resolveDeferredMcpToolLoading` that never
    // consults `workspaceDefaults.deferredMcpToolLoading` at all. So BOTH
    // developer switches are already outranked, through the runtime-documented
    // mechanism (a managed override of an environment variable) rather than
    // through a second policy key beside it — native-first, and no new key.
    //
    // What was missing is the other half of the row's done-means: the refusal
    // was SILENT. A developer whose `NESSY_ENABLE_TOOL_SEARCH=false` is
    // overwritten at boot sees a value they did not set and no statement of
    // where it came from, which is indistinguishable from the switch being
    // broken. One clause, on every runtime's line, because the disposition
    // report is the one surface all three launch paths already emit.
    const managed = input.managedMode === true
        ? ' — and this mode is your administrator\'s: NESSY_ENABLE_TOOL_SEARCH comes from the managed `env` block, which overwrites a local value at boot, and an `always` mode does not consult the workspace preference'
        : '';
    const firstParty = isFirstPartyAnthropicBaseUrl(input.claudeBaseUrl);
    const where = input.claudeBaseUrl ? `ANTHROPIC_BASE_URL=${input.claudeBaseUrl}` : 'ANTHROPIC_BASE_URL unset';
    // P6.529 — the ON directions cross this seam, but only on a first-party base
    // URL. The two arms are named in the report rather than left to be
    // discovered, because after this row one runtime has two behaviours and
    // "which one applied to this connection" is the question an operator asks.
    const projected = projectedToolSearchValue(input.mode, firstParty, off);
    // The other arm: our own ON mode reaching claude as nothing at all and
    // collapsing into whatever the SDK's own fallback does. Said out loud — a
    // threshold the operator set silently becoming somebody else's decision is
    // the divergence shape this row exists to close, and it is invisible from
    // either side otherwise.
    const unprojected = !off && !projected && (input.mode.kind === 'always' || input.mode.kind === 'auto')
        ? ' — and our own ON mode is NOT projected here: since P6.529 `true` and `auto:N` cross this seam only on a first-party base URL, because the SDK sends the beta header through proxies and a request fails on a proxy that does not forward `tool_reference` blocks'
        : '';
    const dispositions: ToolSearchRuntimeDisposition[] = [
        {
            runtime: 'pi',
            state: off ? 'upfront' : 'ours',
            observable: true,
            reason: off
                ? 'our client-side catalog is off, so mcp__tool_search/mcp__tool_load are not registered and every definition loads upfront; the manifest records which reason decided it'
                : input.mode.kind === 'auto'
                    ? `our client-side catalog decides per session against the auto threshold (${input.mode.percentOfContextWindow}% of the model context window), and the manifest records which way it went`
                    : 'our client-side catalog defers, and the manifest records the reason it decided to',
        },
        {
            runtime: 'claude',
            state: off || !firstParty ? 'upfront' : 'sdk',
            observable: off || !firstParty,
            reason: off
                ? 'ENABLE_TOOL_SEARCH=false is written into the child, so the SDK loads every definition upfront'
                : projected
                    ? `our own mode IS projected here as ENABLE_TOOL_SEARCH=${projected}, because ${where} is read here as first-party — the SDK's own tool search runs under the operator's value, and its searches and loads happen inside the subprocess, where no context category and no transcript row counts them`
                    : firstParty
                        ? `the SDK's own tool search runs (${where}, read here as first-party) — "Tool definitions are deferred and discovered on demand" — and its searches and loads happen inside the subprocess, where no context category and no transcript row counts them${unprojected}`
                        : `the SDK disables its own tool search because ${where} is read here as non-first-party, so definitions load upfront without us asking; the classifier is the SDK's and this is our reading of it${unprojected}`,
        },
        {
            runtime: 'codex',
            state: 'unreachable',
            observable: false,
            reason: 'this knob cannot reach codex: both tool-search config keys are Stage::Removed and skipped before the enable arm, and the real gate is model metadata (supports_search_tool && namespace_tools) that no config key reaches',
        },
    ];
    // The codex line keeps its own reason unchanged: the administrator's value
    // decided nothing there, and saying it did would be the inert-control shape
    // P2.456 refuted. Its `n/a` with its reason is the row's third verdict.
    return dispositions.map(entry => (entry.runtime === 'codex'
        ? entry
        : { ...entry, reason: `${entry.reason}${managed}` }));
}

/**
 * P6.529 — the value an operator's ON choice crosses the seam as, or
 * `undefined` when it does not cross at all.
 *
 * Delegated decision 2026-09-05 (Q-den 66) took option 3: honour the choice only
 * where the base URL IS first-party, and keep the forced OFF on the loopback.
 * The vendor's own reasoning is the contract here —
 * `agent-sdk/tool-search.md#configure-tool-search`, verbatim: *"The SDK also
 * disables tool search when `ANTHROPIC_BASE_URL` points to a non-first-party
 * host, since most proxies don't forward `tool_reference` blocks. You can
 * override that default with the `ENABLE_TOOL_SEARCH` environment variable."*
 * We take the override on the connections the sentence's own caveat does not
 * cover, and decline it on the ones it does: every `claude-runtime` session runs
 * against `http://127.0.0.1:<port>`, our per-session Anthropic-Messages adapter,
 * which forwards no `tool_reference` block — and the page's `true` row says such
 * a request FAILS. Overriding there would break the turn on our own default card.
 *
 * `auto` and `auto:N` collapse to `auto:<percent>`, which the page's own table
 * accepts and which is exact: its `auto` row defines the bare spelling as the
 * 10% our parser already substitutes, so no operator value is widened or
 * narrowed by writing the number out.
 *
 * The OFF direction is untouched by this and stays unconditional — `never` and
 * a preference-off `default` still write `false` on every connection, first-party
 * or not. This function answers only "does the operator's ON choice cross".
 *
 * THE VARIABLE IS NOT OMNIPOTENT, and the non-first-party host above is only the
 * case that concerns US. `agent-sdk/tool-search.md` names FOUR further situations
 * in which writing `ENABLE_TOOL_SEARCH` changes nothing, so a `true` that crosses
 * this seam is still not a promise that tool search ran (C3.139, re-read from the
 * page 2026-09-11 — do not carry a count from this comment, re-derive it, because
 * the row this comment closes said "two"):
 *
 * 1. `#how-tool-search-works`: *"Tool search isn't supported on Microsoft Foundry
 *    deployments hosted on Azure, which reject it server-side: the SDK detects the
 *    rejection and loads tool definitions upfront for that deployment instead.
 *    `ENABLE_TOOL_SEARCH` can't override this, since the rejection comes from the
 *    deployment itself."*
 * 2. `#configure-tool-search`: *"Earlier Agent Platform models: the SDK loads tool
 *    definitions upfront, because their serving stacks reject the required beta
 *    header. `ENABLE_TOOL_SEARCH` can't override this."* ("Earlier" means earlier
 *    than the Claude 4.5 generation on Google Cloud's Agent Platform; Opus 4.5,
 *    Sonnet 4.5, Haiku 4.5 and later are on by default there.)
 * 3. `#configure-tool-search`: *"For models on the SDK's unsupported-model list,
 *    the SDK loads tool definitions upfront instead, and no `ENABLE_TOOL_SEARCH`
 *    value overrides that."* That list is the SDK's, not ours, and it is not
 *    published as an enumeration — so it cannot be mirrored here, only respected.
 * 4. `#configure-tool-search`: *"Setting `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`
 *    keeps tool search off. You can't override it by setting `ENABLE_TOOL_SEARCH`
 *    yourself."* An operator or a managed policy can therefore switch this off
 *    from OUTSIDE anything this function sees.
 *
 * Consequence for the disposition report: a first-party projection is "we did not
 * stand in the way", never "it is on". That is why `describeToolSearchAcrossRuntimes`
 * reports which arm applied rather than asserting an outcome.
 */
function projectedToolSearchValue(
    mode: ToolSearchMode,
    firstParty: boolean,
    off: boolean,
): string | undefined {
    if (off || !firstParty) return undefined;
    if (mode.kind === 'always') return 'true';
    if (mode.kind === 'auto') return `auto:${mode.percentOfContextWindow}`;
    // `default` — the operator named no mode, so there is nothing of ours to
    // project and the SDK's own default is the right answer, not a value we
    // invent for it.
    return undefined;
}

/**
 * Our reading of "first-party host", written conservatively because it is a
 * report and not a control — see `describeToolSearchAcrossRuntimes`.
 */
function isFirstPartyAnthropicBaseUrl(baseUrl: string | undefined): boolean {
    if (!baseUrl) return true;
    try {
        const host = new URL(baseUrl).hostname.toLowerCase();
        return host === 'anthropic.com' || host.endsWith('.anthropic.com');
    } catch {
        return false;
    }
}

/**
 * The two inputs every disposition needs, or `null` when the config cannot be
 * read — in which case nothing is decided and the reason is said out loud.
 *
 * A config that cannot be read decides nothing, so `ENABLE_TOOL_SEARCH` stays
 * unset and the SDK's own default applies. Reported rather than silent: this is
 * the one arm where the runtimes may differ for a reason that is ours and
 * temporary, and a reader who sees no tool-search line at all cannot tell it
 * apart from a build where this switch was removed.
 */
function resolveToolSearchDecision(
    env: NodeJS.ProcessEnv,
): { mode: ToolSearchMode; workspacePreference: boolean; managedMode: boolean } | null {
    const mode = toolSearchMode(env);
    try {
        return {
            mode,
            workspacePreference: loadConfigDefaults().workspaceDefaults.deferredMcpToolLoading === true,
            // D1.36 — read at DECISION time, from the registry the managed-env
            // writer fills, so it describes this process's real environment
            // rather than the caller's `env` argument (which a test or a child
            // projection may own). `reportToolSearchDisposition` is called with
            // `process.env` on all three launch paths.
            managedMode: isManagedOriginEnvVar(TOOL_SEARCH_ENV_VAR),
        };
    } catch {
        debug('[tool-search] config unreadable, so ENABLE_TOOL_SEARCH stays unset and the SDK\'s own default and platform fallbacks decide');
        return null;
    }
}

/**
 * One line per runtime, so the DIFFERENCE is what a reader takes away rather
 * than one runtime's setting. `observable: false` is carried because an
 * unauditable influence on what the model can see is the thing the native-first
 * rule says is worse than an absent one.
 *
 * Returns the lines it wrote, because {@link debug} routes into electron-log
 * with the packaged main process's transports disabled — so the returned array
 * is the only thing a test can read, and the report the three launch paths owe
 * is worth pinning.
 */
function reportToolSearchDispositionLines(
    decision: { mode: ToolSearchMode; workspacePreference: boolean; managedMode?: boolean },
    claudeBaseUrl: string | undefined,
): readonly string[] {
    const lines = describeToolSearchAcrossRuntimes({
        mode: decision.mode,
        workspacePreference: decision.workspacePreference,
        claudeBaseUrl,
        ...(decision.managedMode === undefined ? {} : { managedMode: decision.managedMode }),
    }).map(entry =>
        `[tool-search] ${entry.runtime}: ${entry.state}`
        + ` (mode: ${decision.mode.kind}, workspace preference: ${decision.workspacePreference ? 'on' : 'off'},`
        + ` observable here: ${entry.observable ? 'yes' : 'no'}) — ${entry.reason}`);
    for (const line of lines) debug(line);
    return lines;
}

/**
 * P6.145 · THE THREE-RUNTIME REPORT, FROM A NON-CLAUDE LAUNCH PATH.
 *
 * The report was built to say what deferred tool loading is doing on each of the
 * three runtimes — and its only caller was {@link applyToolSearchOffSwitch},
 * which runs inside `buildClaudeSubprocessEnv`. So the one session type that
 * emitted it was the claude one; a Pi or codex session emitted no tool-search
 * line at all, which is the shape where an operator concludes the knob does not
 * exist rather than that it does not reach them.
 *
 * Nothing about the CONTENT is per-runtime: `describeToolSearchAcrossRuntimes`
 * already answers for all three at once, and the codex entry's
 * `state: 'unreachable', observable: false` is a measured refutation (P2.456)
 * that reads the same whoever asks. So this is the reporting half lifted out
 * whole, with no second report built beside it — the host supplying one answer
 * uniformly, which is step 2 of the native-first rule.
 *
 * `ANTHROPIC_BASE_URL` is read from the ambient environment here: on a Pi or
 * codex session there is no claude child to read it off, and the claude row is
 * describing what a claude session on this host WOULD do.
 */
export function reportToolSearchDisposition(env: NodeJS.ProcessEnv = process.env): readonly string[] {
    const decision = resolveToolSearchDecision(env);
    if (!decision) return [];
    return reportToolSearchDispositionLines(decision, env.ANTHROPIC_BASE_URL);
}

function applyToolSearchOffSwitch(env: NodeJS.ProcessEnv): void {
    const decision = resolveToolSearchDecision(env);
    if (!decision) return;
    // Unchanged from the day this switch landed, and deliberately not re-derived
    // from the report below: the report may say a runtime loads upfront for a
    // reason of the SDK's own (a non-first-party base URL), and that is not a
    // reason for US to write the variable. Only OUR knob writes it.
    const off = decision.mode.kind === 'never'
        || (decision.mode.kind === 'default' && !decision.workspacePreference);
    if (off) {
        env.ENABLE_TOOL_SEARCH = 'false';
    } else {
        // P6.529 — the ON directions now cross too, on a first-party base URL
        // only. See `projectedToolSearchValue` for the vendor sentence this
        // takes the override from and the loopback caveat it declines it on.
        // Nothing is written on the other arm: our first-party test is a READING
        // of a classifier that lives in a closed binary, so declining to project
        // leaves the SDK's own decision in force rather than replacing it with
        // ours — which is the same reason `describeToolSearchAcrossRuntimes`
        // gives for calling itself a report.
        const projected = projectedToolSearchValue(
            decision.mode,
            isFirstPartyAnthropicBaseUrl(env.ANTHROPIC_BASE_URL),
            false,
        );
        if (projected !== undefined) env.ENABLE_TOOL_SEARCH = projected;
    }
    reportToolSearchDispositionLines(decision, env.ANTHROPIC_BASE_URL);
}

/**
 * P6.483 — the TWO vendor-neutral opt-out names, and the third that is
 * deliberately not read.
 *
 * Owner ruling 2026-09-05 (Q13, option 3): override
 * `DO_NOT_TRACK` and `DISABLE_TELEMETRY` for the claude child, and NEVER
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. The exclusion is not fastidiousness
 * — the host WRITES that third name itself on every gateway session
 * (`claude-agent.ts`'s own gateway env), and `telemetryOptedOut` treats any
 * non-empty value of it as an opt-out, so reusing that predicate here would
 * silence the exporter on every gateway session and read as a working feature.
 * Hence a narrower predicate rather than the shared one.
 *
 * READ FROM THE AMBIENT ENVIRONMENT, never from the merged child env, for the
 * same reason: by the time the child env exists it carries our own writes, and a
 * predicate over it would be reading the host's decision back as if it were the
 * operator's. `process.env` here is the operator's shell.
 *
 * Read from a SPREAD, because `in` and direct property access lie for names Bun
 * pre-creates slots for and this predicate must answer "was it set at launch".
 *
 * The two readings are the documented ones and they differ on purpose,
 * matching `telemetryOptedOut`'s own halves: `DISABLE_TELEMETRY` is
 * SET-AT-ALL (`env-vars.md`: read only whether you set it), so `0` still opts
 * out; `DO_NOT_TRACK` is a plain boolean, so `0` leaves telemetry on. Anything
 * else would be a third vocabulary for a name two runtimes already read.
 */
function claudeVendorNeutralTelemetryOptOut(ambient: NodeJS.ProcessEnv = process.env): boolean {
    const spread = { ...ambient };
    if ((spread.DISABLE_TELEMETRY ?? '').trim() !== '') return true;
    return ['1', 'true', 'yes', 'on'].includes((spread.DO_NOT_TRACK ?? '').trim().toLowerCase());
}

/**
 * P6.255 (C12) — the proxy variables we set are INERT in the claude child
 * unless this is set, and that is MEASURED rather than suspected.
 *
 * The row's own clause hedged: *"claude: a Node subprocess whose HTTP client is
 * undici-based, so the variables we set may be inert"*. The vendored 2.1.247
 * binary settles it with its own gate — the predicate name still scores 5 lines
 * / 5 occurrences there, re-measured 2026-09-12 (C3.252):
 *
 *     function shouldUseEnvProxy(){let value=process.env.NODE_USE_ENV_PROXY;
 *       if(Boolean(value)===!1||value==="0")return!1;
 *       let httpProxy=process.env.http_proxy||process.env.HTTP_PROXY, …}
 *
 * and it carries its own remedy in prose: *"Some clients do not read
 * HTTPS_PROXY: Node's built-in fetch (run that command with
 * NODE_USE_ENV_PROXY=1 on Node >= 22.21)"*. Counts on that binary, re-measured
 * at HEAD: `NODE_USE_ENV_PROXY` 2, control `NODE_EXTRA_CA_CERTS` 55, fabricated
 * name 0. The same excerpt independently confirms C20's other clause — the
 * child reads LOWERCASE FIRST inside each pair, which is the documented order
 * `network-config.md` states and the order our own interceptor had inverted.
 *
 * Set only when a proxy is actually configured, so an install with none is
 * byte-identical to what it was. Assigned AFTER the overrides for the same
 * reason the blocks above are: an ambient `0` in the host's shell must not
 * re-disable the only thing that makes an administrator's proxy reach this
 * child. An operator who set the name themselves has already decided, in either
 * direction, and is never overridden.
 *
 * Not done for codex: the flag is Node's and codex is a Rust binary, so setting
 * it there would be an invented remedy rather than a measured one.
 */
function applyEnvProxyGate(env: NodeJS.ProcessEnv): void {
    if (env.NODE_USE_ENV_PROXY !== undefined) return;
    if (!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)) return;
    env.NODE_USE_ENV_PROXY = '1';
}

/**
 * P6.696 — the operator's background-task off switch reaches the claude child.
 *
 * `backgroundTasksDisabled()` is the ONE predicate every detach site consults,
 * and until this row its readers were the Pi orchestrator, the local-tool
 * runtime and `PiAgent` — `claude-agent.ts` scored zero. So an operator who
 * turned background tasks off got a Pi session that honoured it and a claude
 * session that did not, from the same setting, with nothing saying so. A
 * control that silently stops controlling on one runtime is the divergence
 * class this fork keeps finding.
 *
 * NATIVE-FIRST, tier 1: the child already has the mechanism and simply does not
 * know our name for it. `env-vars.md`'s `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`
 * row, quoted verbatim on `backgroundTasksDisabled` itself: *"Set to `1` to
 * disable all background task functionality, including the `run_in_background`
 * parameter … and auto-backgrounding."* Binary probe of the vendored `claude`,
 * re-measured 2026-09-12 at `2.1.247`: the name scores **4 lines / 4
 * occurrences**, control `ZZQQNOTAREALNAME` **0/0** (it read 6 at 2.1.233 with
 * no instrument stated; C3.252/C3.294). The mapping is already written down —
 * `background-task-settings.ts` heads its family table with exactly this pair —
 * so this is the projection that table always implied and nobody performed.
 *
 * NEVER OVERWRITES AN INHERITED VALUE. An operator who set the vendor spelling
 * in their own environment has already decided, including deciding `0`, and the
 * Nessy name must not silently re-enable or re-disable it behind them. (The Bun
 * `process.env` enumeration trap does not bite here — `env` is a fresh object
 * literal, not the live `process.env` — but the throwaway-child test asserts
 * the value on a REAL grandchild's spread rather than on this object, because
 * "an object literal contained it" is not "the subprocess received it".)
 */
function applyBackgroundTaskOffSwitch(env: NodeJS.ProcessEnv): void {
    if (env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS !== undefined) return;
    if (!backgroundTasksDisabled(env)) return;
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
}

/**
 * P6.390 — the chat's own memory scope, not just the app-wide switch.
 *
 * The global rule was already right and is unchanged: `'1'` closes memory and
 * the ON case writes NOTHING rather than `'0'`, because `'0'` would force memory
 * on over the user's own `autoMemoryEnabled: false`, over `--bare` and over safe
 * mode. What is added is the per-chat OVERRIDE, which
 * `settings-reference.md#automemoryenabled` says "takes precedence over this key
 * for one session, in either direction" — so it has to be resolved HERE rather
 * than folded into `envOverrides` by a caller: the direction a caller cannot
 * express is the chat that keeps memory ON while the global switch is off, since
 * writing nothing there would leave this applier free to close it again.
 *
 * `buildClaudeSessionMemoryEnv` returns `{}` for a fully-on scope, so passing no
 * override is byte-identical to the behaviour before this row.
 *
 * The projection is LOSSY and deliberately so: one env var over the row's two
 * axes, and a chat that turned only one of them off gets memory closed
 * altogether — the safe arm, with the sentence
 * `describeSessionMemoryScopeResidue` supplies for whoever shows it.
 *
 * ## C3.256 — the memory LOCATION is deliberately NOT projected, and here is why
 *
 * The switch above carries the host's memory ON/OFF decision into the child. The
 * host's memory-location setting — same name as the vendor's, read by
 * `config/storage.ts` symbol `getAutoMemoryDirectory` — is NOT carried, and that
 * is a decision with three measured grounds rather than an omission. (A contract
 * name is spelled without its key punctuation in this block on purpose: the
 * tripwire in `__tests__/claude-auto-memory-directory.test.ts` matches the
 * settings-key form, and prose that spelled it that way would fire the guard
 * against the very comment explaining the refusal — AGENTS.md §Traps.)
 *
 *  1. **The two stores would become ONE PATH, with two writers.** The vendored
 *     binary's own schema text for the key, read out of
 *     `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` at
 *     `claudeCodeVersion 2.1.247` (9 occurrences of the name; `plansDirectory` 9
 *     is the positive control that the probe reads the file, `nessyNotARealSdkKey`
 *     0 the negative): *"Custom directory path for auto-memory storage. Supports
 *     ~/ prefix for home directory expansion. Ignored if set in projectSettings
 *     (checked-in .claude/settings.json) for security. When unset, defaults to
 *     ~/.claude/projects/<sanitized-cwd>/memory/."* So a set value replaces the
 *     WHOLE default path, project leaf included, and the child's auto-memory
 *     index is a `MEMORY.md` at its root (`memory/claude-auto-memory.ts`). The
 *     host's user-scope index is `<that same directory>/MEMORY.md`
 *     (`memory/memory-store.ts` symbols `getUserMemoryRoot` and
 *     `getUserMemoryFilePath`). Projecting therefore points the runtime's own
 *     writer at the file this app maintains and loads into every session on all
 *     three runtimes.
 *  2. **It would OVERRIDE the user's own Claude setting, silently.** A projection
 *     lands in the flag-settings layer this fork composes
 *     (`claude-agent.ts` symbol `composeClaudeSpawnSettings`), which outranks the
 *     `user`/`project`/`local` tiers the child reads for itself — so a user who
 *     set the vendor key in their own settings would lose it to ours with no
 *     diagnostic.
 *  3. **They are not the same store.** Ours is the memory index this app writes,
 *     edits and composes into the prompt on every runtime; the child's is a tree
 *     nothing in this app reads (`memory/claude-auto-memory.ts` states that
 *     disposition per session).
 *
 * WHERE THIS IS SAID OUT LOUD: `describeClaudeAutoMemory`'s sentence names the
 * non-projection, but its only consumer is `this.debug`, and a packaged build
 * logs nothing outside debug mode (AGENTS.md §Traps) — so the user-visible half
 * is a switch-cost row (`chat.runtimeSwitch.costAutoMemoryDirectory`, handed to
 * the switch-cost table's holder by W17-m): on Pi and codex the setting governs
 * everything this session writes as memory, on claude a second store stays where
 * the runtime puts it.
 */
function applyAutoMemoryOffSwitch(
    env: NodeJS.ProcessEnv,
    override?: SessionMemoryScopeOverride,
): void {
    let memoryEnabled: boolean;
    try {
        memoryEnabled = getMemoryEnabled();
    } catch {
        return;
    }
    Object.assign(env, buildClaudeSessionMemoryEnv(
        resolveSessionMemoryScope({ globalEnabled: memoryEnabled, ...(override ? { override } : {}) }),
    ));
}

/**
 * U1. Make the one depth knob govern BOTH runtimes.
 *
 * `resolveMaxSubagentSpawnDepth` already reads `NESSY_MAX_SUBAGENT_SPAWN_DEPTH`
 * with the Claude spelling as a compat alias — but the only reader was
 * `SessionManager`, seeding the PI execution manifest. Nothing carried it into
 * the Claude subprocess, so an operator who set the Nessy name to `1` to turn
 * nesting off got it enforced on Pi sessions and **silently ignored on
 * claude-runtime ones**. Setting it here closes that, and it also pins the
 * value explicitly rather than inheriting whatever the SDK's default happens to
 * be at a given version.
 *
 * That last part is worth stating precisely, because the plan this unit came
 * from had it wrong. It described the default as changing "5 → 1" upstream and
 * asked for a seatbelt against that. `env-vars.md`, the
 * `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` row, says otherwise: "In v2.1.217
 * through v2.1.218, the default was 1 … v2.1.219 raised the default to 3." The
 * uplift target is v2.1.220 parity, on the far side of that restoration, so the
 * feared default is not what we are landing on — and our own
 * `DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH` is already 3 to match. The reason to write
 * the variable is the knob's coherence, not the version window.
 *
 * As with the retry ceiling: an operator who set the Claude spelling themselves
 * has already decided, so that value is never overridden.
 */
function applySubagentSpawnDepth(env: NodeJS.ProcessEnv): void {
    if (env[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR] !== undefined) return;
    env[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR] = String(resolveMaxSubagentSpawnDepth(env));
}

/**
 * P6.16. Make the one CONCURRENCY knob govern both runtimes, the way U1 above
 * made the one DEPTH knob govern both.
 *
 * `NESSY_MAX_CONCURRENT_SUBAGENTS` had exactly one enforcement site — the Pi
 * spawner's counter (`pi-agent-server/src/orchestrator/spawner.ts`). Nothing
 * carried it into the Claude subprocess, so an operator who capped concurrent
 * subagents got the cap enforced on Pi sessions and **silently ignored on
 * claude-runtime ones**: one knob, two runtimes, one of them deaf. Measured
 * before the fix — with `NESSY_MAX_CONCURRENT_SUBAGENTS=5` set, this function
 * returned an env carrying `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=3` (the
 * positive control, U1's variable, on the same call) and no concurrency
 * variable at all.
 *
 * NATIVE-FIRST, asked before writing anything: the SDK already owns this gate,
 * so there is nothing to build. The shipped native binary
 * (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`) carries the refusal
 * verbatim — "Concurrent subagent limit reached. You can run ${n} subagents at
 * once. Do not retry. If the user wants more concurrent subagents, ask them to
 * increase CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS" — and consults its own
 * `ultracode` exemption right beside it, matching
 * `sub-agents.md#concurrent-subagent-limit`: "Sessions with ultracode active are
 * exempt: the limit isn't enforced there." So the host's whole job here is to
 * hand the operator's number to a counter that already exists, and to leave the
 * exemption to the runtime that already implements it.
 *
 * WHAT THIS DELIBERATELY DOES NOT FORWARD, because the row that asked for it had
 * the resource model backwards. `maxConcurrentSubagents()` narrows the
 * documented default of 20 to `hostLiveAgentCeiling - 1` — one runtime per 2 GiB
 * of RAM — and `config/subagent-limits.ts` states why in its own words: "A
 * Claude Code subagent is another context window inside one process; ours is a
 * whole Pi subprocess at roughly a gibibyte." That narrowing prices a Pi
 * SUBPROCESS. A claude-runtime subagent is the first half of that same sentence:
 * the SDK runs it inside the one subprocess this session already holds, and the
 * host mints no runtime for it — `server-core/src/sessions/live-agent-ceiling.ts`
 * counts a running claude subagent as a BUSY DOMAIN on the parent
 * (`backendBackgroundTasks`), never as a new occupant of the memory ceiling.
 * Projecting the Pi formula onto it would refuse work for memory nobody
 * allocates, and would contradict the documented default for no measured cost.
 * So an unset knob leaves the SDK's own 20 in force.
 *
 * The residue, stated rather than hidden: with the knob unset the two runtimes
 * do differ — Pi narrows by installed RAM, claude does not — because their
 * subagents cost different things. An operator who wants one number across both
 * sets the knob, and after this it binds on both.
 *
 * As with the retry ceiling and the depth knob: an operator who set the Claude
 * spelling themselves has already decided, so that value is never overridden.
 * A malformed value is not a cap — `env-vars.md`'s row for this variable says
 * "Accepts a positive whole number in plain digits; anything else is ignored, so
 * the variable can adjust the cap but can't disable it" — so it leaves the
 * variable unset and the SDK's default in charge rather than inventing a number.
 */
function applyConcurrentSubagentCeiling(env: NodeJS.ProcessEnv): void {
    if (env[MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV] !== undefined) return;
    const declared = declaredMaxConcurrentSubagents(env);
    if (declared === undefined) return;
    env[MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV] = String(declared);
}

/**
 * P6.364 (K10) — the operator's subagent model, on claude.
 *
 * `buildClaudeSubprocessEnv` spreads `process.env`, so an operator who exports
 * the CLAUDE spelling already reaches the child; the NESSY spelling reached
 * nothing. This closes that half.
 *
 * **It projects UNCONDITIONALLY since F1.588 (2026-09-24), because the binary
 * we ship now implements the documented order.** Until the 0.3.267 lift it
 * projected only under `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`: the vendored bundle
 * carried no FORCE occurrence and implemented the order
 * `sub-agents.md#choose-a-model` records as superseded — "Before v2.1.251,
 * `CLAUDE_CODE_SUBAGENT_MODEL` came first in this order and overrode both the
 * per-invocation parameter and the frontmatter, including `model: inherit`" —
 * so projecting would have handed claude the opposite order to Pi's spawner.
 * The same section, re-read 2026-09-24 (HTTP 200), lists the order the binary
 * now resolves: "1. The per-invocation `model` parameter 2. The subagent
 * definition's `model` frontmatter, where `inherit` selects the main
 * conversation's model 3. The `CLAUDE_CODE_SUBAGENT_MODEL` environment
 * variable, when you set it to a model alias or model ID 4. The main
 * conversation's model".
 *
 * ## Measured on the vendored 2.1.267, not taken from the page (F1.588)
 *
 * Both self-reports read 2.1.267 (`claudeCodeVersion` in the SDK's
 * `package.json`, and the binary's own `--version`); FORCE now scores 17
 * occurrences (`grep -aoF … | wc -l`) where it scored 0 through 2.1.251. The
 * ORDER was DRIVEN rather than grepped: a loopback Messages stub answered the
 * main agent with one `Agent` call and recorded the model of the subagent's
 * first request, env scrubbed and binary pinned. `CLAUDE_CODE_SUBAGENT_MODEL`
 * alone → its model; a definition `model` beside it → the definition's; FORCE=1
 * beside both → the variable's again; nothing set → the main model. Arm for
 * arm that is the page's order plus its FORCE override, so the projection is a
 * DEFAULT on claude exactly as `NESSY_SUBAGENT_MODEL` is on Pi's spawner — one
 * knob, one meaning, on both (codex drops a role's own `model` anyway).
 *
 * ## FORCE is the binary's own now, exceptions included
 *
 * `sub-agents.md#run-every-subagent-on-one-model`, verbatim: "While
 * `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is on, Claude Code ignores the `model`
 * field of every subagent definition, including the built-in Explore and Plan
 * subagents, and Claude can't pass a model when it starts a subagent. Two kinds
 * of subagent still run on the main conversation's model: A fork; A skill that
 * runs in a subagent with `model: inherit`." — "Requires Claude Code v2.1.257
 * or later", which 2.1.267 is. The operator's FORCE reaches the child through
 * the same `process.env` spread, and this function no longer reads it: the
 * binary applies FORCE and both exceptions per spawn, which a process-wide
 * projection could never see. Before the lift neither exception was honoured.
 *
 * The Pi arm keeps one residue, a SWITCH COST rather than a defect: its spawner
 * gates FORCE on `!isForkAgentDefinition(agentDef)`, so it honours the FIRST
 * exception host-side and cannot honour the SECOND — `AgentDefinition` carries
 * `fork?: true` but no marker saying a definition was forked FROM A SKILL
 * (`skillKeys` lists the skills a definition GRANTS, not where it came from),
 * so "a skill that runs in a subagent with `model: inherit`" is unexpressible
 * there. Recorded, not built: nothing produces that origin today.
 *
 * The debug line says which of the two meanings a session got, because nothing
 * on screen names the model a claude subagent resolved, and a knob whose
 * meaning has just changed is the one an operator most needs confirmed.
 *
 * Retired with this change: the `subagentModelOrder` switch-cost row, whose
 * claude cell said the override is ignored unless FORCE is also set. With a
 * subagent's own `model` winning on all three runtimes it can never fire, and
 * P6.896's rule is that a row which can never fire is not a row; its two
 * locale sentences went with it.
 *
 * As with the three appliers above, an operator who set the CLAUDE spelling
 * themselves has already decided, so that value is never overridden.
 */
function applySubagentModelOverride(env: NodeJS.ProcessEnv): void {
    if (env[SUBAGENT_MODEL_COMPAT_ENV_VAR] !== undefined) return;
    const declared = resolveSubagentModelOverride(env);
    if (declared === undefined) return;
    const forced = isSubagentModelOverrideForced(env);
    debug(
        `[options] P6.364 — NESSY_SUBAGENT_MODEL (${declared}) is projected onto the claude child as `
        + `CLAUDE_CODE_SUBAGENT_MODEL, ${forced
            ? 'and CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set, so the binary puts it on every subagent'
            : 'a DEFAULT: a per-call or definition `model` still wins (the vendored 2.1.267 order, F1.588)'}.`,
    );
    env[SUBAGENT_MODEL_COMPAT_ENV_VAR] = declared;
}

/**
 * CLR-12. Bound how long a stalled upstream can hold an INTERACTIVE turn on
 * `Responding…` before the user is told something went wrong.
 *
 * `env-vars.md`: `CLAUDE_CODE_MAX_RETRIES` — "Override the number of times to
 * retry failed API requests (**default: 10**)… For unattended sessions that need
 * to wait through longer outages, set `CLAUDE_CODE_RETRY_WATCHDOG` instead".
 *
 * Ten retries with escalating backoff is the right default for a headless
 * worker and the wrong one for a person watching a spinner. Measured on this
 * fork (live audit, case `CLR-12`): against a hard-stalled upstream the SDK
 * re-POSTed at +92 s, +268 s and +301 s and the session sat unsettled for
 * **14 minutes** — the adapter behaved correctly and the error simply never
 * arrived in a human timeframe.
 *
 * Two things this deliberately does NOT do, because the page assigns them to
 * the user rather than to us:
 * - **It never overrides an explicit value.** An operator who set the variable
 *   — ambient or through `envOverrides` — has already made this decision.
 * - **It stands down when `CLAUDE_CODE_RETRY_WATCHDOG` is set.** That is the
 *   documented switch for unattended sessions, and it exists precisely to wait
 *   out long outages; capping retries underneath it would defeat the knob the
 *   page tells such users to reach for.
 */
function applyInteractiveRetryCeiling(env: NodeJS.ProcessEnv): void {
    if (env.CLAUDE_CODE_MAX_RETRIES !== undefined) return;
    if (isRetryWatchdogEnabled(env.CLAUDE_CODE_RETRY_WATCHDOG)) return;
    env.CLAUDE_CODE_MAX_RETRIES = String(INTERACTIVE_MAX_RETRIES);
}

/**
 * Retries allowed before an interactive turn surfaces its error. Three, not the
 * SDK's ten: it still absorbs an ordinary transient blip, and it turns the
 * measured 14-minute silence into an error the user gets while still watching.
 */
export const INTERACTIVE_MAX_RETRIES = 3;

/** The page documents the watchdog as `1`; treat the usual truthy spellings as on. */
function isRetryWatchdogEnabled(raw: string | undefined): boolean {
    if (raw === undefined) return false;
    const value = raw.trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** Filename of the per-platform native Claude binary inside its npm package. */
function nativeBinaryName(): string {
    return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

export function getDefaultOptions(
    envOverrides?: Record<string, string>,
    /** P6.390 — threaded to `buildClaudeSubprocessEnv`; see `applyAutoMemoryOffSwitch`. */
    sessionMemoryScopeOverride?: SessionMemoryScopeOverride,
): Partial<Options> {
    // Repair corrupted ~/.claude.json before the SDK subprocess reads it
    ensureClaudeConfig();

    // P6.724 — the todo-tools opt-in travels in the child's ENVIRONMENT
    // (`applyTodoToolsOptIn`), not in an allow list. Nothing here sets
    // `allowedTools` any more, deliberately: a bare entry there is an
    // auto-approval and shadows `canUseTool`. See
    // `CLAUDE_TODO_TOOLS_OPT_IN_ENV_VAR`.
    const env = buildClaudeSubprocessEnv(envOverrides, sessionMemoryScopeOverride);

    // If custom path is set (e.g., for Electron packaged build), point the SDK at it.
    // This is the native `claude` binary, not a JS file.
    if (customPathToClaudeCodeExecutable) {
        return {
            pathToClaudeCodeExecutable: customPathToClaudeCodeExecutable,
            env,
        };
    }

    // Standalone CLI distribution (`scripts/install.sh`) lays the per-version
    // SDK out at ~/.local/share/nessy/versions/<version>/claude-agent-sdk/<binary>
    if (typeof NESSY_AGENT_CLI_VERSION !== 'undefined' && NESSY_AGENT_CLI_VERSION != null) {
        const baseDir = join(homedir(), '.local', 'share', 'nessy', 'versions', NESSY_AGENT_CLI_VERSION);
        return {
            pathToClaudeCodeExecutable: join(baseDir, 'claude-agent-sdk', nativeBinaryName()),
            env,
        };
    }

    // Default: let the SDK auto-discover the native binary via standard
    // node_modules resolution from `sdk.mjs`. The matching platform package
    // (e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64`) is installed via
    // optionalDependencies.
    return { env };
}

/**
 * F1.966 — the child's `ANTHROPIC_BASE_URL` is the CONNECTION's, never the
 * launch environment's. Owner rule, 2026-09-25: the integration decides the
 * endpoint, and the environment the app was launched with never overrides it.
 *
 * KEPT only when `envOverrides` carries it: a `claude-runtime` session's
 * per-session loopback adapter, or a direct connection with its own base URL
 * (`resolveAuthEnvVars` writes the name only `if (connection.baseUrl)`).
 * Otherwise REMOVED, so a value the `...process.env` spread brought in — a
 * terminal export, `electron:dev`, `launchctl setenv`, a headless server's
 * `.env`, or the launch value `resetManagedAnthropicAuthEnvVars` restores on
 * every connection save — cannot send a direct session's key to an endpoint the
 * connection never named. Before this, a direct connection without a base URL
 * followed whatever the host env held at spawn time: the vendor default right
 * after `postInit`'s delete, the launch value again after the next save.
 *
 * Native-first: the host already owns the child's `options.env`, which the SDK
 * hands the child as its whole environment, and an absent name IS the vendor's
 * own default (`api.anthropic.com`; measured by workflow wf_a0694155-7ce).
 * Removal rather than the documented `''` form here; F1.981's settings-file pin
 * (`claude-endpoint-settings.ts`) pins the vendor URL on the flag tier (F1.1005). One site covers every consumer of this
 * builder — the session, a respawn, Test/validation and the title agents —
 * whatever the order of `postInit` and the reset. The same "set or DELETED,
 * never left to the spread" shape as Pi's P6.691/P7.3, and the reason
 * `CLAUDE_CONFIG_DIR` is assigned after the overrides above.
 *
 * Announced, never valued: the debug line names the variable only, and the
 * record a user reads is `reportIgnoredLaunchAnthropicBaseUrl` in
 * `config/storage.ts`, on the rejected-layers surface C4.23 uses. RESIDUE: the
 * child's own Bash tools no longer see a launch value either — uniform with a
 * Dock-launched mac, whose boot reset erases a login-shell export already
 * (F1.980).
 */
function dropAmbientAnthropicBaseUrl(
    env: NodeJS.ProcessEnv,
    envOverrides: Record<string, string> | undefined,
): void {
    if (envOverrides?.ANTHROPIC_BASE_URL !== undefined) return;
    if (env.ANTHROPIC_BASE_URL === undefined) return;
    debug(
        '[options] F1.966 — dropped ANTHROPIC_BASE_URL from the Claude child environment: this '
        + 'connection names no endpoint, so the child uses the vendor default. The endpoint is the '
        + 'connection\'s, never the launch environment\'s. The value is never logged.',
    );
    delete env.ANTHROPIC_BASE_URL;
}

/**
 * F1.825 — the markers of the Claude Code session that LAUNCHED this app
 * ({@link CLAUDE_INHERITED_SESSION_MARKER_ENV_KEYS}, whose header carries the
 * measurement) describe that session, never this child, so the child starts
 * without them and the SDK re-stamps its own entrypoint. Child env only (P3.300);
 * one `debug()` line names what was dropped, never a value.
 */
function dropInheritedClaudeSessionMarkers(env: NodeJS.ProcessEnv): void {
    const dropped = CLAUDE_INHERITED_SESSION_MARKER_ENV_KEYS.filter(key => env[key] !== undefined);
    if (dropped.length === 0) return;
    for (const key of dropped) delete env[key];
    debug(
        `[options] F1.825 — dropped ${dropped.join(', ')} from the Claude child environment: `
        + 'they mark the Claude Code session that launched this app, not this one.',
    );
}
