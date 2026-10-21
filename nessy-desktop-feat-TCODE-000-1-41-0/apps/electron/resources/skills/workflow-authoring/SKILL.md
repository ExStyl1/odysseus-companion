---
name: Workflow Authoring
description: Reference for writing a Workflow script — the script API, the caps, resume, and the mistakes that cost a run. Load before writing or editing a workflow script. It does not authorize running one; the user still opts in.
---

# Workflow authoring

A workflow is a JavaScript orchestration script the `workflow` tool runs. The
script spawns child sessions with `agent()` and composes them with `parallel()`,
`pipeline()` and `phase()`. Read this before writing or editing one.

**This skill does not authorize a run.** Writing or editing a script is not
consent to execute it: the user opts in to a workflow separately, and a launch
the user did not ask for is a defect no matter how good the script is.

## Where a script lives

| Scope    | Directory                                  |
| :------- | :----------------------------------------- |
| Personal | `<config dir>/workflows/`                  |
| Project  | `<repo>/.nessy-agent/workflows/`           |

A saved script is called by name. An inline `script` string and an explicit
`scriptPath` are the other two ways in; `scriptPath` takes precedence over
`name`, and it is canonicalized against the workflow roots above — a path
outside them is refused rather than read.

## The required shape

Every saved script begins with a `meta` literal and then the body:

```js
export const meta = {
  name: 'audit-deps',
  description: 'Inspect each workspace package for unused dependencies',
}

phase('Inspect')
const findings = await parallel(
  packages.map((pkg) => () => agent({ agent: 'scout', task: `Inspect ${pkg}` })),
)

phase('Report')
return agent({ task: `Summarize: ${JSON.stringify(findings.filter(Boolean))}` })
```

`meta` **must be a pure literal object**. Variables, function calls, spreads,
computed keys and template interpolation are all refused — the loader parses the
block without executing it, so anything it would have to run to know the value
is an error. `name` and `description` are required strings. `phases` is the one
documented optional field (`agent-sdk/typescript.md`, the `Workflow` tool's
`script` parameter): an array grouping agents under named stages in the progress
view. Unknown keys are **ignored, not refused** — a misspelled optional key
(`phasez`) loads as absent rather than failing the file, deliberately, so an
upstream field addition cannot silently amputate a whole bundle. A misspelled
*required* key is still caught.

## The helpers

| Helper                       | What it does                                                          |
| :--------------------------- | :-------------------------------------------------------------------- |
| `agent(promptOrDef, opts)`   | Run one child session. `task` must be a non-empty string.             |
| `workflow(nameOrRef, args)`  | Call another saved workflow.                                          |
| `parallel(thunks)`           | Run an array of **functions** concurrently.                           |
| `pipeline(items, ...stages)` | Run each item through each stage in order.                            |
| `phase(label)`               | Name the stage the progress view shows from here on.                  |
| `log(...)`                   | Write a line into the run's log.                                      |
| `args`                       | What the caller passed — `args.input` carries a command's trailing text. |
| `budget`                     | What is left of the run's agent allowance.                            |

## The caps, and why there are two

`workflows.md#behavior-and-limits` states both, and they do different jobs:

- **4,096 items in a single `parallel()` or `pipeline()` call.** Checked
  *before* anything is dispatched, and the refusal names the offending length.
- **1,000 `agent()` calls total per run.** Counted across the whole run; the
  1001st throws, i.e. *after* a thousand agents have already gone out.

The per-call cap exists because the per-run cap alone would let a 100,000-item
list dispatch a thousand agents and then abort mid-flight, leaving a partial
workload behind and no statement of how much was skipped. A per-call `maxAgents`
input can only *lower* the run ceiling, never raise it.

Where the work is genuinely larger than a cap, **say so and chunk it** — do not
quietly slice the list and report success over the part that ran.

## `parallel()` and `pipeline()` return `null` for failures

This is the single most common authoring bug. A failed item is `null`, not a
thrown error, so the array you get back is ragged:

```js
const results = (await parallel(thunks)).filter(Boolean)
```

Call `filter(Boolean)` before anything downstream consumes the outputs.
Forgetting it turns one child failure into a `TypeError` deep in a later stage,
where nothing points at the item that actually failed.

## Resume

A run has a `runId`. Passing a previous run's id as `resumeRunId` replays the
`agent()` calls that already completed out of that run's journal instead of
re-spawning them — the replayed calls return their cached results and cost
nothing. Two consequences worth writing scripts around:

- Keep `agent()` calls **deterministic in order**. A script that decides how many
  agents to spawn from a clock, a random draw, or a directory listing that
  changes between runs will replay against the wrong journal entries.
- A resumed run that never reaches a live `agent()` call completes without
  spawning anything. That is a successful replay, not a refusal, and the script
  should not report it as new work.

## Background runs

Long workflows take `background: true`. A backgrounded script reports back
through events rather than returning inline. Two states read like failures and
are not: a script that never calls `agent()` at all (logging, validation, a pure
transform) spawns nothing by design, and a fully replayed resume finishes with
no new spawn. Neither is a refusal — do not report them as one.

## Quality checklist before saving

1. `meta` is a pure literal with a real `name` and `description`.
2. Every `agent()` has a non-empty, self-contained `task` — the child sees none
   of this conversation.
3. `parallel()` is given **functions**, not already-started promises.
4. `filter(Boolean)` sits between every fan-out and its consumer.
5. Fan-out width is bounded by something the script computes, not by hope.
6. `phase()` labels each stage, so a stalled run is legible in the progress view.
7. The script says what it did — including what it skipped.
