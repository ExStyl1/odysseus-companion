# Project-Local `.nessy-agent` And Session Filesystem Roots

Final architecture for the project-namespace and filesystem-authority cutover
(P1-P6, 2026-07). A Nessy Workspace is the logical isolation boundary for
projects, capabilities and sessions; the selected external project is the
actual filesystem workspace of its session.

## Namespaces

- `~/.nessy-agent` is the application/user root (`CONFIG_DIR`). Its
  `workspaces/<WorkspaceId>` children are managed application storage and are
  never a generic file-tool root for project sessions.
- `<project>/.nessy-agent` is the ONLY Nessy-native project namespace
  (canonical constant: `packages/shared/src/projects/nessy-agent-layout.ts`).
  It holds `config.toml`, `skills/`, `agents/`, `commands/`, `rules/`,
  `mcp.json`, `hooks.json`, `permissions.json`, `output-styles/` and
  `MEMORY.md`.
- `.nessy` has no legacy status: no reader, alias, fallback, migration or
  warning path exists; a populated on-disk `.nessy` changes nothing. The
  `~/.nessy/dp_auth_creds.json` home file is an unrelated nessy-cli contract
  owned by `packages/shared/src/auth/dp`.
- Portable standards remain explicit inputs beside `.nessy-agent`:
  `AGENTS.md`, root `MEMORY.md`, `.agents/skills|rules|commands`, `.mcp.json`.

## Project identity and trust

`resolveProjectIdentity` (device+inode fingerprint of the realpath) issues
path-free `ProjectKey`s; `ProjectHandleService` validates every external path
into an opaque handle and rejects managed roots. Trust is a persisted per-key
decision; every use revalidates identity immediately before effect. An
untrusted project contributes NOTHING repository-owned while global/user and
Workspace capabilities stay available.

## Capability layers and precedence

`buildNativeCapabilityInventory` discovers, per scope:

- global: `~/.nessy-agent/{skills,agents,mcp.json,hooks.json,MEMORY.md,permissions/default.json}`
  plus portable `$HOME/.agents/skills`;
- workspace: managed Workspace root resources;
- project (trusted only): the full `.nessy-agent` set plus portable inputs,
  every path realpath-contained in the verified project root before hashing.

Records carry an explicit `sourceTier`; same-scope collisions resolve
Nessy-native > portable > plugin after scope specificity, and every qualified
duplicate stays addressable. MCP collisions expose qualified wire names only.

`<project>/.nessy-agent/config.toml` v1 is a typed allowlist: `[defaults]
model|thinking_level|permission_mode` and `[plugins]` selectors. Forbidden
sections/keys (credentials, auth, env, trust, roots, install, telemetry) are
diagnosed with severity error and never applied. New-session defaults compose
at explicit session > trusted project > Workspace > global > built-in, and a
project permission mode can only narrow the Workspace/global floor.

## Session filesystem authority

`SessionFilesystemScope` (`packages/shared/src/agent/session-filesystem-scope.ts`)
is the ONE captured authority per session: `primaryRoot` is the project
canonical path (managed Workspace root only for no-project sessions), `cwd`,
approved `additionalRoots` receipts and `managedExclusions` (`CONFIG_DIR`).
Every local tool, shell cwd and provider projection resolves through
`resolveScopedPath`, which canonicalizes against the nearest existing parent
immediately before effect (closing symlink/rename races) and:

- allows primary-root paths for read and write;
- allows additional roots per receipt access (write includes read, never the
  reverse);
- keeps git metadata read-only inside every allowed root (`.git` as directory,
  pointer file and its resolved `gitdir:` target — hook/config injection is
  code execution) — `GitMetadataDeniedError`, approval cannot broaden it;
- keeps project agent configuration read-only for file tools (`.nessy-agent`
  and `.agents`, Codex `.codex`/`.agents` parity): an agent must not rewrite
  its own trusted config/hooks/skills — `AgentConfigDeniedError`;
- allows canonical `$TMPDIR`/`/tmp` without approval (production builder
  opt-in `includeSystemTempRoots`, Codex workspace-write parity);
- denies managed Nessy storage even under a broad approved parent;
- raises a structured `OutsideRootError` otherwise — no side effect.

An outside-root path suspends the exact tool call and raises one structured
approval (`outside_root_request/response` on the Pi wire; the generic
permission event elsewhere). Approve = this request only; approve-always =
session receipt, stored server-side in memory, revoked on cwd/project switch,
identity/trust loss, revocation RPC, session close and Workspace drain, and
never inherited by branches.

## External project watching

`ProjectCapabilityWatcherRegistry` (`packages/server-core/src/projects/`) is
ref-counted by immutable `(WorkspaceId, ProjectKey)` and watches only the
project root, `.nessy-agent` and `.agents` (non-recursive). Every event
revalidates identity before emitting: fingerprint mismatch revokes receipts
and refreshes; ordinary content changes refresh through the resolver
lifecycle. `.nessy` events are filtered out. The managed Workspace
ConfigWatcher owns only managed Workspace/global state.

## Desktop surface

The Pi runtime security snapshot exposes a safe
`PiHarnessFilesystemScopeSummaryV1` (primary root display path, project flag,
receipt list). The permission dialog renders `outside_root` with "Allow once"
(default, request lifetime) and "Allow for this session"; the renderer submits
only the request ID and lifetime. `sessions:revokeFilesystemRoot` revokes one
receipt server-side and rebuilds the agent runtime through the existing
authority lifecycle.
