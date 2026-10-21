# Statuses

Every session carries exactly one status that marks where it sits in your workflow — from "not started yet" through review to finished. Statuses decide what shows up in the active inbox and what moves to archive views, and they are the backbone for filtering and automation.

## Open And Closed

Each status belongs to one of two categories:

| Category   | Meaning                              | Where sessions appear |
| ---------- | ------------------------------------ | --------------------- |
| **Open**   | Work that still needs attention      | Inbox / active lists  |
| **Closed** | Finished or abandoned work           | Archive               |

New sessions get the workspace's default status (out of the box, "Todo"). Moving a session to a closed status archives it; moving it back to an open status returns it to the inbox. In both directions the session's content and history are untouched — only its place in your workflow changes.

## Default Statuses

A fresh workspace ships with five statuses:

| Status           | Category | Typical use                    |
| ---------------- | -------- | ------------------------------ |
| **Backlog**      | Open     | Ideas parked for later         |
| **Todo**         | Open     | Ready to start (the default)   |
| **Needs Review** | Open     | Waiting on a human check       |
| **Done**         | Closed   | Finished successfully          |
| **Cancelled**    | Closed   | Dropped, no longer relevant    |

You can add your own states — "In Progress", "Blocked", "Waiting" — or restyle the defaults. See [Customizing Statuses](./customizing).

## Status Types

How editable a status is depends on two flags in its configuration:

| Type    | Flags                | What you can change                                        |
| ------- | -------------------- | ---------------------------------------------------------- |
| Fixed   | `isFixed: true`      | Color and icon only. `todo`, `done`, and `cancelled` are fixed because the app relies on them existing. |
| Default | `isDefault: true`    | Label, color, and icon — but the status cannot be deleted. `backlog` and `needs-review` ship this way. |
| Custom  | neither flag set     | Everything, including deletion.                            |

## Per-Workspace Configuration

Statuses are configured independently for each workspace, so a personal scratch workspace and a team delivery workspace can run different flows. The configuration lives at:

```
~/.nessy-agent/workspaces/<workspace-id>/statuses/config.json
```

Status icons are stored next to it:

```
~/.nessy-agent/workspaces/<workspace-id>/statuses/icons/
```

If the config file is missing or fails validation, the workspace silently runs on the default five statuses.

## Changing A Session's Status

Use the status control on a session to move it to another state at any time. An agent can move its session between open statuses — for example to Needs Review when its work is ready — but only you close a session as Done or Cancelled. A session whose stored status no longer exists — for example after a custom status was deleted — falls back to `todo` rather than disappearing.

On Codex, the agent reaches these tools over the session's host link: `set_session_status` and `set_session_labels` are available while that link is up.

::: info
Status changes are an automation trigger: moving a session to a review state can kick off a summary prompt or run a command. See [Automations](../automations/overview).
:::
