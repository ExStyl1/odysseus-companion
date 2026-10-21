---
name: Loop
description: Run a prompt on repeat while the session stays open. Use when the user types /loop or asks to poll something on an interval, babysit a PR, or keep re-running a prompt. Both the interval and the prompt are optional.
---

# Loop

Run a prompt repeatedly in this session. The text after `/loop` may carry an
interval, a prompt, both, or neither — what was provided determines the mode:

| What was provided         | Example                     | What to do                                                             |
| :------------------------ | :-------------------------- | :--------------------------------------------------------------------- |
| Interval and prompt       | `/loop 5m check the deploy` | Fixed schedule: convert the interval to cron and call `CronCreate`     |
| Prompt only               | `/loop check the deploy`    | Self-paced: you choose the delay after each iteration                  |
| Interval only, or nothing | `/loop` or `/loop 15m`      | The default prompt (the user's `loop.md`, or the built-in maintenance prompt) |

Every loop expires automatically seven days after it starts.

## First: check that this session can schedule

Every mode above ends in `CronCreate`, and `CronCreate`, `CronList`,
`CronDelete`, `CronControl` and `ScheduleWakeup` are host tools a session can be
running without — a runtime with no scheduler, the `NESSY_DISABLE_CRON` switch, or a
Codex session whose host-callback bridge did not start.

If they are not in your tool list, say so in one line and stop. Do not describe a
schedule you did not create, and do not substitute a sleep, a poll, or a promise
to pick this up later: nothing will wake you, so an answer that sounds like a
started loop is worse than the refusal.

## Parsing the interval

The interval may LEAD the prompt as a bare token (`30m check CI`) or TRAIL it
as a clause (`check CI every 2 hours`). Units: `s` seconds, `m` minutes, `h`
hours, `d` days. Everything that is not the interval is the prompt.

Rounding rules — cron has one-minute granularity:

- Seconds round UP to the nearest minute (`45s` → every minute).
- An interval that does not map to a clean cron step is rounded to the nearest
  one that does: `7m` → `*/5 * * * *` or `*/10 * * * *` (pick the nearer),
  `90m` → every hour or every 2 hours. **Always tell the user what you
  picked** when you rounded.

## Fixed schedule (interval given)

Convert the interval to a 5-field cron expression and call `CronCreate` with
`recurring: true`, the expression, and the prompt. Confirm to the user the
cadence you scheduled and the 8-character job ID from the result.

- `/loop 5m check the deploy` → `CronCreate {schedule: "*/5 * * * *", prompt: "check the deploy", recurring: true}`
- Interval only (`/loop 15m` — no prompt): pass `promptSource: "loop-md"` and a
  short placeholder prompt such as `Default loop (loop.md / maintenance)`.
  The host then delivers the real default prompt — the user's `loop.md` or the
  built-in maintenance prompt — re-resolved fresh at every fire, so edits to
  `loop.md` take effect on the next iteration.

## Self-paced mode (no interval given)

When no interval was given, do NOT invent a cron schedule. Call `CronCreate`
with `dynamic: true`, `recurring: true`, and the prompt (plus
`promptSource: "loop-md"` and a placeholder prompt when the user gave no
prompt either — bare `/loop`). Do not run the prompt in this turn: the first
iteration is delivered to you as soon as this turn ends.

At the END of every delivered iteration, decide:

- **Continue** — call `ScheduleWakeup` with `delaySeconds` (60 to 3600: one
  minute to one hour) and a short `reason`. Pick the delay from what you
  observed: short waits while a build is finishing or a PR is active, longer
  waits when nothing is pending. **Print the chosen delay and the reason at
  the end of the iteration.**
- **Done** — when the task is complete, call `ScheduleWakeup` with
  `stop: true`, which cancels the pending wakeup immediately, and say the loop
  ended.

If an iteration ends without rescheduling or stopping, one fallback wakeup
fires about 20 minutes later, and the loop ends for good when that iteration
does not reschedule either. Consider the `Monitor` tool instead of a
self-paced loop when a background command can stream the answer — it avoids
polling altogether.

## The default prompt (bare `/loop`)

When the user supplies no prompt, the host resolves the default prompt at
every iteration, in this order: the project's `.nessy-agent/loop.md`, then the
user-level `loop.md` in the agent config directory, then the built-in
maintenance prompt (continue unfinished work from the conversation; tend the
current branch's PR — review comments, failed CI, merge conflicts; cleanup
passes when nothing else is pending; no new initiatives, and irreversible
actions only when the transcript already authorized them). A supplied prompt
always wins — `loop.md` is ignored for `/loop <prompt>`.

## Managing and stopping loops

- The loop appears in the scheduled task list: `CronList` shows it, and
  `CronDelete <id>` cancels it — that is also how the user can ask you to stop
  a fixed-interval loop.
- Pressing `Esc` while a self-paced loop is waiting clears its pending wakeup;
  tasks scheduled by asking directly are not affected by `Esc`.

## Scheduled fires and skills

The user may pass a skill as the prompt (`/loop 20m /review-pr 1234`) to re-run
it each iteration. A scheduled fire only runs skills you are allowed to invoke
on your own. Built-in commands, skills marked `disable-model-invocation: true`,
skills withheld from you by settings, and MCP prompts reach you as plain text
instead of executing — treat that text as the iteration's instruction, not as
something to execute by other means.
