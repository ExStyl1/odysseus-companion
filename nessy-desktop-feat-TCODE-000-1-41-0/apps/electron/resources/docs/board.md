# Task Board

The task board is a view of the workspace's sessions as cards in columns. Use this guide when the user asks about the board, about tasks and their subtasks, or wants work captured as a task.

## The board

- Switch between the session list and the board with the **List** / **Board** toggle.
- Every top-level session is a card. Archived sessions, child sessions and Generate drafts that were never saved are not cards; a child session appears as a subtask row on its parent's card instead.
- The columns are **ToDo**, **In Progress** and **Done**. A card's column follows its status (`todo` → ToDo; `in-progress` and `needs-review` → In Progress; `done` and `cancelled` → Done) until someone drags it to another column. Column colours, the status a drop into a column sets, and the live pulse on running cards are in **Settings → Appearance**; they are kept per viewer, in the app's local storage.
- Dragging a card to another column moves it and sets the column's drop status. With the keyboard: focus a card, press Space to pick it up, Left or Right Arrow to choose the column and Space (or Enter) to drop it (Escape cancels; Enter on a card that is not moving opens it). Closing work (moving it to **Done**) is the user's decision — an agent never closes a card (`set_session_status` refuses closed statuses; see `statuses.md`).
- **New Task** at the top of ToDo creates a card from a title and stays open, so several can be added in a row. **Add subtask** on a card adds a subtask to it.
- Clicking a card (or a subtask row) of a task opens its session in **All Sessions** with the list filtered to that task's label and, when the task belongs to a project, to that project. These are the list's ordinary filters, which the user can clear. A card that is not a task opens its session plainly.

## Projects on the board

- The project filter in the board's header shows the cards of the chosen projects; **No project** shows the cards without a project. A card created while the filter is on (with **New Task** or the task editor) goes to the first chosen project.
- With exactly one project chosen, the board shows that project's own columns, if it has any ("Columns from <project>"). Clicking a column's header then edits it: rename, colour, the status a drop sets, or remove; the **+** at the end adds a column. The first edit starts from the three default columns. Removing a column moves its cards to the first remaining column, and the last column cannot be removed. The columns are stored with the project, so every viewer sees them; the all-projects view always uses the default columns.

## Tasks

A **task** is a card backed by a spec: `tasks/<slug>/task.yaml` under the workspace folder. Its card is the task's **orchestrator** session; each step of the spec is a **subtask** (a node) that runs as its own child session.

The spec, in short:

```yaml
id: weekly-report            # the slug: lowercase letters, digits and hyphens
title: Weekly report
goal: Write the weekly status report.
acceptance_criteria: The report lists every shipped change and every open risk.
defaults:
  permissionMode: default    # the mode of the whole task: the orchestrator and every subtask
nodes:
  - id: gather
    title: Gather the numbers
    prompt: Collect this week's merged changes and open incidents.
  - id: write
    title: Write the report
    prompt: "Write the report from: ${nodes.gather.output}"
    depends_on: [gather]
```

- `nodes` is a small graph: a node runs once everything in its `depends_on` has finished, and `${nodes.<id>.output}` passes an earlier node's final answer into a later prompt. Every reference must name a node the spec declares.
- `acceptance_criteria` is the rubric the orchestrator checks the finished work against.
- A title in a non-Latin script gets a slug like `task-1a2b3c`; a slug that already exists is never overwritten.
- The folder is never a path an agent chooses: a task runs in its orchestrator's folder, and a `cwd` in the yaml is accepted only for a folder the user has trusted.

The **Task editor** (**Edit task** on a card) is where the user writes or changes the spec: title, goal, acceptance criteria, the project, the model and connection of the orchestrator, the permission mode, sources, skills and the subtasks. A new task in a project with a folder starts in that folder unless the user picks another one; choosing a project for an existing task never moves its folder, and a task that already has a project cannot be set back to **No project** in the editor.

## Generate

The editor's **Generate** tab drafts a plan from the goal (or the title): a draft orchestrator session writes the spec, and the editor fills in the subtasks and switches to **Manual** for the user to review and change. The draft writes nothing: it authors in the most restrictive mode (`dontAsk`), so an action no rule already allows is refused without asking, on every runtime. It is a session of its own but never a card; saving a new task adopts it as the task's orchestrator, in the mode chosen in the editor, saving an edited task keeps the task's own orchestrator and deletes the draft, and leaving the editor without saving (or generating again) deletes it. A working directory picked after Generate moves the draft to that folder before it is adopted; a folder that is not trusted is refused, as for any task. A generated plan that is saved and run asks for the run confirmation first, because an agent wrote its subtasks — in a new task and in an edited one alike. The editor waits up to about six minutes for a draft; a slower one keeps working in its session.

## Permission mode

The task's permission mode is a ceiling for the subtasks the orchestrator dispatches (the spec's nodes): a node starts in its own mode capped at the orchestrator's, and every later change of a node's mode is capped at the orchestrator's mode at that moment. Lowering the orchestrator's mode caps each node's next mode change and its next dispatch; a node that is already running keeps its mode until then. A run resumed after a restart keeps the mode it last ran under, even when the orchestrator itself comes back narrower (a **Bypass permissions** session restarts in the mode a new session starts in); once you change the orchestrator's mode, that mode is the run's ceiling again. Two kinds of session have no ceiling: a subtask added with **Add subtask** is the user's own session, and a node whose orchestrator is gone. The editor says, for the chosen mode, where a subtask stops for approval and — in **Auto** — which judge decides on each runtime.

## Running a task

The user starts a task: **Play** on its card, or **Create & Run** / **Save & Run** in the editor. The orchestrator then dispatches the subtasks in dependency order, each as its own child session in the task's folder, and grades the finished work against `acceptance_criteria`; a failed grade sends the named subtasks back for a repair, up to the task's limit.

- **Run confirmation.** A run asks first whenever the spec on disk is not the last one the user saved in the editor or confirmed: a task an agent created, a plan Generate wrote, or a `task.yaml` changed on disk. The confirmation lists every subtask with its runtime, connection, model and permission mode, the task's sources, and the plugins a subtask sees with their MCP server names. The app enforces it, not only the button: a run of an unconfirmed spec is refused.
- **Plugins and sources.** A subtask has the plugins enabled for the workspace and for the task's project; plugins loaded only for one chat do not carry over. A task's sources choose workspace sources only — plugin MCP servers follow plugin enablement. A plugin part a runtime cannot host is absent on that runtime's subtasks, as in any session there.
- **Folder.** Every subtask runs in the orchestrator's folder; its access is re-issued from that folder without a new trust prompt.
- **Results.** The editor's **Results** tab shows the run's status, the grade and its history, and each subtask's state and final answer, with a link to its session. **Pause** stops new subtasks from starting (running ones finish), **Resume** continues, **Stop** ends the run. A run the app restart interrupted reads **Interrupted** and offers **Resume**, which continues from the plan the run started with.
- **Worked after done.** A card shows this badge when a subtask's session took another turn after its subtask was marked done; that later work is not in the task's results.

A subtask counts as done when its turn has ended and nothing it started is still working: no background agent, workflow or shell, no monitor, no scheduled wake-up, no active goal. If background work is still running when the turn ends, the subtask stays running. It finishes a few seconds after that work ends, with the answer it gave before (on Claude Code, see below). On Codex, an agent spawned with spawn_agent and left running after its turn is waited for, but its report is not the subtask's output: Codex keeps it for the subtask's next turn. A background command started in the subtask's last turn may not be seen before the subtask is marked done. On Claude Code, when a background task ends the assistant writes a reply in the subtask's chat; the subtask waits for that reply and takes it as its output.

## Creating a task from a conversation

`create_board_task` puts a task on the board, in ToDo, with its orchestrator session, and **never runs it** — starting a task is the user's decision. Use it when the user asks to capture or queue work as a task; for the steps of the work you are doing now, use your in-session checklist or plan tool instead.

- The task stays in your own working folder and connection, goes to your own project or another project bound to the same folder, and takes your permission mode; it may use only the sources enabled in your session. Anything wider is refused.
- It is offered on Pi and Claude, and on codex when the session tools reach the app (the same condition as the other session tools that need the app).

## What an agent cannot do here

- Close a card (move it to `done` or `cancelled`).
- Start, pause or stop a task's run.
- Write `tasks/<slug>/task.yaml` to create a task behind the board's back — use `create_board_task`, or ask the user to use the editor.
