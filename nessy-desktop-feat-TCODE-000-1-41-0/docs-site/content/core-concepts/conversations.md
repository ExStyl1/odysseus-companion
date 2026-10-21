# Conversations

Nessy Desktop keeps your work organised the way a mail client keeps your inbox. Every task lives in its own conversation thread, so you can juggle several in-flight tasks, step away, and pick any of them back up later without losing context.

## Multi-Conversation Inbox

Each conversation is an independent thread. From the inbox you can:

- Start a new thread, pause it, and return to it whenever you like
- Group threads by status (Backlog, Todo, Needs Review, Done, and any custom states you add)
- Search and filter to locate earlier work
- Archive or delete threads once they are no longer useful

Because threads are isolated, a long-running refactor never gets tangled up with a quick one-off question.

## Session ID Format

Every conversation is assigned a readable identifier of the shape:

```
YYMMDD-adjective-noun
```

The `YY` segment is the two-digit year (`26` for 2026, `25` for 2025). A few examples:

- `260111-swift-river` — created 11 January 2026
- `260108-bright-mountain` — created 8 January 2026
- `251230-calm-harbor` — created 30 December 2025

Encoding the date up front makes threads easy to sort and skim, while the adjective-noun pair keeps each one recognisable at a glance.

## Conversation Storage

Conversations are written to disk as JSON Lines (JSONL) under the global session
partition. `CONFIG_DIR` is `NESSY_CONFIG_DIR` when set, otherwise
`~/.nessy-agent`:

```
CONFIG_DIR/sessions/{workspace-id}/{session-id}/session.jsonl
```

Workspace resources stay under `CONFIG_DIR/workspaces/{workspace-id}`. Sessions
do not live inside that folder; the `workspaceId` path partition and header bind
each session to its Workspace.

The layout of that file is:

- **Line 1** — the session header, holding all list-view metadata
- **Lines 2 and beyond** — one message per line

```jsonl
{"id":"260111-swift-river","workspaceId":"ws-abc123","createdAt":1737451800000,"lastUsedAt":1737451900000,"sessionStatus":"todo","permissionMode":"default","workingDirectory":"/Users/you/projects/nessy"}
{"id":"msg_1","type":"human","content":"Summarise the auth module","timestamp":1737451800000}
{"id":"msg_2","type":"assistant","content":"The auth module has three entry points...","timestamp":1737451802000}
```

Common header fields:

| Field                | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `id`                 | Session ID (`YYMMDD-adjective-noun`)                               |
| `workspaceId`        | Immutable ID of the Workspace that owns the conversation          |
| `createdAt`          | Creation time in milliseconds                                      |
| `lastUsedAt`         | Last-activity time in milliseconds                                 |
| `sessionStatus`      | Status ID such as `todo` or `done`                                 |
| `permissionMode`     | Stored mode: `dontAsk`, `plan`, `default`, `acceptEdits`, `auto`, or `bypassPermissions`; the retired `explore` (read as `plan`) and legacy spellings (`safe`, `ask`, `allow-all`, …) in older files stay readable |
| `name`               | Optional name you set on the thread                                |
| `isFlagged`          | Whether the thread is flagged                                      |
| `labels`             | Applied labels (bare IDs or `id::value` entries)                   |
| `model`              | Per-session model override, if set                                 |
| `llmConnection`      | Connection slug; can be changed at any idle moment (see *Changing the Integration*) |
| `connectionLocked`   | Whether the session has bound a connection of its own rather than following the workspace default |
| `thinkingLevel`      | Reasoning level: `off`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `workingDirectory`   | Directory that bash commands and file tools run from               |
| `enabledSourceSlugs` | Slugs of the sources active for this thread                        |

`workingDirectory` is an optional pointer to an external Project, not a path to
Workspace storage. The backend accepts project choices through opaque handles,
revalidates the canonical project identity before use, and never treats a path
or a recent-project entry as authorization. Repository instructions, skills,
MCP, hooks, agents, memory, and `.nessy-agent` policy are loaded only after project
trust is granted.

Fork lineage identifies its parent by `{ workspaceId, sessionId }`; it never
stores a managed parent-session path.

Splitting the header onto its own line pays off in three ways:

- **Fast list rendering** — the inbox only needs to read the first line of each file
- **Cheap appends** — new messages are added without rewriting the whole file
- **Simple parsing** — each line stands alone and can be processed independently

## Status-Based Organisation

Statuses let you track where each thread sits in your workflow:

| Status           | Category | Meaning                               |
| ---------------- | -------- | ------------------------------------- |
| **Todo**         | Open     | Queued, not started yet               |
| **Backlog**      | Open     | Captured, not yet planned             |
| **Needs Review** | Open     | Waiting for you to check the result   |
| **Done**         | Closed   | Finished                              |
| **Cancelled**    | Closed   | Abandoned or no longer relevant       |

**Open** statuses stay in the inbox; **closed** statuses move the thread out of the active queue. The set is fully editable — see [customizing statuses](/statuses/customizing) to add states like Blocked or Waiting.

## Batch Operations

Select several threads to act on them together. Hold **⌘ Click** (macOS) or **Ctrl+Click** (Windows/Linux) to toggle individual threads, or **⇧ Click** to select a range. With more than one thread selected, a batch panel offers:

| Action            | Effect                                    |
| ----------------- | ----------------------------------------- |
| **Change Status** | Apply one status to every selected thread |
| **Set Labels**    | Toggle labels across the selection        |
| **Flag / Unflag** | Flag or clear the flag on all selected    |
| **Archive**       | Archive the whole selection               |
| **Delete**        | Permanently remove the selected threads   |

Press **Esc** to drop the selection.

::: tip
Right-clicking a multi-selection opens a context menu with the same actions.
:::

## Conversation Continuity

Reopening a thread restores its full state, so you can carry on as if you never left:

- Every earlier message is still there
- The agent retains what was already discussed
- References to files and documents from earlier turns remain valid

### Reopening a long, idle conversation

A big conversation that has been sitting idle costs you on **every** later
request, because the whole history is re-sent each time. So when you reopen one
that is both idle and over roughly 100,000 tokens, Nessy asks once before your
first message:

- **Resume from summary** — the conversation is compacted first, and later
  requests carry the summary instead of the full transcript.
- **Resume full session as-is** — every detail is kept, at a per-request cost
  that scales with the conversation's size.

It asks once per reopen, not once per message. Change the threshold with
`reopenCompactPromptTokens` in `config.json`; **zero or a negative number turns
the dialog off**.

### Branching a conversation

`/branch` forks the conversation in place and switches you into the branch, so
you can try a different direction without losing the thread you came from. The
turn button already did this; the command exists so branching is reachable when
there is no transcript row to click. It works on all three runtimes, including a
Codex session that has not started yet.

### Running a conversation as an agent

A conversation can be pinned to one of your agents. Its system prompt and its
tool restrictions then apply to every turn — not just to children it spawns —
and the composer shows `@<name>` beside the permission mode so you can see which
agent is answering. Set it with `sessionAgent` in `config.json`. Switching to a
runtime with no main-thread agent tells you the pin is being dropped rather than
quietly ignoring it.

```
> Resuming 260111-swift-river…

Last message: "Mapped out the auth module dependencies."

> Good — let's start the refactor.
Picking up where we stopped. I'll begin with the token exchange path…
```

## How Long a Conversation's Agent Lives

An open conversation holds a running agent, and that agent outlives your
individual messages. On Claude this is new: the app used to start a process per
message and end it with the answer, which is why nothing on that runtime could
continue between turns.

**It is released when it is idle, and only then.** After thirty minutes with no
turn started or finished, the agent is shut down and your next message starts it
again — the conversation, its files and its history are untouched, and what the
release costs is the seconds to start, not the thread.
[`NESSY_IDLE_AGENT_TTL_MS`](/reference/config/environment-variables) changes the
window or turns the release off. A Codex chat keeps its conversation files (Codex's
own thread transcript, tool output included) in a private folder until you delete
the chat, so after a release or an app restart the model continues the same thread.

**Holding work postpones it indefinitely.** A running turn, a background task, a
background command, a child agent, a permission card you have not answered and a
question waiting on you all keep the agent. So does a conversation that is
listening for something — a plugin's monitor, a connected tool's channel —
because releasing that one would not pause it, it would make it deaf until you
typed again.

**When too many conversations are open at once**, the app refuses to start a new
agent rather than taking a busy one's work away, and names how many are still
holding something. Wait for one to finish, or stop it, and send again.

**Stop cancels the turn, not the conversation.** The agent is still there and
answers your next message. If it stops responding to the cancel, the app ends it
after five seconds rather than leaving you with a thread that never replies.

## Changing the Integration

A conversation is not locked to the integration it started on. The picker offers
every integration at any idle moment, and the change takes effect in place — the
thread keeps its name, its project, its files and its history.

There are three tiers, and they are not equally disruptive:

| What you change | What happens |
| --- | --- |
| The model, within the same integration | Nothing else changes. No confirmation. On Claude the running agent is retuned in place, so there is not even a restart — unless the new model has a different thinking shape, or is outside the Claude family. |
| The integration, same underlying agent | The agent restarts and resumes its own record of the conversation. |
| The integration, different agent | The conversation is handed over, and some things stop. Confirmed first. |

**Only the third tier asks.** The confirmation names what will actually stop:
background agents, a plugin's always-on monitor, a language server a plugin
provided, and any images already in the conversation that the new agent cannot
read. It names them rather than counting them, because a count cannot be checked
against anything.

### What crosses, and what does not

An agent you have not used in this conversation before receives the
conversation itself, not a retelling of it: when it fits the new model's
context window, the full history — including tool calls and their results, so
the agent can answer about a file it read or a command it ran before the
switch — is handed over as the agent's own native history. When it does not
fit, or the window is unknown, a text summary of the recent messages crosses
instead — and the confirmation dialog says which of the two you are getting
before you agree. An agent you were on **earlier** still has its own record,
so it resumes that and is told only what it missed while you were away — not
read the whole conversation a second time.

The model you picked also survives the move when the new integration offers
it; when it does not, the session lands on that integration's default and a
notice names both ends of the change.

What does not cross:

- **Work in flight.** A switch is refused while a reply is being written.
- **Anything scheduled by the old agent** — a `/loop`, a background agent, a
  monitor. These are stopped as part of the move. Ones that can start again do
  when you come back.
- **Permissions you granted.** An "always allow" is an answer about one agent;
  a different one asks again.
- **The context meter's history.** Each agent measures its own capacity, so the
  meter resets with the switch and refills from the agent now running.

A switch is also refused if leaving would strand uncommitted work in a
worktree — and it is refused up front, before anything is torn down, when the
target cannot actually start here: its runtime is not in this build, its
binary is missing, or the connection has no usable credentials. Sign in first,
then switch.

## How Context Builds

A conversation is tied to one workspace, and context accumulates naturally as you go:

```
> Find the release checklist
Found "Release Checklist v3" — here's the outline…

> Add a section called "Rollback"
Added a "Rollback" section.

> Now add three steps under it
Added three steps:
1. Snapshot the database
2. Revert the deployment
3. Notify the on-call channel
```

You can lean on earlier turns with phrases like "that document" or "the step we just added" — the agent tracks what you are referring to.

## Starting a New Conversation

Use **New Chat** in the sidebar (or its keyboard shortcut) to open a fresh thread. A new session ID is minted while every existing thread stays put in the inbox.

## Using Skills in Conversations

Skills are named capabilities you invoke inline with bracket syntax. An invoked skill runs with access to the conversation so far:

```
> Find the release checklist
Found "Release Checklist v3"…

> [skill:research] Gather background on the rollback strategy
Running the research skill…
(the skill can read the checklist from the previous turn)
```

That means skills can build on earlier context, reference documents already in the thread, and be chained one after another. See the [Skills documentation](/skills/overview) for how to add and invoke them.

## Long Conversations

For extended sessions, context is managed automatically so you never have to
prune it by hand. Large tool results are trimmed rather than kept in full, and
the active agent backend handles the context window for you.

Local Pi sessions can report live context usage: the `/usage` and `/context`
commands show the model window, current context, remaining tokens, and the
source of the number. If you run `/compact`, the session refreshes the meter as
soon as compaction finishes.

When you run `/compact` yourself on a Pi session, the model is asked to produce
a structured context checkpoint — current progress and key decisions, active
constraints and your preferences, what remains to be done, and any critical data
or references — so the summary that replaces the transcript reads as a handoff
to the model that continues the work. Automatic compaction (triggered by the
context window filling up) uses the backend's own built-in summary instead.

Automatic compaction is checked after the model answers, so the room it leaves
has to cover the whole of the next turn — your message and every tool result it
produces. Nessy Desktop sizes that room to fit at least one tool result of the
maximum permitted size, and raises it with you if you raise `NESSY_MCP_OUTPUT_TOKENS`.
On a model with a small context window the room is capped at a third of the
window, so a narrow-window session keeps a usable amount of history.

Nestor Cloud sessions are honest about what the remote agent reports. When the
cloud agent sends structured usage or compaction state, Nessy Desktop shows it;
when it does not, the context meter stays unavailable instead of guessing a
remaining window from local heuristics.

## Independent History Per Workspace

Each Workspace has independent conversation history even though all session
partitions live under `CONFIG_DIR/sessions`:

| Workspace         | History  |
| ----------------- | -------- |
| Personal Notes    | Separate |
| Work Projects     | Separate |
| Client Engagement | Separate |

Switching workspaces switches you to that workspace's threads.

## Sharing

Share a chat from its menu or the chat header: after a confirmation card, a masked snapshot is published to t-artifacts. See [Sharing](/go-further/sharing).

## Tips for Effective Conversations

- **Point back with shorthand.** Rather than spelling out full names again, a phrase like "that doc" or "the task from a moment ago" is enough — the agent holds onto what you mean.
- **Iterate on what just happened.** Immediately after making something, tweak it in place: "give it a due date" or "rename that".
- **Set it straight fast.** When the agent takes a request the wrong way, say so plainly — "no, I meant the other repo" or "the older one".
- **Lean on statuses.** Marking threads Todo, Needs Review, or Done keeps parallel work legible.
