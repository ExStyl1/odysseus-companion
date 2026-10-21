# Tasks

A task is work planned as a spec rather than a single conversation: `tasks/<slug>/task.yaml` under the workspace folder. The task's card on the [board](./overview) is its orchestrator session, and each step of the spec — a subtask — runs as its own child session.

## The Spec

- `nodes` is a small graph: a node runs once everything in its `depends_on` has finished, and `${nodes.<id>.output}` passes an earlier node's final answer into a later prompt. Every reference must name a node the spec declares.
- `acceptance_criteria` is the rubric the finished work is graded against.
- A task runs in its orchestrator's folder; a folder picked for a task must be one you have trusted.

You normally write the spec in the task editor rather than by hand.

## The Task Editor

The editor is where you write or change a task: title, goal, acceptance criteria, the project, the model and connection of the orchestrator, the permission mode, the sources and skills every subtask gets, the folder, and the subtasks themselves. New Task on the board opens it; so does **Edit task** on a card or in the task's chat header. A new task in a project with a folder starts in that folder unless you pick another one; choosing a project for an existing task never moves its folder.

## Generate

The editor's **Generate** tab drafts a plan from the goal (or the title). Generate drafts a plan in a read-only session that is deleted unless you save it; a generated plan asks for the run confirmation before its first run. The draft writes nothing: it authors in the most restrictive mode, so an action no rule already allows is refused without asking. Saving a new task adopts the draft as the task's orchestrator; leaving the editor without saving deletes it.

## Running A Task

You start a task: **Play** on its card, or **Create & Run** / **Save & Run** in the editor. The orchestrator dispatches the subtasks in dependency order, each as its own child session in the task's folder, and grades the finished work against the acceptance criteria; a failed grade sends the named subtasks back for a repair, up to the task's limit.

Running a task asks for confirmation when you did not save the plan yourself (an agent wrote it, Generate drafted it, or task.yaml changed on disk); the confirmation lists each subtask's runtime, connection, model and mode, the sources and the plugins.

**Pause** stops new subtasks from starting (running ones finish), **Resume** continues, **Stop** ends the run. The editor's **Results** tab shows the run's status, the grade and its history, and each subtask's state and final answer, with a link to its session.

## When A Subtask Is Done

A subtask counts as done when its turn has ended and nothing it started is still working: no background agent, workflow or shell, no monitor, no scheduled wake-up, no active goal. If background work is still running when the turn ends, the subtask stays running. It finishes a few seconds after that work ends, with the answer it gave before (on Claude Code, see below). On Codex, an agent spawned with spawn_agent and left running after its turn is waited for, but its report is not the subtask's output: Codex keeps it for the subtask's next turn. A background command started in the subtask's last turn may not be seen before the subtask is marked done. On Claude Code, when a background task ends the assistant writes a reply in the subtask's chat; the subtask waits for that reply and takes it as its output.

## Permission Mode

The task's permission mode is a ceiling for its subtasks: a subtask starts in its own mode capped at the orchestrator's, and every later mode change is capped again. Lowering the orchestrator's mode while the task runs caps a running subtask's next mode change and every subtask that starts after it; a subtask that is already running keeps its mode until then. A run resumed after a restart keeps the mode it last ran under until you change the orchestrator's mode. A subtask you add yourself from a board tile is your own session and is not clamped. See [Permissions](../core-concepts/permissions).
