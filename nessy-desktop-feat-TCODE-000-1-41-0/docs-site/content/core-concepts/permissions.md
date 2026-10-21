# Permissions

Your agent can do consequential things — read files, run shell commands, edit documents, call external tools. To keep you in charge of how far it goes on its own, Nessy Desktop runs every session in one of Claude Code's six permission modes, which set the level of autonomy.

::: tip
**Just ask.** You can have the agent adjust permissions for you. Try "Allow `npm run build` in Plan mode" or "Let me run pytest without a prompt", and it will edit the configuration files itself.
:::

## Permission Modes

There are six modes, listed here from most restrictive to least. The mode menu offers five of them, and **SHIFT+TAB** in the chat input cycles through the same five (see [Switching Modes](#switching-modes)).

| Mode                   | Config value        | Behaviour                                              | Best for                          |
| ---------------------- | ------------------- | ------------------------------------------------------ | --------------------------------- |
| **Don't ask**          | `dontAsk`           | Never prompts; runs only pre-approved actions, denies the rest | Runs where nobody can answer      |
| **Plan**               | `plan`              | Read-only, to prepare a plan; writes only its plan file and the session's data folder | Research, and scoping work before you commit |
| **Manual**             | `default`           | Always asks before making changes                      | Controlled, step-by-step work     |
| **Accept edits**       | `acceptEdits`       | Auto-accepts file edits in session roots; still asks for the rest | Fast iteration on trusted files   |
| **Auto**               | `auto`              | Handles permission decisions for you: low-risk actions proceed, a safety judge reviews borderline ones | The default — longer tasks with safety checks |
| **Bypass permissions** | `bypassPermissions` | Accepts all permissions — approval granted in advance; some calls are still refused | Trusted, repeatable automation    |

These are Claude Code's own permission modes, with its config values, so a mode name you know from there means the same thing here, and the names and descriptions are the ones Claude Desktop's mode menu shows. Nessy Desktop's own **Explore** mode is retired since 1.41.0, and Plan takes its place — see [Explore Mode Is Retired](#explore-mode-is-retired) below.

### A mode states your intent; the runtime decides how much of it it can hold you to

The table above is what you are asking for, and it reads the same whichever
runtime a session is on — that is deliberate, because your intent does not
change when you switch runtime mid-conversation.

What does change is enforcement. On **Pi** and **Claude**, Nessy checks each
action before it runs, so the mode is enforced by us. On **Codex** it is not:
that runtime decides for itself what to ask you about, and Nessy answers rather
than gates. Two consequences follow, and the app now says both of them next to
the mode you are picking rather than leaving you to find out:

- In Plan on Codex, what holds a file change back is Codex's own read-only
  sandbox, not Nessy: a command that writes a file is refused, and a file edit
  asks you first. Directories you added to the session, and the session's own
  plans and data folders, stay writable.
- Plan on Codex produces no plan to approve — that runtime has no such concept.

The one exception is Don't ask: Nessy answers Codex's requests in that mode, so
what no rule pre-approves is refused without a prompt. Codex still runs commands
it judges to be safe file reads without asking us at all, and, whether the OS
sandbox is switched on or off, it runs everything its read-only sandbox permits
the same way — including a write into a directory you added to the session,
which needs no rule and shows no card.

Where Codex does ask Nessy — an MCP tool call or a session tool — Nessy answers
by your mode and your rules, as on Pi and Claude Code:

- In Plan, a source's write tool and a session-configuration tool (for example
  editing an automation) are refused, not shown to you as a card.
- An allow or deny rule for `mcp__<source>__<tool>`, or for a session tool,
  approves or refuses the call with no card.
- A deny rule for MCP tools — one tool, a whole server or a pattern — removes the
  tools it names from Codex entirely, and an ask rule makes Codex ask even about
  a tool its server marks read-only. The one gap: a source that was still
  connecting when the Codex runtime started can add a read-only tool that Codex
  runs without asking, until the runtime restarts; the session records a note
  saying so.
- **Always Allow** on a Codex MCP card lasts for the rest of the session.
- **Always Allow** on a Codex shell-command card saves a rule for that command in
  the workspace permissions, so later sessions in the workspace run it without
  asking, and the card says so under its buttons. A card whose approval cannot be
  saved says it lasts for the session.
- Since 1.41.0 a shell command Codex asks you about runs **outside** Codex's
  sandbox once you approve it, as Codex does on its own: Nessy no longer adds a
  credential deny list to that sandbox (see `deniedPaths` below). Only while one
  of your own `deniedPaths` entries reaches Codex does an approved command stay
  inside the sandbox; then anything it blocks, such as a write outside the
  working folder, still fails, the card says so, and **Always Allow** on that
  card lasts for the rest of the session and saves no permanent rule.
- An ask rule for a shell command or an MCP tool waits on a card that names the
  rule, Bypass permissions included, and that card has no **Always allow**; when
  nobody is present to answer, the call is refused, naming the rule.
- A deny or ask rule you add while a Codex session is running applies from that
  session's next turn, including to the commands Codex runs without asking.
- With [Codex auto-review](/reference/config/config-file) on, the reviewer
  answers only in Auto and Bypass permissions: in Manual, Accept edits and Plan
  what Codex asks comes to you, and Don't ask refuses it. If your organisation's
  Codex policy allows only the reviewer, that policy wins, with auto-review on or
  off: the reviewer answers in Manual, Accept edits and Don't ask too (so in
  Don't ask it may approve what no rule pre-approves), Codex refuses Plan turns,
  and the session says so.

Older configurations keep working: the retired `explore`, the pre-migration spellings `safe`, `ask`, and `allow-all`, the still older `execute` and `ask-to-edit`, `automatic`, and Claude's `manual` synonym are permanent aliases on every read path — session files, workspace config, agent definitions, automations, and deep links all accept them (case- and separator-insensitively) and resolve them to the modes above; `explore` and `safe` resolve to `plan`. New writes always use the current spellings.

### Each Mode on Each Runtime

The six modes mean the same on every runtime; how a runtime holds you to them differs:

- **Claude Code** runs each session in the Claude Agent SDK's own mode of the same name, and Nessy's check runs before each tool call, as described in the sections below.
- **Pi** follows Claude Code's pages: Nessy's own check reads the mode directly and decides each call before it runs.
- **Codex** has no such modes of its own, so each mode is mapped onto Codex's own settings — its sandbox, its approval questions, and its auto-review reviewer — and Nessy answers the questions Codex asks by your mode and rules. Where Codex has no matching setting, the table says what is different:

| Mode | What Codex is set to | What differs on Codex |
| --- | --- | --- |
| **Auto** | Codex's own *Default* setup: it reads, edits and runs commands inside the workspace, and asks before it goes further. With [Codex auto-review](/reference/config/config-file) on, Codex's reviewer answers those questions before you do. | Auto-review is off by default, and without it Auto on Codex works like Accept edits: what Codex asks comes to you. The reviewer judges only what Codex asks about. |
| **Manual** | The same *Default* setup. What Codex asks about comes to you. | Codex cannot ask before an edit or a command inside the workspace, so on Codex, Manual edits files and runs commands there without a card; it asks about what goes beyond the workspace. |
| **Accept edits** | The same *Default* setup. What Codex asks about comes to you. | Codex has no edits-only setting: inside the workspace it also runs any command its sandbox allows, not only `mkdir`, `touch`, `mv` and `cp`. |
| **Plan** | Codex's own *Read Only* setup, with the session's plans and data folders and any directory you added kept writable. What Codex asks about always comes to you, never to the reviewer. | Codex's own plan mode is not used, so there is no plan to approve, and commands during planning are not reviewed by a judge as they are on Pi. |
| **Bypass permissions** | The *Default* setup, and Nessy answers yes to everything Codex asks unless a safety floor or one of your ask rules applies. With auto-review on, Codex's reviewer answers first. | Codex's own *Full Access* is never used: protected folders stay read-only, and a shell command that writes outside the workspace is refused by the operating system, which is narrower than Bypass on Claude Code. |
| **Don't ask** | *Read Only*. What no rule pre-approves is refused without a prompt, and the reviewer never answers — unless your organisation's Codex policy allows only the reviewer (see above). | Any directory you added to the session stays writable, so a command or a file change there runs with no rule and no card, where Claude Code's Don't ask refuses it unless a rule allows it. |

**Nestor Cloud** sessions use the cloud agent's own modes instead — see [Switching Modes](#switching-modes).

### Don't Ask Mode (`dontAsk`)

Don't ask never prompts — it exists for runs where nobody is present to answer. Only actions that are pre-approved can run: what your permission rules explicitly allow, the built-in read-only command set, and calls a hook approves. Everything else is denied outright with a reason the agent can report, instead of a prompt that would hang forever.

Because there is nobody to ask:

- `WebFetch` and the browser tool are denied unless an allow rule pre-approves them.
- Web search is pre-approved: it runs here as in every other mode, with no
  card, unless a deny rule names the search tool. A `WebSearch` deny covers
  Claude Code's own search, Pi's `web_search`, the app's own search tool
  (`mcp__session__web_search`) wherever it is offered, and Codex's own search on the
  ChatGPT (Codex) card, which is switched off when the session starts or, for a
  rule added mid-session, from the next turn. An allow or ask rule for
  `WebSearch` does not carry to the app's search tool, and cannot reach Codex's
  own search, which has no approval step. Search domains are unrestricted unless
  an operator sets
  [`NESSY_WEB_SEARCH_ALLOWED_DOMAINS`](/reference/config/environment-variables#nessy-web-search-allowed-domains).
- Writes to [protected paths](#protected-paths) are denied, never prompted.
- Any tool that requires human interaction is denied.

Don't ask never enters the **SHIFT+TAB** rotation and is not offered in the mode menu — cycling into a mode that silently denies everything would be a surprise. Select it deliberately: as a workspace default, from an automation, or through a deep link. A session or automation that runs in it still shows the mode by its name, Don't ask.

### Plan Mode (`plan`)

Plan is the read-only mode, for research and for planning: the agent can gather information but cannot change your files. It may end with a plan you approve before any execution, or simply answer you — as in Claude Code's plan mode, a plan is not required.

**Allowed:**

- `Read`, `Glob`, `Grep` — reading and searching files
- `WebSearch`, `WebFetch` — web search and page fetching
- `Task`, `TaskOutput` — sub-agent orchestration
- `TodoWrite`, `SubmitPlan` — planning
- `LSP` — read-only language-server queries (hover, definitions, and so on)
- `browser_tool` — browser commands that only read the page or browser state
- Read-only bash commands (see [Safe Commands](#safe-commands) below)

**Blocked or asked:**

- `Write`, `Edit`, `MultiEdit`, `NotebookEdit` — except for the two folders below
- MCP tool mutations (create, update, delete)
- Write-style API requests (POST, PUT, DELETE)
- Bash mutations (`rm`, `mv`, `mkdir`, and the like) and browser commands that change page or browser state — these are not refused outright, see the shell rule below

The four core write tools are hard-blocked and cannot be re-enabled through configuration, with two exceptions on Pi and Claude Code. The first is the plan itself: the agent writes it as a Markdown (`.md`) file in the session's own plans folder with `Write`, `Edit` or `MultiEdit`, and `SubmitPlan` then opens the plan card for you. The second is the session's own data folder, where any of the four tools may write any file, with no [protected-path](#protected-paths) card: Claude Code and Pi both write the file. Pi's file tools reach the whole of the session's own folder except its records (`session.jsonl`, `attachments`, `long_responses`, and the files Nessy and Pi keep there: `.pi-carry`, `.pi-sessions`, `.pi-agent`, `.orchestrator`, `meta`, `hook-env`, `file_checkpoints`, `checkout-move.patch`, `tool-metadata.json` and `api-error.json`), which they never write; of those they read only `attachments` and `long_responses`, where the agent finds the files you attached and the full output of a large tool result. Plan writes nothing else: no other file in the plans folder, nothing in a directory added to the session, and no shell write. On Codex the plans and data folders and any added directory stay writable, as described above.

When a tool is refused, the agent is told why and answers you — it does not stop mid-turn. A refusal is a refusal of that one tool call, not of the whole reply, so you get an explanation of what was blocked and can decide what to do next.

Shell commands during planning follow their own rule: read-only commands run freely, while on Pi sessions a command outside the read-only set is reviewed by the [Guardian safety judge](#guardian-safety-judge) when it is available (this is the default) — approved commands run, rejected ones are blocked. Without the judge, and on Claude Code, such commands prompt you instead; Codex decides for itself what to ask you about, as described above. A browser command that changes page or browser state is handled the same way.

Plan mode never ends on its own. The agent submitting a plan leaves the session in Plan; sending another message refines the plan rather than exiting. Accepting the plan is the one explicit step that transitions the session. Approving from Plan switches it to **Manual**, so the plan can run and each edit still asks you. Approving from Manual, Accept edits, Auto or Bypass permissions leaves that mode as it is. An approval never switches a session into Bypass permissions; Bypass is only entered through its own confirmation. Re-entering Plan later is equally explicit. Reach for Plan when you want the agent to look around and reason without any chance of an accidental change, or when you want a proposed approach first, then carry it out at whatever autonomy level suits.

### Explore Mode Is Retired

Until 1.41.0 Nessy Desktop had a seventh mode of its own, Explore (`explore`), which Claude Code does not have. It is gone, and Plan takes its place:

- A session, automation, workspace default, agent definition, deep link or CLI flag that names Explore — or its older spelling `safe` — opens in Plan, and is written back as `plan`. An automation saved in Explore shows and runs as Plan, and the next time any automation is saved, the file says `plan`.
- Plan now also writes into the session's data folder, as Explore did. Explore's other writes are gone: anything in the plans folder other than the `.md` plan, directories added to the session, the paths listed in `allowedWritePaths`, and shell redirects into those folders. Settings → Permissions no longer offers `allowedWritePaths`; a `permissions.json` that still lists it loads as before, and no mode reads it.
- A former Explore session behaves as Plan in everything else too: on Pi a shell command outside the read-only set, or a browser command that changes the page, goes to the Guardian or asks you instead of being refused.
- For messages from your other sessions it counts as Plan as well. Where Bypass permissions is available, Plan counts as bypassing permission prompts, so such a session now holds a message from a session that prompts for your approval, and takes one from a bypassing session without asking ([`crossSessionInbound`](/reference/config/config-file) changes that default).
- The agent's own tools that start a session or create or edit an automation offer the six modes; an agent that asks for `explore` there gets an error that names them.

### Manual Mode (`default`)

Manual applies a three-tier policy to bash commands:

| Command type           | Behaviour                                          |
| ---------------------- | -------------------------------------------------- |
| **Safe commands**      | Auto-allowed, exactly as in Plan mode              |
| **Regular commands**   | Prompt for approval; "always allow" is offered     |
| **Dangerous commands** | Prompt every time; "always allow" is not offered   |

**"Safe commands" is the read-only allowlist, and it runs unasked.** It is the
same set Plan mode runs freely — see [Safe Commands](#safe-commands), loaded
from `default.json` so you can extend it — and a command in it runs with no card
at all, even though you never approved it and even though Manual is the mode you
picked in order to be asked. `echo`, `uname` and their siblings therefore never
prompt here, on any runtime, while an edit in the same session still does. That
is the posture rather than an oversight: what Manual asks about is a command that
can change something. No mode asks before a read-only command — Plan runs the same
set freely — so to be asked about one as well, add an ask rule for it.

When the agent wants to run something that isn't a safe command, you get a prompt:

```
The agent wants to run: npm install lodash

Allow?  [y]es  /  [n]o  /  [a]lways allow
```

- **yes** — permit this one operation
- **no** — deny it
- **always** — remember the approval, so the same command runs without a card next time. What is remembered, and for how long, depends on the runtime: see [What Always Allow Remembers](#what-always-allow-remembers). The button is not offered when nothing exact can be remembered (dangerous commands among them).

**Either answer can carry a note.** The card has a comment field, and what you
type reaches the model: as the reason if you deny, and after the result if you
allow. It works the same on Pi, Claude Code and Codex — on Claude Code the
denial reason travels on the runtime's own field rather than through ours.
"Always allow" deliberately takes no note: a note explains one answer, and a
rule outlives the answer that made it.

### Accept Edits Mode (`acceptEdits`)

Accept edits auto-approves file writes (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) so the agent can iterate on files without a prompt for each change, while still prompting for shell commands, network calls, and MCP tool actions.

The auto-approval is bounded, not global. A write is only accepted automatically when its target sits inside the session's write roots — the working directory, the workspace root, the session's plans and data folders, and any additional directories attached to the session. A write anywhere else prompts as usual.

One app action counts as a file write: saving a memory note to the session or project memory file, which is accepted like a write inside those roots. A note to your user-wide memory, and every other app action — installing a plugin, managing sources, automations or schedules — still asks.

Four plain filesystem commands — `mkdir`, `touch`, `mv`, `cp` — are also auto-approved, and only when every target is inside those same roots and the command is exactly that one command: any pipe, chain, redirect, or substitution sends it back to the normal prompt. This set is deliberately narrower than Claude Code's equivalent: `rm`, `rmdir`, and `sed` are never auto-approved here, and env-prefixed or wrapper spellings (`env mkdir …`) do not ride the exemption — a deletion or a wrapped command always prompts.

### Auto Mode (`auto`)

Auto is the guided-autonomy mode, and it is the mode a new session starts in. Low-risk actions the app can classify confidently run without a prompt; borderline actions are reviewed by the [Guardian safety judge](#guardian-safety-judge) on Pi sessions before falling back to a prompt, and prompt you directly on Claude Code and Codex; clearly risky actions prompt as usual. Use it for longer coding tasks where you want fewer interruptions without giving the agent full no-prompt freedom.

Set a different starting mode per workspace in **Workspace Settings**, or app-wide through the `permissionMode` workspace default.

Three bounds keep Auto honest:

- **Writes are bounded by the same session roots Accept edits uses.** Auto never auto-approves a file write outside the working directory, workspace root, session plans/data folders, and additional directories — such a write follows the normal prompt flow.
- **Auto pauses itself when the judge keeps objecting, on Pi sessions.** If the safety judge blocks 3 actions in a row, or 20 in total within a session, Auto mode stops: the session drops to Manual, tells you (and the agent) why, and prompting resumes. Switch back to Auto explicitly if you want it again. On Claude Code and Codex the mode never changes on its own.
- **The first read outside the working directories asks.** Reads had no boundary at all before — the write side had roots and the read side had nothing. Auto now raises one card the first time a session reads outside its working directories, with three answers: *Allow once*, *Keep allowing* (silences the prompt for this session) and *Block from now on*, which refuses such reads in every later session too. The last answer writes `blockReadsOutsideWorkingDirectories: true` in `config.json`, and an operator can set that key directly: it is a hard fence that binds in **every** mode, Bypass included, not merely a prompt.

The judge's own refusals are readable now. **Settings → Permissions** lists what
Auto's safety judge denied and shows the rules the judge itself is given, so a
deployment is no longer instructing a second model in private. The same page
says how the workspace and app scopes compose, and marks a workspace rule the
defaults already grant as inert.

### Bypass Permissions Mode (`bypassPermissions`)

Bypass permissions grants full autonomy. Operations run without prompting, which is what makes hands-off, uninterrupted workflows possible.

It is deliberately gated:

- It is **offered by default**, in the SHIFT+TAB rotation and in the mode menu alike. To take it out for a workspace, remove it from the cyclable modes in **Workspace Settings**.
- The **first activation** on an install shows a responsibility confirmation; declining leaves the session in its current mode.
- A **managed policy** installed by an administrator can disable the mode entirely; a session that asks for it then lands on the strictest available alternative instead.
- It is **not restored when a session is reopened** from disk, for example after the app restarts: a session saved in Bypass permissions reopens in the mode a new session in its workspace would start in (Auto unless you changed the default), as Claude Code does when it resumes a session. Switch back to Bypass permissions to continue unattended.

Even in Bypass permissions, three floors remain: removals aimed at the filesystem root or your home directory (`rm -rf /`, `rm -rf ~`) still prompt as a circuit breaker, Nessy's own control records (the files that decide what later sessions may do — see [Protected Paths](#protected-paths)) are refused, and on Pi sessions the [Guardian](#guardian-safety-judge) can veto high-risk actions.

A check inside one tool is not a boundary in Bypass permissions, because the agent's own shell commands around it run without a card. For example, `plugin_plan_install` refuses a repository URL it has no route for (a `file://` or `git://` address, say — see [Plugins](/plugins/overview)), and a Bypass session can answer that by serving the plugin source itself: in one measured session a Pi model started its own local `git daemon` to do exactly that.

::: warning
Bypass permissions skips the permission prompts entirely. Only use it when you trust every action the agent might take — for example, in a well-understood automation you have run before.
:::

## Guardian Safety Judge

The Guardian is an optional LLM safety judge that reviews risky actions in the
autonomous modes on **Pi** sessions. It is a consulted input to the permission system — it can
block or ask, but never grants anything the mode would already deny.

- **In Auto mode**, the Guardian reviews borderline actions before Nessy asks
  you. `No objection` lets the action run; a `deny` blocks it with a short
  reason; anything uncertain still asks you as usual. This cuts down on prompts
  for actions the judge is confident about.
- **In Plan mode**, the Guardian reviews shell commands outside the read-only
  set during planning (on by default via the auto-during-plan setting).
  Approved commands run, rejected ones are blocked; when the judge is
  unavailable, those commands prompt you instead.
- **In Bypass permissions mode**, the Guardian acts as a deny-only safety net on
  high-risk actions — secret exfiltration, credential probing, destructive
  operations, and git actions on protected branches. It can block a dangerous
  action or downgrade it to a prompt, but everything else runs as usual with no
  added latency. File edits inside the session's folders (the working directory,
  the workspace, the session's plans and data folders and any additional
  directories) run without it, as in Auto; an edit outside them, or to a
  [protected path](#protected-paths), is still reviewed. With the Guardian on, Bypass also consults it before an app
  action such as installing a plugin or managing sources, as it does for other
  MCP actions.
- **In Don't ask, Manual, and Accept edits**, the Guardian never runs.

**Claude Code and Codex sessions do not consult the Guardian about their
actions.** What it would have reviewed in Auto or Plan asks you instead, and
Bypass has no deny-only net on those runtimes. Codex has a reviewer of its own:
with [Codex auto-review](/reference/config/config-file) turned on, Codex asks it
before asking you, in Auto and Bypass permissions.

The judge never answers a question that is reserved for you: a write to a
[protected path](#protected-paths), a removal caught by the circuit breaker, or
an explicit `ask` rule always reaches a human, not the model.

The judge runs as a read-only helper (it can read files and inspect git state
but cannot edit, run commands, or reach the network) and has a hard time limit
of 90 seconds per review. Within it the judge may look before it answers: up to
eight model round trips, so it can read the target of an action and then give
its verdict. If it times out, errors, or cannot decide, Nessy always falls back
to asking you — never to running the action.

The judge rules on the planned action with its input — a command, an MCP or
session tool's arguments, a file write or edit's path and content — and on your
own words. Nothing else is taken for yours: a skill you run reaches it by name
only and it loads no skill, and it starts with none of the session's MCP
servers, so neither a skill's instructions nor a server's description of itself
can steer its verdict. The judge never shows you a card of its own: a read
outside the project, a call an `ask` rule matches, or a hook that would raise
one while it judges is refused at once instead. A refused read is marked as giving no file
content, and its instructions send an action whose risk depends on content it
could not read to you instead.

Turn the Guardian on or off, and choose the model it runs on, in **Settings →
AI → Guardian**. It is on by default. The default model is the fast Nessy
Gateway model; a cheap, fast model is recommended.

The same switch governs one review that runs on every runtime and in every mode:
a message one session's agent sends into another session is judged before it is
delivered, by a judge with no tools at all. A message it refuses is not
delivered, and the sending agent is told why. If that judge cannot answer, the
message is delivered, because no one is there to ask.

## Switching Modes

The mode menu in the composer is Claude Desktop's: **Auto** (marked *Recommended*), **Manual**, **Accept edits**, **Plan** and **Bypass permissions**, in that order and numbered 1–5 — while the menu is open, pressing a digit picks that mode. A check marks the current mode, and a *Default* badge marks the mode a new session in this workspace starts in (it follows a default you change in Workspace Settings as soon as the change is saved).

**SHIFT+TAB** in the chat input steps through the same list as a ring:

```
Auto → Manual → Accept edits → Plan → Bypass permissions → Auto → …
```

**Don't ask** is the one mode the menu and the rotation leave out: it silently denies and never prompts, so it is selected through configuration, the CLI flag or an automation only. From Don't ask, or from a mode the workspace left out of its rotation, the first **SHIFT+TAB** goes to Manual. **Bypass permissions** is offered by default — in the rotation and in the mode menu alike. The first time you enter it on an install, a confirmation dialog asks you to accept responsibility; every switch after that is direct. To take it back out for a workspace, remove it from that workspace's cyclable-modes setting.

The current mode is always shown in the interface so you can see how much freedom the agent has at a glance. You can narrow the cycle in **Workspace Settings** to only the modes you use (a minimum of two). Each mode is also a slash command in the composer.

One more rule applies to sub-agents and to the subtasks a task runs: a child session's mode is clamped so it is never broader than its parent's — for a task's subtask, the task's own session — so a child can narrow its permissions, never widen them, and the clamp is re-applied on every later mode change. For a task, lowering the orchestrator's mode during a run caps each running subtask's next mode change and every subtask that starts after it, and a run resumed after a restart keeps the mode it last ran under until you change the orchestrator's mode. A subtask you add yourself from a board tile is your own session and is not clamped.

**Nestor Cloud sessions offer Nestor Cloud's own modes.** When such a session starts, Nessy Desktop reads the modes the cloud agent advertises — today **Plan** and **Act** — and the mode menu, the slash menu and SHIFT+TAB offer only those, under Nestor's own names and descriptions (not translated). Each turn sends the chosen mode to Nestor Cloud by its own id, `plan` or `act`. The list comes from Nestor Cloud, not from the table above, so a change to Nessy Desktop's own modes does not change it; if the agent's card cannot be read, the session offers the same built-in pair ([Nestor Cloud composer modes](/reference/config/llm-connections#nestor-cloud-composer-modes)). The file and shell actions the cloud agent asks for still run on your computer under Nessy Desktop's own checks: read-only under Plan, and under Act the checks of Manual, which ask before risky actions. The iPhone app's mode menu offers the same two on a Nestor Cloud session, and on every other session Auto, Manual, Accept edits and Plan, with Bypass permissions listed but greyed out, because the server does not accept it from a phone.

## Protected Paths

A small set of paths is never auto-approved for writing, no matter what allow rules say — this check runs before allow rules are even read, so a broad allow pattern cannot open it:

- Repository and tooling state: `.git`, `.husky`, `.vscode`, `.idea`, `.cargo`, `.devcontainer`, and similar directories
- Agent configuration: `.nessy-agent`, `.agents`, and `.claude` directories, and Nessy's data folder wherever it lives — with `NESSY_CONFIG_DIR` pointing somewhere else, that folder is protected just as `~/.nessy-agent` is
- Shell startup files: `.zshrc`, `.bashrc`, `.profile`, and the rest of the rc family
- Package-manager and build configuration: `.npmrc`, `.yarnrc`, `bunfig.toml`, lockfile hooks, wrapper properties, and the like

In every mode that can prompt, a write to a protected path asks you directly — it is never delegated to the Guardian — and the card offers no Always Allow, since no saved answer skips this check: the next write asks again. In Don't ask it is denied. Bypass permissions is the only mode that lets it through, except for Nessy's own control records below. The session's own folder is exempt, on every data-folder location: its plans, data, `job/tmp` scratch and downloads folders, and the files a session without a project creates there. The file tools get the exemption, and so does a shell command whose every path lies there (`echo x > job/tmp/a`, `mkdir data/out`). A relative path counts from the folder the agent's commands run in. On Claude Code a session without a project runs them in this session folder, so the examples above work as written, and a word that climbs out of it with `..` keeps the card. On Pi such a session runs its commands in the workspace folder, so there name the session folder by its full path, in a command that only redirects output into it (`echo x > <full path>/job/tmp/a`): a command that changes files itself, such as `mkdir` or `cp`, keeps the card, because Nessy cannot tell its other words from file names in the workspace folder. Its own records stay protected (`session.jsonl`, `attachments`, `long_responses`, `.pi-carry`, `.pi-sessions`, `.pi-agent`, `.orchestrator`, `meta`, `hook-env`, `file_checkpoints`, `checkout-move.patch`, `tool-metadata.json` and `api-error.json`), and so do another session's folder, a shell command that also names a path outside these folders or one Nessy cannot resolve (a variable, a wildcard), and the rest of the data folder, the workspace folder included.

This floor covers writes by the file tools, and since 1.38.0 the shell path too: a shell command that writes into an agent-configuration directory or one of the protected files (`>> ~/.zshrc`, for example) raises the same card the file tool would. `.git` is deliberately left off the shell floor so `git commit` keeps working without a prompt; on the Codex runtime the protected directories are refused by Codex's own permission table rather than prompted for, and the protected files are not projected there at all — the runtime switch discloses both differences. Independent of it, `deniedPaths` patterns (secrets like `.env`, `~/.ssh`, key files) block both reads and writes in every mode — see the [configuration schema](#configuration-schema).

**Nessy's own control records are refused in every mode, Bypass permissions included.** They decide what later sessions may do, so a session that could rewrite them could grant itself more. In the data folder they are the global `hooks.json` (its command hooks run with no card), `mcp.json`, `config.json` and everything under `permissions/`. In a workspace folder they are `permissions.json`, `automations.json` and `automations-history.jsonl`, and for any workspace other than the session's own, its `hooks.json` too. A write to one of them, by a file tool or a shell command, is refused with the reason and where to make the change instead: Nessy's Settings, that workspace, or the automation tools. That includes copying, moving or linking a file into their folder (`cp x/hooks.json ~/.nessy-agent/`, or from another machine with `scp`), `dd of=`, extracting an archive there (`tar -x -C`, `unzip -d`, `7z x`) and downloading a file there (`wget -P`, `curl -O`, `aria2c -d`); and when a command writes into the data folder, its `workspaces` folder or another workspace's folder under names it does not spell out (a folder, a wildcard, a variable), the whole command is refused. That also covers a folder copied into a folder above the data folder when its tree holds the data folder's own path (`cp -R x/me /Users/` with a `.nessy-agent` folder inside `x/me`); a tree without that path still copies. Into the session's own workspace folder, a copy whose names the command does not spell out (a folder's contents, as in `cp -R x/ .`, or a wildcard, as in `cp x/* .`) is refused only when Nessy, listing the source as it checks the command, finds `permissions.json`, `automations.json` or `automations-history.jsonl` there; any other such copy still runs. A shell command that names one is refused even when it only reads it; the `Read` tool still reads them. The session's own workspace `hooks.json` keeps the protected-path card instead, so you can still ask the agent for a hook in the workspace you are in. On Codex, Nessy refuses a file change, a write grant or a shell command Codex asks approval for that targets these records, the Codex homes or `credentials.enc`, in every mode as well (a command that only reads one is refused too when Codex asks about it; a plain read such as `cat` normally runs without a question), and never gives Codex a folder inside the data folder as an added directory. Skills in the data folder are not control records and are not refused by this rule. On Codex, when the data folder sits inside a folder Codex may write other than the session's working folder (your home folder added as a directory, or a data folder under `/tmp`), Codex's sandbox keeps the agent's commands out of the whole data folder, skills and plugins included: in that layout a command cannot read or run a skill's own files. A skill's instructions still arrive, because they are read outside the sandbox: Nessy reads them itself when the agent invokes the skill as `[skill:name]`, and Codex does the same for a `$name` mention of a skill in its own list. What fails is any step that opens a file in the skill's folder with a command: a script the skill asks the agent to run, a reference it asks the agent to read, or a skill the agent picks from Codex's own list without being named, which Codex opens with a command.

## The Primary Attached Folder

The Permissions page carries one control that changes no permission at all, and
it sits here so the distinction is visible. **Primary folder** picks which of the
folders already attached to the session is shown and ordered first; it is stored
as `primaryDirectory` in `config.json` and the select offers nothing that is not
already attached. Discovery still runs on the project root, and the resolver can
only ever answer with a folder from the attached set — so no value of it widens
what the agent may read or write. The control is hidden when there is nothing to
choose between.

Adding a root is still a permission decision, made the two documented ways:
`additionalDirectories`, or the outside-root approval whose *Allow for this
session* answer adds a revocable session root.

## Dangerous Commands

Within the non-safe category sits a smaller group that warrants extra caution. Here is how they differ from regular commands:

- **Regular commands** can be remembered with "always allow" — see [What Always Allow Remembers](#what-always-allow-remembers).
- **Dangerous commands** need your sign-off on each invocation: their card offers no "always allow", and the line under its buttons says nothing is remembered.
- **`curl` / `wget`** are a special case on Claude Code: "always allow" grants the target **hosts** for the rest of the session, not the command. The grant covers a later call only when it is one plain command and every host it contacts is granted: piping the download into a shell, adding a second host, reading options from a config file (`-K`), redirecting the output to a file or chaining another command all ask again. A `curl` line the app cannot vouch for that way gets no "always allow" at all. On Pi such a card offers none either; on Codex network access is decided by Codex's own sandbox.

In Bypass permissions mode every command runs automatically, dangerous ones included — except removals targeting the filesystem root or your home directory, which prompt in every mode as a circuit breaker. A command that touches Nessy's own control records is refused (see [Protected Paths](#protected-paths)).

On Pi and Claude Code the circuit breaker's card offers no Always Allow, and neither does the card for a command that runs `eval` or for a tool its MCP server marks as needing your interaction: no saved answer skips these checks, so the next call asks again.

```
rm, rmdir                          # Delete files and directories
mv, cp                             # Move/copy (can overwrite)
sudo, su                           # Privilege escalation
chmod, chown, chgrp                # Permission changes
dd, mkfs, fdisk, parted            # Disk operations
kill, killall, pkill               # Process termination
reboot, shutdown, halt, poweroff   # System control
curl, wget                         # Network downloads
ssh, scp, rsync                    # Remote access and transfer
git push                           # Push to a remote
git reset                          # Reset git state
git rebase                         # Rewrite history
git checkout                       # Can discard changes
```

## What Always Allow Remembers

**Always Allow** on a shell-command card remembers exactly what you approved, never a wider command. The line under the card's buttons says what the click will keep, and that line is what happens:

- A command-line tool with subcommands (`git`, `npm`, `docker`, `kubectl` and the like) is remembered by its leading words, up to three and before the first flag: approving `git status` covers `git status -s` later in the session, not `git push`.
- A few single-purpose commands (`mkdir`, `touch`, `sleep` and the like) are remembered by their name.
- Everything else — an interpreter or a runner such as `node`, `python3`, `npx` or `npm run` included — is remembered as the **exact** command you saw. Approving `node -e "console.log(1)"` does not cover `node evil.js`, and approving `npx prettier --check .` does not cover `npx prettier --write .`.
- Nothing is remembered, and the button is not offered, for a chain, a pipe into another program, a redirect to a file, a variable assignment or expansion, a dangerous command, `gh api`, a flag before the subcommand, a destructive word among the leading words (`aws s3 rm`, `docker system prune`, `npm uninstall`), or a command that runs its own argument (`bash -c …`). Two harmless endings are allowed: a trailing `2>&1`, and a final `| tail`, `| head`, `| wc` or `| grep` that only filters the output.

How long it lasts depends on the runtime, and the card says which:

| Runtime | What one Always Allow keeps |
| --- | --- |
| Pi | The session remembers it, and a rule is saved in `.claude/settings.local.json` at the repository root, so later Pi sessions in that repository run it without asking. The saved rule is the exact line you approved (for a single-purpose command, its name with any arguments), so a later session asks again for a different flag spelling that this session's grant covers. A line with a `*` in it, and a session with no folder, keep the grant for the session only: a saved rule would read the `*` as a wildcard, and a session with no folder has no repository to save into. |
| Claude Code | The session only. Nothing is saved: a saved rule would not spare a later Claude Code session the card, and it would widen what Pi and Codex sessions allow in the repository. |
| Codex | A rule for that command in the workspace permissions, as described under [Permission Modes](#permission-modes). |

Approvals of other kinds — an MCP tool, a session tool — last for the session. A card for an action that can never be remembered (a protected path, the circuit breaker, a command that runs `eval`, an ask rule) says so and has no Always Allow.

## Risk Badges

With **Risk badges** switched on under the [decision model](./decision-model), a permission card can carry small badges saying what the action does: deletes data, sends data out, publishes, touches secrets, changes the system or spends money. A card with a known risk is drawn in the danger tone. The badges are information only: the buttons, the default focus and what your answer does are unchanged. The card waits briefly for its badges; if the decision model does not answer in time, the card appears without them.

On Codex, when Codex's own auto-review judged an action, the risk level it reported is shown on the review line, labelled as Codex's.

## Safe Commands

A broad set of read-only commands runs without a prompt in every mode, Plan and Don't ask included. The list is loaded from `~/.nessy-agent/permissions/default.json`, so it can be extended. The shipped defaults cover:

**File exploration**

```
ls, ll, la, tree            # Directory listings
cat, head, tail, less, more # File viewing
file, stat, du, df, wc, nl  # File information
bat                         # Cat with syntax highlighting
```

**Search**

```
find, locate, which, whereis, type
grep, rg, ag, ack, fd, fzf
```

**Git (read-only)**

```
git status, git log, git diff, git show
git branch, git tag, git remote
git stash list, git blame, git reflog
```

**GitHub CLI (read-only)**

```
gh pr / issue / repo / release  (view, list, status, diff, checks, comments)
gh api  (with an explicit GET method)
```

**Package managers (read-only)**

```
npm ls/list/view/outdated/audit
yarn list/info/why/outdated
pnpm list/ls/why/outdated
pip list/show/freeze
cargo tree/metadata
go list / go mod graph
```

**Docker & Kubernetes (read-only)**

```
docker ps, images, logs, inspect, stats
kubectl get, describe, logs, top, explain
```

**System info**

```
pwd, whoami, id, uname, hostname
date, uptime, env, ps, free
```

**Text processing**

```
jq, yq, xq, xmllint    # Structured-data processors
sort, uniq, cut, tr, column
sed -n  (print-only)
```

**Network diagnostics**

```
ping, traceroute, dig, nslookup
netstat, ss, ip addr/link/route
```

**Version checks**

```
node --version, python --version, npm --version, cargo --version
(and other runtime version flags)
```

A few read-looking commands print stored credentials, so they are not on the
shipped list: `kubectl config view --raw` (or `--flatten`), `npm config get` of
an auth key, `gh auth status -t`, and `gh config get` of a token. They are
treated like any other command outside the list, and an existing install lost
the older, looser entries automatically.

## Customising the Read-Only Set

::: info
**Ask the agent to do it.** The simplest way to widen what Plan mode runs without asking is to tell the agent what you need:

- "Allow `npm run build` in Plan mode"
- "Let Linear comments work in Plan mode"
- "Add `bun run test` to the allowed commands"

The agent updates the configuration files for you.
:::

If you would rather edit by hand, the read-only set is highly configurable — you can add bash commands, MCP tool patterns and API endpoints. The file write paths of `allowedWritePaths` went with Explore mode: no mode reads them.

### Configuration Files

Permissions are read from `permissions.json` files at several levels:

```
~/.nessy-agent/permissions/default.json                             # App-wide defaults
~/.nessy-agent/workspaces/{id}/permissions.json                     # Per workspace
~/.nessy-agent/workspaces/{id}/sources/{slug}/permissions.json      # Per source
```

More specific files **extend** the broader ones rather than replacing them. Patterns in a source file are automatically scoped to that source's tools. A source file can only grant for that source's own tools: its `allowedBashPatterns`, its `allowedWritePaths` and an allow rule for any other tool are ignored, since the agent may edit that file while setting the source up. Put a session-wide grant in the workspace file (**Settings → Permissions**). A source file's deny rules still apply.

**When an edit applies.** A deny or ask rule that you add to a workspace or source `permissions.json` while a Claude Code or Pi session is working applies from that session's next tool call, in the same turn, as it does in Claude Code. In `toolRules`, which is read first-match-wins, that holds for a new deny or ask placed above every allow rule in the file; if the turn started with a `toolRules` deny in any permissions file of the session (`default.json`, the workspace file, a source file, or the project's `.nessy-agent/permissions.json`), even a deny for other tools, a new ask, and any rule placed below an ask, waits as well. A rule that waits applies in the same turn only to tools that no existing rule matches, and in full from the next turn. Removing a rule or adding an allow rule waits for the session's next turn, and so does an edit of `default.json`. On Codex a new deny or ask rule applies from the session's next turn.

### Configuration Schema

```json
{
  "allowedBashPatterns": [
    { "pattern": "^npm run build\\b", "comment": "Allow npm build" },
    { "pattern": "^make\\s+test\\b", "comment": "Allow make test" }
  ],
  "allowedMcpPatterns": [
    { "pattern": "create_draft", "comment": "Allow creating drafts" }
  ],
  "allowedApiEndpoints": [
    { "method": "POST", "path": "/api/drafts", "comment": "Create drafts" }
  ],
  "deniedPaths": [
    "~/.ssh/**",
    "**/.env"
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
  ]
}
```

### Pattern Types

**`allowedBashPatterns`** — regex patterns matched against bash commands:

```json
{ "pattern": "^npm run (build|test|lint)\\b", "comment": "npm scripts" }
```

**`allowedMcpPatterns`** — patterns matched against MCP tool names:

```json
{ "pattern": "^mcp__linear__create_comment$", "comment": "Allow Linear comments" }
```

At the workspace level a pattern is matched against the full tool name, `mcp__<source>__<tool>`, so spell the double underscores out as above.

In a source's `permissions.json` these are auto-scoped and anchored. Writing `list` becomes an internal match for that source's tools whose name **starts** with it as a whole word (`mcp__linear__list`, `mcp__linear__list_issues`), never one that merely contains it (`mcp__linear__delete_playlist`), and never another source's tools.

One more rule applies to every read-only MCP pattern: shipped, per-source or your own. A tool whose name carries a write word after its first word — `get_or_create_user`, `find_and_replace`, `status_update` — is never treated as read-only, whatever pattern matches it. The shipped read-only list follows the same leading-verb rule, and names the built-in dp servers' read tools exactly (`dp_jira_jql_search`, for example), because their verb is not the first word. Existing installs were updated automatically: the old shipped entries were replaced and your own entries kept, except one spelled exactly like an old shipped entry, which goes with it.

**`allowedApiEndpoints`** — an HTTP method plus a path pattern:

```json
{ "method": "POST", "path": "/api/comments", "comment": "Create comments" }
```

`method` must be one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, or `OPTIONS`. `path` is a regex.

**`allowedWritePaths`** — retired with Explore mode in 1.41.0. It listed glob patterns for paths the agent could write to in Explore; no mode reads it now, and Settings → Permissions no longer offers it. A file that still lists it loads as before, and the entries are unused.

**`deniedPaths`** — glob patterns for files the agent may **never read and never
write**, in any mode:

```json
["~/.ssh/**", "**/.env", "**/*.pem", "/srv/deploy/secrets/**"]
```

This is the answer to "how do I stop the agent reading my credentials?". A match
blocks `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Glob`, `Grep`,
`Find`, `Ls`, and any path named inside a `Bash` command — `Glob`/`Grep` are the
Claude runtime's names for file discovery and search, `Find`/`Ls` are Pi's, and a
deny covers both vocabularies. The check runs **before** every mode
decision, so Bypass permissions does not reopen it, and the refusal names the
entry that produced it.

It can be set in any of the files above, and an administrator can deliver it in a
managed policy. The list is additive in one direction only: a layer can add
entries and no layer can remove one another layer added — so a managed entry
outranks everything. When an administrator turns on the managed-only lock, that
lock drops *allow*-direction contributions from the other layers while every
layer's `deniedPaths` keeps merging.

Patterns are matched against **absolute** paths, so an entry has to be anchored:
start it with `/`, `~/`, or `**/`. A bare `secrets/**` or `.env` matches nothing.
`**` matches any depth, `*` one path segment, `?` one character.

A `<dir>/**` entry **covers the directory itself**: `~/.ssh/**` denies the files
under `~/.ssh` *and* `~/.ssh` as a path, so `Grep` and `Glob` cannot be rooted
there either.

A malformed entry is **dropped, with a warning naming it**, and the rest of the
file still applies. Three shapes cannot match anything and are reported: a blank
entry, a Windows-style path such as `C:\secrets\**` (write the separators as
`/`), and an unanchored one such as `secrets/**`.

One limit worth knowing: the check is enforced on the tool's *request*, not on
its *results*. A search rooted **above** a denied directory can still return
matches from inside it — denying `~/.ssh/**` stops a `Grep` at `~/.ssh`, but does
not yet filter a `Grep` at `~`.

Nessy ships a credential floor in `default.json` — `.env` files, `~/.ssh`,
`~/.gnupg`, `~/.aws`, `~/.config/gcloud`, `~/.azure`, `~/.kube`,
`~/.docker/config.json`, git credential stores, `.npmrc`, `.pypirc`, `~/.netrc`,
`*-service-account.json`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519` — and your own
entries add to it.

**On Codex the shipped floor does not reach Codex's sandbox (since 1.41.0).**
Codex runs with its own sandbox defaults, so a command Codex runs can read
Nessy's own credential files (`credentials.enc` in the data folder, `~/.nessy`),
`~/.ssh`, `~/.aws` and the rest of the list above like any other file Codex's
sandbox allows. Entries you or an administrator add to `deniedPaths` still
reach Codex's sandbox, which then refuses the read — including an entry spelled
exactly like a shipped one, written in a workspace or source file. Each such
entry makes a Codex thread open slower, because Codex then checks its
instruction files through the sandbox; the session log's
`codex-deny-read-slows-thread-open` line counts them. Pi and Claude Code are
unchanged: the whole floor applies there.

**`blockedTools`** — extra tool names blocked in the read-only modes (Plan and
Don't ask):

```json
["BashOutput", "mcp__linear__create_issue"]
```

Exact tool names, not globs. The four the runtime blocks by itself (`Write`,
`Edit`, `MultiEdit`, `NotebookEdit`) are a floor: a list here adds to them and
can never remove one. For glob matching, or for a block that also covers the
write modes, use `deniedToolPatterns` or `disallowedTools`. Some names it cannot
block, and **since 1.34.0 the Permissions page says so rather than reporting
nothing**: an entry the runtime never consults still appears where you wrote it,
still shows its badge, and carries a line naming the branch that decides instead
(*"blockedTools \"Bash\" is NOT enforced: shell calls are decided by the
read-only command classifier, which runs before this list is consulted"*). The
names it cannot block are the always-allowed read-only tools
(`Read`, `Glob`, `Grep`, `Task`, `TaskOutput`, `WebFetch`, `WebSearch`,
`TodoWrite`, `SubmitPlan`, `LSP`, `read_mcp_resource`, `list_mcp_resources`,
`read_skill_resource`, and their `mcp__…__<name>` spellings), `Bash`, and
`browser_tool` are decided before this list is consulted, so naming one here does
nothing — reach for `deniedToolPatterns` instead, where `["Web*"]` really does
block `WebFetch` in Plan and Manual alike. Use `permissionDsl`
when you need an explicit `allow`, `ask`, or `deny` decision.
`blockedCommandHints` only changes the guidance shown for rejected commands.

**`deniedToolPatterns`** and **`disallowedTools`** — glob patterns matched
against the **tool name**, blocking it in **every** permission mode:

```json
{
  "deniedToolPatterns": ["Web*", "mcp__linear__*"],
  "disallowedTools": [
    { "pattern": "mcp__jira__*", "comment": "No Jira writes from this workspace" }
  ]
}
```

These are the two glob levers `blockedTools` sends you to, and they are the only
tool-name controls that reach the write modes. Each entry is a plain string, or
an object with a `pattern` and an optional `comment`. `**` matches any depth, `*`
one path segment, `?` one character — a tool name contains no `/`, so `Web*`
matches `WebFetch` and `mcp__linear__*` matches every tool of that server.

Both are checked **before** every mode decision — `deniedToolPatterns` first,
then `disallowedTools` — so Bypass permissions does not reopen them, and neither
is subject to the always-allowed read-only list that makes a `blockedTools` entry
silently inert. The refusal names the pattern that produced it (`Tool blocked:
WebFetch matched deniedToolPatterns pattern Web*`).

They can be set in any of the files above, and an administrator can deliver them
in a managed policy. Like `deniedPaths`, the lists are additive in one direction
only: a layer adds entries and no layer removes another layer's, so a managed
entry outranks everything and survives the managed-only lock.

The two keys do the same job here, so pick either — `disallowedTools` is also the
name the Claude Agent SDK and skill frontmatter use for a tool denylist, which is
why both spellings are accepted.

**`allowedTools`** — the **allowlist** counterpart, and the one key here whose
name means the opposite of what a Claude user expects. Claude's `--allowedTools`
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

Once non-empty, any tool matching no pattern is refused with
`Tool blocked: <name> is not included in allowedTools`. Like the two denylists
it is checked **before** the mode decision, so Bypass permissions does not
reopen it. It also **loses to every deny**: `deniedPaths`, `deniedToolPatterns`
and `disallowedTools` are all evaluated first, so naming a tool here cannot
rescue one that a deny rule already blocks.

Across layers the lists concatenate, so a second layer's entries only ever widen
what is admitted. Under the managed-only lock every non-managed layer's
`allowedTools` is dropped and the managed one alone decides.

**`toolRules`** — per-tool `allow` / `deny` / `ask` decisions, for when a plain
allowlist or denylist cannot say what you mean:

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
applies in every mode. On Pi and Claude Code an `ask` rule's card offers no Always
Allow: approving it allows that call only, and the rule asks again next time.

Under the managed-only lock, `allow` entries from non-managed layers are dropped
entry by entry while their `deny` and `ask` entries survive — the lock removes
grants, never protections.

### Permission DSL v1

`permissionDsl` is the readable, versioned policy format used by the Pi runtime.
Its `deny` rules bind Claude Code sessions too: before a tool runs, Nessy refuses
what the merged policy denies, in every mode, Bypass permissions included, and
names the rule. Its `ask` rules bind there too: the call waits on an approval
card that names the rule, in every mode, Bypass permissions included, and
Don't ask mode refuses it instead, because that mode never asks. Such a card
offers no Always Allow (on Claude Code, no Allow for this session): approving it
allows that call only, and the rule asks again next time. The same holds on Pi,
in Manual as in every other mode, and on Codex, as described above. On Pi the
card shows the command or path it asks about next to the rule, and on Claude
Code the command, the file, the URL or the call's arguments. Only an `allow`
rule is not honoured on Claude Code, so the mode decides. It lives inside any
supported `permissions.json` file:

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
| `bash` | `executable`, optional `args`, `cwdRoot` | A parsed shell command; `cwdRoot` must be absolute and is canonicalised by the host |
| `path` | `root`, optional `parameter` | Host-canonicalised paths under an absolute root |
| `host` | `host` | The destination hostname |
| `mcp` | `server`, optional `tool` | An MCP server and tool |
| `agent` | `agent` | Admission of a named custom agent |
| `parameter` | `name` plus `equals` or `oneOf` | A bounded safe input field |

`path.parameter` may be `file_path`, `notebook_path`, `path`, `cwd`, or
`workingDirectory`. `parameter.name` may be `method`, `mode`, `action`,
`access`, `operation`, or `transport`.

A `bash` rule matches one parsed command. A command the parser cannot split
into one — a chain with `;` or `&&`, a redirect such as `>>`, a `$(…)`
substitution, a glob — is never approved by an `allow` bash rule: evaluation
moves on to the next rule and then to the mode, exactly as if that rule were not
there. An `ask` or `deny` bash rule reads such a command part by part, as
Claude Code's own rules do: it applies when any part — including one inside a
`$(…)` substitution, a subshell or an `if` body — runs the rule's program (with
the rule's arguments, when it lists them), and a command none of whose parts
does is decided as if the rule were not there. So an `ask` rule for
`touch notes.txt` asks about `cd docs && touch notes.txt`, not about
`echo 1 >> log && wc -l log`. A command too complex to read part by part asks,
naming the rule, and a `deny` rule for every program (`"executable": "*"`) still
refuses every such command. Rules that Codex's **Always allow** saved in earlier versions have this shape, so one
such grant for `git` does not turn unrelated compound commands into refusals.

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

### Managed Pi policy

Administrators can install one host-owned, non-overridable Pi policy:

| Platform | Path |
| --- | --- |
| macOS | `/Library/Application Support/Nessy/managed-policy.json` |
| Linux | `/etc/nessy/managed-policy.json` |
| Windows | `%ProgramFiles%\Nessy\managed-policy.json` |

On Windows the former location, `%ProgramData%\Nessy\managed-policy.json`, is
not read, because ordinary accounts can write to that directory. A policy left
there is ignored and reported with the path to move it to. If `%ProgramFiles%`
is unset or not an absolute path, or the policy path resolves outside
`%ProgramFiles%\Nessy` (for example through a directory junction), the policy
file is not applied and the reason is reported. Windows has no ownership check: the
protection is that only administrators can write to `%ProgramFiles%` by default.

The server reads the file at startup, together with any `*.json` files in the
`managed-policy.d/` directory beside it, which are merged after the file in name
order (hidden files are skipped), so several teams can each ship their own part.
Project, workspace, user, plugin, and repository configuration cannot select
another path or widen the loaded policy. A missing file keeps the built-in
managed layer.

When the Nessy Gateway delivers a managed policy that carries any setting, that
delivered policy applies instead of the file and its `managed-policy.d/` parts:
the two are not merged. Only `env` combines variable by variable, and a few lock
keys set in either source still apply (`forceRemoteSettingsRefresh` and the
`sandbox` network and filesystem locks).

**When an edited policy takes effect.** A running app re-reads the policy (the
file, its `managed-policy.d/` parts and any delivered policy) at the start of
each turn, and a delivered policy that only tightens is adopted at once. A tool
call already approved is never re-decided. From the next decision on, the new
policy applies to the permission modes (`disabledPermissionModes`,
`defaultMode` for new sessions), `permissionDsl`,
`allowManagedPermissionRulesOnly`, `autoMode`, the HTTP hook allowlists
(`allowedHttpHookUrls`, `httpHookAllowedEnvVars`), channel pushes
(`channelsEnabled`, `allowedChannelServers`, `deniedMcpServers`),
`connectSourcesOnStartup` and `companyAnnouncements`. The hook locks
(`allowPluginHooks`, `allowManagedHooksOnly`, `disableAllHooks`) take effect in
one direction only: a tightening applies from the next decision, and a loosening
brings back user and project hooks at the next turn but plugin hooks only after
a restart, because the set of plugins a session is offered is built from the
policy the app started with. One tightening also waits for a restart:
`allowManagedHooksOnly` turned on while managed `enabledPlugins` force-enables
plugins stops user and project hooks at the next turn, but the hooks of every
plugin the app started with keep running, not only the force-enabled ones,
because which plugins' hooks the lock keeps is decided at startup. For the same
reason, a change to which plugins `enabledPlugins` force-enables reaches their
hooks only after a restart — emptying the set is the one change that does not
wait: with no plugin force-enabled, the plugin hooks stop at the next turn. The
MCP server allow and deny lists
(`allowedMcpServers`, `deniedMcpServers`) are checked again whenever a built-in
dp server or a plugin's local (stdio) server starts, so a tightening reaches
those servers at their next start, and the organisation's own servers
(`managedMcpServers`) follow the current policy at each start. Every other
judgement uses the policy the app started with: a plugin server denied at
startup returns only after a restart, and outside a Claude Code session a change
to the lists that affects any other MCP server, such as one from a `.mcp.json`
file, a workspace source or a plugin's remote server, takes effect in either
direction only after a restart. A Claude Code session gets the current policy
as its managed settings at its next turn. What the app builds once at startup
keeps the policy it started with until you restart Nessy Desktop: which plugins a
session is offered (`allowedPluginKeys`, `deniedPluginKeys`,
`strictPluginOnlyCustomization`), the marketplace keys, the model list and
pricing, the sandbox network rules, `env`, `claudeMdExcludes` on Pi and Codex,
and the version bounds. Restart the app after changing any key not named in this
paragraph.

A policy file that cannot be trusted or read fails closed: if the file or its
directory is a symlink, is not owned by root or is writable by group or others
(macOS and Linux), or the file is larger than 256 KiB, is not valid JSON, or is
not a JSON object, the server does not start, and Nessy Desktop shows an error
that names the file. A file in `managed-policy.d/` that fails the same checks is
skipped and reported instead, and the rest of the policy still applies.

Inside a readable policy, an entry the schema does not accept, such as an
unknown or misspelt field, a malformed value, or an invalid rule, is dropped on
its own and reported, and every other entry is still enforced. A bad entry in a
list drops that entry only; an allowlist whose value is not a list is enforced
as empty, so it admits nothing until it is fixed; an on/off lock whose value is
not `true` or `false` is read at its locking value. A misspelt key therefore
enforces nothing. The dropped entries are logged at startup under
`[managed-settings]`, and
[`doctor`](/reference/cli#doctor-configuration-checkup) lists each one with its
file and field and exits with code 1, so run it before a fleet push.

Schema version 1 accepts these keys besides `schemaVersion`:

- **Permissions:** `disabledPermissionModes`, `defaultMode`, `permissionDsl`,
  `allowManagedPermissionRulesOnly`, `claudeRules`, `autoMode`,
  `unattendedApprovalFallback`.
- **Plugins and marketplaces:** `allowedPluginKeys`, `deniedPluginKeys`,
  `enabledPlugins`, `strictPluginOnlyCustomization`,
  `disableCommandPluginSources`, `disableSideloadFlags`, `pluginTrustMessage`,
  `strictKnownMarketplaces`, `blockedMarketplaces`, `extraKnownMarketplaces`,
  `pluginSuggestionMarketplaces`.
- **MCP servers and channels:** `allowedMcpServers`, `deniedMcpServers`,
  `allowManagedMcpServersOnly`, `managedMcpServers`, `channelsEnabled`,
  `allowedChannelServers`, `connectSourcesOnStartup`.
- **Hooks:** `allowPluginHooks`, `allowManagedHooksOnly`, `disableAllHooks`,
  `allowedHttpHookUrls`, `httpHookAllowedEnvVars`.
- **Models:** `model`, `availableModels`, `enforceAvailableModels`,
  `modelPricing`, `disableNonGatewayConnections`.
- **Sandbox and environment:** `sandbox`, `env`.
- **Workflows, agents and memory:** `workflow`, `disableAgentView`,
  `claudeMdExcludes`, `autoCompactEnabled`, `cleanupPeriodDays`.
- **The app and its browser:** `companyAnnouncements`, `disableInAppUpdates`,
  `requiredMinimumVersion`, `requiredMaximumVersion`,
  `forceRemoteSettingsRefresh`, `disableInAppBrowser`,
  `disableBrowserExternalNavigation`, `disableBrowserCdp`,
  `browserHostAllowlist`, `browserExternalPageTools`.

Denials win over allowlists. The policy is applied before mode clamping,
capability resolution, or process creation, so a managed denial never relies on
cleanup after a side effect.

### Example: allow npm scripts in Plan mode

Create `~/.nessy-agent/permissions/default.json`:

```json
{
  "allowedBashPatterns": [
    { "pattern": "^npm run\\b", "comment": "All npm scripts" },
    { "pattern": "^yarn\\b", "comment": "All yarn commands" },
    { "pattern": "^bun run\\b", "comment": "All bun scripts" }
  ]
}
```

### Example: allow Linear comments in Plan mode

Create `~/.nessy-agent/workspaces/{id}/sources/linear/permissions.json`:

```json
{
  "allowedMcpPatterns": [
    { "pattern": "create_comment", "comment": "Allow posting comments" }
  ]
}
```

## Blocked Shell Constructs

An otherwise-safe command stops counting as read-only when it contains shell constructs that could be abused, so it no longer runs unasked: in Plan it goes to the Guardian or asks you (see [Plan Mode](#plan-mode-plan)), and Don't ask refuses it:

**Command chaining** — could branch into a dangerous command:

```
&&   ||   ;   |   &   |&
```

**Redirects** — could overwrite files:

```
>   >>   >&
```

**Substitution** — could execute embedded commands:

```
$(…)   `backticks`   <(…)   >(…)
```

**Control characters** — newlines and carriage returns act as separators.

Commands are parsed into a syntax tree, so a compound like `git status && git log` is validated part by part — each simple command must be safe on its own. Safe input redirects (`<`) and output to `/dev/null` are permitted.

::: note
A safe command stops running unasked once you combine it with a shell construct. For instance, `ls | grep foo` no longer runs unasked in Plan mode, because the pipe could chain into something unsafe. Run the pieces as separate commands instead.
:::

## Credentials

Secrets for external services are handled carefully:

- Stored in an encrypted file inside your config directory
- Never shown in plain text after you enter them
- Scoped to the workspaces and sources that need them

When the agent first needs a service's credentials, you are prompted to supply them, and they are kept securely for later use.

The Nessy Gateway cards authenticate with a gateway token the app holds; the Developer Platform command-line session (`dp`) is needed only to mint that token and for the Developer Platform tools themselves. Since 1.38.0 a chat never waits on that session: if it has ended, the chat keeps answering, the session shows one notice naming `dp auth login`, and only the Developer Platform tools refuse — by name, with what to do. The notice distinguishes a session that has ended from a `dp` command line the app could not reach at all. See [Credentials](/reference/config/credentials) for the full storage model.

## Best Practices

- **Start in Plan.** When looking at unfamiliar code or systems, research safely before you allow any changes.
- **Use Manual for day-to-day work.** The default strikes a good balance between speed and control.
- **Reserve Bypass permissions for trusted flows.** Keep it for well-understood, repeatable tasks where you trust every action.
- **Tune the read-only set to your workflow.** Add your usual build commands, test runners, and safe MCP operations so they work without prompts in Plan.
- **Read before approving.** In Manual mode, glance at what a command will do before allowing it — especially anything unfamiliar.
