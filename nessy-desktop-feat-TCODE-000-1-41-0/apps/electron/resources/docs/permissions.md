# Permissions Configuration Guide

This guide explains how to configure custom permission rules, above all for Plan mode, the read-only mode.

> **CLI-first workflow (recommended):** Use `nessy-general-agent permission ...` commands instead of editing JSON directly.
> - `nessy-general-agent permission --help`

## Overview

The permission modes are Claude Code's six: `plan`, `dontAsk`, `default` (Manual), `acceptEdits`, `auto` and
`bypassPermissions`. Plan mode is the read-only mode that blocks potentially destructive operations.
Custom permission rules let you allow specific operations that would otherwise be blocked.

The former Explore mode (`explore`, and its older spelling `safe`) is retired: a stored `explore` is read as
`plan`, and a tool that takes a mode (`spawn_session`, `automation_create`, `automation_update`) rejects
`explore` — pass `plan` instead. Plan writes only a `.md` plan in the session's plans folder and any file in
the session's data folder; Explore's other writes (the whole plans folder, additional directories,
`allowedWritePaths`, shell redirects into those folders) are gone.

`CONFIG_DIR` is `NESSY_CONFIG_DIR` when set, otherwise `~/.nessy-agent`.
Permission files use the immutable Workspace ID, not its name or slug:
- Workspace: `CONFIG_DIR/workspaces/{workspaceId}/permissions.json`
- Source: `CONFIG_DIR/workspaces/{workspaceId}/sources/{sourceSlug}/permissions.json`

Scratch files: `CONFIG_DIR/sessions/{workspaceId}/{sessionId}/job/tmp` is your session's own temporary folder, deleted with the session. `Write` and `Edit` there need no approval on Claude Code and Pi (Plan and Don't ask still refuse writes); from the shell only Claude Code skips the approval, for a read-only command redirected into `$CLAUDE_JOB_DIR/tmp/...`.

Project trust is separate from Workspace permissions. Repository instructions and capabilities are
resolved only after explicit Project trust; the decision is stored by `ProjectKey` in
`CONFIG_DIR/project-trust.json`, without a raw Project path.

## Auto-Scoping for Source Permissions

**Important:** MCP patterns in a source's `permissions.json` are automatically scoped to that source.

When you write:
```json
{ "pattern": "list", "comment": "Allow list operations" }
```

The system converts it to `^mcp__<sourceSlug>__(?:list)(?:_<word>)*$` internally. This means:
- `list` matches a tool whose name STARTS with it (`list`, `list_issues`), never one that merely contains it (`delete_playlist`)
- It only affects tools from that source: no risk of allowing `list` tools from other sources
- Workspace-level patterns still apply globally (for intentional cross-source rules)
- A source's file grants only for that source's own tools: its `allowedBashPatterns`, `allowedWritePaths` and any `toolRules`/`permissions.allow` rule for another tool are IGNORED (they would widen the whole session). Put such a grant in the workspace `permissions.json` (the user's Settings > Permissions). Deny rules in a source file still apply.

## permissions.json Schema

```json
{
  "allowedMcpPatterns": [
    { "pattern": "list", "comment": "Allow list operations" },
    { "pattern": "get", "comment": "Allow get operations" },
    { "pattern": "search", "comment": "Allow search operations" }
  ],
  "allowedApiEndpoints": [
    { "method": "GET", "path": ".*", "comment": "All GET requests" },
    { "method": "POST", "path": "^/search", "comment": "Search POST" }
  ],
  "allowedBashPatterns": [
    { "pattern": "^ls\\s", "comment": "Allow ls commands" }
  ],
  "deniedPaths": [
    "~/.ssh/**",
    "**/.env",
    "/srv/deploy/secrets/**"
  ],
  "deniedToolPatterns": [
    "Web*",
    "mcp__linear__*"
  ],
  "disallowedTools": [
    { "pattern": "mcp__jira__*", "comment": "No Jira writes from this workspace" }
  ],
  "allowedTools": [
    "Read",
    "Glob",
    { "pattern": "mcp__linear__*", "comment": "Linear only, nothing else" }
  ],
  "toolRules": [
    { "pattern": "mcp__jira__create*", "action": "ask", "comment": "Confirm each Jira write" },
    { "pattern": "mcp__jira__*", "action": "deny" }
  ],
  "blockedCommandHints": [
    {
      "command": "printf",
      "reason": "printf is not in the default read-only allowlist.",
      "context": "Plan mode keeps a narrow read-only command set.",
      "tryInstead": [
        "Use echo for simple output",
        "Switch to Manual mode for this command"
      ],
      "example": "echo '--- separator ---'"
    },
    {
      "command": "sed",
      "reason": "Only print-only sed is allowed by default.",
      "whenNotMatching": "^sed\\s+-n\\b"
    }
  ]
}
```

## Rule Types

### allowedMcpPatterns

Regex patterns for MCP tool names to allow in Plan mode, the read-only mode. No pattern allows a tool whose name carries a write word after its leading verb (`get_or_create_user`, `status_update`, `fetch_and_delete`), and the shipped defaults name the built-in dp servers' read tools exactly (`dp_jira_jql_search`), because their verb is not the first word.

For **source-level** permissions.json, use simple patterns (auto-scoped; each matches the tools whose name STARTS with it):
```json
{
  "allowedMcpPatterns": [
    { "pattern": "list", "comment": "All list operations for this source" },
    { "pattern": "get", "comment": "All get operations for this source" },
    { "pattern": "search", "comment": "All search operations for this source" }
  ]
}
```

For **workspace-level** permissions.json (global rules), use full patterns:
```json
{
  "allowedMcpPatterns": [
    { "pattern": "^mcp__[^_]+(?:_[^_]+)*__list(?:_[^_]+)*$", "comment": "Tools led by list, across all sources" }
  ]
}
```

### allowedApiEndpoints

Fine-grained rules for API source requests.

```json
{
  "allowedApiEndpoints": [
    { "method": "GET", "path": ".*", "comment": "All GET requests" },
    { "method": "POST", "path": "^/search", "comment": "Search POST" },
    { "method": "POST", "path": "^/v1/query$", "comment": "Query endpoint" }
  ]
}
```

### allowedBashPatterns

Regex patterns for bash commands to allow.

```json
{
  "allowedBashPatterns": [
    { "pattern": "^ls\\s", "comment": "ls commands" },
    { "pattern": "^git\\s+status", "comment": "git status" },
    { "pattern": "^pwd$", "comment": "pwd command" }
  ]
}
```

### allowedWritePaths

Glob patterns for paths the agent may write to **without a permission card in the default mode**. A write
to a matching path runs directly; a write to any other path still asks, and **plan mode always refuses
it** — plan keeps writing only its own plan file and the session data folder, whatever this list says.
Settings > Permissions does not offer the list yet: author it by hand in the workspace
`permissions.json`.

```json
{
  "allowedWritePaths": [
    "~/code/my-service/**",
    "~/code/my-service/config.json"
  ]
}
```

`~` expands to your home folder, `**` crosses directories, `*` stays inside one, and the match is checked
against the resolved absolute path. The same matcher the retired Explore mode used compiles these
patterns, so a list authored for Explore behaves identically here.

### deniedPaths

Glob patterns for files the agent may **never read and never write**, in any
permission mode. This is the answer to "how do I stop the agent reading my
credentials?" — it is the one control that is checked before every mode decision,
so Bypass permissions does not reopen it.

```json
{
  "deniedPaths": [
    "~/.ssh/**",
    "**/.env",
    "**/*.pem",
    "/srv/deploy/secrets/**"
  ]
}
```

A match blocks `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Glob`,
`Grep`, `Find`, `Ls`, and any path named inside a `Bash` command. The refusal
names the entry that produced it. (`Glob` and `Grep` are the Claude runtime's
names for file discovery and search; `Find` and `Ls` are Pi's — a deny covers
both vocabularies, so you do not write the list twice.)

**Where it can be set.** Every layer that carries a `permissions.json`:

| Layer | File |
| --- | --- |
| App-wide defaults | `CONFIG_DIR/permissions/default.json` |
| Workspace | `CONFIG_DIR/workspaces/{workspaceId}/permissions.json` |
| Source | `CONFIG_DIR/workspaces/{workspaceId}/sources/{sourceSlug}/permissions.json` |
| Managed | a policy an administrator delivers |

The list is **additive in one direction only**: each layer can add entries and no
layer can remove one another layer added. A managed policy therefore outranks
everything — and when an administrator turns on the managed-only lock, the lock
drops *allow*-direction contributions from the other layers while every layer's
`deniedPaths` keeps merging.

**Pattern syntax.** `**` matches any depth, `*` matches one path segment, `?`
matches one character, and `~/` is your home directory. Patterns are matched
against **absolute** paths, so an entry has to be anchored: start it with `/`,
`~/`, or `**/`. A bare `secrets/**` or `.env` matches nothing.

A `<dir>/**` entry **covers the directory itself.** `~/.ssh/**` denies the files
under `~/.ssh` *and* `~/.ssh` as a path, so `Grep` and `Glob` cannot be rooted
there either. (Before this was fixed, only the files were covered, and a search
tool handed the directory returned matching lines from inside it.)

**A malformed entry is dropped, with a warning naming it.** The rest of the file
still applies. Three shapes cannot match anything and are reported:

| Entry | Why it denies nothing |
| --- | --- |
| `""` | blank |
| `C:\secrets\**` | Windows-style separators; write them as `/` |
| `secrets/**`, `.env` | not anchored |

**One limit worth knowing.** The check is enforced on the tool's *request*, not
on its *results*: a search rooted **above** a denied directory can still return
matches from inside it. Denying `~/.ssh/**` stops a `Grep` at `~/.ssh`; it does
not yet filter a `Grep` at `~` down to exclude it.

**What is denied out of the box.** Unlike the upstream setting this mirrors —
whose default is unset — Nessy ships a credential floor: `.env` files, `~/.ssh`,
`~/.gnupg`, `~/.aws`, `~/.config/gcloud`, `~/.azure`, `~/.kube`,
`~/.docker/config.json`, git credential stores, `.npmrc`, `.pypirc`, `~/.netrc`,
`*-service-account.json`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, and the app's
own t-artifacts registry (`workspaces/<id>/artifacts/registry.json`). Your own
entries add to that list.

### deniedToolPatterns and disallowedTools

Glob patterns matched against the **tool name**, blocking it in **every**
permission mode. These are the two glob levers the `blockedTools` note above
sends you to, and they are the only tool-name controls that reach the write
modes.

```json
{
  "deniedToolPatterns": [
    "Web*",
    "mcp__linear__*"
  ],
  "disallowedTools": [
    { "pattern": "mcp__jira__*", "comment": "No Jira writes from this workspace" }
  ]
}
```

Each entry is a plain string, or an object with a `pattern` and an optional
`comment`. `**` matches any depth, `*` one path segment, `?` one character — a
tool name contains no `/`, so `Web*` matches `WebFetch` and `mcp__linear__*`
matches every tool of that server.

Both are checked **before** every mode decision — `deniedToolPatterns` first,
then `disallowedTools` — so Bypass permissions does not reopen them, and neither
is subject to the always-allowed read-only list that can make a `blockedTools`
entry silently inert. The refusal names the pattern that produced it: `Tool
blocked: WebFetch matched deniedToolPatterns pattern Web*`.

**Where they can be set.** The same four layers as `deniedPaths`, and with the
same one-way merge: a layer adds entries and no layer can remove one another
layer added, so a managed policy's entries outrank everything and survive the
managed-only lock.

The two keys do the same job here, so pick either — `disallowedTools` is also the
name the Claude Agent SDK and skill frontmatter use for a tool denylist, which is
why both spellings are accepted.

### allowedTools

The **allowlist** counterpart, and the one key here whose name means the opposite
of what a Claude user expects. Claude's `--allowedTools`
*adds* allow rules for one session; this key *narrows*. Setting it does not grant
anything — it forbids everything it does not name:

```json
{
  "allowedTools": [
    "Read",
    "Glob",
    { "pattern": "mcp__linear__*", "comment": "Linear only, nothing else" }
  ]
}
```

Entries take the same two forms as the denylists above — a plain string, or an
object with a `pattern` and an optional `comment` — and match the tool name as a
glob.

**Empty means "no constraint", not "deny everything".** The check runs only while
the merged list is non-empty, so an absent key and `[]` behave identically. This
is the one thing to get right before deploying it: `"allowedTools": []` locks
nothing down, and a policy written expecting the opposite is silently open.

Once non-empty, any tool matching no pattern is refused with `Tool blocked:
<name> is not included in allowedTools`. Like the two denylists it is checked
**before** the mode decision, so Bypass permissions does not reopen it. It also
**loses to every deny**: `deniedPaths`, `deniedToolPatterns` and
`disallowedTools` are all evaluated first, so naming a tool here cannot rescue
one that a deny rule already blocks.

Across layers the lists concatenate, so a second layer's entries only ever widen
what is admitted. Under the managed-only lock every non-managed layer's
`allowedTools` is dropped and the managed one alone decides.

### toolRules

Per-tool `allow` / `deny` / `ask` decisions, for when a plain allowlist or
denylist cannot say what you mean:

```json
{
  "toolRules": [
    { "pattern": "mcp__jira__create*", "action": "ask", "comment": "Confirm each Jira write" },
    { "pattern": "mcp__jira__*", "action": "deny" }
  ]
}
```

Every entry needs a `pattern` and an `action`; `comment` is optional. The pattern
is a glob over the tool name, as everywhere else on this page.

**Order matters here, and only here.** `toolRules` is read first-match-wins, so
the example above asks about `create` calls and denies the rest — reversing the
two entries would deny everything and the `ask` rule would never be reached. The
other tool lists are membership tests, where order changes only which pattern the
refusal names.

`deny` refuses. `allow` permits the tool and skips the mode decision entirely.
`ask` prompts — except in **Don't ask** mode, which never prompts: there an `ask`
rule denies instead, and that refusal is non-negotiable, so a hook cannot approve
it. Like the lists above, `toolRules` is evaluated ahead of the mode decision and
applies in every mode.

Under the managed-only lock, `allow` entries from non-managed layers are dropped
entry by entry while their `deny` and `ask` entries survive — the lock removes
grants, never protections.

### blockedCommandHints

Command-specific guidance shown when a Bash command falls outside the read-only set in Plan or Don't ask mode.
This provides deterministic explanations for known commands instead of relying only on closest-pattern heuristics.

```json
{
  "blockedCommandHints": [
    {
      "command": "printf",
      "reason": "printf is not in the default read-only allowlist.",
      "context": "Plan mode keeps a narrow read-only command set.",
      "tryInstead": [
        "Use echo for simple output",
        "Switch to Manual mode for this command"
      ],
      "example": "echo '--- separator ---'"
    },
    {
      "command": "sed",
      "reason": "Only print-only sed is allowed by default.",
      "whenNotMatching": "^sed\\s+-n\\b"
    }
  ]
}
```

Fields:
- `command` (required): Base command name (e.g. `printf`, `sed`)
- `reason` (required): Primary explanation shown to the user
- `context` (optional): Additional policy/risk context
- `tryInstead` (optional): Suggested alternatives
- `example` (optional): Example command
- `whenNotMatching` (optional): Regex condition; hint applies only when command does **not** match this pattern

## Permission DSL v1

`permissionDsl` is the readable, versioned policy format Nessy compiles rules
into. Add it to any supported `permissions.json` file:

```json
{
  "permissionDsl": {
    "version": 1,
    "rules": [
      {
        "id": "ask-git-push-origin",
        "action": "ask",
        "match": { "kind": "bash", "executable": "git", "args": ["push", "origin"] }
      },
      {
        "id": "deny-production-host",
        "action": "deny",
        "match": { "kind": "host", "host": "production.example.com" }
      }
    ]
  }
}
```

Each rule has a stable `id`, an `action` (`allow`, `ask`, or `deny`), and one
matcher:

| Matcher | Fields | Matches |
| --- | --- | --- |
| `tool` | `semanticId` | A semantic tool ID or tool name |
| `bash` | `executable`, optional `args`, `cwdRoot` | A parsed shell command; `cwdRoot` must be absolute and is canonicalized by the host |
| `path` | `root`, optional `parameter` | Host-canonicalized paths under an absolute root |
| `host` | `host` | The destination hostname |
| `mcp` | `server`, optional `tool` | An MCP server and tool |
| `agent` | `agent` | Admission of a named custom agent |
| `parameter` | `name` plus `equals` or `oneOf` | A bounded safe input field |

`path.parameter` accepts `file_path`, `notebook_path`, `path`, `cwd`, or
`workingDirectory`. `parameter.name` accepts `method`, `mode`, `action`,
`access`, `operation`, or `transport`.

When several rules match, the safer action wins:
`deny` → `ask` → `allow`. For equal actions, scope precedence is
`managed` → `global` → `workspace` → `project` → `plugin`.

Every matched decision records the rule `id`, policy scope, and source digest,
so the app can explain which policy produced it. A rule whose matcher cannot be
compiled is skipped with a warning that names it, and the rest of its document
still applies. A document that cannot be read — invalid JSONC, a wrong shape,
an unknown matcher kind or field, or a nonmatching optional `generation` — is
ignored as a whole: the session warning names its settings tier, its own rules,
deny rules included, stop applying until it is fixed, and every other document
still applies (an untrusted project's unreadable document is skipped the same
way, without the warning). Two cases still fail closed and deny every call, naming the
cause: a managed document that cannot be read, and one settings source that
declares more `deny` and `ask` rules than the 512-rule compile limit, because
dropping any of them would widen the policy. A request from another generation
is denied too; a policy is never silently reused.

The four blocked write tools (`Write`, `Edit`, `MultiEdit`, and
`NotebookEdit`) are fixed by the runtime and can never be removed. A
`blockedTools` list in `permissions.json` ADDS to them: exact tool names, blocked
in the read-only modes (Plan, Don't ask). For glob matching, or for a
block that also covers the write modes, use `deniedToolPatterns` or
`disallowedTools`. Some names it cannot block, and it reports nothing when it
cannot: the always-allowed read-only tools (`Read`, `Glob`, `Grep`, `Task`,
`TaskOutput`, `WebFetch`, `WebSearch`, `TodoWrite`, `SubmitPlan`, `LSP`,
`read_mcp_resource`, `list_mcp_resources`, `read_skill_resource`, and their
`mcp__…__<name>` spellings), `Bash`, and `browser_tool` are decided before this
list is consulted, so naming one here does nothing — reach for
`deniedToolPatterns` instead, where `["Web*"]` really does block `WebFetch` in
Plan and Manual alike.

### Which runtime reads which rules

This used to read "the policy format used by the Pi runtime", which was true of
the compiled form and gave the wrong answer about rules:

- **Pi** evaluates the compiled policy in its own permission gate, so every rule
  below applies to it.
- **Codex** consults the same compiled policy when it answers its runtime's
  approval requests: an `allow` answers automatically, a `deny` refuses, and
  anything unmatched still reaches you. A rule can shape that answer, never
  Codex's own configuration.
- **Claude** runs its own permission system rather than ours, so it does not
  read this compiled form. It does read the `permissions` `allow`/`ask`/`deny`
  blocks of `.claude/settings.json` (user, project and local scopes) itself, and
  applies them natively — so a rule written **there** takes effect on Claude,
  while a rule written under `permissionDsl` in a `permissions.json` does not.

A `.claude/settings.json` `permissions` block is compiled into this same format
for Pi and Codex, so writing your rules there is what makes one rule mean the
same thing on all three runtimes.

## Default Behavior in Plan Mode

**Blocked by default:**
- Write, Edit, MultiEdit, NotebookEdit tools (except the two writes allowed below)
- MCP tools with write semantics (create, update, delete)
- API POST/PUT/DELETE requests

**Not run unasked:**
- Bash commands outside the read-only commands listed below, and browser commands that change the page or the browser's state: on Pi the Guardian reviews them when it is available, otherwise the user is asked (Don't ask refuses them)

**Allowed by default:**
- Read, Glob, Grep
- WebFetch, WebSearch
- TodoWrite, SubmitPlan
- Browser tools (`browser_*` and `mcp__session__browser_*`) for commands that only read the page or the browser's state
- MCP tools whose name STARTS with a read verb (`list`/`list_…`, `get_…`, `search_…` and the other verbs in the app's `permissions/default.json`) — a verb elsewhere in the name (`update_issue_status`) does not count
- Writing a `.md` plan in the session's plans folder, and any file in the session's data folder

### Read-Only Bash Commands

These commands are allowed in Plan mode without custom configuration:

| Category | Commands |
|----------|----------|
| **File exploration** | `ls`, `tree`, `cat`, `head`, `tail`, `nl`, `file`, `stat`, `wc`, `du`, `df` |
| **Search** | `find`, `grep`, `rg`, `ag`, `fd`, `locate`, `which` |
| **Git (read-only)** | `git status`, `git log`, `git diff`, `git show`, `git branch`, `git blame`, `git reflog` |
| **GitHub CLI** | `gh pr view/list`, `gh issue view/list`, `gh repo view` |
| **Package managers** | `npm ls/list/outdated`, `yarn list`, `pip list`, `cargo tree` |
| **Quality checks (read-only)** | `bun run typecheck`, `bun run typecheck:all`, `bunx tsc --noEmit`, `tsc --noEmit`, `yarn typecheck`, `pnpm typecheck` |
| **Browser helper** | `bun run browser-tool --help`, `bun run browser-tool list`, `bun run browser-tool template ...`, `bun run browser-tool parse-url <url>` |
| **System info** | `pwd`, `whoami`, `env`, `ps`, `uname`, `hostname`, `date`, `echo` |
| **Text processing** | `awk`/`gawk`/`mawk`/`nawk` (safe forms), `jq`, `yq`, `sort`, `uniq`, `cut`, `column` |
| **Network diagnostics** | `ping`, `dig`, `nslookup`, `netstat` |
| **Version checks** | `node --version`, `python --version`, etc. |

Notes:
- `echo` is allowed for literal output formatting (e.g. `echo ---`), but redirects and command substitution are still blocked.
- `awk` family commands are allowed for read-only text processing, but dangerous execution primitives (for example `system(...)`, command-pipe `getline`, or `print | "cmd"`) are blocked.

### Compound Commands

Compound commands using `&&`, `||`, and `|` are **allowed** when all parts are safe:

| Construct | Example | Behavior |
|-----------|---------|----------|
| **Logical AND** | `git status && git log` | ✅ Allowed if both commands are safe |
| **Logical OR** | `git status \|\| echo "failed"` | ✅ Allowed if both commands are safe |
| **Pipes** | `git log \| head` | ✅ Allowed if all commands are safe |

Each command is validated independently. If any command is not in the allowlist, the entire compound command is outside the read-only set.

### Blocked Shell Constructs

These constructs always take a command out of the read-only set, even if the base command is allowed:

| Construct | Examples | Why Blocked |
|-----------|----------|-------------|
| **Background execution** | `&` | Runs asynchronously, could hide activity |
| **Redirects** | `>`, `>>` | Could overwrite files |
| **Command substitution** | `$()`, backticks, `<()`, `>()` | Execute embedded commands |
| **Control characters** | newlines, carriage returns | Act as command separators |

Example: `git status > file.txt` is not read-only because `>` could overwrite files, so Plan does not run it unasked.

## Cascading Rules

Legacy allow-list rules are additive across their supported config scopes.
Permission DSL rules can return `allow`, `ask`, or `deny`; conflicting matches
use the precedence documented above.

## Best Practices

1. **Be specific with patterns** - Use anchors (^, $) to avoid over-matching
2. **Add comments** - Explain why each rule exists
3. **Test patterns** - Verify regex matches expected tool names
4. **Minimal permissions** - Only allow what's needed

## Examples

### Read-only Linear access:
```json
{
  "allowedMcpPatterns": [
    { "pattern": "^mcp__linear__(list|get|search)", "comment": "Read operations" }
  ]
}
```

### Search-only API:
```json
{
  "allowedApiEndpoints": [
    { "method": "GET", "path": ".*" },
    { "method": "POST", "path": "^/search" }
  ]
}
```

### Safe git commands:
```json
{
  "allowedBashPatterns": [
    { "pattern": "^git\\s+(status|log|diff|branch)", "comment": "Read-only git" }
  ]
}
```

## Planning in Plan Mode

In Plan mode, you can create implementation plans that the user can accept to transition to execution. A plan
is not required: in Plan you may also simply answer, as in Claude Code's plan mode.

### When to Create Plans

Create a plan when:
- The task has multiple complex steps
- You want user approval before making changes
- You've gathered enough context and are ready to implement

### Creating a Plan

1. Write your plan to a markdown (`.md`) file in the session's plans folder
2. Call `SubmitPlan` with the file path
3. The user sees a formatted plan with an "Accept Plan" button
4. Clicking "Accept Plan" exits Plan mode and switches the session to Manual, so the plan can run and each edit still asks

### Plan Format

```markdown
# Plan Title

## Summary
Brief description of what this plan accomplishes.

## Steps
1. **Step description** - Details and approach
2. **Another step** - More details
3. ...
```

### Research → Implementation Workflow

The recommended workflow:
1. **Research** - Read files, search code, understand the codebase
2. **Plan** - Write a structured plan to the plans folder
3. **Submit** - Call `SubmitPlan` to present to user
4. **Accept** - User clicks "Accept Plan" to exit Plan mode
5. **Execute** - Implement the plan in the mode the session is now in

This provides a smooth transition from exploration to implementation with user oversight.
