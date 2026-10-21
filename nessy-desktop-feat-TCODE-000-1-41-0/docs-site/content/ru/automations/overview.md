# Автоматизации

Automations реагируют на events внутри Nessy Desktop и выполняют работу за вас — запускают new session, отправляют HTTP webhook или пишут activity to disk. Итоговая конфигурация хранится в JSON file per workspace, но обычное создание и обновление идут через guided UI или agent tools.

::: tip
**Попросите агента вместо ручного редактирования.** Скажите что-то вроде "create an automation that starts a session when I flag one" или "run a morning briefing every weekday at 9". Агент использует `automation_create` или `automation_update`, затем запускает `automation_validate`.
:::

## Getting Started

Самый быстрый путь — описать outcome обычным языком. Несколько prompts:

| Goal | Ask |
| ---- | --- |
| Scheduled briefing | "Run a standup briefing every weekday morning at 9" |
| Webhook on flag | "When I flag a session, POST to my Slack incoming-webhook URL" |
| Audit trail | "Record every permission-mode change to a log" |
| Status-driven work | "When a session moves to done, summarise what changed" |
| Weekly report | "Every Friday at 5pm, open a session that recaps the week" |

Add Automation учитывает тип. Если открыть его из **Scheduled**, **Event** или **Agentic**, prompt сразу получает подходящий контекст:

- **Scheduled** automations используют `SchedulerTick` и `cron`.
- **Event** automations используют app events вроде `LabelAdd`, `LabelRemove`, `SessionStatusChange` или `PermissionModeChange`.
- **Agentic** automations используют agent lifecycle events вроде `UserPromptSubmit`, `PreToolUse`, `PostToolUse` или `PermissionRequest`.

Agents manage automations через `automation_list`, `automation_create`, `automation_update` и `automation_validate`. Они не должны редактировать `automations.json` directly.

Автоматизация, которую агент создаёт или правит, ограничена режимом **Accept edits** или более узким: более широкий отклоняется с объяснением, а любой режим вы по-прежнему можете задать сами на странице Automations. Изменение того, что делает автоматизация без присмотра в режиме Auto или Bypass permissions, — её действий, повторное включение, перенос триггера или расписания — спрашивает вас карточкой, которая называет автоматизацию и её режим, и сохранённый ответ её не пропускает: в Pi и Claude Code у карточки нет Always Allow. Сессия в режиме Don't ask («Не спрашивать») такое изменение отклоняет, а сессия, которая сама работает в Bypass permissions, не спрашивает. На Codex такое изменение никогда не одобряется за вас, когда никто не смотрит. При включённом авто-ревью Codex сессия в режиме Auto, где отвечает проверяющий, отклоняет его ещё до того, как спросят проверяющего, а Manual и Accept edits показывают вам карточку, как описано выше; если политика Codex вашей организации разрешает только проверяющего, его отклоняет любой режим, кроме Bypass permissions. Если Codex не может выполнить эту проверку, ход сообщает об этом, и решает проверяющий.

### Your First Automation

Минимальная полезная automation отправляет webhook каждый раз, когда label added. Event data попадает в `NESSY_EVENT_DATA`, а named fields становятся отдельными variables:

```json
{
  "version": 2,
  "automations": {
    "LabelAdd": [
      {
        "actions": [
          {
            "type": "webhook",
            "url": "${NESSY_WH_SLACK_URL}",
            "body": { "text": "Label added: $NESSY_LABEL" }
          }
        ]
      }
    ]
  }
}
```

Это пример итоговой file shape. Для создания используйте Add Automation или попросите агента, чтобы config был validated before write.

### Scheduling a Prompt

Чтобы агент делал что-то по timer, attach cron expression к matcher `SchedulerTick` и используйте prompt action:

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "cron": "0 9 * * 1-5",
        "timezone": "Europe/Budapest",
        "labels": ["Scheduled"],
        "actions": [
          { "type": "prompt", "prompt": "Check @github for issues assigned to me and summarise them" }
        ]
      }
    ]
  }
}
```

New session создаётся каждый weekday at 9, source `@github` активируется, а session получает label `Scheduled`, чтобы её можно было filter later.

## How Automations Work

Когда event fires — label change, tool run или scheduler tick — Nessy Desktop смотрит matchers configured for that event, проверяет filter and conditions каждого matcher и запускает actions that pass.

Для `automations.json` actions бывают четырёх kinds:

- **Prompt actions** — start a new session with a prompt (App events only).
- **Webhook actions** — send HTTP request to external endpoint.
- **Script actions** — run an approved workspace script.
- **Event log actions** — record event for later inspection.

::: info
`command` и `decision` actions доступны только из lifecycle hook config (`hooks.json` или поле `hooks` в workspace `config.json`). Обычные app-event automations по-прежнему используют prompts, webhooks и event logging. [Plugins](../plugins/overview) могут добавлять другие hook handler kinds — HTTP, MCP tool, prompt и agent hooks — см. [Plugin And Project Hooks](#plugin-and-project-hooks).
:::

## Configuration File

Automations live per workspace in `automations.json`:

```
~/.nessy-agent/workspaces/<workspace-id>/automations.json
```

### Basic Structure

```json
{
  "version": 2,
  "automations": {
    "EventName": [
      {
        "matcher": "regex-pattern",
        "actions": [
          { "type": "prompt", "prompt": "Do the thing" }
        ]
      }
    ]
  }
}
```

Each event name maps to array of matcher entries. Каждый matcher carries array actions, которые run when matcher matches event value.

### Lifecycle Hook Config

Agent lifecycle hooks могут жить в workspace `hooks.json` или top-level `hooks` object в workspace `config.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "actions": [
          {
            "type": "command",
            "command": "node .nessy-agent/hooks/check-bash.js"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "actions": [
          {
            "type": "webhook",
            "url": "${NESSY_WH_SLACK_URL}",
            "body": { "text": "Prompt submitted: $NESSY_PROMPT" }
          }
        ]
      }
    ]
  }
}
```

Hooks-файл может использовать и формат settings Claude Code, где каждая запись matcher перечисляет свои handlers в `hooks`, а не в `actions`. `matcher` такой записи работает по правилам Claude (простой список имён сравнивается точно, `*` совпадает со всем, остальное — регулярное выражение), а фильтр `if` у handler-а применяется к этому handler-у. Command handler в таком формате также следует правилу кодов выхода Claude: exit 2 блокирует, а любой другой non-zero exit — неблокирующая ошибка, которая показывает уведомление об ошибке hook-а и не останавливает действие (на `WorktreeCreate` любой non-zero exit по-прежнему прерывает создание), если handler сам не задаёт `blockOnNonZero`. Список `args` у handler-а читается: команда тогда запускается напрямую с этими аргументами, без shell. Поля handler-а `timeout`, `statusMessage` и `onFailure` читаются (`timeout` задаётся в секундах и превращается в `timeoutMs` с потолком в 120 секунд command-хука; явно заданный `timeoutMs` выигрывает; `onFailure` описан ниже, в разделе о plugin hooks); `once` игнорируется — по правилам Claude она чтится только для hook-ов, объявленных в skill frontmatter. Из типов handler-ов Claude из hooks-файла запускается только `command`: handler `http`, `mcp_tool`, `prompt` или `agent` загружается с предупреждением и никогда не запускается. Запись, в которой есть и `hooks`, и `actions`, отклоняется.

Hook config принимает любой [agent lifecycle event](#agent-events) — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` и остальные из таблицы ниже. Webhooks доставляются тем же automation path, что и `automations.json`. Command hooks получают sanitized `NESSY_*` environment variables, работают в workspace/working directory, по умолчанию имеют timeout 30 секунд, а их output capped и redacted до того, как может быть surfaced.

Для `PreToolUse` non-zero exit команды блокирует tool, если `blockOnNonZero` не выставлен в `false` (handler в формате settings Claude получает `false`, см. выше). Команда также может напечатать JSON decision в stdout:

```json
{ "decision": "allow", "updatedInput": { "command": "npm ci --offline" } }
```

Допустимые decision values: `allow`, `ask`, `block` и `deny`.

`PreToolUse` guard видит только те tools, которые называет его matcher, поэтому guard `^Bash$` не останавливает ту же команду, отправленную через собственные script tools сессии: `script_sandbox` и `transform_data` запускают Python-, Node- или Bun-скрипт в изолированном subprocess, и модель, которой Bash guard отказал, может выполнить команду там. Чтобы охранять и их, добавьте их имена в matcher. Hook видит их как `mcp__session__script_sandbox` и `mcp__session__transform_data` в Claude runtime и как `script_sandbox` и `transform_data` в сессиях Pi, поэтому `"matcher": "^(Bash|(mcp__session__)?(script_sandbox|transform_data))$"` покрывает оба написания и обе формы hooks-файла.

**Прежде чем command hook запустится, его собственная команда проходит проверку разрешений Nessy.** Hook из вашего глобального `hooks.json` или из `.nessy-agent/hooks.json` доверенного проекта выполняется без карточки; hook workspace, plugin, skill или agent, которому нужно одобрение, получает карточку. В Plan и Don't ask проверка оценивает hook так же, как в Manual, потому что эти режимы ограничивают собственные tools агента, а не ваши hooks: ваш `UserPromptSubmit` или `PreToolUse` hook продолжает там работать, а не отклоняется read-only allowlist-ом. Don't ask никогда не показывает карточку, поэтому hook, которому она понадобилась бы, там отклоняется с причиной; отклонённый native hook блокирует только вызов tool в `PreToolUse` или worktree в `WorktreeCreate` (см. ниже), а hook plugin-а сообщает об ошибке hook-а и ничего не блокирует. Чтобы workspace hook запускался в Don't ask, перенесите его в ваш глобальный `hooks.json` (`~/.nessy-agent/hooks.json`), который агент записать не может. Deny rule или denied path отклоняет hook в любом режиме. Отклонённый hook никогда не запускается. В `PreToolUse` он по-прежнему блокирует вызов tool, а в `WorktreeCreate` worktree не создаётся. На любом другом событии действие идёт так, будто hook-а нет: отклонённый `UserPromptSubmit` или `UserPromptExpansion` hook не останавливает ваш prompt (на prompt всё равно отвечают), отклонённый `Stop` или `SubagentStop` hook не заставляет агента продолжать работу, отклонённый `PreCompact` hook не отменяет compaction, отклонённый `PermissionRequest` hook не отклоняет запрос (показывается обычная карточка разрешения), отклонённый `ConfigChange` hook не отменяет изменение, отклонённый `PostToolBatch` hook не останавливает цикл, отклонённый `PostToolUse` или `PostToolUseFailure` hook ничего не передаёт агенту, отклонённый `TaskCreated` или `TaskCompleted` hook не отменяет задачу и не оставляет её открытой, отклонённый `PreModelSwitch` hook не задерживает смену модели, а отклонённый elicitation hook не отклоняет запрос. Уведомление «Command hook not run» показывает команду hook-а и причину отказа, называя правило, если отказало правило.

Чтобы временно выключить все hooks, не удаляя config, поставьте root-level key `"disableAllHooks": true` в `hooks.json` или в workspace `config.json`. Удаление ключа (или `false`) включает hooks обратно. Managed policy тоже может отключать hooks на весь fleet; этот switch важнее локального.

### Plugin And Project Hooks

User/global native hooks живут в `~/.nessy-agent/hooks.json`. Workspace hooks — в workspace `hooks.json` или поле `hooks` workspace `config.json`. Project hooks живут under `.nessy-agent`, а [plugin hooks](../plugins/overview) projected из installed plugin bundles after trust checks.

During an agent turn Nessy runs internal permission and pre-tool checks first, then native user/global and workspace hooks, then project `.nessy-agent` hooks, then trusted plugin hooks. Изменения user/global, workspace, project или plugin hook config invalidate active runtime sessions, чтобы следующий queued turn использовал fresh hook state.

Всего работает пять hook handler kinds: `command` hooks (shell или executable),
HTTP hooks, MCP tool hooks, prompt hooks (одноразовый context через bounded
model call) и agent hooks (spawn объявленного subagent). Native config files
несут `command`, `webhook` и `decision` actions; остальные kinds приходят из
imported plugin bundles. Поддержка per event: основные tool-, prompt-, task- и
permission-events принимают все пять kinds; `SessionStart` — только
`command` и MCP tool hooks; все остальные events — `command`, HTTP и MCP tool
hooks.

Imported plugin command hooks могут также нести поля Claude hook format:
per-hook `timeout` budget, spinner label `statusMessage`, `async` для
background hooks, которые никогда не блокируют, и exec-form argument vector в
обход shell. Plugin HTTP, MCP-tool и agent hooks тоже соблюдают объявленный
`timeout`, а без него — значения по умолчанию из Claude hook format: 600 секунд
для HTTP и MCP-tool hooks (30 на `UserPromptSubmit`, `PreModelSwitch` и
`PostModelSwitch`, 10 на `MessageDisplay`) и 60 для agent hooks. Верхний
предел — 600 секунд.

Trusted plugin agent hooks используют существующего child-session owner,
MCP tool hooks вызывают tools только через pinned MCP lease session, а HTTP
hooks идут через обычный permission-checked webhook executor. Plugin HTTP hooks
credentialless: auth fields, sensitive headers/query/body values и URL userinfo
fail-close до policy и network access.

HTTP hook (в том числе native-действие `webhook`), который Nessy отказался
запустить, не выполняется, но и не молчит: project не доверен, URL вне managed-списка
`allowedHttpHookUrls`, или permission mode сессии потребовал бы спросить перед
отправкой (hook спросить не может). В transcript появляется одно предупреждение
hook error на hook и причину, tool call или событие продолжаются, а каждый
отклонённый запуск всё равно записывается.

MCP tool hook, который Nessy отказался запустить, сообщает об этом так же:
project не доверен, или permission mode сессии потребовал бы спросить перед
вызовом tool.

Ответ HTTP hook-а читается так же, как его читает Claude Code. Пустой ответ 2xx —
это чистый запуск, а JSON-объект может заблокировать, разрешить или добавить
context так же, как JSON output command hook-а. Любое другое тело ответа 2xx —
неблокирующая ошибка, как и статус не из 2xx: обычный текст вроде `ok` от
сервиса уведомлений, JSON-массив или строка в кавычках. В transcript появляется
предупреждение hook error для этого запуска, tool call или событие продолжаются,
а текст никогда не попадает в context агента. MCP tool hooks сохраняют правило
command hook-ов: их обычный текст добавляется в context на `UserPromptSubmit`,
`UserPromptExpansion`, `SessionStart` и `PostModelSwitch`.

Native-действие `webhook` на agent event — это уведомление, поэтому его ответ
2xx считается доставкой: обычный текст вроде `ok` от Slack incoming webhook —
чистый запуск без предупреждения, и текст по-прежнему не попадает в context
агента. JSON-объект в ответе читается так, как описано выше, если это валидный
hook output, поэтому он по-прежнему может заблокировать, разрешить или добавить
context. Любой другой объект — тоже чистая доставка, без предупреждения и без
применения чего-либо из него: объект, который отклоняет проверка схемы ниже,
например собственный `{"continue":"yes"}` сервиса, или тело, которое
начинается с `{` и не является одним JSON-объектом, например JSON с
разделителями-переводами строк. Такой ответ никогда не блокирует tool call;
если сломанный ответ endpoint-а должен блокировать, используйте HTTP hook с
`"onFailure": "block"`. Статус не из 2xx по-прежнему даёт предупреждение hook
error.

Native-действие `webhook` на agent event раскрывает шаблоны перед отправкой,
так же как на App event. В `url`, значениях заголовков и теле `$NESSY_*` читает
hook input: `NESSY_EVENT`, `NESSY_EVENT_DATA` (весь input в JSON) и по одной
переменной на каждое поле input, например `NESSY_TOOL_NAME`, `NESSY_TOOL_INPUT`
или `NESSY_PROMPT` (те же имена, что читает command hook). `$NESSY_WH_*` читает
ваши экспортированные секреты. Незаданное имя раскрывается в пустую строку.
Текст, вставленный переменной, повторно не раскрывается, а каждое строковое
значение JSON-тела раскрывается отдельно, поэтому prompt с кавычками не ломает
тело. Проверки выше читают уже раскрытый запрос: секрет, который раскрывается в
query `token=` или в URL с именем пользователя, отклоняется так же, как
записанный в конфиге. Webhook на `SessionStart` не запускается никогда, потому
что Claude Code не запускает там HTTP hooks, и валидация об этом предупреждает.

Context hook-а `PostModelSwitch` (обычный текст command или MCP tool hook-а при
exit 0 или `additionalContext` из его JSON) добавляется к вашему следующему
prompt после смены модели, на любом runtime и один раз. Если модель снова
меняется до этого prompt, отправляется context только последней смены; hook,
который ещё выполняется, когда вы отправляете prompt, добавит свой context к
следующему prompt.

Matcher у `PreModelSwitch` и `PostModelSwitch` сравнивается с каноническим
именем модели, на которую переключается сессия, как в Claude Code. Суффикс
`[1m]`, дата (`claude-sonnet-4-5-20250929`), id Bedrock или Vertex и префикс
провайдера вроде `anthropic/` сводятся к одному имени, поэтому `claude-opus-5`
или `.*opus.*` совпадает с любым написанием Opus 5. Если у целевой модели нет
канонического имени Claude, запускается каждый hook смены модели, что бы ни
говорил его matcher. Это модель Nessy Gateway или другая модель не от Claude,
alias вроде `opus` и возврат к модели по умолчанию. Поэтому hook, который
блокирует смену, должен проверять `to_model` из своего input.

JSON output проверяется по схеме вывода hook-ов Claude Code, если он пришёл от
command hook-а в формате Claude (из Claude plugin-а или от handler-а hooks-файла
в формате settings Claude), завершившегося с exit 0, от HTTP hook-а или от MCP
tool hook-а. Вывод не проходит схему, если в поле значение не того типа
(включая `null`), если top-level `decision` — не `approve` и не `block`
(`allow`, `deny`, `ask` и `defer` пишутся в `hookSpecificOutput.permissionDecision`),
или если у `hookSpecificOutput` нет `hookEventName`, он называет событие, у
которого нет `hookSpecificOutput`, или называет не то событие, которое
сработало; неизвестные схеме поля игнорируются. На `McpElicitation` это имя
Claude Code — `Elicitation`, и command hook в формате Claude тоже получает
`Elicitation` в `hook_event_name` своего input-а. Command hooks в собственном
формате `actions` этой страницы получают `McpElicitation`. Применяются только
поля самой схемы, как в Claude Code:
top-level `additionalContext`, `updatedInput` или `updatedToolOutput` ничего не
делают, как и поле из `hookSpecificOutput` другого события, а top-level
`"continue": true` ничего не разрешает. Такой
вывод — неблокирующая ошибка: в transcript появляется предупреждение hook error с
описанием проблемы, действие продолжается, и ничего из этого вывода не
применяется и не попадает в context агента, даже на событиях, где обычный текст
становится context-ом. Command hook в формате Claude, напечатавший JSON-объект,
который не разбирается, обрабатывается так же. Command hooks в собственном
формате `actions` этой страницы и command hooks plugin-ов Codex сохраняют
описанный выше формат решения и не проверяются по схеме. Но их вывод, который
начинается с `{` и не разбирается как один JSON-объект, — та же неблокирующая
ошибка: появляется предупреждение, а текст не попадает в context агента. Из
вывода фонового (`async`) hook-а читаются поля, которые можно использовать (у
hook-а в формате Claude `additionalContext` берётся только из
`hookSpecificOutput` его собственного события).

Command или HTTP hook с `"onFailure": "block"` при сбое закрывает путь: если он
не может запуститься (Nessy его отклонил или скрипта нет), завершается с кодом
кроме 0 и 2, превышает timeout, получает статус не из 2xx или не может
соединиться, или отвечает JSON, который не читается или не проходит описанную
выше проверку схемы, действие блокируется так,
будто hook завершился с exit 2. Tool call на `PreToolUse` блокируется, prompt на
`UserPromptSubmit` блокируется, а `PermissionRequest` отклоняется; причина
блокировки начинается с `failed; blocking because onFailure is "block"` (или
`timed out`), а собственное предупреждение hook error о сбое по-прежнему
показывается. На hooks `Stop`, `SubagentStop` и `TaskCompleted`, на `async`
hooks и на ход, который вы остановили, поле не действует. Без него или со
значением `"continue"` упавший hook пропускает действие, как описано выше. Поле
читают plugin hooks, command handlers hooks-файла и hooks из frontmatter skill
или agent; в собственном формате hooks Codex такого поля нет.

Plugin monitor попадает в существующий `SchedulerTick` path только с explicit
five-field cron, опциональным valid IANA timezone и installation trust.
До агента он доходит только пока идёт ход: tick, сработавший, когда session
простаивает, пропускается, а не ставится в очередь, и `/tasks` перечисляет
каждый такой monitor с этой пометкой. Imported monitor без schedule остаётся
видимым, но inert. Disable или uninstall
plugin останавливает scheduled work до release runtime lease.

## Managing Automations

### In the UI

Откройте **Automations** в sidebar, чтобы увидеть всё configured for workspace. Там можно:

- **Enable / Disable** — toggle matcher without deleting it.
- **Duplicate** — copy existing automation.
- **Delete** — remove it.
- **Test** — trigger by hand before real event.
- **History** — каждая automation records its runs. History written to `automations-history.jsonl`, capped at last 20 runs per automation and 1000 entries total.

### In a chat

Собственная строка фоновых задач чата теперь перечисляет запланированную работу
и наблюдения этой сессии — рядом с задачами, которые в ней уже идут.
Запланированная automation показывается чипом с её частотой — **Один раз** или
**Повторяется**, — а наблюдение под тем же именем, которое уже использует payload
hook'а. Работа, у которой есть своя строка, второй раз не рисуется.

Три ответа намеренно не сливаются в один. **Ничего не запланировано** значит, что
сессию спросили и у неё ничего нет в очереди. *Не удалось прочитать фоновую
работу этой сессии* значит, что хост не смог ответить. Отсутствие строки значит,
что ещё не спрашивали. Строка «ничего не запланировано» появляется только рядом с
работой, которая уже на экране, где она отвечает на вопрос, поднятый чипами;
чтобы спросить про сессию, в которой больше ничего нет, наберите
[`/tasks`](/ru/core-concepts/interactions#slash-commands) — команда печатает ту
же опись в транскрипт и оставляет её там.

### In the Config File

Используйте этот раздел как reference для того, что пишут automation tools. Direct edits to `automations.json` blocked в agent sessions; попросите агента использовать `automation_update` и `automation_validate`.

**Disable matcher** через `"enabled": false`. Drop field или flip to `true`, чтобы включить обратно.

```json
{
  "matcher": "^urgent$",
  "enabled": false,
  "actions": [
    { "type": "webhook", "url": "${NESSY_WH_SLACK_URL}" }
  ]
}
```

**Delete** by removing matcher entry. If event ends up with no matchers, drop whole event key.

::: tip
Ask the agent to manage them: "disable all my scheduled automations" или "remove the urgent webhook". Он вызывает `automation_list`, затем `automation_update` или `automation_create`, и завершает через `automation_validate`.
:::

## Events

### App Events

Raised by Nessy Desktop itself. Поддерживают prompt and webhook actions.

| Event | Fires when | Match value |
| ----- | ---------- | ----------- |
| `LabelAdd` | Label added to session | Label ID (e.g. `urgent`) |
| `LabelRemove` | Label removed | Label ID |
| `LabelConfigChange` | Label configuration changes | Always matches |
| `PermissionModeChange` | Permission mode changes | New mode name |
| `FlagChange` | Session flagged/unflagged | `true` or `false` |
| `SessionStatusChange` | Session status changes | New status (e.g. `done`) |
| `SchedulerTick` | Every minute (use cron) | Matched via cron |

::: info
**Renamed.** `TodoStateChange` теперь `SessionStatusChange`. Old name still accepted as deprecated alias — config loader rewrites it to `SessionStatusChange` and logs warning — but configs should be updated.
:::

::: tip
To act on specific transition (e.g. session reaching `done`), match `SessionStatusChange` and use matcher like `"^done$"`, since match value is new status.
:::

### Agent Events

Доставляются agent backend как hooks during session lifecycle. Применяются webhook, event-log, command и decision actions (command и decision — только из [hook config](#lifecycle-hook-config)).

**Session lifecycle:**

| Event | Fires when |
| ----- | ---------- |
| `InstructionsLoaded` | Instruction file (project memory, rules) загружен в context — по разу на file |
| `SessionStart` | Session стартует, и снова после каждой завершённой compaction |
| `SessionEnd` | Session torn down; matcher — по exit reason |
| `CwdChanged` | Effective working directory меняется |
| `ConfigChange` | Runtime configuration change committed |

**Prompts и turns:**

| Event | Fires when |
| ----- | ---------- |
| `UserPromptSubmit` | Prompt submitted, до любой expansion |
| `UserPromptExpansion` | После expansion prompt, до старта агента |
| `Stop` | Текущий turn завершается |
| `StopFailure` | Turn заканчивается terminal failure, прямо перед `Stop` |
| `PreCompact` | Перед context compaction; matcher — `manual` или `auto` |
| `PostCompact` | После context compaction |
| `Notification` | Агент поднимает notification; matcher — по notification type |

**Tools и permissions:**

| Event | Fires when |
| ----- | ---------- |
| `PreToolUse` | Перед запуском tool; hook может block или rewrite вызов |
| `PermissionRequest` | Требуется interactive approval |
| `PermissionDenied` | Permission decision denied |
| `PostToolUse` | После успешного tool |
| `PostToolUseFailure` | После failed tool |
| `PostToolBatch` | Когда собраны все tool results turn-а |
| `FileChanged` | File mutation завершилась |

**Subagents, tasks и worktrees:**

| Event | Fires when |
| ----- | ---------- |
| `SubagentStart` | Subagent spawns |
| `SubagentStop` | Subagent finishes |
| `TaskCreated` | До сохранения task-list entry; blocking hook откатывает его |
| `TaskCompleted` | До пометки task как completed |
| `WorktreeCreate` | До создания session worktree; hook может заменить path |
| `WorktreeRemove` | Session worktree удаляется |

**MCP interactions:**

| Event | Fires when |
| ----- | ---------- |
| `McpElicitation` | MCP server запрашивает user input, до открытия dialog |
| `ElicitationResult` | Пользователь ответил на MCP elicitation, до отправки ответа server-у |
| `McpResult` | External MCP interaction завершилась |

## Action Types

### Prompt Actions

Start new session with prompt. App events only.

```json
{
  "type": "prompt",
  "prompt": "Run the @weather skill and summarise today's forecast",
  "ephemeral": true
}
```

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `type` | `"prompt"` | Required | Action type |
| `prompt` | string | Required | Prompt text (must be non-empty) |
| `llmConnection` | string | Workspace default | LLM connection slug from AI Settings |
| `model` | string | Workspace default | Model ID for created session |
| `thinkingLevel` | `"off"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` | Workspace default | Thinking level for created session |
| `ephemeral` | boolean | `false` | Run created session in memory only |

**Features:**

- Reference sources and skills with `@mentions` (e.g. `@github`) — mentioned sources activated for new session.
- Environment variables expand in prompt text (e.g. `$NESSY_LABEL`, `${NESSY_SESSION_NAME}`).

**Per-action overrides.** `llmConnection`, `model` and `thinkingLevel` stand on their own — omit any and workspace default is used. If connection/model does not exist, it quietly reverts to default instead of erroring.

Ставьте `ephemeral: true` для notification-style или high-frequency prompt
actions, transcript которых не нужно reviewing later. Такая session создаётся
только в memory: она не пишет session record или metadata на disk, не
возвращается после restart и исчезает после close. Если результат automation
должен остаться в workspace history, оставьте поле unset.

```json
{
  "type": "prompt",
  "prompt": "Quick review of recent changes",
  "llmConnection": "openrouter",
  "model": "anthropic/claude-sonnet-4.6",
  "thinkingLevel": "high",
  "ephemeral": true
}
```

Legacy `thinkingLevel` value `"think"` from old configs migrates to `"medium"` automatically.

### Webhook Actions

Send HTTP request when event fires.

```json
{
  "type": "webhook",
  "url": "${NESSY_WH_SLACK_URL}",
  "method": "POST",
  "bodyFormat": "json",
  "body": { "text": "Session $NESSY_SESSION_NAME changed" },
  "captureResponse": false
}
```

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `type` | `"webhook"` | Required | Action type |
| `url` | string | Required | `http`/`https` URL, or `$VAR` template |
| `method` | `GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE` | `POST` | HTTP method |
| `headers` | object | — | Header name → value pairs |
| `bodyFormat` | `json` \| `form` \| `raw` | — | How body is encoded |
| `body` | any | — | Request body |
| `captureResponse` | boolean | `false` | Store response body in history (truncated) |
| `auth` | object | — | `{ "type": "basic", ... }` or `{ "type": "bearer", ... }` |

**Secrets.** Webhook actions run with restricted environment: only variables named `NESSY_WH_*` read from shell, and `process.env` not otherwise exposed. Export secrets, then reference them from config:

```bash
export NESSY_WH_SLACK_URL="https://hooks.slack.com/services/T.../B.../xxx"
```

```json
{ "url": "${NESSY_WH_SLACK_URL}", "headers": { "Authorization": "Bearer ${NESSY_WH_TOKEN}" } }
```

### Script Actions

Действие `script` запускает скрипт из рабочего пространства на вашем компьютере при событии приложения — без сессии агента и без токенов.

```json
{
  "type": "script",
  "script": "scripts/daily-report.ts",
  "args": ["--yesterday"],
  "runtime": "bun",
  "timeoutMs": 120000
}
```

- `script` задаётся относительно корня рабочего пространства и не может выходить за его пределы; `runtime` — `bun` (по умолчанию), `node` или `python3`; `timeoutMs` по умолчанию 60 с (от 1 с до 15 мин).
- Скрипт выполняется только после вашего одобрения: на странице автоматизации показывается «Не одобрено — не запустится» с кнопкой **Approve**. Одобрение охватывает точные байты скрипта вместе с путём, аргументами и рантаймом, и любое изменение спрашивает заново. Отказанный запуск записывается в историю с причиной; **Run test** следует тому же правилу.
- Скрипт выполняется без оболочки, из корня рабочего пространства, как один самодостаточный файл, с доступом к сети и без секретов в окружении — только переменные событий `NESSY_*`, `NESSY_WORKSPACE_PATH` и `HOME`.
- Действия со скриптами работают только на событиях приложения. Политика, отключающая локальные автоматизации, отключает и их.

### Command Hook Actions

Command actions — только для lifecycle hooks.

```json
{
  "type": "command",
  "command": "node .nessy-agent/hooks/pretool-policy.js",
  "timeoutMs": 30000,
  "env": { "POLICY": "strict" }
}
```

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `type` | `"command"` | Required | Action type |
| `command` | string | Required | Shell command, запускаемая из workspace |
| `args` | список строк | — | Запустить `command` напрямую с этими аргументами, без shell (`shell` тогда игнорируется); всё, кроме списка строк, отклоняется |
| `cwd` | string | Workspace directory | Working directory для этой команды |
| `env` | object | — | Дополнительные non-secret environment variables |
| `timeoutMs` | number | `30000` | Timeout, cap 120 секунд |
| `shell` | `"bash"` \| `"powershell"` | Platform default | Shell для команды; запрошенный, но не установленный shell — execution error |
| `blockOnNonZero` | boolean | `true` (`false` в формате settings Claude) | Блокирует ли non-zero exit `PreToolUse` tool |

## Matchers

### Regex Matching

Most events filter their match value with regular expression:

```json
{
  "matcher": "^urgent$",
  "actions": [
    { "type": "webhook", "url": "${NESSY_WH_SLACK_URL}" }
  ]
}
```

Omit `matcher` to fire on every event of that type.

| Pattern | Matches |
| ------- | ------- |
| `^urgent$` | Exactly "urgent" |
| `bug\|feature` | "bug" or "feature" |
| `^prod-` | Anything starting with "prod-" |
| *(omitted)* | All events of the type |

Patterns limited to 500 characters and rejected if prone to catastrophic backtracking (ReDoS protection).

### Cron Matching

`SchedulerTick` matchers use cron expression instead of regex:

```json
{
  "cron": "0 9 * * 1-5",
  "timezone": "Europe/Budapest",
  "actions": [
    { "type": "prompt", "prompt": "Morning briefing" }
  ]
}
```

**Format:** `minute hour day-of-month month day-of-week`

| Field | Range | Examples |
| ----- | ----- | -------- |
| Minute | 0–59 | `0`, `*/15` |
| Hour | 0–23 | `9`, `14` |
| Day of month | 1–31 | `1`, `15` |
| Month | 1–12 | `1`, `*/3` |
| Day of week | 0–6 (0 Sunday) | `1-5`, `0,6` |

| Cron | Schedule |
| ---- | -------- |
| `*/15 * * * *` | Every 15 minutes |
| `0 9 * * *` | Daily at 9:00 |
| `0 9 * * 1-5` | Weekdays at 9:00 |
| `30 14 1 * *` | 1st of month at 14:30 |
| `0 */6 * * *` | Every 6 hours |

**Timezone** uses IANA names (`Europe/Budapest`, `America/New_York`) and falls back to system timezone. Validator rejects invalid cron and timezone values.

**Пропущенные запуски.** При старте приложения и при пробуждении компьютера планировщик запускает ровно один catch-up запуск для последнего пропущенного срабатывания каждого `SchedulerTick`-матчера — более старые пропуски отбрасываются, а время, прошедшее, пока приложение работало, заново не воспроизводится. Catch-up запуск несёт **только prompt-действия**: действие `script` или `webhook`, чей момент пришёлся на закрытое приложение или спящий компьютер, пропускается — его расписание помечается как учтённое и позже не воспроизводится.

## Conditions

Conditions — optional gate after matcher/cron matched and just before actions run. Whole array must pass — implicit AND — and empty or absent means nothing blocks actions.

```json
{
  "cron": "0 9 * * *",
  "conditions": [
    { "condition": "time", "weekday": ["mon", "tue", "wed", "thu", "fri"] }
  ],
  "actions": [
    { "type": "prompt", "prompt": "Good morning — here's your briefing." }
  ]
}
```

### Time Conditions

Gate on clock time and weekday within timezone.

```json
{
  "condition": "time",
  "after": "09:00",
  "before": "17:00",
  "weekday": ["mon", "tue", "wed", "thu", "fri"],
  "timezone": "Europe/Budapest"
}
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `after` | `"HH:MM"` | Start of window |
| `before` | `"HH:MM"` | End of window |
| `weekday` | `string[]` | Allowed days: `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun` |
| `timezone` | string | IANA timezone; falls back to matcher timezone, then system |

If `after` is later than `before`, range wraps across midnight.

### State Conditions

Check field from event payload. Use exactly **one** operator group per condition.

```json
{
  "condition": "state",
  "field": "permissionMode",
  "from": "plan",
  "to": "bypassPermissions"
}
```

| Field | Description |
| ----- | ----------- |
| `field` | Payload field name (required) |
| `value` | Exact match |
| `from`/`to` | Previous / new value for transition events |
| `contains` | Array membership check |
| `not_value` | Matches anything except this value |

State condition must use one of `value`, `from`/`to`, `contains`, or `not_value` — mixing operator groups is validation error.

### Logical Composition

Group conditions using `and`, `or`, and `not` — each expects non-empty `conditions` array.

```json
{
  "condition": "or",
  "conditions": [
    { "condition": "state", "field": "permissionMode", "value": "bypassPermissions" },
    { "condition": "state", "field": "isFlagged", "value": true }
  ]
}
```

| Type | Behaviour |
| ---- | --------- |
| `and` | All sub-conditions must pass |
| `or` | At least one must pass |
| `not` | None may pass |

::: warning
Conditions may nest up to 8 levels deep (top level depth 0). Simplification warning emitted past depth 4. Keep them shallow.
:::

### Семантическое условие

`conditions` сравнивают поля. `semanticCondition` вместо этого задаёт вопрос «да/нет» обычными словами, а отвечает на него [модель решений](../core-concepts/decision-model), когда в ней включён переключатель **Условия автоматизаций**:

```json
{
  "matcher": "^needs-triage$",
  "semanticCondition": {
    "question": "Is the user reporting a bug or crash, rather than asking a question?",
    "threshold": 0.6
  },
  "actions": [{ "type": "prompt", "prompt": "Triage the bug in session $NESSY_SESSION_NAME" }]
}
```

| Поле | Тип | По умолчанию | Описание |
| --- | --- | --- | --- |
| `question` | string | обязательно | Вопрос «да/нет», до 500 символов |
| `threshold` | number | `0.5` | Вероятность ответа «да», нужная для запуска: больше 0 и не больше 1 |

- Его спрашивают **последним**: после матчера, массива `conditions` и [защиты от циклов](#защита-от-циклов), так что запуск, который всё равно не состоялся бы, вопроса не стоит.
- Модель решений видит название события, название автоматизации и поля события; для события сессии — ещё название сессии, её метки, статус и последние сообщения пользователя и ассистента (до 1500 символов каждое).
- Ниже порога запуск пропускается, и история автоматизации показывает его как **Пропущено** с вероятностью, а не как ошибку.
- Матчер оценивается один раз на событие: либо выполняются все его prompt-действия, либо ни одно.
- Условие управляет только prompt-действиями. Действия webhook и script им не ограничиваются.
- Если модель решений выключена, недоступна или не ответила, автоматизация выполняется так, будто условия нет. Семантическое условие никогда не выключает работающую автоматизацию.

## Matcher Options

Each matcher entry accepts:

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `id` | string | — | Stable identifier (auto-generated in UI) |
| `name` | string | — | Display name |
| `matcher` | string | Match all | Regex filter for event value |
| `cron` | string | — | Cron expression (SchedulerTick) |
| `timezone` | string | System TZ | IANA timezone for cron |
| `conditions` | array | `[]` | Conditions that must all pass |
| `semanticCondition` | object | — | Вопрос «да/нет», на который модель решений должна ответить «да», прежде чем выполнятся prompt-действия, — см. [Семантическое условие](#семантическое-условие) |
| `permissionMode` | string | `plan` | `dontAsk`, `plan`, `default`, `acceptEdits`, `auto` или `bypassPermissions` для spawned session (упразднённый `explore` и устаревшие написания `safe`, `ask`, `allow-all` продолжают читаться) |
| `labels` | string[] | `[]` | Labels applied to prompt-created sessions |
| `enabled` | boolean | `true` | Set `false` to disable without deleting |
| `actions` | array | Required | One or more actions |

## Environment Variables

### Common

Set for every action:

| Variable | Description |
| -------- | ----------- |
| `NESSY_EVENT` | Event name |
| `NESSY_EVENT_DATA` | Full event payload as JSON |
| `NESSY_SESSION_ID` | Session ID |
| `NESSY_SESSION_NAME` | Session name |
| `NESSY_SESSION_METADATA` | Session id/name as JSON |
| `NESSY_WORKSPACE_ID` | Workspace ID |

### App Event Variables

Derived from payload:

- **Label events** (`LabelAdd`, `LabelRemove`): `NESSY_LABEL`
- **PermissionModeChange**: `NESSY_OLD_MODE`, `NESSY_NEW_MODE`
- **FlagChange**: `NESSY_IS_FLAGGED`
- **SessionStatusChange**: `NESSY_OLD_STATE`, `NESSY_NEW_STATE`
- **SchedulerTick**: `NESSY_LOCAL_TIME` (`HH:MM`), `NESSY_LOCAL_DATE` (`YYYY-MM-DD`)

### Agent Event Variables

- **Tool events** (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`): `NESSY_TOOL_NAME`, `NESSY_TOOL_INPUT`, `NESSY_TOOL_RESPONSE` (post-success), `NESSY_ERROR` (on failure)
- **Session start**: `NESSY_SOURCE`, `NESSY_MODEL`
- **Prompt submit**: `NESSY_PROMPT`
- **Subagent events**: `NESSY_AGENT_ID`, `NESSY_AGENT_TYPE`
- **Notifications**: `NESSY_MESSAGE`, `NESSY_TITLE`

## Permission Modes for Prompt Sessions

Matcher `permissionMode` sets security mode of session created by prompt action:

| Mode | Behaviour |
| ---- | --------- |
| `dontAsk` | Никогда не спрашивает; всё, что не pre-approved rules или read-only allowlist, denied |
| `plan` | Read-only; Bash проверяется по allowlist; пишет только план и папку data этой session |
| `default` | Bash просит approval |
| `acceptEdits` | File edits auto-approved; остальные actions спрашивают |
| `auto` | Low-risk работа идёт сама; risky или ambiguous actions всё ещё спрашивают |
| `bypassPermissions` | Без approval prompts |

Устаревшие написания (`safe`, `ask`, `allow-all`, а также более старые `execute`/`ask-to-edit`/`automatic`) продолжают читаться в существующих automations и разрешаются в режимы выше; в новых automations используйте текущие написания. Automation, сохранённая в упразднённом режиме `explore` (или как `safe`), показывается и выполняется как `plan`, а в файле будет `plan` при следующем сохранении любой automation; automation без `permissionMode` тоже выполняется в `plan`.

См. [Permissions](../core-concepts/permissions) for what each mode allows.

## Labels for Prompt Actions

Prompt actions can tag their sessions so scheduled work is easy to filter:

```json
{
  "cron": "0 9 * * *",
  "labels": ["Scheduled", "morning-briefing"],
  "actions": [
    { "type": "prompt", "prompt": "Today's priorities" }
  ]
}
```

Labels support variable expansion (`"priority::${NESSY_LABEL}"`) and must reference labels existing in workspace — validator flags unknown label IDs. См. [Labels](../labels/overview).

## Защита от циклов

Prompt-действие, сессия которого снова запускает собственный матчер, — например, автоматизация `LabelAdd`, которая ставит свою метку на созданную ею сессию, — иначе выполнялась бы бесконечно. Прежде чем prompt-действие создаст сессию, Nessy Desktop проверяет, откуда пришло событие:

- **Автоматизация никогда не выполняется для события о сессии, которую создала сама.** Первый запуск происходит; событие, которое вызывает его собственная сессия, пропускается.
- **Цепочки разных автоматизаций останавливаются на глубине трёх сессий.** Сессия автоматизации A может запустить B, а сессия B — C; четвёртое звено пропускается.
- Пропущенный запуск виден в истории автоматизации как **Пропущено** с причиной на вашем языке, а не теряется в журнале.
- Catch-up запуск по расписанию (после того как приложение было закрыто или компьютер спал) — новый запуск, а не цикл.

Защита действует на prompt-действия — те, что создают сессии. Она работает в дополнение к ограничениям частоты ниже.

## Rate Limits

Чтобы stop runaway loops, event bus caps how often each event fires:

| Event | Max per minute |
| ----- | -------------- |
| `SchedulerTick` | 60 |
| All other events | 10 |

Anything past cap discarded until current 60-second window rolls over.

## Examples

### Daily Morning Briefing

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "cron": "0 9 * * 1-5",
        "timezone": "Europe/Budapest",
        "labels": ["Scheduled", "briefing"],
        "actions": [
          { "type": "prompt", "prompt": "Run the @daily-standup skill" }
        ]
      }
    ]
  }
}
```

### Notify on Permission Escalation

Срабатывает только когда режим меняется с `plan` на `bypassPermissions`:

```json
{
  "version": 2,
  "automations": {
    "PermissionModeChange": [
      {
        "conditions": [
          { "condition": "state", "field": "permissionMode", "from": "plan", "to": "bypassPermissions" }
        ],
        "actions": [
          {
            "type": "webhook",
            "url": "${NESSY_WH_SLACK_URL}",
            "body": { "text": "Permission escalated to bypassPermissions in $NESSY_SESSION_NAME" }
          }
        ]
      }
    ]
  }
}
```

### Two Schedules, One Disabled

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "cron": "0 9 * * 1-5",
        "timezone": "Europe/Budapest",
        "labels": ["Scheduled"],
        "actions": [
          { "type": "prompt", "prompt": "Morning briefing" }
        ]
      },
      {
        "cron": "0 17 * * 5",
        "timezone": "Europe/Budapest",
        "enabled": false,
        "labels": ["Scheduled"],
        "actions": [
          { "type": "prompt", "prompt": "Recap this week's work" }
        ]
      }
    ]
  }
}
```

Friday recap stays dormant until you flip `"enabled"` back to `true` or delete field.

## Validation

Tell agent "validate my automations configuration" или call tool `config_validate` with `target: "all"`. It looks for:

- JSON syntax and unknown event names
- Empty action arrays
- Invalid cron expressions and timezones
- Over-long or unsafe regex patterns (ReDoS)
- Labels that don't exist in workspace
- Invalid condition types, field names, weekdays and nesting depth
- Missing `llmConnection` slugs (error) and model/provider mismatches (warning)
- Legacy `thinkingLevel: "think"` (migrated to `"medium"`)

## Security

Automations ship with safeguards:

- **Secret isolation** — webhook actions only see `NESSY_WH_*` variables, never full environment.
- **ReDoS protection** — regex patterns length-limited and screened for catastrophic backtracking.
- **Rate limiting** — prevents feedback loops between automations.
- **Защита от циклов** — автоматизация никогда не перезапускается из-за собственной сессии, а цепочки автоматизаций останавливаются на глубине трёх сессий.
- **Shell-safe expansion** — user-controlled values (session names, labels) escaped where they reach shell context.
- **Governed plugin effects** — child, MCP, HTTP и scheduled plugin actions revalidate pinned trust, capability generation, permission, timeout и cancellation до side effect.

### Troubleshooting

**Automation not firing**

1. Check event name — case-sensitive (`LabelAdd`, not `labeladd`).
2. Check matcher regex against event match value.
3. For `SchedulerTick`, verify cron expression.
4. Make sure matcher isn't `"enabled": false`.
5. Look for `[automations]` lines in application logs.
6. Прочитайте заметки в чате этого workspace. `automations.json`, который не
   загрузился, назван там вместе с первой ошибкой: после правки продолжают
   действовать автоматизации, бывшие до неё, а при запуске из этого файла не
   действует ни одна. Сломанный `hooks.json` получает собственную заметку и
   больше не мешает перезагрузке `automations.json`.
7. Вспомните, когда запуск пропущен: если в назначенное время приложение было
   закрыто или компьютер спал, при следующем старте или пробуждении догоняют
   только prompt-действия — пропущенное действие `script` или `webhook`
   пропускается.
8. Откройте историю автоматизации. Запуск, остановленный [защитой от циклов](#защита-от-циклов)
   или [семантическим условием](#семантическое-условие), показан там как
   **Пропущено** с причиной.

**Prompt not creating a session**

1. Prompt actions only work with App events, not agent events.
2. Prompt text must be non-empty.
3. `@mentions` must reference valid sources or skills.

**Condition never matches**

1. Weekdays must be 3-letter lowercase (`mon`, `tue`, …).
2. Times must be `HH:MM` 24-hour (`09:00`, not `9:00 AM`).
3. Invalid timezones fall back to system local silently.
4. Don't nest deeper than 8 levels.
