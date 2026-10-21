# Статусы

У каждой session ровно один status, показывающий, где она находится в workflow — от "not started yet" через review до finished. Statuses решают, что отображается в active inbox и что уходит в archive views, и служат основой для filtering and automation.

## Open And Closed

Каждый status относится к одной из двух categories:

| Category | Meaning | Where sessions appear |
| -------- | ------- | --------------------- |
| **Open** | Работа, которая ещё требует внимания | Inbox / active lists |
| **Closed** | Finished или abandoned work | Archive |

New sessions получают default status workspace (из коробки "Todo"). Перемещение session в closed status archives it; возврат в open status возвращает её в inbox. В обе стороны content и history session не трогаются — меняется только место в workflow.

## Default Statuses

Fresh workspace поставляется с пятью statuses:

| Status | Category | Typical use |
| ------ | -------- | ----------- |
| **Backlog** | Open | Ideas parked for later |
| **Todo** | Open | Ready to start (the default) |
| **Needs Review** | Open | Waiting on a human check |
| **Done** | Closed | Finished successfully |
| **Cancelled** | Closed | Dropped, no longer relevant |

Можно добавить свои states — "In Progress", "Blocked", "Waiting" — или restyle defaults. См. [Customizing Statuses](./customizing).

## Status Types

Насколько status editable, зависит от двух flags в configuration:

| Type | Flags | What you can change |
| ---- | ----- | ------------------- |
| Fixed | `isFixed: true` | Только color и icon. `todo`, `done` и `cancelled` fixed, потому что app relies on them existing. |
| Default | `isDefault: true` | Label, color and icon — but status cannot be deleted. `backlog` и `needs-review` ship this way. |
| Custom | neither flag set | Всё, включая deletion. |

## Per-Workspace Configuration

Statuses configured independently for each workspace, поэтому personal scratch workspace и team delivery workspace могут иметь разные flows. Configuration lives at:

```
~/.nessy-agent/workspaces/<workspace-id>/statuses/config.json
```

Status icons stored next to it:

```
~/.nessy-agent/workspaces/<workspace-id>/statuses/icons/
```

Если config file missing или fails validation, workspace silently runs on default five statuses.

## Changing A Session's Status

Используйте status control на session, чтобы move it to another state at any time. Агент может переводить свою сессию между открытыми статусами — например, в Needs Review, когда работа готова к проверке, — но закрыть сессию как Done или Cancelled можете только вы. Session, whose stored status no longer exists — например после удаления custom status — falls back to `todo`, а не disappears.

В Codex агент получает эти инструменты через host link сессии: `set_session_status` и `set_session_labels` доступны, пока этот канал поднят.

::: info
Status changes are automation trigger: перемещение session в review state может kick off summary prompt или run webhook. См. [Automations](../automations/overview).
:::
