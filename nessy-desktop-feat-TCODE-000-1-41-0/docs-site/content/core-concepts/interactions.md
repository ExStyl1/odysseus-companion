# Interactions

Typing a message is the main way to talk to your agent, but not the only one. Nessy Desktop also lets you pull in sources and skills inline, attach files, steer or queue follow-up messages, and manage sessions from the sidebar.

## Mentions

Use `@` mentions inside a message to bring a source or skill into the conversation without opening any settings.

### Source Mentions

Type `@` followed by a source name to point the agent at it:

```text
"Check @linear for my open issues"
"Look in @docs-kb for the deployment runbook"
"Read the latest rows from @analytics-db"
```

Mentioning a source activates it for the conversation, so the agent gains that source's tools for the turn without any manual configuration. See [Sources](/sources/overview) for how to connect them.

### Skill Mentions

Skills work the same way — reference one with `@` to invoke it:

```text
"Run @daily-standup"
"Use the @code-review skill on this branch"
```

You can also invoke a skill with bracket syntax (`[skill:code-review]`) anywhere in the message.

### Session Mentions

Live sessions appear in the same `@` list, each row naming the runtime it is
running on, so you can address another conversation by its name:

```text
"Ask @auth-refactor whether the migration landed"
"Tell @'release sitting' the gate is green"
```

Unlike a source or a skill, what gets inserted is the plain `@name` — no bracket
token. The name is text the *model* reads and hands to its own cross-session
message tool, which is why a name with a space or any character outside letters,
digits, hyphens and underscores is quoted for you.

One unambiguous live name is delivered on the name alone, with no roster lookup
in between. If more than one live session answers to the name, the agent asks you
which one you mean instead of choosing; those rows say so in the list before you
insert them, because names the app generates are not checked for uniqueness. A
name that belongs to no live session is refused by name rather than silently
dropped.

Renaming a session yourself *is* checked: if the name is taken, the session that
already has it keeps it, yours becomes a two-word variant such as
`auth-refactor-graceful-unicorn`, and you are told.

::: tip
As you type `@`, an autocomplete list appears with the available sources, skills and live sessions. Pick one to insert the mention.
:::

## Slash Commands

Type `/` at the start of the input to reach built-in commands. Two are worth
calling out for code work:

- **`/code-review`** runs a dedicated, adversarial code review of a diff. By
  default it reviews your branch's commits ahead of its upstream plus any
  uncommitted changes; pass a target to review something else — a branch name, a
  ref range such as `main...my-feature`, one or more file paths, or a single
  commit. It spawns a read-only reviewer with a rubric and returns structured
  findings ordered most-severe-first (P0–P3), each with a `file:line` reference
  and a category: `correctness` or `test-coverage` for a bug, `reuse`,
  `simplification` or `efficiency` for a cleanup. Add `--fix` to apply the
  findings to your working tree after the review. Two things this build cannot
  do: a pull-request number is not a valid target and `--comment` cannot post
  inline PR comments, because there is no GitHub integration. There is no
  `/review` alias — type the full name.
- **`/init`** inspects the repository and writes a starter `AGENTS.md` project
  guide (build/test commands, structure, conventions) at the project root. If an
  `AGENTS.md` already exists it is preserved — the agent offers to append or
  improve it in place rather than overwriting it, and the file is written through
  the normal permission-gated tool path.

Four session commands manage the conversation itself:

- **`/btw <question>`** asks a quick side question about your current work
  without adding to the conversation history. The answer appears in a
  dismissible overlay above the composer and never enters the transcript, so
  you can check a detail without growing context. Side questions see the full
  conversation but have no tool access, and work even while the agent is busy
  with a turn. They also work on a chat that has not started yet: asking one
  starts the chat's agent exactly as an ordinary message would, and the
  question and answer still stay out of the transcript. The panel carries a
  composer of its own, so you can keep asking without leaving it; a `/btw`
  typed inside is just another question (the prefix is dropped), and `/recap`
  or `/heapdump` typed there are text, because both act on the real chat and
  the panel deliberately does not. The panel is a thread: every question and
  its answer stay in it, in order, newest at the bottom, exactly like the main
  chat — earlier answers are no longer a dimmed list above the current one, and
  there is no stepping between them. Run `/btw` with no question to reopen it.
  Inside, `c` copies the latest answer as raw Markdown, `x` clears the thread,
  and `Escape` dismisses it. `Space` and `Enter` dismiss it too, but only from
  the panel body — the composer has the focus when the panel opens, so typing
  is never eaten.
- **`/recap`** generates a one-line summary of what has happened in the session
  so far, shown in the same overlay — useful when returning after stepping
  away.
- **`/clear`** resets the conversation to an empty context: the next prompt
  starts a fresh conversation with no prior history. The previous conversation
  remains on disk in session storage. On a Nestor Cloud session it also resets
  the remote conversation, so the next prompt starts fresh on the cloud side
  too.
- **`/quota`** reports the remaining budget on the connection's gateway: for
  each limit, how much is left as a percentage, the gateway's own message about
  the limit's state, and its reset time when the server provides one. The
  command is offered on every connection that reports a quota: Nestor Cloud
  sessions and all three Nessy Gateway cards (Pi, Claude Code and Codex). They
  share the same per-user budget, so the three cards show the same numbers, and
  Stop cancels the read. On a connection pointed at your own endpoint there is
  no such budget, so the command is hidden from the slash menu. On the
  [ChatGPT (Codex)](/reference/config/llm-connections#chatgpt-codex) card, which
  signs Codex in to your ChatGPT account, `/quota` is offered and asks Codex
  itself: it shows that subscription's usage windows (used share, window length,
  reset time, plan and credits), and when the Codex runtime is not running it
  shows the windows Codex last reported, marked as such. On a Codex connection to
  your own endpoint, a typed `/quota` explains why no window is available.

`/compact` (see [Long Conversations](/core-concepts/conversations#long-conversations))
and the `/usage` and `/context` meters round out the set. `/usage` and
`/context` are no longer Pi-only: a Claude Code or Codex session can now say
which `CLAUDE.md`, `CLAUDE.local.md` and rules files actually loaded, and where
a runtime publishes no category breakdown the overlay says so instead of showing
an empty box. The output-token figure in `/usage` arrives when the answer
finishes: on every runtime it is reported once, at the end of the response,
rather than climbing while the text streams, so an **Output** row that does not
move mid-answer is the expected state and not a stalled session.

Several more commands arrived with this release, on every runtime unless noted:

- **`/branch`** forks the conversation in place and switches you into the
  branch — see [Conversations](/core-concepts/conversations#branching-a-conversation).
- **`/diff`** summarises the working tree and opens the patch in a viewer. A
  diff can be annotated: a line-anchored comment reaches the next turn as one
  batch.
- **`/hooks`** lists the hooks this session will actually run, grouped by event,
  with each hook's matcher, handler type and source file, on every runtime. Its
  run history shows every hook that ran this session. That includes prompt,
  agent, MCP-tool and HTTP hooks as well as command hooks, hooks that ran inside
  a Claude session, and hooks the app fires itself, such as `MessageDisplay`. A
  hook that could not run is listed with its reason. With every hook switched off
  (`disableAllHooks`), it answers "No hooks will run in this session."
- **`/config`** reads and changes a setting from the prompt, over a stated
  allowlist. It was offered by the menu before and dispatched by nothing, so a
  typed `/config` reached the model as prose.
- **`/status`** says what this session is really connected to: base URL,
  credential source, provider and proxy.
- **`/simplify`** and **`/security-review`** ship beside `/code-review`, and the
  effort level a review runs at is remembered across sessions instead of resetting
  every time.
- **`/mcp`**, `/help`, `/config` and `/diff` answer over several lines now, and
  the row they answer in can be selected and copied — they used to collapse into
  one paragraph.
- **`/tasks`** lists this chat's background work — its scheduled automations, its
  watches and the tasks running right now — and leaves the answer in the
  transcript, so it is still there after the next few turns.
- **`/workflows`** opens the workflow progress view, and **`/workflows stop`**
  stops every background agent this chat started. Both forms are recognised by
  the app itself, so they mean the same thing on Pi, Claude Code and Codex —
  before 1.40.0 neither token was parsed anywhere and both reached the model as
  ordinary text.

## File Attachments

You can hand files to the agent in three ways:

- **Drag and drop** — drop files straight onto the chat input
- **Paste** — paste an image or file from your clipboard
- **File picker** — click the attachment button and browse for a file

The agent handles most common formats:

| Type          | Examples                  | What the agent can do                |
| ------------- | ------------------------- | ------------------------------------ |
| **Code**      | .py, .ts, .js, .go, .rs   | Read, review, refactor, explain      |
| **Documents** | .pdf, .docx, .xlsx, .pptx | Extract text, summarise, convert     |
| **Images**    | .png, .jpg, .svg, .webp   | View, describe, resize, convert      |
| **Data**      | .json, .csv, .xml, .yaml  | Parse, analyse, transform            |
| **Notebooks** | .ipynb                    | Read cells, outputs, and figures     |

Image attachments are only sent when the active model supports image input.

### Size Limits

Attachments travel to the app's server in one message, so the composer checks their size before anything is sent:

- **One file** larger than the limit is refused as soon as you add it, before it is read, with a notice naming the file and its size.
- **A set of files** that is too big together is refused when you press send; your message and attachments stay in the composer, so you can remove some or send them in separate messages.
- The limit is **`73.4 MB`** in the desktop app and **`11.7 MB`** when you are connected to a [headless server](/server/headless), which accepts smaller messages. The server tells the app its limit when you connect; an older server that does not is assumed to have the smaller one.
- An image counts at most 5 MB toward the total, because larger images are resized before they are sent.

Before this check, an attachment over the limit broke the connection and every request in flight failed with "Connection lost".

**PDFs on Claude Code.** A PDF of up to 10 MB is handed to the model as a document when the connection talks to Anthropic's API directly. A larger PDF, and every PDF on a connection whose endpoint does not speak Anthropic's API natively — the **Claude Code (Nessy Gateway)** card among them — goes by the path where the app stored it, and the agent is told to read it with its Read tool, page range by page range for a big file. Pi sessions always receive PDFs by path.

## Sending While the Agent Is Responding

You can send a follow-up at any time — even mid-turn, while the agent is streaming a reply or running a tool. How that message is handled is decided per **AI connection**, with two behaviours:

| Mode      | What happens                                                                            | When to reach for it                                            |
| --------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Steer** | Your message is delivered into the running turn so the agent notices it before finishing | Redirecting a task in flight ("actually, do it in Python")       |
| **Queue** | The current turn completes untouched; your message is replayed as the next turn          | Adding a follow-up without disturbing the work already underway |

### Defaults

The default depends on the backend the connection uses:

- **Nessy Gateway and other Pi-backed providers** default to **steer**. Because Pi steers natively without discarding work — your note lands once the in-flight tool call wraps up, and nothing already computed is lost — steering immediately costs you nothing.
- **Codex connections** default to **steer**. The Codex runtime has its own steer call, and it is stricter in a way that helps you: the request names the turn it is meant for, so a correction aimed at a turn that has already moved on is refused rather than applied to the wrong work. Two kinds of turn decline steering outright — a review and a compaction — and a message refused for either is queued instead of dropped.
- **Claude connections** default to **steer** as well. Steering is emulated there: your message reaches the model at its next tool call. A turn that makes no further tool call finishes first, and your message then runs as the next turn, so nothing is lost. The cost is that turn's tokens.
- **Nestor Cloud connections** default to **queue**. The remote agent has no way to receive a message mid-turn.

**A message with attachments is always queued, whatever the connection's setting.** A steer carries text only, so the files ride the next turn with the message. The send button says **Queue** for such a message. On its queue row, Steer and Edit are disabled with a tooltip, because using either would drop the files. The message is sent with its files when the turn ends, even across an app restart. A text message you send after it waits behind it too, so the order stays the one you typed.

### Overriding it for one message

**Alt/Option + Enter** sends the message you are typing the *other* way —
steering on a connection that queues, queueing on one that steers — without
changing the connection's setting. The composer says which of the two the chord
will do. It is a normal rebindable action, so you can change or unbind it on the
Shortcuts page. The chord cannot steer a message with attachments; that one is
always queued.

### When the decision model decides

With **Mid-turn messages** switched on (Settings → AI → **Decision model (Jev)** → **Advanced settings**; see [Decision model](./decision-model)), a text message you send mid-turn is queued at once, so your send is never held up. The decision model then judges whether it corrects the work in progress. A correction moves from the queue into the running turn, the way a steer does, provided the same turn is still running and the runtime can take it at that moment. A separate follow-up stays queued. If the model gives no confident answer, the connection's mode applies.

Two queued messages that the model reads as one request (for example "when you create the event later," and "call it Team day") are sent together as one turn. Neither half is steered on its own. The model never re-decides a message with attachments, a workflow command, a message sent with the **Alt/Option + Enter** override, or a message sent after Stop.

### Changing the mode

This setting rides on the connection itself, so every session sharing that connection inherits it. Toggle it whenever you like — the switch kicks in the next time you send mid-stream. For the underlying config field, see [LLM Connections](/reference/config/llm-connections).

**A default reaches new connections only.** The mode is stored on the connection when you add it, so a connection you already have keeps what it was created with even if the default for that backend changes later. That is deliberate: the app cannot tell a stored value that came from a default apart from one you chose, and quietly rewriting it would undo a real decision. If a release announces a new default you want, set it here once.

::: tip
When in doubt, keep the default. For a calm follow-up the two modes reach the same end result — the difference only matters when you are actively redirecting a task that is still running.
:::

## Stopping Work

Use the stop control when a turn should end right away. In the CLI, sending `SIGINT` (Ctrl+C) to a `run` command asks the server to cancel the session and exits with code `130`; `SIGTERM` exits with code `143` and stops the turn at once but records no result for it, so a resume continues it. See the [CLI reference](/reference/cli) for the full lifecycle.

If a follow-up is waiting in the queue when you press Stop, the queue pauses. A banner reads "Queue paused because you interrupted", with a **Resume** button, and nothing is sent until you choose. The stopped prompt is not put back in the composer. A message you send after Stop, while the turn is still winding down, is queued; it is never steered into the stopping turn.

With the composer empty, pressing `Up` while a turn is running does the same as Stop and puts the stopped prompt back in the composer. If you cleared a draft with `Esc Esc`, `Up` brings that draft back instead and the turn keeps running.

**Stop ends the reply, not the background work.** Tasks already running in the background keep running and report when they finish: on Pi, a long MCP call that was moved to the background before you pressed Stop delivers its result afterwards; on Claude Code and Codex, background agents and commands carry on as the runtime runs them. To end one of them, use its chip — see [Background Tasks](#background-tasks).

## Background Tasks

Work the agent moved to the background — a long command, a background agent, a workflow — shows as a chip above the composer, with a spinner while it runs and a mark when it ends.

Click a chip to open its card:

- **A command** shows the end of its output, refreshed while it runs ("Showing the end of the output" when it was cut).
- **An agent** shows its step count, its recent steps and its latest message.
- **Open** shows the whole output in a separate view, **Copy** copies it, **Dismiss** removes the chip, and **Stop** ends that one task — the chip reads **Stopping…** until the task has ended.

What the card can show while a task runs depends on the runtime: Pi's supervised commands and Claude Code's background commands and agents can be read live; a Codex background terminal cannot be read while it runs, so its chip shows its status only. A finished task that left output can still be opened. `/tasks` lists this work in the transcript too.

## Session Management

Every conversation is a session, and you manage them from the sidebar. A name you give a session is kept: since 1.38.0 a rename at creation reaches disk like every other change, and switching the runtime keeps the name.

### Flagging

Flag the sessions you want to come back to. Flagged sessions show a flag marker and can be filtered.

### Archiving

Archive finished or dormant sessions to keep the sidebar tidy. Archived sessions drop out of the default view but stay reachable through the filter.

### Read / Unread

A session is marked unread when the agent produces new output while you are not looking at it. Opening the session marks it read.

### Batch Operations

Select several sessions to change their status, toggle labels, flag or unflag, archive, or delete them in one action. See [Conversations](/core-concepts/conversations#batch-operations) for the full list.

### Background session alerts

Turn on **Settings → Appearance → Background session alerts** to see a small chip in the corner of the composer when a session you are not looking at finishes a turn. Click it to open that session. It is off by default and is remembered on this computer only.

## Agent Runtime Panel

The model picker names where its list came from — the Nessy Gateway catalogue or the connection's own endpoint — so two lists that look alike are not mistaken for one another.

Conversations that run on the built-in Pi runtime (including the Nessy Gateway connection) expose a runtime panel in the right sidebar. It shows the live state of the agent while it works:

- **Tasks and plan** — the agent's task list, pending questions, and plan approval controls
- **Goal** — the active completion contract, hard turn/token/cost/time budgets, and its settled, blocked, or completed state
- **Subagents** — background child agents with their status, token usage, and steer/stop controls
- **Processes** — supervised background commands with output and stop actions
- **Checkpoints** — file checkpoints recorded before edits, with one-click rewind
- **Receipts** — bounded, redacted execution outcomes with process, workflow, checkpoint, child, and goal correlations
- **Context and security** — context usage, compaction state, pending permissions, and the active isolation profile

The panel is read-only projection plus explicit controls; it never bypasses the permission mode of the conversation.

The cross-session **Agent View** lists Pi sessions in the workspace, including
working/needs-input state and hot, cold, recovering, updating, or lost runtime
residency. You can open a session or issue an owner-checked stop/resume action;
Nessy reports non-resumable work as lost instead of silently restarting it.

## Keyboard Shortcuts

Escape closes whichever chat-pane dialog is open — the rewind menu, the agents, context and usage panes alike — and interrupts a running turn only when no dialog is open.

Nessy Desktop ships with shortcuts for the common actions. Open the shortcuts reference from the app menu (**Keyboard Shortcuts**). Frequently used bindings include:

| Action                 | Notes                                    |
| ---------------------- | ---------------------------------------- |
| New Chat               | Opens a fresh conversation               |
| Cycle Permission Mode  | **Shift + Tab** steps through the modes  |
| Send message           | Configurable in **Settings → Input**     |
| Stop                   | Ends the agent's current turn            |
| Keyboard Shortcuts     | Opens this reference                     |
| Send the other way     | **Alt/Option + Enter** — steer once on a queueing connection, or queue once on a steering one |
| Background the running task | **Ctrl/Cmd + Shift + B** — let the turn carry on without waiting for the tool call it is blocked on |

::: note
The send shortcut is configurable under **Settings → Input**, and the modes that **Shift + Tab** cycles through can be narrowed in **Workspace Settings**.
:::

Every binding in the list is rebindable, and a rebind that cannot be accepted —
a collision, or a spelling the app does not understand — now says so instead of
being dropped to a log file. Editing `preferences.json` by hand takes effect
without a relaunch.

**The Shortcuts page answers questions in both directions.** The search row
filters the roster by command name in the language the app is running in, and
the reverse lookup records one keystroke and names every command bound to it —
including the honest "nothing is bound to this". The reverse lookup and the
collision notice you get when rebinding are the same check, so the two can never
disagree about who owns a chord.

**Backgrounding a blocked turn** works where the runtime has somewhere to put
the task: on Claude Code the chord moves the in-flight tool call into the
background and the turn carries on, and the finding arrives in the conversation
when it settles. On Codex the press is refused by name rather than doing
nothing. On Pi, `/code-review` already hands the composer back on its own.
