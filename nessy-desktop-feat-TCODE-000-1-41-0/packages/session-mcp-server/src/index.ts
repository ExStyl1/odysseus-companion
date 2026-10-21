#!/usr/bin/env node
/**
 * Session MCP Server
 *
 * This MCP server provides session-scoped tools to Codex via stdio transport.
 * It uses the shared handlers from @nessy-agent/session-tools-core to ensure
 * feature parity with Claude's session-scoped tools.
 *
 * Callback Communication:
 * Tools that need to communicate with the main Electron process (e.g., SubmitPlan
 * triggering a plan display, OAuth triggers pausing execution) send structured
 * JSON messages to stderr with a "__CALLBACK__" prefix. The main process monitors
 * stderr and handles these callbacks.
 *
 * Usage: node session-mcp-server.js --session-id <id> --workspace-root <path> --plans-folder <path> --config-root <path>
 *
 * Arguments (not every flag — the argv loop in `main()` is the complete list):
 *   --session-id: Unique session identifier
 *   --session-path <absolute path>: F1.765 — THIS SESSION's own folder (storage v2); see `createCodexContext`.
 *   --workspace-root: Path to workspace folder
 *   --plans-folder: Path to session's plans folder
 *   --config-root: Trusted Nessy config root
 *   --host-callback-port: T5 host-callback bridge port (loopback). Present only
 *     when the host started a bridge for this session; it turns the five
 *     scheduling/watching tools from "unavailable" into real calls onto the
 *     session's own cron and monitor ports.
 *   --advisor-consult: P3.13 — the host serves `advisor/consult` on that bridge
 *     AND the `advisorEnabled` setting is on. Two facts in one flag because
 *     either one alone is the wrong surface: no route means a tool with nowhere
 *     to land, and a disabled advisor must be INVISIBLE rather than advertised
 *     in order to answer "the advisor is turned off". Meaningless without
 *     `--host-callback-port`, which is where its route lives.
 *   --memory-scope-write <true|false>: D1.426 — THIS CHAT's own memory write
 *     axis, which is host state (`SessionMemoryScopeOverride`) no other channel
 *     carries here. Absent means the chat set no axis of its own and the
 *     app-wide switch decides alone, which is every session spawned before this
 *     flag existed. See `codexMemoryWriteAxis`.
 *   --memory-app-write <true|false>: F1.118 — the APP-WIDE memory switch, as
 *     the HOST reads it. Emitted only for an OFF switch, because ON is the
 *     default on both sides and the state in which nothing withholds a write.
 *     It is what answers the question the ground comparison below cannot ask on
 *     a host that moved its config directory. See `codexMemoryWriteAxis`.
 *   (F1.161 / F1.174 — these flags have a CLASS, and the one statement of it is
 *   `buildSessionMcpSpec`'s own docblock in `shared/agent/codex-agent.ts`, under
 *   §"The argv classification": which carry this chat's own state, which are a
 *   setting resolved per session (both move mid-session and are corrected in a
 *   RUNNING child by the host's turn-head argv comparison), which describe the
 *   spawn and which are constant. Three sites must agree per flag — that
 *   emitter, the argv loop in `main()` below, and `createCodexContext`'s
 *   binding — so read the classification before adding a fourth flag here.)
 *   --working-directory <absolute path>: D1.372 — THIS SESSION's project
 *     directory, which is host state (`session.workingDirectory`) no other
 *     channel carries here and the one thing `remember` with `scope: "project"`
 *     resolves from. Absent means this session chose no project, which is the
 *     state pi and claude are in when they refuse that scope by name — so an
 *     absent flag keeps the refusal rather than guessing a directory.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isDeveloperFeedbackEnabled } from '@nessy-agent/shared/feature-flags';
import { createSessionCredentialManager } from './credential-reader.ts';
import {
  createAutomationEntry,
  listAutomationEntries,
  updateAutomationEntry,
  validateAutomationConfigFile,
  validateAutomations, formatAutomationListText,
} from '@nessy-agent/shared/automations';
import { atomicWriteFileSync } from '@nessy-agent/shared/utils';
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths';
// D1.371 — PRICED BEFORE IT WAS ADDED, and it costs nothing: this module is
// already in this subprocess's graph at HEAD. `@nessy-agent/shared/automations`
// is imported above at module scope, its barrel re-exports `automation-system.ts`
// and `validation.ts`, and `automation-system.ts` imports THIS VERY FUNCTION
// (`import { getMemoryEnabled } from '../config/storage.ts'`). Measured in-repo
// (provenance asserted, so it is not the out-of-repo-rig trap): importing the
// automations barrel costs 50 177 ms cold, and importing `config/storage`
// AFTER it costs 1 ms.
//
// The wall-clock A/B/A/B on the whole child boot is recorded here as the
// weaker instrument it turned out to be: A 25 162 / B 25 524 / A 29 133 /
// B 70 762 ms, `user` 0.07–0.13 s and `sys` 0.03–0.04 s on every arm. Adjacent
// pairs disagree by +362 ms and +41 629 ms on an import that adds no module, so
// that spread is the page cache and the load, not this line — which is exactly
// why the structural reading above is the one to trust.
import { getMemoryEnabled } from '@nessy-agent/shared/config/storage';
// D1.426 — the same resolver `claude-context.ts`, `SessionManager` and
// `codex-agent.ts` read, so the per-chat axis cannot mean one thing here and
// another there. Types and two pure functions, no imports of its own.
import { resolveSessionMemoryScope } from '@nessy-agent/shared/agent/memory/session-memory-scope';
// F1.104 — the one resolver for the user-scope memory index
// (`getAutoMemoryDirectory() ?? CONFIG_DIR`, P6.390(2)), so this tool cannot
// answer a different directory from the loader, the cleanup pass and the memory
// RPC. See `codexUserMemoryPath` for the ground rule that gates it here.
import { getUserMemoryFilePath } from '@nessy-agent/shared/agent/memory';
import {
  validateAll,
  validateAllPermissions,
  validateAllSources,
  validateConfig,
  validatePreferences,
  validateSkill,
  validateSource,
  validateSourcePermissions,
  validateStatuses,
  validateToolIcons,
} from '@nessy-agent/shared/config/validators';
// Import from session-tools-core
import {
  type SessionToolContext,
  type ToolResult,
  type CallbackMessage,
  type AuthRequest,
  type SourceConfig,
  type ValidatorInterface,
  // Registry
  AutomationCreateSchema,
  AutomationUpdateSchema,
  getSessionToolRegistry,
  getToolDefsAsJsonSchema,
  SESSION_TOOLS_REQUIRING_HOST_CALLBACK,
  SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK,
  SESSION_BACKEND_TOOLS_BRIDGED_BY_HOST_CALLBACK, MEMORY_FILE_NAME,
  // Helpers
  loadSourceConfig as loadSourceConfigFromHelpers,
  errorResponse,
  successResponse,
  withoutEmptyStructuredContent,
} from '@nessy-agent/session-tools-core';
import { createBridgeAdvisorConsult, createBridgeCronPort, createBridgeGetSessionInfo, createBridgeResolveLabels, createBridgeResolveStatus, createBridgeSetSessionLabels, createBridgeSetSessionStatus,
  createBridgeArchiveSession, createBridgeCreateBoardTask, createBridgeAppendProjectMemory, createBridgeGoalPort, createBridgePages, createBridgeMcpSources, createBridgeDecide, createBridgeListArtifacts, createBridgeListSessions, createBridgeMonitorPort, createBridgeNotificationPort, createBridgePublishArtifact, createBridgeReviewDiff, createBridgeSendAgentMessage, createBridgeWorktreePort } from './host-callback-bridge-client.ts';

// ============================================================
// Types
// ============================================================

interface SessionConfig {
  configRoot: string; userMemoryRoot?: string; // F1.194 `--user-memory-root`; see codexUserMemoryPath
  sessionId: string; sessionPath?: string; // F1.765 `--session-path`, the host's storage-v2 session folder; see createCodexContext
  workspaceRootPath: string;
  plansFolderPath: string;
  // F1.1135 — `callbackPort` (`--callback-port`) is gone: no host passed it and no server answered it.
  /**
   * T5 — the codex host-callback bridge's port (`--host-callback-port`).
   *
   * The only callback port left: the older `--callback-port` `/call-llm` +
   * `/spawn-session` channel had no producer and no server (F1.710, F1.1135). A bridge
   * port is per-session and ephemeral, so it is read from the spawn arguments
   * and NEVER from the environment — an inherited value would name another
   * session's bridge, which the host would reject, one tool call at a time.
   */
  hostCallbackPort?: string;
  /**
   * P3.13 — `--advisor-consult`. See the header: it means the host serves the
   * `advisor/consult` route AND the advisor is enabled for this session.
   */
  advisorConsultBridge?: boolean;
  /**
   * D1.426 — `--memory-scope-write`, this chat's own write axis. `undefined` is
   * "the chat set none", not "off": the resolver reads an unset axis as the
   * app-wide switch, so absence is HEAD's behaviour exactly.
   */
  memoryScopeWrite?: boolean;
  /**
   * F1.118 — `--memory-app-write`, the APP-WIDE switch as the host reads it.
   * `undefined` is "the host did not need to say", which means ON: the emitter
   * writes only the OFF position, exactly as `codexMemoriesOption` writes only
   * the OFF position of codex's own `[memories]` table.
   */
  memoryAppWrite?: boolean;
  /**
   * D1.372 — `--working-directory`, this session's project directory.
   * `undefined` is "this session chose no project", not "the host forgot": the
   * emitter (`buildSessionMcpSpec`) sends the flag only for a session that has
   * one, so absence is the state `handleRemember` refuses `scope: "project"` in
   * — by name, on all three runtimes — instead of writing to a guessed place.
   */
  workingDirectory?: string;
}

// F1.1135 — `CALLBACK_TOOL_TIMEOUT_MS` went with the `--callback-port` channel; the bridge has its own ceiling.

// ============================================================
// Callback Communication
// ============================================================

/**
 * Send a callback message to the main process via stderr.
 * These messages are parsed by the main process to trigger UI actions.
 */
function sendCallback(callback: CallbackMessage): void {
  // Write to stderr as a single line JSON (main process parses this)
  console.error(`__CALLBACK__${JSON.stringify(callback)}`);
}

// ============================================================
// Codex Context Factory
// ============================================================

/**
 * P6.885 — the FULL Zod validators on codex, but only when the ground agrees.
 *
 * ## What was wrong
 *
 * `config_validate` fell back to `validateJsonFileHasFields` here because
 * `ctx.validators` was absent, and P6.879 measured what that costs: `config`
 * checked ONE field, and `preferences`/`permissions`/`automations` checked none
 * at all — "the file parses as JSON" answered as `✓ Validation passed`. The
 * comment at the bottom of {@link createCodexContext} blamed Electron
 * internals; that was never true of these ten functions, which are plain Node
 * and zod.
 *
 * ## The real blocker, and the measurement
 *
 * The shared validators resolve `CONFIG_FILE`/`PREFERENCES_FILE` from their own
 * module-level `CONFIG_DIR` (`config/paths.ts`, `NESSY_CONFIG_DIR` or
 * `~/.nessy-agent`, frozen at import), while every handler here reads
 * `ctx.configRoot` — the `--config-root` argv the host passes as ITS
 * `CONFIG_DIR`. In this subprocess those are not the same value, and the reason
 * is codex's, not ours: `create_env_for_mcp_server`
 * (`codex-rs/rmcp-client/src/utils.rs`, `rust-v0.150.1`) builds a stdio MCP
 * server's environment from an ALLOWLIST — `DEFAULT_ENV_VARS` is HOME, LOGNAME,
 * PATH, SHELL, USER, `__CF_USER_TEXT_ENCODING`, LANG, LC_ALL, TERM, TMPDIR, TZ
 * — plus names the server's own `env_vars` config lists, plus its literal `env`
 * overrides. `NESSY_CONFIG_DIR` is in none of those, and
 * `CodexMcpServerSpec.env` is not set for this server, so it CANNOT arrive.
 *
 * Measured on this rig with a throwaway child, both arms: with
 * `NESSY_CONFIG_DIR` in the child env, shared's `CONFIG_DIR` is that value; with
 * only codex's `DEFAULT_ENV_VARS` set, it is `~/.nessy-agent`. So the two
 * grounds agree on an ordinary install and DIVERGE on every host that moved its
 * config directory — every multi-instance dev run and every test rig.
 *
 * ## Why a gate rather than a fix on either side
 *
 * A validator silently reporting on a file the caller did not ask about is
 * worse than one that says what it checked, which is the whole point of P6.879.
 * So the ground is compared, once, here: equal supplies the full interface and
 * codex answers exactly as claude does; unequal supplies nothing and the
 * handler keeps its basic tier AND its naming. Neither state is silent.
 *
 * The clean way to open the gate always is codex's own mechanism, not ours:
 * `buildSessionMcpSpec` (`shared/agent/codex-agent.ts`) can set the spec's
 * `env` to `{ NESSY_CONFIG_DIR: CONFIG_DIR }`, which `config-writer.ts` already
 * emits and `create_env_for_mcp_server` already honours as `extra_env`. That is
 * one line in a file this lane does not hold; the gate is correct with or
 * without it, which is why it is written this way round.
 *
 * ## Mirrored, deliberately
 *
 * The wiring below is `shared/agent/claude-context.ts`'s, call for call. This
 * paragraph used to flag `validateAll(wsPath)` as a mirrored GAP — one argument
 * where the signature took two, leaving skills, statuses, labels, automations
 * and permissions out of the `all` target on both runtimes. P6.894 settled it
 * the other way round: the second parameter was never a second value (its
 * `workspaceId` name was wrong — `validateAllSources` resolves it through
 * `getWorkspaceSourcesPath(rootPath)`), so `validateAll` now takes the one
 * workspace root path this call has always passed and runs all six
 * workspace-scoped validators with it. Both contexts were already correct; there
 * is no second argument left for them to drift over.
 *
 * The two contexts satisfy one interface, so TypeScript pins their SHAPE; the
 * argument wiring is the part that can still drift, and this paragraph is what a
 * reader diffing them is owed.
 */
function createCodexValidators(configRoot: string): ValidatorInterface | undefined {
  if (CONFIG_DIR !== configRoot) return undefined;
  return {
    validateConfig: () => validateConfig(),
    validateSource: (wsPath: string, slug: string) => validateSource(wsPath, slug),
    validateAllSources: (wsPath: string) => validateAllSources(wsPath),
    validateStatuses: (wsPath: string) => validateStatuses(wsPath),
    validatePreferences: () => validatePreferences(),
    validatePermissions: (wsPath: string, sourceSlug?: string) => (
      sourceSlug ? validateSourcePermissions(wsPath, sourceSlug) : validateAllPermissions(wsPath)
    ),
    validateAutomations: (wsPath: string) => validateAutomations(wsPath),
    validateToolIcons: () => validateToolIcons(),
    validateAll: (wsPath: string) => validateAll(wsPath),
    validateSkill: (wsPath: string, slug: string) => validateSkill(wsPath, slug),
  };
}

/**
 * D1.371 — the WRITE axis of the memory switch, on the one runtime it never
 * reached.
 *
 * `handleRemember` refuses only on an explicit `false`
 * (`if (ctx.memoryEnabled === false)`), and this factory bound no
 * `memoryEnabled` at all, so a user who had turned memory OFF still had
 * memories written by a codex session — while `createClaudeContext` binds
 * `get memoryEnabled() { return resolveMemoryWriteAxis(); }` and Pi resolves the
 * same switch host-side through that same context. A privacy control that
 * silently stops controlling on one runtime is the divergence class this fork
 * pays for most, so the key is bound rather than left absent.
 *
 * ## The GROUND, and why it is compared rather than assumed
 *
 * Exactly {@link createCodexValidators}'s gate, for exactly its reason:
 * `getMemoryEnabled()` resolves `CONFIG_FILE` from shared's module-level
 * `CONFIG_DIR`, while `--config-root` is the host's. In this subprocess those
 * are the same value on an ordinary install and DIFFERENT on any host that
 * moved its config directory, because `create_env_for_mcp_server`
 * (`codex-rs/rmcp-client/src/utils.rs`) builds a stdio MCP server's environment
 * from an allowlist that does not carry `NESSY_CONFIG_DIR`. Answering from the
 * wrong directory would be worse than not answering: it would refuse a write the
 * user never turned off, or permit one they did.
 *
 * Unequal grounds therefore return `undefined` — the key stays absent and the
 * write proceeds, which is HEAD's behaviour exactly. Fail-CLOSED was considered
 * and declined: it would break `remember` outright on every dev rig and every
 * moved-config install, which is a larger fault than the one being closed, and
 * the honest statement of the residue is this docblock plus the arm in
 * `remember-scopes.test.ts` that drives the equal-ground case.
 *
 * ## D1.426 — the PER-CHAT axis, which used to be residue #1 here
 *
 * That residue read: *"the PER-CHAT override is host state that no argv carries
 * into this subprocess ... A chat that closed its own memory can still write one
 * through a codex `remember`."* It was true of every runtime, not only this one
 * — `SessionManager`'s backend config never carried `memoryScopeOverride` at
 * all — and closing it host-side left codex as the one runtime whose `remember`
 * is served by a CHILD. So the axis crosses as `--memory-scope-write`, the
 * shape `--advisor-consult` already uses for host state a child cannot read.
 *
 * Resolved through `resolveSessionMemoryScope`, never by a second rule of its
 * own, so this tool and codex's own `[memories]` table
 * (`codex-agent.ts`'s `codexMemoriesOption`) answer the same question the same
 * way inside one session. Its precedence is "in either direction"
 * (`settings-reference.md#automemoryenabled`: the per-session override *"takes
 * precedence over this key for one session, in either direction"*), so a chat
 * that CLOSED its axis is refused while the app-wide switch is on, and a chat
 * that OPENED its own is saved while the app-wide switch is off. A floor was
 * considered and declined: the session menu renders the chat's axis with a
 * check mark of its own, so flooring it would show a control that does nothing
 * — the exact defect D1.426 is, one direction over — and would make this tool
 * disagree with the thread's own memory mode.
 *
 * ## The three residues, stated rather than left to be discovered
 *
 * 1. The argv is read ONCE, at spawn. codex re-spawns its MCP children on
 *    `config/mcpServer/reload` (P3.28 measured it at 7–32 ms), so a mid-session
 *    flip could be carried by the same seam that carries `--advisor-consult`;
 *    until a row wires it, a flip lands at the next runtime start — exactly
 *    when codex's OWN per-thread mode lands, because `applyCodexThreadMemoryMode`
 *    is sent at thread open. One rule for both, rather than two. **CLOSED by
 *    F1.116 (2026-09-20):** the host compares the WHOLE `spec.args` at the head
 *    of every turn and re-spawns this child through that pair, so every value on
 *    this argv — including `--memory-app-write` below — is corrected on the same
 *    thread instead of at the next runtime start.
 * 2. Only the WRITE axis crosses. This subprocess loads no memories: its single
 *    gate is `handleRemember`'s `ctx.memoryEnabled`, so a read-axis flag would
 *    be a surface to keep in sync for nothing.
 * 3. An unreadable switch reads as ON, which is `claude-context.ts`'s own rule
 *    verbatim — a broken config must not silently disable a feature nobody
 *    turned off. The chat's own axis still applies on top of it.
 *
 * ## F1.118 — the app-wide half now crosses by argv too, so unequal grounds are
 * no longer unanswerable
 *
 * This paragraph used to read: *"With UNEQUAL grounds the app-wide half stays
 * unanswerable ... a chat that opened one is left unanswered rather than
 * asserted `true`."* True, and it left a real hole: an install whose config
 * directory had moved kept WRITING on an app-wide OFF, because `undefined` means
 * the key stays absent and `handleRemember` refuses only on an explicit `false`.
 * Fail-closed was the alternative D1.371 declined, for the stated reason above.
 *
 * The third option is the one taken: **the host knows the answer, so the host
 * says it.** `--memory-app-write` carries the app-wide switch as
 * `buildSessionMcpSpec` read it (`codexAppMemoryWriteArgs`, `codex-agent.ts`),
 * emitted only for an OFF switch — ON is the default on both sides and the
 * state in which nothing withholds a write, so an ordinary session's argv is
 * byte-identical to the one this subprocess has always been spawned with, and
 * nothing fail-closes on a dev rig.
 *
 * The two axes cross SEPARATELY and are resolved ONCE, here, so the documented
 * either-direction precedence holds identically on both grounds. The ordering
 * above is deliberate: with the grounds EQUAL the live read still wins, because
 * it is the fresher of two facts that cannot disagree for long — the flag is
 * re-derived at every turn head by the same comparison residue #1 names.
 *
 * The only state left in the last branch is a child spawned by something other
 * than `buildSessionMcpSpec`, and it keeps HEAD's answer exactly.
 *
 * A FUNCTION rather than a value, read through a getter below: this context is
 * built once per process and the switch can move under it (`loadStoredConfig`
 * reads the file on every call and caches nothing, which is what makes the
 * liveness assertion in the suite meaningful).
 */
function codexMemoryWriteAxis(
  configRoot: string,
  chatWriteAxis: boolean | undefined,
  appWriteAxis: boolean | undefined,
): boolean | undefined {
  let globalEnabled: boolean;
  if (CONFIG_DIR === configRoot) {
    // The grounds agree, so the LIVE read wins over the spawn-time snapshot: it
    // is the fresher of the two facts, and this getter is called per `remember`
    // while the argv is fixed for the child's lifetime. They cannot disagree for
    // long either way — the turn-head argv comparison re-spawns the child.
    try {
      globalEnabled = getMemoryEnabled();
    } catch {
      globalEnabled = true;
    }
  } else if (appWriteAxis !== undefined) {
    globalEnabled = appWriteAxis;
  } else {
    // Neither ground nor flag: this subprocess's behaviour before F1.118, and
    // the only state left that reaches it is a child nobody spawned from
    // `buildSessionMcpSpec`.
    return chatWriteAxis === false ? false : undefined;
  }
  return resolveSessionMemoryScope({
    globalEnabled,
    ...(chatWriteAxis === undefined ? {} : { override: { write: chatWriteAxis } }),
  }).write;
}

/**
 * F1.104 (origin D1.427) — the USER-scope memory index, resolved the way the
 * rest of this app resolves it, on the same GROUND rule
 * {@link codexMemoryWriteAxis} uses.
 *
 * `getUserMemoryFilePath` is the one answer to where this app keeps that index
 * — `getAutoMemoryDirectory() ?? CONFIG_DIR` (P6.390(2)) — and the loader, the
 * cleanup pass and the memory RPC all read it. Joining `--config-root` here
 * instead gave a user who had MOVED their memory directory a second, invisible
 * index: the agent's own `remember` wrote one file while everything that LOADS
 * memories read another. The split was silent because the two paths are the
 * same file for everyone who set nothing, which is almost everyone.
 *
 * ## Why unequal grounds keep the old answer rather than the setting
 *
 * `getAutoMemoryDirectory` resolves `CONFIG_FILE` from shared's module-level
 * `CONFIG_DIR`, while `--config-root` is the host's. In this subprocess those
 * are the same value on an ordinary install and DIFFERENT on any host that
 * moved its config directory, because `create_env_for_mcp_server`
 * (`codex-rs/rmcp-client/src/utils.rs`) builds a stdio MCP server's environment
 * from an allowlist that does not carry `NESSY_CONFIG_DIR`. Reading the setting
 * out of the wrong config file would move the index to a directory the host
 * never chose, so unequal grounds keep `join(configRoot, …)` — HEAD's answer,
 * and claude's file only while `autoMemoryDirectory` is unset. SET, the host now
 * states its root by argv (`--user-memory-root`, F1.194), and that answers here.
 *
 * A FUNCTION read through a getter, for `codexMemoryWriteAxis`'s reason: this
 * context is built once per process and the setting can move under it.
 */
function codexUserMemoryPath(configRoot: string, userMemoryRoot?: string): string {
  if (CONFIG_DIR !== configRoot) return join(userMemoryRoot ?? configRoot, MEMORY_FILE_NAME);
  return getUserMemoryFilePath();
}

/**
 * Create a SessionToolContext for the Codex MCP server.
 * This provides the context needed by all handlers.
 */
function createCodexContext(config: SessionConfig, sandbox: CodexSandboxReadArgs = {}): SessionToolContext {
  const { configRoot, sessionId, workspaceRootPath, plansFolderPath } = config;

  // File system implementation
  const fs = {
    exists: (path: string) => existsSync(path),
    readFile: (path: string) => readFileSync(path, 'utf-8'),
    readFileBuffer: (path: string) => readFileSync(path),
    writeFile: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
    atomicWriteFile: (path: string, content: string) => atomicWriteFileSync(path, content),
    isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
    readdir: (path: string) => readdirSync(path),
    stat: (path: string) => {
      const stats = statSync(path);
      return {
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
      };
    },
  };

  // Callback implementation using stderr
  const callbacks = {
    onPlanSubmitted: (planPath: string) => {
      sendCallback({
        __callback__: 'plan_submitted',
        sessionId,
        planPath,
      });
    },
    onAuthRequest: (request: AuthRequest) => {
      sendCallback({
        __callback__: 'auth_request',
        ...request,
      });
    },
  };

  // Trusted bundled subprocess reads the encrypted store directly. It never
  // materializes decrypted credentials on disk and re-reads on every call.
  const credentialManager = createSessionCredentialManager(configRoot);

  // P6.885 — the full Zod validators, or nothing. See the factory's own doc for
  // the ground comparison and the codex source it rests on.
  const validators = createCodexValidators(configRoot);

  // Session paths for transform_data / render_template
  const sessionsDir = config.sessionPath ?? join(workspaceRootPath, 'sessions', sessionId);
  const sessionDataDir = join(sessionsDir, 'data');
  // F1.765 — `sessionsDir` is the session's OWN folder, `<config>/sessions/<ws>/<sid>/`,
  // which the host states by argv (`--session-path`): it is where pi and claude
  // bind `sessionPath`/`dataPath` (`getSessionDirPath`) and what every host
  // reader opens (`getSessionDataPath` — the session-memory loader, the prompt's
  // data-folder line, the memory cleanup pass). This child cannot derive it: its
  // argv carries no workspace ID, and its own `CONFIG_DIR` can differ from the
  // host's (`NESSY_CONFIG_DIR` is not in codex's MCP env allowlist). The
  // `join(workspaceRootPath, 'sessions', …)` fallback is the pre-storage-v2
  // layout, kept ONLY for an OLDER host that sends no `--session-path`: on the
  // 1.41.0 release sitting it put `remember` (scope session) — and with it every
  // reader below (`transform_data`, `render_template`, `script_sandbox`,
  // `todo_write`, `send_user_file`'s roots) — in a `workspaces/<ws>/sessions/`
  // tree no host reader opens (SIT-b, RS-105 A4).

  // T5/P2.2 — the three host ports, present only when the host started a bridge
  // for this session. Absent otherwise, which is what makes the bridged tools
  // report unavailability through their own handlers instead of guessing.
  const bridge = config.hostCallbackPort
    ? { port: config.hostCallbackPort, sessionId }
    : undefined;

  // Build context
  return {
    configRoot,
    sessionId,
    workspacePath: workspaceRootPath,
    get sourcesPath() { return join(workspaceRootPath, 'sources'); },
    get skillsPath() { return join(workspaceRootPath, 'skills'); },
    plansFolderPath,
    sessionPath: sessionsDir,
    dataPath: sessionDataDir,
    // D1.359 — the USER scope's memory index, and its absence is why a codex
    // session could not answer `remember` with `scope: "user"` AT ALL.
    //
    // MEASURED over the real MCP stdio transport (2026-09-18): the call returns
    // immediately — nothing hangs, the bridge is not involved — with
    // `[ERROR] remember with scope=user requires userMemoryPath in context.`,
    // `handleRemember`'s named refusal for a scope this context never bound,
    // while `scope: "session"` answered `Saved memory to …` in the same
    // exchange as the control. That scope is the one AUTO MEMORY itself uses
    // (`memory.md` §Auto memory: Claude "accumulates knowledge across sessions
    // without you writing anything"), and the host writes its index under
    // `CONFIG_DIR`, so the documented feature had no reachable file on codex.
    //
    // F1.104 — resolved by `codexUserMemoryPath`, whose docblock carries the
    // whole rule: `join(configRoot, …)` is the FLOOR (it names the same file
    // claude binds on a host whose config directory moved, where this
    // subprocess's own module-level `CONFIG_DIR` cannot follow, because
    // `NESSY_CONFIG_DIR` is not in codex's env allowlist), and the operator's
    // `autoMemoryDirectory` is honoured on top of it only when the two grounds
    // are equal. `createCodexValidators` above carries that measurement.
    //
    // D1.372 — the PROJECT scope's index, and the spawn flag this comment used
    // to say was missing now carries it. `handleRemember` reads
    // `ctx.workingDirectory`; the host emits `--working-directory` only for a
    // session that HAS a project, so the key below is present exactly then and
    // absent otherwise — and an absent key is still the named refusal
    // (`remember with scope=project requires workingDirectory in context.`),
    // which is what pi and claude answer for the same session. Spread rather
    // than assigned, so "no project" is the key missing rather than a key
    // holding `undefined`.
    get userMemoryPath() { return codexUserMemoryPath(configRoot, config.userMemoryRoot); },
    ...(config.workingDirectory ? { workingDirectory: config.workingDirectory } : {}),
    // D1.371 + D1.426 + F1.118 — see `codexMemoryWriteAxis` for the ground
    // comparison, the two axes the argv carries, the residues and why an
    // unreadable switch reads as ON.
    get memoryEnabled() { return codexMemoryWriteAxis(configRoot, config.memoryScopeWrite, config.memoryAppWrite); },
    callbacks,
    fs,
    // T5/P2.2 — `cronPort`, `monitor` and `goalPort` are the SAME per-session
    // ports `SessionManager` binds for Pi and Claude, reached over the bridge
    // instead of in-process. Written conditionally rather than as no-ops: an
    // absent port is the handlers' documented "unavailable for this backend"
    // path.
    ...(bridge
      ? {
          cronPort: createBridgeCronPort(bridge),
          monitor: createBridgeMonitorPort(bridge),
          goalPort: createBridgeGoalPort(bridge),
          // P6.45-adjacent — the same per-session closure `SessionManager` binds
          // for Pi and Claude. Without it a codex session could LIST its peer
          // sessions (`list_sessions` needs no host callback) and could not
          // write to one, so a switch to codex removed half a capability and
          // left the other half advertised.
          sendAgentMessage: createBridgeSendAgentMessage(bridge),
          // P3.222 — the ROSTER half, and the residue `6173c9778` left. Those
          // two tools were never gated, so they were ADVERTISED on both codex
          // surfaces while this factory bound neither closure: measured
          // 2026-09-02, `list_sessions` answered "not available in this context"
          // on every call, bridged or not. `cross-session-messaging.md` names
          // ONE capability with two tools, so the halves are bound together.
          listSessions: createBridgeListSessions(bridge),
          getSessionInfo: createBridgeGetSessionInfo(bridge),
          // P6.466 — the archive verb. Bound here for a reason the roster pair
          // did not have: the approval card `archive_session` must raise in
          // every permission mode is raised by the HOST closure this reaches,
          // because neither `INTERACTION_ONLY_TOOLS` nor
          // `findNonNegotiableFloors` is on codex's answer path for a session
          // MCP tool (measured — see the route's docblock). Advertised without
          // this binding, the verb would be offered with no card behind it.
          archiveSession: createBridgeArchiveSession(bridge),
          // UA1.18 — the t-artifacts pair. Both tools are in `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`; the publish
          // card is raised by the HOST closure this reaches (archive_session's seam), so the pair is bound together
          // with the offer from the same `bridge` value and a codex spawn without the bridge has neither.
          publishArtifact: createBridgePublishArtifact(bridge),
          listArtifacts: createBridgeListArtifacts(bridge),
          // UA3.5 — the board task tool, bound with its offer from the same `bridge` value; the restrictions on the
          // caller are the host closure's, so a codex spawn without the bridge has neither the tool nor the binding.
          createBoardTask: createBridgeCreateBoardTask(bridge),
          // UB1.12 — the project-memory append closure, bound with its offer from the same `bridge` value (the tool
          // is in `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`, offered unconditionally): the project read, the dated
          // heading and the one O_APPEND write are the host closure's, so a codex spawn without the bridge has
          // neither the tool nor the binding.
          appendProjectMemory: createBridgeAppendProjectMemory(bridge),
          // UA6.3 — the six page tools as ONE grouped port (`ctx.pages`), bound with their offer from the same `bridge`
          // value; storage and `delete_page`'s card are the host closure's, so a codex spawn without the bridge has
          // neither the tools nor the binding.
          pages: createBridgePages(bridge),
          // UB7.11 — the MCP prompt pair as ONE grouped port (`ctx.mcpSources`, upstream v0.15.1's shape), bound with
          // its offer from the same `bridge` value; the enabled-source check, the pool reads, the rendering and the
          // large-result guard are the host closure's, so a codex spawn without the bridge has neither the tools nor
          // the binding.
          mcpSources: createBridgeMcpSources(bridge),
          // UB6.11 — the decide port (upstream v0.15.1's ctx.decide), bound with its offer from the same `bridge`
          // value; the resolution, the fail-closed "not enabled" answer and the decision record are the host closure's.
          decide: createBridgeDecide(bridge),
          // UA1.3 — the self-management pair. Both tools are in
          // `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`, so a bridged codex session is
          // OFFERED them; the four members are bound together so the handlers
          // resolve (and refuse a closed status) exactly as on Pi and Claude, and
          // the set closure on the host re-checks both rules itself.
          resolveStatus: createBridgeResolveStatus(bridge),
          setSessionStatus: createBridgeSetSessionStatus(bridge),
          resolveLabels: createBridgeResolveLabels(bridge),
          setSessionLabels: createBridgeSetSessionLabels(bridge),
          // P3.276 — the one host-computed review diff, on codex. The tool is
          // in `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`, so it is ADVERTISED to
          // a bridged codex session; binding it here is what stops that offer
          // being the "not available in this context" the roster pair was.
          reviewDiff: createBridgeReviewDiff(bridge),
          // P6.184 — the desktop notification, on the runtime that has none of
          // its own. Measured on both shipped mac `codex-app-server` binaries:
          // `push_notification` 0, `user_notification` 0, "desktop
          // notification" 0, against `notification` 101/147 and `thread/start`
          // 5/5 as controls. Bound together with the OFFER flag below, which is
          // derived from the same `bridge` value, so the tool cannot be
          // advertised without the route behind it.
          notificationPort: createBridgeNotificationPort(bridge),
          // P6.137 — the worktree family, on the runtime that publishes no
          // worktree surface at all (`worktree` 0 files in
          // `packages/codex-protocol`, `WorktreeCreate` 0 in the shipped
          // `codex-app-server`). The context key is `worktree`, which is what
          // `handleEnterWorktree` and its siblings read; the FLOOR the enter
          // needs lives on the host side of the route, because
          // `runPreToolUseChecks` — where `evaluateWorktreeApproval` runs — has
          // zero call sites in `codex-agent.ts`. Bound together with the OFFER
          // flag below, derived from the same `bridge` value, so the three
          // tools cannot be advertised without the routes behind them.
          worktree: createBridgeWorktreePort(bridge),
        }
      : {}),
    automationManager: createAutomationManager(workspaceRootPath),
    loadSourceConfig: (sourceSlug: string): SourceConfig | null => {
      return loadSourceConfigFromHelpers(workspaceRootPath, sourceSlug);
    },

    // Credential manager reads the current encrypted host store on demand.
    credentialManager,

    // Preferences: write directly to preferences.json
    updatePreferences: (updates: Record<string, unknown>) => {
      const prefsPath = join(configRoot, 'preferences.json');
      try {
        let current: Record<string, unknown> = {};
        if (existsSync(prefsPath)) {
          current = JSON.parse(readFileSync(prefsPath, 'utf-8'));
        }
        const merged = {
          ...current,
          ...updates,
          location: updates.location
            ? { ...(current.location as Record<string, unknown> || {}), ...(updates.location as Record<string, unknown>) }
            : current.location,
          updatedAt: Date.now(),
        };
        writeFileSync(prefsPath, JSON.stringify(merged, null, 2), 'utf-8');
      } catch (err) {
        console.error('Failed to update preferences:', err);
      }
    },

    // Developer feedback: write one JSON file per entry to {configDir}/feedback/
    submitFeedback: (feedback) => {
      const feedbackDir = join(configRoot, 'feedback');
      mkdirSync(feedbackDir, { recursive: true });
      const filePath = join(feedbackDir, `${feedback.id}.json`);
      writeFileSync(filePath, JSON.stringify(feedback, null, 2), 'utf-8');
    },

    // P6.885 — written conditionally, never as an empty object: `config_validate`
    // branches on the PRESENCE of `validators`, and an object that answered
    // nothing would make the basic tier unreachable while validating nothing.
    ...(validators ? { validators } : {}),

    // Note: saveSourceConfig and renderMermaid are not available in the Codex
    // context (they require Electron internals). `validators` was on this list
    // until P6.885 and did not belong: the ten shared validators are plain Node
    // and zod, and what actually kept them out was the config-root ground, which
    // `createCodexValidators` now compares instead of assuming.

    // F1.191 / F1.196 — what `script_sandbox`'s profile denies, as the HOST
    // resolved it. See {@link CodexSandboxReadArgs} for why this child cannot
    // resolve either half itself.
    ...(sandbox.credentialHome ? { credentialHomeDir: () => sandbox.credentialHome as string } : {}),
    ...(sandbox.readsFenced === undefined
      ? {}
      : {
          sandboxReadFloor: () => ({
            deniedReadRoots: sandbox.deniedReadRoots ?? [],
            readsFencedToWorkingDirectory: sandbox.readsFenced === true,
          }),
        }),
  };
}

/**
 * F1.191 + F1.196 — `script_sandbox`'s read policy on codex, carried by ARGV.
 *
 * On claude and Pi `createClaudeContext` binds two accessors: the host's read
 * policy (`sandboxReadFloor`, F1.107 — `permissions.deniedPaths` projected to
 * roots, plus `blockReadsOutsideWorkingDirectories`) and the LATCHED home the
 * credential floor anchors on (`credentialHomeDir`, F1.191). Neither reached
 * this child, so codex's `script_sandbox` kept the credential floor alone — the
 * tool's receipt said "this runtime declares no read policy" — anchored on
 * whatever `HOME` the child was started with.
 *
 * ## Why this child cannot resolve either half itself (source outranks page)
 *
 * `create_env_for_mcp_server` (`codex-rs/rmcp-client/src/utils.rs`, read at
 * `rust-v0.154.0`, the tag `codex-protocol/manifest.json` pins) builds a stdio
 * MCP server's environment from `DEFAULT_ENV_VARS` — HOME, LOGNAME, PATH,
 * SHELL, USER, `__CF_USER_TEXT_ENCODING`, LANG, LC_ALL, TERM, TMPDIR, TZ —
 * each read with `env::var_os` from codex-app-server's OWN environment, which
 * the host spawned from its `process.env`. So:
 *
 * - `HOME` DOES arrive, and it is the host's LIVE value at app-server spawn: after
 *   a confirmed managed `HOME` that is the administrator's home, and this
 *   child's own latch would capture it. The launch home the credential store
 *   is latched to can only come from the host.
 * - `NESSY_CONFIG_DIR` does NOT arrive, so on a moved-config install this
 *   child's `CONFIG_DIR` is not the host's and a local read of the permissions
 *   config would answer for a different install (the ground `createCodexValidators`
 *   compares, one screen up).
 *
 * ## The flags, and what their absence means
 *
 * `--credential-home <absolute>` (FIXED: the latch never moves), and
 * `--sandbox-reads-fenced <true|false>` plus one `--sandbox-denied-read-root
 * <absolute>` per root (SETTING: resolved per session; the turn-head argv
 * comparison re-spawns this child when they move). The host writes the fence
 * flag ALWAYS, so its presence is "the host declared a policy", possibly an
 * empty one; absent, the context binds nothing and the receipt keeps saying so.
 * A relative path is dropped rather than guessed, the rule every path flag here
 * follows.
 */
interface CodexSandboxReadArgs {
  credentialHome?: string;
  deniedReadRoots?: string[];
  readsFenced?: boolean;
}

function createAutomationManager(workspaceRootPath: string) {
  return {
    list: async (args: Record<string, unknown>) => {
      const entries = await listAutomationEntries(workspaceRootPath);
      const includeDisabled = args.includeDisabled === true;
      const automations = includeDisabled ? entries : entries.filter((entry) => entry.enabled);
      return automationToolResult(formatAutomationListText(automations), { automations }); // F1.1265
    },
    create: async (args: Record<string, unknown>) => {
      // `AutomationManagerInterface` types every method's argument as
      // `Record<string, unknown>`, which erases the shape its only caller —
      // `handleAutomationCreate` — has already established with this exact
      // schema. Something has to bridge that erasure, and the choice is between
      // an assertion and a check: the assertion cannot be wrong out loud (a bag
      // with no `kind`/`actions` would reach `buildMatcher` and write a
      // malformed matcher to disk), the check can. Parsing also makes the
      // schema-vs-`AutomationCreateInput` agreement a COMPILE error if either
      // side drifts, which the cast silently absorbed. A throw here lands in the
      // handler's own try/catch as `automation_create failed: <reason>`.
      const result = await createAutomationEntry(workspaceRootPath, AutomationCreateSchema.parse(args));
      return automationToolResult(`Created automation ${result.automationId} under ${result.event}[${result.matcherIndex}].`, { ...result });
    },
    update: async (args: Record<string, unknown>) => {
      const result = await updateAutomationEntry(workspaceRootPath, AutomationUpdateSchema.parse(args));
      return automationToolResult(`Updated automation ${result.automationId} under ${result.event}[${result.matcherIndex}].`, { ...result });
    },
    validate: async () => {
      const result = await validateAutomationConfigFile(workspaceRootPath);
      return automationToolResult(result.message, result);
    },
  };
}

/**
 * `structuredContent` is `Record<string, unknown>` on `ToolResult`, and an
 * `interface` — unlike an anonymous object type — gets no implicit index
 * signature, so `AutomationManagementResult` is not assignable to it even
 * though every one of its values is JSON. Callers spread (`{ ...result }`)
 * rather than cast: the spread is a real record with the same fields, and it
 * copies rather than aliasing the value the caller still holds.
 */
function automationToolResult(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
    isError: false,
  };
}

// ============================================================
// Tool Definitions (from canonical registry)
// ============================================================

function createSessionTools(
  includeDeveloperFeedback: boolean,
  externalStandaloneOnly = false,
  hostCallbackBridge = false,
  advisorConsultBridge = false,
  decidePort = false,
): Tool[] {
  const filter = {
    includeDeveloperFeedback,
    externalStandaloneOnly,
    hostCallbackBridge,
    advisorConsultBridge,
    // P6.184 — derived from the bridge rather than from a spawn flag of its
    // own, because the two are the same fact: the bridge exists only for a
    // session `SessionManager` owns, and that manager binds `notificationPort`
    // for every runtime since this row. The flag is ANDed with the bridge again
    // inside `getSessionToolDefs`, so a caller that set it without one still
    // gets nothing.
    notificationPort: hostCallbackBridge,
    // P6.137 — the same derivation for the same reason: `SessionManager` binds
    // `worktreePort` unconditionally for every runtime, and the FLOOR
    // (`worktreeEnterAuthority`) beside it, so a bridged session is exactly the
    // set that can serve these three. ANDed with the bridge again inside
    // `getSessionToolDefs`.
    worktreePort: hostCallbackBridge,
    // C3.360 (rig day 2026-09-12, RS-37) — the same derivation a third time,
    // and its absence was a shipped defect: `SessionManager` binds the
    // review-diff port for every bridged session, but this filter never said
    // so, so `ReviewDiff` was advertised to NO bridged session (52 tools
    // against 53, `EnterWorktree` present in both as the control) and
    // C4.13's background review could not be requested by any model. ANDed
    // with the bridge again inside `getSessionToolDefs`.
    reviewDiffPort: hostCallbackBridge,
    // UB6.11 — decide's offer, ANDed with the bridge at the derive site (the
    // flag is only emitted beside `--host-callback-port`, so both are true
    // together; the AND here keeps a hand-set flag from advertising a tool
    // whose route does not exist).
    decidePort: hostCallbackBridge && decidePort,
  };
  // Same filter, same source — so the advertised set and the annotations
  // cannot come from two different views of the registry.
  const registry = getSessionToolRegistry(filter);
  return getToolDefsAsJsonSchema(filter).map(def => {
    // P6.345 — `readOnly` lives on the canonical registry def and six tool
    // families set it, but this map used to carry only `{ name, description,
    // inputSchema }`, so `readOnlyHint` reached no MCP client. The claude
    // adapter has always taken the documented opt-in
    // (`session-scoped-tools.ts` passes `annotations.readOnlyHint`); codex and
    // Pi, which see these tools over MCP, saw nothing.
    //
    // Read back through the registry rather than through
    // `getToolDefsAsJsonSchema`'s return shape: that function is in another
    // lane's zone this wave, and widening its `JsonSchemaToolDef` would move a
    // contract several packages read. The registry is already imported here and
    // is the same source, so the two cannot disagree.
    const readOnly = registry.get(def.name)?.readOnly === true;
    return {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema as Tool['inputSchema'],
      ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
    };
  });
}

/**
 * Append a result's non-text blocks to its `content` (P6.345).
 *
 * MCP carries images and embedded resources inside `content`; the shared
 * registry contract keeps them in the additive `extraContent` field, for the
 * reason written on `ToolResult.extraContent`. This is the codex/Pi half of
 * that merge — `session-scoped-tools.ts:convertResult` is the claude half.
 *
 * A result with no `extraContent` is returned untouched, so the ~40 tools that
 * only ever answer in text are byte-identical to before.
 */
function withMergedExtraContent<T extends object>(result: T): T {
  const candidate = result as { content?: unknown; extraContent?: unknown };
  if (!Array.isArray(candidate.extraContent) || candidate.extraContent.length === 0) {
    if (!('extraContent' in result)) return result;
    const { extraContent: _empty, ...rest } = result as T & { extraContent?: unknown };
    return rest as T;
  }
  const text = Array.isArray(candidate.content) ? candidate.content : [];
  const { extraContent, ...rest } = result as T & { extraContent?: unknown };
  return { ...rest, content: [...text, ...(extraContent as unknown[])] } as T;
}

// ============================================================
// call_llm Handler (backend-specific)
// ============================================================

async function handleCallLlm(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  // Primary path: PreToolUse intercept injects _precomputedResult (works on Codex).
  const precomputed = args?._precomputedResult as string | undefined;

  if (precomputed) {
    try {
      const parsed = JSON.parse(precomputed);
      if (parsed.error) {
        return errorResponse(`call_llm failed: ${parsed.error}`);
      }
      if (parsed.text !== undefined) {
        return {
          content: [{ type: 'text' as const, text: parsed.text || '(Model returned empty response)' }],
        };
      }
      return errorResponse('call_llm: _precomputedResult has unexpected format (missing text field).');
    } catch {
      return errorResponse(`call_llm: Failed to parse _precomputedResult: ${precomputed.slice(0, 200)}`);
    }
  }

  // F1.1135 — no fallback: the `--callback-port` HTTP channel had no producer and no server in the tree, so a port a
  // launcher named received the call's arguments; the host's intercept is the only path (F1.710 removed the env one).
  return errorResponse('call_llm requires the host\'s PreToolUse intercept (_precomputedResult), which did not reach this call.');
}

// ============================================================
// spawn_session Handler (backend-specific)
// ============================================================

async function handleSpawnSession(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  // Primary path: PreToolUse intercept injects _precomputedResult (works on Codex).
  const precomputed = args?._precomputedResult as string | undefined;

  if (precomputed) {
    try {
      const parsed = JSON.parse(precomputed);
      if (parsed.error) {
        return errorResponse(`spawn_session failed: ${parsed.error}`);
      }
      // Return the full result (could be help info or spawn result)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(parsed, null, 2) }],
      };
    } catch {
      return errorResponse(`spawn_session: Failed to parse _precomputedResult: ${precomputed.slice(0, 200)}`);
    }
  }

  // F1.1135 — no fallback, for call_llm's reason above.
  return errorResponse('spawn_session requires the host\'s PreToolUse intercept (_precomputedResult), which did not reach this call.');
}

// ============================================================
// MCP Server Setup
// ============================================================

function setupSignalHandlers(): void {
  const shutdown = (signal: string) => {
    console.error(`Session MCP Server received ${signal}, shutting down gracefully`);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection in session MCP server:', reason);
  });
}

async function main() {
  setupSignalHandlers();

  // Parse command line arguments
  const args = process.argv.slice(2);
  let sessionId: string | undefined;
  // F1.765 — the host's storage-v2 session folder; absent from an older host.
  let sessionPath: string | undefined;
  let workspaceRootPath: string | undefined;
  let plansFolderPath: string | undefined;
  let configRoot: string | undefined;
  let hostCallbackPort: string | undefined;
  // External-subprocess providers (Codex) advertise/dispatch only standalone
  // tools — callback-dependent tools are gated off (recoverable error, no crash),
  // except the five T5's host-callback bridge carries when one is configured.
  let externalStandaloneOnly = false;
  // P3.13 — the host's statement that it serves `advisor/consult` and that the
  // advisor is on. ANDed with the bridge below, never read on its own.
  let advisorConsultFlag = false;
  // UB6.11 — the host's statement that the decision layer is configured at spawn
  // (`--decide-port`, emitted beside the bridge port only then). ANDed with the bridge in createSessionTools.
  let decidePort = false;
  // D1.426 — this chat's own memory write axis. `undefined` means the chat set
  // none, which is not the same as `false`; see `codexMemoryWriteAxis`.
  let memoryScopeWrite: boolean | undefined;
  // F1.118 — the app-wide switch as the HOST reads it. `undefined` means the
  // host had nothing to say, which is ON; see `codexMemoryWriteAxis`.
  let memoryAppWrite: boolean | undefined;
  // D1.372 — this session's project directory, or undefined when it chose none.
  let workingDirectory: string | undefined;
  // F1.194 — the HOST's user-memory root, stated only when it differs from `--config-root`.
  let userMemoryRoot: string | undefined;
  // F1.191 / F1.196 — `script_sandbox`'s read policy; see `CodexSandboxReadArgs`.
  const sandbox: CodexSandboxReadArgs = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-id' && args[i + 1]) {
      sessionId = args[i + 1];
      i++;
    } else if (args[i] === '--session-path' && args[i + 1]) {
      // F1.765 — a FIXED-class flag (the emitter's §"The argv classification").
      // ABSOLUTE only, the `--user-memory-root` rule: a relative value would
      // resolve against this child's cwd, a directory the host never chose, so
      // it is dropped and the pre-flag derivation in `createCodexContext` stands.
      if (isAbsolute(args[i + 1]!)) sessionPath = args[i + 1];
      i++;
    } else if (args[i] === '--workspace-root' && args[i + 1]) {
      workspaceRootPath = args[i + 1];
      i++;
    } else if (args[i] === '--plans-folder' && args[i + 1]) {
      plansFolderPath = args[i + 1];
      i++;
    } else if (args[i] === '--config-root' && args[i + 1]) {
      configRoot = args[i + 1];
      i++;
    } else if (args[i] === '--decide-port') {
      decidePort = true; // UB6.11
      i++;
    } else if (args[i] === '--host-callback-port' && args[i + 1]) {
      hostCallbackPort = args[i + 1];
      i++;
    } else if (args[i] === '--external-standalone-only') {
      externalStandaloneOnly = true;
    } else if (args[i] === '--advisor-consult') {
      advisorConsultFlag = true;
    } else if (args[i] === '--memory-scope-write' && args[i + 1]) {
      // Exactly the two spellings the host writes (`String(boolean)`). Anything
      // else is left unset rather than guessed: an unset axis follows the
      // app-wide switch, which is this subprocess's behaviour before the flag
      // existed, while guessing would either refuse a write nobody turned off
      // or permit one the user did.
      if (args[i + 1] === 'true') memoryScopeWrite = true;
      else if (args[i + 1] === 'false') memoryScopeWrite = false;
      i++;
    } else if (args[i] === '--memory-app-write' && args[i + 1]) {
      // F1.118, and exactly the rule above for exactly its reason: anything but
      // the two spellings the host writes is left UNSET, which falls back to the
      // ground comparison — this subprocess's behaviour before the flag existed.
      if (args[i + 1] === 'true') memoryAppWrite = true;
      else if (args[i + 1] === 'false') memoryAppWrite = false;
      i++;
    } else if (args[i] === '--working-directory' && args[i + 1]) {
      // D1.372. The `&& args[i + 1]` above already drops an empty value, which
      // is the same refusal the emitter makes: a blank would reach
      // `handleRemember` as a truthy-enough path only after `join('', …)` had
      // turned it into a relative one.
      workingDirectory = args[i + 1];
      i++;
    } else if (args[i] === '--user-memory-root' && args[i + 1]) {
      // F1.194. ABSOLUTE only, the `--credential-home` rule: a relative value would
      // resolve against this child's cwd, a directory the host never chose, so it
      // is dropped and the pre-flag answer (`--config-root`) stands.
      if (isAbsolute(args[i + 1]!)) userMemoryRoot = args[i + 1];
      i++;
    } else if (args[i] === '--credential-home' && args[i + 1]) {
      if (isAbsolute(args[i + 1]!)) sandbox.credentialHome = args[i + 1];
      i++;
    } else if (args[i] === '--sandbox-denied-read-root' && args[i + 1]) {
      if (isAbsolute(args[i + 1]!)) (sandbox.deniedReadRoots ??= []).push(args[i + 1]!);
      i++;
    } else if (args[i] === '--sandbox-reads-fenced' && args[i + 1]) {
      // The two spellings the host writes, and nothing else: an unrecognised
      // value leaves the policy UNDECLARED, which is the pre-flag state.
      if (args[i + 1] === 'true') sandbox.readsFenced = true;
      else if (args[i + 1] === 'false') sandbox.readsFenced = false;
      i++;
    }
  }

  if (
    !sessionId
    || !workspaceRootPath
    || !plansFolderPath
    || !configRoot
    || !isAbsolute(configRoot)
  ) {
    console.error('Usage: session-mcp-server --session-id <id> [--session-path <absolute-path>] --workspace-root <path> --plans-folder <path> --config-root <absolute-path> [--host-callback-port <port>] [--advisor-consult] [--memory-scope-write <true|false>] [--memory-app-write <true|false>] [--working-directory <path>] [--user-memory-root <absolute-path>] [--credential-home <absolute-path>] [--sandbox-reads-fenced <true|false>] [--sandbox-denied-read-root <absolute-path>]...');
    process.exit(1);
  }

  const config: SessionConfig = {
    configRoot,
    sessionId,
    // F1.765 — absent unless the host stated it; see `createCodexContext`.
    ...(sessionPath ? { sessionPath } : {}),
    workspaceRootPath,
    plansFolderPath,
    // No env fallback here, deliberately — see the field's doc.
    ...(hostCallbackPort ? { hostCallbackPort } : {}),
    ...(advisorConsultFlag ? { advisorConsultBridge: true } : {}),
    ...(decidePort ? { decidePort: true } : {}), // UB6.11
    // Spread rather than assigned, so "the chat set no axis" stays ABSENT on
    // the config object the context reads — the state every pre-D1.426 spawn is
    // in, and the one the resolver reads as "follow the app-wide switch".
    ...(memoryScopeWrite === undefined ? {} : { memoryScopeWrite }),
    // F1.118 — spread for the same reason: "the host said nothing" is the key
    // being ABSENT, which `codexMemoryWriteAxis` reads as the pre-flag state.
    ...(memoryAppWrite === undefined ? {} : { memoryAppWrite }),
    // D1.372 — spread for the same reason: "this session chose no project" is
    // the key being ABSENT, which is the state `createCodexContext` turns into
    // an unbound `workingDirectory` and `handleRemember` refuses by name.
    ...(workingDirectory ? { workingDirectory } : {}),
    // F1.194 — absent unless the host stated a root; see `codexUserMemoryPath`.
    ...(userMemoryRoot ? { userMemoryRoot } : {}),
  };

  // Create the Codex context
  const ctx = createCodexContext(config, sandbox);

  // T5 — the bridge is configured for this spawn. Only meaningful together with
  // `--external-standalone-only`: every other consumer of this filter already
  // resolves the ports in-process.
  const hostCallbackBridge = Boolean(config.hostCallbackPort);
  // P3.13 — the advisor route lives ON the bridge, so the flag is worth nothing
  // without one. ANDed here so the advertisement and the dispatch guard below
  // read the same single value.
  const advisorConsultBridge = Boolean(config.advisorConsultBridge) && hostCallbackBridge;

  // P3.13 — built once, beside the registry, so the tool this server ADVERTISES
  // and the callable it DISPATCHES to are decided by the same expression.
  const advisorConsult = advisorConsultBridge && config.hostCallbackPort
    ? createBridgeAdvisorConsult({ port: config.hostCallbackPort, sessionId })
    : undefined;

  const includeDeveloperFeedback = isDeveloperFeedbackEnabled();
  const sessionToolRegistry = getSessionToolRegistry({
    includeDeveloperFeedback,
    externalStandaloneOnly,
    hostCallbackBridge,
    advisorConsultBridge,
  });

  // P6.553 — KEPT on the `@deprecated` low-level `Server`, deliberately: the SDK's
  // note carves out "advanced use cases", and this is one. `tools/call` is
  // overridden WHOLESALE because it is the single egress point P3.11 exists for —
  // every reply to codex leaves through one `withoutEmptyStructuredContent`, whatever
  // built it — and `McpServer.registerTool` replaces that with one callback per tool,
  // i.e. N places for the wire rule to be forgotten. `registerTool` also takes Zod or
  // an `AnySchema`, while every session tool declares raw JSON Schema in the registry.
  const server = new Server(
    {
      name: 'nessy-general-agent-session',
      version: '0.3.1',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle tool listing — session tools only
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: createSessionTools(includeDeveloperFeedback, externalStandaloneOnly, hostCallbackBridge, advisorConsultBridge, decidePort), // UB6.11 — the decide offer rides the last arg
  }));

  /**
   * Dispatch one tool call. Every exit is a RESULT — a thrown error would kill
   * the turn — and every one of them leaves through the codex-wire guard in the
   * request handler below.
   */
  const dispatchToolCall = async (
    name: string,
    toolArgs: Record<string, unknown> | undefined,
  ): Promise<ToolResult> => {
    try {
      // Under external-standalone-only (Codex), callback-dependent tools are not
      // available: return a recoverable error (never throw), so the turn survives.
      //
      // T5 — the five the host-callback bridge carries are the exception, and
      // the SAME condition decides here and in the advertisement above: a tool
      // this server lists must be a tool it will run.
      if (
        externalStandaloneOnly
        && SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name)
        && !(hostCallbackBridge && SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK.has(name))
        // P3.13 — the advisor rides its own flag, and the same `advisorConsult`
        // that decided the advertisement decides here, so the two cannot drift.
        && !(advisorConsult && SESSION_BACKEND_TOOLS_BRIDGED_BY_HOST_CALLBACK.has(name))
      ) {
        return errorResponse(`Tool '${name}' is not available under Codex in this build (requires a Nessy-side host callback).`);
      }

      // P3.13 — `advisor_consult` is `executionMode: 'backend'`, so there is no
      // registry handler to fall through to: the host renders the reply and this
      // returns it verbatim. NOT an error result even when the advisor refused —
      // the host already chose that, for every runtime, in one place.
      if (name === 'advisor_consult' && advisorConsult) {
        return successResponse(await advisorConsult((toolArgs ?? {}) as Record<string, unknown>));
      }

      // call_llm has backend-specific execution (the host's precomputed result, F1.1135)
      if (name === 'call_llm') {
        return await handleCallLlm(toolArgs as Record<string, unknown>);
      }

      // spawn_session has backend-specific execution (the host's precomputed result, F1.1135)
      if (name === 'spawn_session') {
        return await handleSpawnSession(toolArgs as Record<string, unknown>);
      }

      // Check canonical session tool registry first (feature-filtered)
      const def = sessionToolRegistry.get(name);
      if (def?.handler) {
        return await def.handler(ctx, toolArgs);
      }

      return errorResponse(`Unknown tool: ${name}`);
    } catch (error) {
      return errorResponse(
        `Tool '${name}' failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // Handle tool calls — route via canonical registry or backend-specific tools
  //
  // P3.11 — the ONE place every reply to codex leaves through, and therefore
  // the place the codex-wire rule is enforced: a present-but-empty
  // `structuredContent` replaces the reply text with `{}` for the model (the
  // quote is in `session-tools-core/src/response.ts`), so it is dropped here
  // whatever built the result. A non-empty one is untouched.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;
    // Spread, because the SDK's result type wants an index signature and the
    // `ToolResult` INTERFACE does not provide one (the handler used to satisfy
    // it with object literals returned inline).
    return {
      ...withMergedExtraContent(withoutEmptyStructuredContent(await runInBridgeCallOrigin(request.params._meta, () => dispatchToolCall(name, toolArgs)))), // F1.493 (2) — the call's `_meta` origin rides every bridge request it makes
    };
  });

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`Session MCP Server started for session ${sessionId} (developerFeedback=${includeDeveloperFeedback}, hostCallbackBridge=${hostCallbackBridge}, advisorConsultBridge=${advisorConsultBridge})`);
}

// F1.386 — the same entry point is codex's `PermissionRequest` hook when the host
// projected one (`--permission-request-hook`): read the payload from stdin and
// answer through the exit code, never starting the MCP server. See
// `permission-request-hook.ts` for the contract and the failure direction.
if (process.argv.includes(PERMISSION_REQUEST_HOOK_FLAG)) {
  // Synchronous stderr, then an explicit exit: a module-level handle must not keep
  // the hook alive past its answer (codex would time it out into "no verdict").
  process.exit(runPermissionRequestHook(process.argv.slice(2), readHookStdin(0, 'utf-8'), text => writeSync(2, text)));
} else {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

// F1.386 — appended so no cited line of this file moves; imports are hoisted.
import { PERMISSION_REQUEST_HOOK_FLAG, runPermissionRequestHook } from './permission-request-hook.ts';
import { readFileSync as readHookStdin, writeSync } from 'node:fs';
// F1.493 (2) — appended for the same reason.
import { runInBridgeCallOrigin } from './bridge-call-origin.ts';
