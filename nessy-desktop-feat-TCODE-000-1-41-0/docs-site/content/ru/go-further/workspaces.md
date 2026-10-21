# Workspaces

Workspace — изолированный набор управляемых Nessy настроек: sources, skills,
statuses, labels, automations, defaults и история диалогов. При переключении
Workspace весь этот контекст меняется сразу.

Workspace — не каталог проекта. **Workspace** — состояние Nessy с неизменяемым
`workspaceId`, а **Project** — необязательная внешняя папка или репозиторий,
используемые как рабочий каталог сессии. Одна Workspace может работать с
несколькими Project, а один Project — использоваться в нескольких Workspace без
копирования в хранилище Nessy.

## What a Workspace Owns

| Component | Description |
| --------- | ----------- |
| Sources | MCP servers, APIs и local folders connected here |
| Skills | Reusable instructions invoked with `@mention` |
| Statuses | Workflow states used to organize sessions |
| Labels | Session tags |
| Automations | Scheduled and event-driven runs |
| Sessions | Chat history scoped to this workspace |

Workspace только ссылается на credentials: они находятся в зашифрованном
хранилище, а не в конфигурации Workspace. Файлы Project остаются внешними.

## Where Workspaces Live

`CONFIG_DIR` равен `NESSY_CONFIG_DIR`, если переменная задана, иначе —
`~/.nessy-agent`. Каждая Workspace хранится под неизменяемым идентификатором:

```
CONFIG_DIR/workspaces/{workspace-id}/
```

Typical layout:

```
CONFIG_DIR/
  config.json
  credentials.enc
  capabilities.json
  project-trust.json
  capability-trust.json
  mcp.json
  hooks.json
  skills/
  agents/
  plugins/
  logs/
  recent-projects.json
  sessions/
    {workspace-id}/
      {session-id}/
        session.jsonl
        attachments/
        plans/
        data/
        downloads/
        long_responses/
  workspaces/
    {workspace-id}/
      config.json           # Workspace configuration
      capabilities.json     # Workspace activation policy
      sources/
        {source-slug}/
          config.json
          guide.md
      skills/
        {skill-slug}/
          SKILL.md
      agents/
      hooks.json
      automations.json
      permissions.json
      labels/
        config.json
      statuses/
        config.json
      views.json
```

Ресурсы Workspace и сессии создаёт и обслуживает приложение; вручную их обычно
не редактируют. Сессии разделены глобально по `workspaceId`, а не вложены в
каталог ресурсов Workspace.

## config.json

Workspace config file stores identity and per-workspace defaults:

```json
{
  "id": "ws_1a2b3c4d",
  "name": "Client A",
  "defaults": {
    "defaultLlmConnection": "nessy-gateway",
    "colorTheme": "nord",
    "permissionMode": "plan"
  }
}
```

Блок `defaults` может задавать LLM connection, model, color theme, permission
mode и cyclable modes, внешний Project, thinking level и sources для новых
сессий Workspace. UI выбирает Project через непрозрачный backend handle;
backend канонизирует и заново проверяет Project перед изменением default или
сессии.

`CONFIG_DIR/recent-projects.json` — управляемая backend история внешних Project.
Она хранит пути за непрозрачными идентификаторами и может содержать подсказку
стабильной идентичности, но каждый выбор проверяется заново. Недавний Project не
является разрешением или решением о доверии.

## Custom Agent Definitions

Папки `agents/` хранят пользовательские агенты оркестрации — подагентов, которых
Nessy может запускать для распараллеливания работы. Каждый агент — это markdown-файл
с YAML-frontmatter и телом system prompt:

```markdown
---
description: Audit one narrow concern.
toolset: read-only
tier: small
maxTurns: 4
permissionMode: plan
---
Audit only the requested concern and report findings first, with file references.
```

Встроенные агенты: `scout`, `planner`, `worker` и `reviewer`; запись с тем же
именем заменяет встроенного агента.

| Поле | Значение |
| ----- | ------- |
| `description` | Короткое описание, показываемое при предложении агента. |
| `toolset` | `read-only` или `full`; задаёт набор инструментов по умолчанию. |
| `tier` | `small`, `medium` или `big`; выбирает модель для этого tier. |
| `model` | Явное переопределение модели для агента. |
| `effort` | `off`, `low`, `medium`, `high`, `xhigh` или `max`; сужает reasoning effort агента. |
| `tools` | Шаблоны инструментов, доступных агенту; без значения агент наследует набор по умолчанию из `toolset`. |
| `disallowedTools` | Шаблоны инструментов, исключаемые из набора агента. |
| `maxTurns` | Необязательное положительное целое: ограничивает число обращений к модели за один запуск агента. На пределе агент останавливается, его результат возвращается с пометкой «частичный», и его можно возобновить, чтобы продолжить (каждое возобновление идёт под тем же пределом). Без значения — без ограничения. У Codex соответствия нет: в сессии Codex агент работает с ограничениями самой сессии, и сессия сообщает об этом уведомлением. |
| `permissionMode` | Необязательный стартовый [permission mode](../core-concepts/permissions) агента. |

### Tool Patterns

`tools` и `disallowedTools` принимают YAML-список или одну строку, элементы
которой разделены пробелами или запятыми. Запятая **внутри** скобок
принадлежит своему элементу, поэтому `Agent(reviewer, planner)` — это один
элемент, а не два: в `tools` так сохраняется grant, который написал автор, а в
`disallowedTools` — запрет продолжает делать то, что в нём написано.

Оба поля принимают и server-level MCP pattern: `mcp__<server>` или
`mcp__<server>__*` выдаёт или убирает все инструменты этого сервера. Имя
сервера должно совпадать целиком, поэтому rule с `mcp__git` никогда не достаёт
до `mcp__github__create_issue`.

Указанный `Agent` позволяет агенту запускать собственных подагентов, пока это
разрешает лимит глубины; список типов внутри скобок игнорируется, поэтому
`Agent(reviewer)` и `Agent` означают одно и то же. Любой *другой* инструмент,
записанный со скобочным specifier, не называет инструмент, который можно
разрешить, поэтому он не попадает в набор агента и отмечается в session log, а
не обрывает turn.

`maxTurns` и `permissionMode` могут только ужесточать, но не ослаблять. `permissionMode`
дочернего агента ограничивается так, чтобы он никогда не был шире сессии, которая его
запустила (`dontAsk < plan < default < acceptEdits < auto < bypassPermissions`;
упразднённый `explore` и прежние написания вроде `safe`, `ask` и `allow-all`
по-прежнему разрешаются в эти режимы). `maxTurns`
ограничивается любым унаследованным пределом. Отсутствующие поля наследуют parent/default.
Явно заданные недопустимые ceilings, model, tier, effort либо пустые/некорректные
списки tools отклоняют definition до рекламы или запуска.

## Adding and Switching

Первая workspace создаётся during onboarding. Чтобы добавить ещё одну:

1. Open workspace dropdown in sidebar.
2. Choose **Add Workspace…**.
3. Задайте имя. Backend создаст Workspace только по имени, присвоит ей
   неизменяемый `workspaceId` и применит defaults.

To switch, click any entry in same dropdown. Active workspace name shows in sidebar, and selecting another one pulls in its sources, skills, statuses and sessions.

## Connection Resolution

Когда session needs LLM connection, Nessy Desktop resolves it in order:

1. Session's own connection, if set.
2. Workspace default (`defaults.defaultLlmConnection`).
3. Global default.
4. First connection in list.

## Multiple Windows

Можно держать несколько windows open — обычно one per workspace — чтобы разные contexts были side by side. Title bar adapts:

| Open windows | Title on each window |
| ------------ | -------------------- |
| 1 | `Nessy Desktop` (app name) |
| 2 or more | Workspace name that window is viewing |

Titles update as windows open, close or reassign, making it easy to pick right one from app switcher.

## Remote Workspaces

Можно подключаться к workspaces on [headless server](../server/headless); они появляются в switcher рядом с local ones.

To connect:

1. Open workspace dropdown and choose **Add Workspace… → Connect to Remote Server**.
2. Enter server URL (например `wss://192.168.1.100:9100`) and server token.
3. Test connection.
4. Select existing remote workspace or create new one.

Один server может содержать несколько Workspace; можно подключить несколько
server. Сохранённая remote binding содержит только URL и remote Workspace ID.
Токен хранится отдельно в `CONFIG_DIR/credentials.enc`, не возвращается в данных
Workspace и не подставляется при повторном подключении. Remote Workspace
показывает состояние подключения в switcher и проверяется при его открытии.
Удаление remote Workspace убирает только локальную ссылку и ничего не удаляет
на server.

### Sending a Session to Another Workspace

**Отправить в рабочее пространство** (в меню сессии) копирует сессию — вместе с кратким резюме для контекста — в другое рабочее пространство, локальное или удалённое. Результат — самостоятельная копия: дальнейшие правки в любом из мест не синхронизируются. Удалённое пространство должно быть в сети; локальное доступно всегда.

## CLI and Workspaces

[Command-line client](../reference/cli) targets workspace with global flag:

- `--workspace <id>` selects existing workspace on server.

## Use Cases

- **Personal vs work.** Separate sources, skills and history without cross-contamination.
- **Client projects.** One workspace per client, each with its own sources and skills.
- **Environments.** Separate dev, staging and production workspaces with right endpoints and permissions.
- **Повторное использование контекста.** Одна Workspace может обслуживать
  несколько внешних Project, сохраняя управляемые Nessy ресурсы вместе.

::: tip
Start with one workspace and add more only when sources, permissions or review practices genuinely diverge. Name each one clearly. Per-workspace rules for what Plan mode runs without asking live in `permissions.json` — see [permissions](../core-concepts/permissions).
:::
