# Working Directory

The working directory is your agent's **current working directory (cwd)** — the same notion `cwd` carries in a terminal. Unless you say otherwise, file operations and shell commands resolve against this folder. Ask it to look at a config file or kick off the test suite and that folder is where it begins.

You can change it at any point during a conversation.

## What the Working Directory Does

Picture yourself dropping into a shell and issuing `cd /path/to/project`. From there, each action the agent takes is anchored to that spot:

- **Read** files and their contents
- **Write** new files or overwrite existing ones
- **Edit** files with precise text replacements
- **Search** with Glob (file patterns) and Grep (content search)
- **Run** bash commands in that directory

Contrast this with [Sources](/sources/overview), which talk to outside services over MCP. The working directory covers direct access to files on your own machine.

## Setting the Working Directory

Click the folder badge in the chat input to set or change the cwd for the current conversation. The badge shows the folder name and, when the directory is a git repository, the current branch.

Clicking it lets you:

- Pick from your recent directories
- Browse for a different folder
- Reset back to the session's starting directory

When the cwd is a git repository, a branch control next to the badge lists the
local branches and switches between them. If you have uncommitted changes it
does not fail silently — it explains that you have local changes and offers
"Stash & switch", which stashes your work, switches, and restores it (your
changes are never discarded, even if the restore conflicts). Outside a git
repository the control is shown disabled with a short explanation.

The change takes effect immediately — later commands run from the new location. Nessy Desktop keeps a short history of recent directories so switching back is one click away.

## Available Tools

These agent-native tools all operate from the cwd by default:

| Tool      | Purpose                        | Example                     |
| --------- | ------------------------------ | --------------------------- |
| **Read**  | View file contents             | Read a configuration file   |
| **Write** | Create or overwrite files      | Write a new component       |
| **Edit**  | Make precise text replacements | Fix a bug in existing code  |
| **Glob**  | Find files by pattern          | Find every `*.tsx` file     |
| **Grep**  | Search file contents           | Find usages of a function   |
| **Bash**  | Run shell commands             | Run tests or git operations |

Each one touches your filesystem directly, with no MCP layer in between.

## Project Context And Memory Files

If the working directory contains a `CLAUDE.md` or `AGENTS.md` file, its contents are surfaced to the agent as project context. The match is case-insensitive, so `Claude.md`, `agents.md`, and similar casings all work. Files are discovered recursively through the directory tree, which supports monorepos where each package carries its own context file. Each file is capped at 10&nbsp;KB; anything longer is truncated.

Use these files to record things like:

- Project structure and conventions
- Build and test commands
- Which files matter and what they do
- Team-specific guidelines

```markdown
# CLAUDE.md

This is a Next.js application written in TypeScript.

## Commands
- `npm run dev`   — start the development server
- `npm test`      — run tests
- `npm run build` — production build

## Structure
- `src/components/` — React components
- `src/lib/`        — utility functions
- `src/app/`        — Next.js app-router pages
```

The agent reads this automatically when a conversation runs in that working directory.

## Project scope and the `.nessy-agent` namespace

A Workspace groups projects, capabilities and sessions; the selected project is
the agent's actual filesystem workspace. The project's canonical path is the
session's one primary filesystem root: file tools and shell commands operate
inside it without extra approval. Pi's file tools can also write in the system
temp folders (`$TMPDIR`, `/tmp`) without a prompt, but a shell command that
writes there asks on Claude Code and Pi: in Manual, and for a redirect into them
(for example `echo x > /tmp/a`) in Accept edits too. Managed Nessy storage under `~/.nessy-agent`
stays off-limits to generic file tools even when a broader parent folder has
been approved. Git metadata (`.git`) and the project's agent configuration
(`.nessy-agent`, `.agents`) are read-only for the agent's file tools — edit
those yourself.

Each chat also has a scratch folder of its own for temporary files:
`~/.nessy-agent/sessions/<workspace>/<session>/job/tmp` (under your data folder,
if you moved it). On Claude Code and Pi the agent's `Write` and `Edit` calls into
it take no approval card in Manual, Accept edits and Auto; Plan still refuses the
write, and Don't ask denies it. Only that chat's `job/tmp` is
covered: the rest of its `job` folder and another chat's scratch folder ask as
usual. From the shell, only Claude Code has a spelling that skips the card — a
read-only command such as `echo` redirected into `$CLAUDE_JOB_DIR/tmp/…`; the
folder's literal path, and every spelling on Pi, ask as usual. The folder is
deleted together with the chat. Codex is given the folder's parent `job` in the
`NESSY_SESSION_JOB_DIR` environment variable.

The **Primary folder** control on the Permissions page does not move this root.
It chooses which of the folders already attached is shown and ordered first —
see [Permissions](/core-concepts/permissions#the-primary-attached-folder).

A path outside the project root raises one structured approval showing the
canonical target and the requested access. "Allow once" covers only that call;
"Allow for this session" adds a revocable session root visible in the runtime
panel. Approvals never carry over to other sessions or branches.

A trusted project can also configure Nessy through `<project>/.nessy-agent/`:
`config.toml` (`[defaults] model / thinking_level / permission_mode` — a
project can narrow but never weaken your permission floor — and `[plugins]`
selectors), plus `skills/`, `agents/`, `commands/`, `rules/`, `mcp.json`,
`hooks.json` and `MEMORY.md`. Nothing repository-owned loads before you trust
the project, and the legacy `.nessy` directory is ignored entirely.

The same decision holds on the Claude Code and Codex runtimes. On **Claude
Code**, a project you have not trusted (*Keep restricted*, or no answer yet)
contributes nothing from the repository: its `.claude/settings.json` and
`.claude/settings.local.json` (their hooks, `env` block and permission rules),
its `.mcp.json` servers, its `CLAUDE.md` and `CLAUDE.local.md`, and the rules,
skills, commands and subagents under its `.claude/` are not loaded. Your own
user-level Claude Code settings still are. On **Codex**, Nessy writes your
decision into Codex's configuration as that folder's trust entry, so Codex never
trusts the folder by itself when a session opens: a restricted project's
`.codex/` layer (its MCP servers, hooks and rules) does not load, and Codex does
not read the project's `AGENTS.md` on its own either. Codex would still load a restricted project's skills —
from its `.codex/skills` folder and from every `.agents/skills` folder between the
project root and the working folder — so each time a chat opens its Codex thread, Nessy
asks Codex for that list and switches every one of those skills off; if Codex cannot
give the list, the thread is not opened. A skill added to the project while a chat is
open stays available until that chat next opens its thread. Trusting the project
brings all of this back. Whatever you decide, a project's `.codex/config.toml`,
or your own `~/.codex` when your home folder is the project, cannot switch the
Codex sandbox or approval policy off, and cannot hand your approvals to Codex's
auto-review reviewer while [Codex auto-review](/reference/config/config-file) is
off: Nessy restates all three, with its permission profile, on every thread it
opens, above every project setting.

Before you decide, the trust dialog lists what the repository would actually
contribute: its `AGENTS.md`/`CLAUDE.md` instruction files, `.nessy-agent`
configuration, MCP server configs, skills, and hooks. Detection is read-only —
nothing is executed, oversized or non-regular files are skipped, and only
path-free names cross into the dialog. The same inventory can be re-inspected
any time later from the Sources panel.

Since 1.40.0 the prompt is skipped entirely where that inventory is empty: a
folder that would contribute nothing is not worth a question, and the prompt
returns the moment something appears — it is re-evaluated per session and per
launch, and the untrusted state itself is unchanged. The inventory the prompt
reads now covers the whole `.nessy-agent` tier it previews (`agents`, `mcp.json`,
`hooks.json`, `permissions.json`, `MEMORY.md`, `rules`) and the portable
`.agents/skills` layer, which it did not before. Since 1.41.0 it also covers the
layers Claude Code and Codex load only for a trusted project: a `.codex/` folder's
`config.toml`, `hooks.json`, `rules/` and `agents/`, and `.claude/skills` and
`.claude/rules`, so a folder that carries only one of them is asked about too.
For a folder inside a repository it also covers those layers where the runtimes
read them above the folder — in the repository root and every folder in between,
such as a monorepo's root `.codex/`, `.claude/skills`, `.mcp.json` or `AGENTS.md` —
and lists them by their path relative to the folder (for example
`../../.claude/skills`).
In a linked git worktree it also covers what Claude Code reads from the main
checkout: its `.claude/settings.local.json`, and its `.claude/agents` and
`.claude/commands` when the worktree has no folder of that name (for example
`../main/.claude/commands`). Trust is still asked per folder: trusting the main
checkout does not trust its worktrees.
Claude Code reads further up still, and the prompt follows it: the `CLAUDE.md`,
`CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/rules` and `.mcp.json` of the
folders above the repository root and, for a folder in no repository, also the
`.claude/skills`, `.claude/agents` and `.claude/commands` of its parent folders —
stopping below your home folder, so your personal `~/CLAUDE.md` and `~/.claude`
setup is never asked about (in a Nessy Claude Code session it loads only for a
trusted project).
On Pi, trust also starts the language servers of your enabled code-intelligence
plugins and the checks that run after each edit, so since 1.41.0 the prompt names
those servers too and an ordinary code folder is asked about while such a plugin
is enabled.

Durable memory lives in `MEMORY.md`. A project `MEMORY.md` is merged with your
personal and session memory before each turn, and memory files can inline nearby
markdown with either `@import ./path.md` or `@./path.md`.

The chat's own **Memory** menu says what the runtime does beside all this. Under
**Runtime notes** a Claude Code session now reports whether the runtime keeps
notes of its own for this chat and the directory they are written to — they
outlive the chat and nothing in Nessy reads them — or that memory is off for this
chat and neither happens. The same section says when an administrator has put the
session into the runtime's restricted mode, that files your deny rules cover are
kept out of search results by Nessy itself rather than by the runtime, and that
the runtime may enter a git worktree of its own accord while the working
directory recorded here stays as it was.

Notes the agent writes itself are tagged as agent-written, and a daily
background pass quietly deduplicates them and ages out stale ones past a
threshold. Anything you wrote by hand is never touched — human notes stay
byte-for-byte as you left them, and the agent-written tag is stripped before the
memory reaches the prompt.

For path-specific guidance, add markdown files under `.agents/rules/` with a
frontmatter path match:

```markdown
---
paths:
  - packages/ui/**
---

Prefer existing UI primitives before adding a new component.
```

The rule is loaded only when the current working directory matches the declared
path, so monorepos can keep package-specific instructions without leaking them
into unrelated tasks.

## Setting the cwd from the CLI

For one-shot runs, pass a directory to `run` with `--workspace-dir`:

```bash
bun run apps/cli/src/index.ts run --workspace-dir /path/to/project "Summarise the repo"
```

The CLI creates or reuses a name-only Workspace, validates the directory as an
external Project, and selects it through a Workspace-bound opaque handle before
sending the prompt. The Project remains outside managed Workspace storage. See
the [CLI reference](/reference/cli) for the full set of flags.

## Working Directory vs Sources

| Aspect                 | Working Directory                          | Sources                             |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| **Access method**      | Direct agent tools (`Read`, `Write`, `Bash`) | MCP tools (`mcp__slug__toolname`)   |
| **Scope**              | A single local folder                      | One or more services or paths       |
| **Authentication**     | None needed                                | OAuth, API keys, or tokens          |
| **Permission control** | Session permission modes                   | Per-source `permissions.json`       |
| **Project context**    | `CLAUDE.md`, `AGENTS.md`, memory, and rules | Source guide instructions           |
| **Typical use**        | Coding and local files                     | External services and remote data   |

## When to Use Each

**Use the working directory for:**

- Writing and editing code
- Running build scripts and tests
- Git operations (commit, branch, diff)
- Reading project files and configs
- Anything that touches local files

**Use sources for:**

- Reaching external services through MCP
- Reading from remote APIs
- Connecting to hosted databases
- Accessing files elsewhere via an MCP filesystem server
- Anything that needs authentication to an external service

**Use both together.** Many workflows combine them — pull issues from an MCP source, then fix them in code; read documentation from an API source, then write the implementation locally.

## Best Practices

- **Keep context files current.** Well-maintained `CLAUDE.md`, `AGENTS.md`, and `MEMORY.md` files help the agent understand your project's structure and conventions. Update them as the project changes.
- **Point at the specific project.** Instead of your home folder, set the cwd to the exact project you are working on — it keeps the agent focused and faster.
- **Lean on git integration.** When the cwd is a git repository, the badge shows the branch and the agent can use git effectively. Use Plan mode to review changes safely before committing.
- **Bring extra folders in as sources.** Working across several locations? Leave the primary project as your working directory and register each additional path as a [local folder](/sources/local-filesystems).
