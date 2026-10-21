# Board

The board shows the workspace's sessions as cards in columns — a kanban view of everything in flight. Switch between the session list and the board with the **List / Board** toggle.

## Cards And Columns

- Every top-level session is a card. Archived sessions, child sessions and Generate drafts that were never saved are not cards; a child session appears as a subtask row on its parent's card instead.
- The columns are **ToDo**, **In Progress** and **Done**. A card's column follows its status (`todo` → ToDo; `in-progress` and `needs-review` → In Progress; `done` and `cancelled` → Done) until someone drags it to another column. Dragging a card to a column moves it and sets the column's drop status; column colours and drop statuses are in **Settings → Appearance**, kept per viewer.
- Closing work — moving a card to **Done** — is your decision: an agent never closes its own card. See [Statuses](../statuses/overview).

## Adding A Task

New Task on the board opens the task editor. Give the task a title, a goal and, optionally, acceptance criteria; pick the orchestrator's model (grouped by connection, with the runtime that serves it), the permission mode, the sources and skills every subtask gets, and the folder. Add subtasks, each with its own prompt, optional model and dependencies on other subtasks. The task lands in To do. Edit it later from the tile's pencil or from the task's chat header (Edit task).

See [Tasks](./tasks) for what a task is made of, Generate, and running one.

## Projects On The Board

Choose projects in the board's header filter to see only their cards; **No project** shows the cards without a project. With exactly one project chosen, the board shows that project's own columns: click a column's header to rename it, recolour it, set the status a drop applies, or remove it, and use **+** to add one. The first edit starts from the three default columns, a removed column's cards move to the first remaining column, and the last column cannot be removed. Clicking a task's card opens All Sessions filtered to that task (and its project); clear the filters as usual. In the task editor, **Project** puts the task in a project; a new task then starts in the project's folder unless you pick another one.

See [Projects](../projects/overview) for projects themselves.

## Tasks From A Conversation

An agent can add a task to the board with `create_board_task`. The task lands in To do and is never started by the agent; it uses the agent's own folder, project, connection and enabled sources.

## Deleting A Task

Deleting a task's orchestrator chat also deletes the task folder `tasks/<slug>/` unless another chat still carries the task; archiving keeps it.
