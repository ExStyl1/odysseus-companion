# Справочник HTTP-протокола `nessy serve`

Этап 1 [проектирования демона nessy-cli](https://github.com/NessyLM/nessy-cli/issues/3803). Все маршруты находятся под базовым URL демона (по умолчанию `http://127.0.0.1:4170`).

## Аутентификация

Когда демон запущен с `--token` или `NESSY_SERVER_TOKEN`, **каждый маршрут кроме `/health` при привязке к loopback** должен содержать:

```
Authorization: Bearer <token>
```

Без настроенного токена (loopback dev default) заголовок опционален. Сравнение токена выполняется за константное время. Ответы `401` унифицированы для `missing header` / `wrong scheme` / `wrong token`.

**Исключение `/health`** (Bctum): при привязке к loopback (`127.0.0.1` / `localhost` / `::1` / `[::1]`) `/health` регистрируется ПЕРЕД bearer middleware, поэтому liveness probes внутри pod не нуждаются в токене, даже если демон запущен с `--token`. При привязке к non-loopback (`--hostname 0.0.0.0` и т.д.) `/health` проверяется через bearer как каждый другой маршрут — см. секцию [`GET /health`](#get-health) для обоснования.

**`--require-auth`** (PR 15 #4175). Передайте этот флаг при запуске, чтобы расширить правило «должен быть токен» на loopback также. Запуск завершится ошибкой без токена; исключение `/health` отбрасывается (так что `/health` также требует `Authorization: Bearer …`).

Когда флаг включён, глобальный `bearerAuth` middleware проверяет **каждый** маршрут — включая `/capabilities`. **Неаутентифицированный** клиент не может сделать pre-flight `caps.features` чтобы обнаружить, что требуется auth: поверхность discovery для этого случая — сам **401 response body** (унифицированный для всех маршрутов согласно секции [Аутентификация](#аутентификация)). Capability tag `require_auth` — это **подтверждение после аутентификации** — после успешной аутентификации клиента и чтения `/capabilities`, наличие tag подтверждает, что демон запущен с `--require-auth` (полезно для audit / compliance UI и для SDK клиентов, чтобы отображать «это deployment hardened» в панели настроек). Mutation routes, которые opt-in в per-route strict mode (Wave 4 follow-ups), отказывают с `401 { code: "token_required", error: "…" }` при достижении на no-token loopback default — но с включённым `--require-auth` глобальный bearer middleware short-circuits запрос до per-route gate, поэтому legacy `Unauthorized` body — это то, что неаутентифицированные вызывающие стороны фактически видят.

**`--allow-origin <pattern>` (T2.4 [#4514](https://github.com/NessyLM/nessy-cli/issues/4514)).** Веб-интерфейсы браузера, обращающиеся к демону с другого origin, по умолчанию блокируются: любой запрос с заголовком `Origin` возвращает `403 {"error":"Request denied by CORS policy"}`, поскольку клиенты CLI/SDK не отправляют `Origin`, а демон считает его наличие признаком браузерного контекста, который оператор явно не разрешил. Передайте `--allow-origin <pattern>` (флаг можно повторять) при запуске, чтобы вместо полного запрета установить список разрешённых origin. Каждый шаблон имеет одну из форм:

- Литерал `*` — разрешить любой origin. **Рискованно**: запуск будет отклонён, если настроен `*`, но отсутствует bearer-токен (из `--token`, `NESSY_SERVER_TOKEN` или `--require-auth`, который требует токен при запуске). При наличии `*` в списке стартовое сообщение в stderr содержит предупреждение. **Рекомендация**: при привязке к loopback сочетайте его с `--require-auth`, чтобы `/health` и `/demo` также защищались bearer-аутентификацией: по умолчанию они регистрируются до bearer middleware на loopback, а список `*` делает их доступными любому cross-origin браузеру. При привязке к non-loopback bearer уже обязателен при запуске, поэтому с `*` открыты только `/health` (JSON статуса) и `/demo` (статическая страница, JavaScript которой всё равно вызывает защищённые токеном маршруты); основной API в любом случае защищён.
- Канонический URL origin — `<scheme>://<host>[:<port>]`. **Без завершающего слеша, пути, userinfo и query.** Запуск завершается с `InvalidAllowOriginPatternError`, если запись не проходит проверку `new URL(pattern).origin === pattern`; сообщение об ошибке показывает неверный шаблон и каноническую форму. Строгость намеренна: тихая нормализация (например, удаление завершающего `/`) скрывала бы опечатки и принимала неоднозначный ввод.

Для совпавших origin каждый ответ содержит стандартные заголовки CORS:

```
Access-Control-Allow-Origin: <echoed origin>
Vary: Origin
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type, X-Nessy-Client-Id, Last-Event-ID
Access-Control-Max-Age: 86400
Access-Control-Expose-Headers: Retry-After
```

`Access-Control-Allow-Origin` возвращает origin запроса дословно (с тем же регистром, в котором его отправил браузер), а не литерал `*`, даже при шаблоне `*`: браузерные кэши различают ответы по нему совместно с `Vary: Origin`, а такой ответ позволит в будущем добавить `Access-Control-Allow-Credentials` без изменения протокола. `Access-Control-Expose-Headers: Retry-After` позволяет веб-клиентам соблюдать рекомендации демона о повторе из ответов `429` и `503`. Заголовок `Access-Control-Allow-Credentials` сейчас **НЕ** отправляется: демон использует bearer в `Authorization`, который работает cross-origin без `credentials: 'include'`.

Запросы OPTIONS preflight (OPTIONS с `Access-Control-Request-Method` или `Access-Control-Request-Headers`) немедленно завершаются ответом `204 No Content` с перечисленными заголовками. Это стандартный и безопасный шаблон CORS: preflight лишь сообщает, какие методы и заголовки принимает демон; последующий реальный запрос всё равно проходит всю цепочку (список разрешённых host → bearer-аутентификация → маршруты), поэтому защита от DNS rebinding и проверка bearer выполняются до чтения или изменения состояния. Обычные OPTIONS-запросы от совпавших origin продолжают обрабатываться дальше с добавленными заголовками CORS.

Origin, не совпавшие со списком разрешённых, по-прежнему получают `403 {"error":"Request denied by CORS policy"}` — тот же формат ответа, что и при полном запрете, поэтому существующим клиентам не нужна отдельная обработка демонов со списком. В ответе отказа **нет** заголовков `Access-Control-*`: браузер всё равно проигнорировал бы их, а наличие заголовков косвенно раскрывало бы размер списка.

Настроенный список шаблонов намеренно НЕ возвращается в `/capabilities`: браузерный веб-интерфейс уже знает собственный origin, а публикация списка позволила бы неаутентифицированному читателю `/capabilities` перечислить все доверенные origin — полезные разведданные при ошибочной конфигурации. Клиенты SDK проверяют тег `caps.features.allow_origin`, означающий, что демон поддерживает cross-origin обращения браузеров, без знания конкретных разрешённых origin.

Self-origin запросы loopback (например, страница `/demo`, обращающаяся к демону на том же `127.0.0.1:port`) обрабатываются отдельной прослойкой удаления Origin, которая работает ДО CORS middleware и удаляет заголовок `Origin` для `127.0.0.1:port`, `localhost:port`, `[::1]:port` и `host.docker.internal:port`. Поэтому такие запросы проходят при любой настройке `--allow-origin`: операторам не требуется добавлять собственный порт демона в список ради demo-страницы.

## Общая форма ошибок

5xx ответы содержат оригинальный `code` и `data` ошибки при наличии (формат JSON-RPC — ACP SDK пересылает `{code, message, data}` от агента):

```json
{
  "error": "Internal error",
  "code": -32000,
  "data": { "reason": "model quota exceeded" }
}
```

Некорректный JSON в теле запроса возвращает:

```json
{ "error": "Invalid JSON in request body" }
```

со статусом `400`.

`SessionNotFoundError` для неизвестного session id возвращает:

```json
{ "error": "No session with id \"<sid>\"", "sessionId": "<sid>" }
```

со статусом `404`.

`WorkspaceMismatchError` для `POST /session`, чей `cwd` не канонизируется в привязанный workspace демона (#3803 §02 — 1 демон = 1 workspace) возвращает `400` с:

```json
{
  "error": "Workspace mismatch: daemon is bound to \"…\" but request asked for \"…\". …",
  "code": "workspace_mismatch",
  "boundWorkspace": "/path/the/daemon/binds",
  "requestedWorkspace": "/path/in/the/request"
}
```

Используйте это для обнаружения несоответствия заранее: прочитайте `workspaceCwd` из `/capabilities` и опустите `cwd` из `POST /session` (он использует привязанный workspace по умолчанию), или направьте запрос на демон, привязанный к `requestedWorkspace`.

`POST /session` сверх лимита `--max-sessions` демона возвращает `503` с заголовком `Retry-After: 5` и:

```json
{
  "error": "Session limit reached (20)",
  "code": "session_limit_exceeded",
  "limit": 20
}
```

Подключения к существующим сессиям НЕ считаются в лимите, поэтому переподключения к простаивающему демону продолжают работать даже при максимальной загрузке.

`RestoreInProgressError` — выдаётся только `POST /session/:id/load` и `POST /session/:id/resume` — возвращает `409` с заголовком `Retry-After: 5` (соответствует `session_limit_exceeded`) и:

```json
{
  "error": "Session \"<sid>\" is already being restored via session/<resume|load>; retry session/<load|resume> after it completes",
  "code": "restore_in_progress",
  "sessionId": "<sid>",
  "activeAction": "load",
  "requestedAction": "resume"
}
```

Срабатывает, когда `session/load` вызван для id, у которого уже есть активный `session/resume` (или наоборот). Подождите как минимум `Retry-After` секунд и повторите попытку — базовое восстановление завершается в течение `initTimeoutMs` (по умолчанию 10с). Конфликты одинаковых действий (`load` против `load`, `resume` против `resume`) объединяются вместо ошибки.

## Capabilities

Демон рекламирует свои поддерживаемые feature tags из serve capability registry. Клиенты **должны** определять доступность UI по `features`, а не по `mode` (согласно design §10).

```
['health', 'capabilities', 'session_create', 'session_scope_override',
 'session_load', 'session_resume',
 'unstable_session_resume',
 'session_list', 'session_prompt', 'session_cancel', 'session_events',
 'slow_client_warning', 'typed_event_schema',
 'session_set_model', 'client_identity', 'client_heartbeat',
 'session_permission_vote', 'permission_vote', 'workspace_mcp', 'workspace_skills',
 'workspace_providers', 'auth_provider_install', 'workspace_memory',
 'workspace_agents', 'workspace_agent_generate', 'workspace_env',
 'workspace_preflight', 'session_context', 'session_context_usage',
 'session_supported_commands', 'session_tasks', 'session_stats',
 'session_lsp',
 'session_close', 'session_metadata', 'mcp_guardrails',
 'workspace_mcp_manage', 'mcp_guardrail_events',
 'mcp_server_runtime_mutation',
 'workspace_file_read', 'workspace_file_bytes', 'workspace_file_write',
 'session_approval_mode_control', 'workspace_tool_toggle',
 'workspace_settings', 'workspace_init', 'workspace_mcp_restart',
 'session_recap', 'session_btw', 'session_shell_command',
 'mcp_workspace_pool', 'mcp_pool_restart',
 'require_auth', 'allow_origin', 'auth_device_flow',
 'permission_mediation', 'prompt_absolute_deadline', 'writer_idle_timeout',
 'non_blocking_prompt', 'session_language', 'session_rewind',
 'workspace_hooks', 'session_hooks', 'workspace_extensions',
 'session_branch', 'rate_limit', 'workspace_reload']
```

> Условные теги появляются только при включении соответствующего параметра развёртывания (см. таблицу ниже). Тег F3 `permission_mediation` включён всегда и содержит `modes: ['first-responder', 'designated', 'consensus', 'local-only']`, чтобы SDK-клиенты могли определить поддерживаемый сборкой набор; активная стратегия находится в `body.policy.permission`.

`session_scope_override` — это механизм согласования для поля `sessionScope` в `POST /session` (см. ниже). Старые демоны молча игнорируют это поле, поэтому SDK-клиенты должны делать pre-flight `caps.features` для этого tag перед отправкой.

`session_load` и `session_resume` объявляют явные маршруты восстановления (`POST /session/:id/load` и `POST /session/:id/resume`). Старые демоны возвращают `404`, поэтому SDK-клиенты должны заранее проверять `caps.features`. `unstable_session_resume` по-прежнему объявляется как устаревший alias для совместимости с SDK, выпущенными, когда базовый ACP-метод назывался `connection.unstable_resumeSession`; новые клиенты должны проверять `session_resume`.

`slow_client_warning` покрывает два совместно выпущенных механизма управления backpressure SSE, введённых в #4175 Wave 2.5 PR 10: (a) демон emit'ит `slow_client_warning` synthetic event-stream frame, когда очередь подписчика пересекает 75% заполнения, один раз на эпизод переполнения (повторно активируется после того, как очередь опускается ниже 37.5%); (b) `GET /session/:id/events` принимает query param `?maxQueued=N` (диапазон `[16, 2048]`) для предварительного выделения per-subscriber backlog для холодных переподключений против большого replay ring. Daemon-wide ring size контролируется через `--event-ring-size` (по умолчанию **8000**, согласно #3803 §02). Старые демоны молча игнорируют оба — делайте pre-flight этого tag перед opt-in.

`typed_event_schema` рекламирует daemon event payloads, которые соответствуют SDK's `KnownDaemonEvent` schema. Старые демоны могут всё ещё stream'ить совместимые frames, но SDK-клиенты должны делать pre-flight этого tag перед использованием typed event coverage.

`client_heartbeat` рекламирует `POST /session/:id/heartbeat`. Старые демоны возвращают `404`; делайте pre-flight этого tag перед отправкой периодических heartbeats.

`session_close` и `session_metadata` рекламируют `DELETE /session/:id` и `PATCH /session/:id/metadata`. Старые демоны возвращают `404`; делайте pre-flight этих tags перед предоставлением affordances закрытия или переименования.

`session_lsp` объявляет `GET /session/:id/lsp` — структурированный снимок состояния LSP только для чтения для клиентов демона. Старые демоны возвращают `404`; проверяйте этот тег до показа удалённого состояния LSP.

`session_approval_mode_control`, `workspace_tool_toggle`, `workspace_init`, и `workspace_mcp_restart` (issue [#4175](https://github.com/NessyLM/nessy-cli/issues/4175) PR 17) рекламируют четыре маршрута управления изменениями, задокументированных ниже в разделе «Mutation: approval, tools, init, MCP restart». Все четыре строго защищены PR 15 mutation gate (демон, сконфигурированный без bearer token, отклоняет их с 401 `token_required`). Старые демоны возвращают `404`; делайте pre-flight каждого tag перед использованием соответствующей возможности.

`mcp_guardrails` (issue [#4175](https://github.com/NessyLM/nessy-cli/issues/4175) PR 14) покрывает поверхность бюджетирования MCP: поля `clientCount` / `clientBudget` / `budgetMode` / `budgets[]` в `GET /workspace/mcp`, поле `disabledReason` в per-server cells, и CLI флаги `--mcp-client-budget` / `--mcp-budget-mode`. Старые демоны опускают новые поля полностью; SDK-клиенты делают pre-flight этого tag перед использованием семантики `budgets[]`. Registry descriptor также несёт `modes: ['warn', 'enforce']` для будущего раскрытия режимов — пока клиенты выводят mode из поля `budgetMode` snapshot'а. Отказ сервера в режиме `enforce` детерминирован по порядку объявления `Object.entries(mcpServers)`; будущий слой приоритетов scope (если nessy-cli adopt один) сдвинет это на «lowest-precedence first» для зеркалирования claude-code's `plugin < user < project < local` convention.

> ⚠️ **PR 14 v1 scope: per-session, не per-workspace.** Каждая ACP session внутри демона конструирует свой собственный `Config` + `McpClientManager` (через `acpAgent.newSessionConfig`). Budget caps live MCP clients **per session**; каждая session независимо читает `NESSY_SERVE_MCP_CLIENT_BUDGET` из forwarded env. С `--mcp-client-budget=10` и 5 concurrent ACP sessions, фактическое live MCP client count может достигать 5 × 10 = 50 across the daemon. `GET /workspace/mcp` snapshot читает **bootstrap session's** `McpClientManager` accounting только — `budgets[0].scope: 'session'` value — это honest signal, что это per-session, не aggregated. **Wave 5 PR 23 (shared MCP pool)** введёт workspace-scoped manager и добавит `scope: 'workspace'` cell наряду с per-session cell для true cross-session aggregation. v1 — это in-process counter + soft enforcement foundation, на которой PR 23 строит.

`workspace_file_read` покрывает маршруты workspace file text/list/stat/glob (`GET /file`, `GET /list`, `GET /glob`, `GET /stat`). `workspace_file_bytes` покрывает `GET /file/bytes`, который был добавлен позже, чтобы клиенты могли делать pre-flight поддержки raw byte-window против демонов эры PR19. `workspace_file_write` покрывает hash-aware маршруты изменения текста (`POST /file/write`, `POST /file/edit`). Write tag означает, что контракт маршрута существует; это не означает, что текущий deployment открыт для анонимных изменений. Write/edit — это строгие маршруты изменений и требуют настроенный bearer token даже на loopback.

`daemon_status` объявляет `GET /daemon/status` — объединённый диагностический снимок только для чтения для операторов, описанный ниже.

**Условные теги.** Небольшое количество feature tags рекламируется только когда соответствующий переключатель deployment включён. Наличие tag = поведение включено; отсутствие = либо старый демон до появления tag, либо текущий демон, где оператор не сделал opt in. В настоящее время:

| Тег                        | Когда объявляется                                                                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `require_auth`             | Демон запущен с `--require-auth` (или `requireAuth: true` через embedded API). Bearer-токен обязателен для каждого маршрута, включая `/health` при привязке к loopback.                                                                                                                                   |
| `mcp_workspace_pool`       | Активен общий пул транспорта MCP. Не объявляется, если `NESSY_SERVE_NO_MCP_POOL=1` отключает пул.                                                                                                                                                                                                         |
| `mcp_pool_restart`         | Активен общий пул транспорта MCP; ответы перезапуска могут содержать учитывающие пул формы с несколькими элементами.                                                                                                                                                                                      |
| `allow_origin`             | T2.4 ([#4514](https://github.com/NessyLM/nessy-cli/issues/4514)). Демон запущен как минимум с одним `--allow-origin <pattern>` (или `allowOrigins: [...]` через embedded API). Совпавшие origin получают заголовки CORS, несовпавшие — стандартный 403. Список шаблонов не публикуется в `/capabilities`. |
| `prompt_absolute_deadline` | Установлено положительное значение `--prompt-deadline-ms`, `NESSY_SERVE_PROMPT_DEADLINE_MS` или `ServeOptions.promptDeadlineMs`.                                                                                                                                                                          |
| `writer_idle_timeout`      | Установлено положительное значение `--writer-idle-timeout-ms`, `NESSY_SERVE_WRITER_IDLE_TIMEOUT_MS` или `ServeOptions.writerIdleTimeoutMs`.                                                                                                                                                               |
| `workspace_settings`       | Демон создан с доступным сохранением настроек.                                                                                                                                                                                                                                                            |
| `session_shell_command`    | Явно разрешено выполнение shell-команд сессии.                                                                                                                                                                                                                                                            |
| `rate_limit`               | Включено `--rate-limit`, `NESSY_SERVE_RATE_LIMIT=1` или `ServeOptions.rateLimit`.                                                                                                                                                                                                                         |
| `workspace_reload`         | Во встроенной конфигурации маршрутов доступна перезагрузка рабочей области.                                                                                                                                                                                                                               |

`mcp_guardrails` **не** в этой таблице условных тегов — это always-on tag, рекламируемый всякий раз, когда binary поддерживает новые поля бюджетирования `/workspace/mcp`, независимо от того, сконфигурировал ли оператор бюджет. Операторы, которые не установили `--mcp-client-budget`, всё равно получают новые поля (с `budgetMode: 'off'`, `budgets: []`).

`mcp_guardrail_events` (issue [#4175](https://github.com/NessyLM/nessy-cli/issues/4175) PR 14b) рекламирует типизированные push-события SSE, которые surfacing пересечения состояния бюджета MCP без poll loop. Два типа frame поступают на `GET /session/:id/events`:

- `mcp_budget_warning` — срабатывает один раз при пересечении 75% вверх `reservedSlots.size / clientBudget`. Перезаряжается только после того, как ratio падает ниже 37.5% (`MCP_BUDGET_REARM_FRACTION`). Зеркалирует гистерезис `slow_client_warning` из PR 10, но на уровне manager, а не на уровне per-subscriber backlog. Payload: `{ liveCount, reservedCount, budget, thresholdRatio: 0.75, mode: 'warn' | 'enforce' }`. Срабатывает под обоими `warn` и `enforce` modes; никогда под `off`.
- `mcp_child_refused_batch` — срабатывает в конце каждого `discoverAllMcpTools*` pass, когда один или несколько servers были refused, AND как length-1 batch на `readResource` lazy-spawn refusal path. Payload: `{ refusedServers: [{ name, transport, reason: 'budget_exhausted' }, ...], budget, liveCount, reservedCount, mode: 'enforce' }`. `mode` — это literal `'enforce'`, потому что `warn` mode никогда не refuses.

Оба события живут в per-session SSE replay ring (они несут `id`), поэтому клиент, reconnecting с `Last-Event-ID`, resumes через них; snapshot на `GET /workspace/mcp` всё ещё является source-of-truth для state-after-extended-disconnect. Always-on однажды рекламируемый — нет conditional toggle. SDK reducer state (`DaemonSessionViewState`) exposes `mcpBudgetWarningCount`, `lastMcpBudgetWarning`, `mcpChildRefusedBatchCount`, `lastMcpChildRefusedBatch` для adapters, которые хотят simple lag-style UI.

## Routes

### `GET /health`

Liveness probe. Форма по умолчанию возвращает `200 {"status":"ok"}`, если listener запущен — дёшево, без обращения к bridge, подходит для высокочастотных liveness probe в k8s/Compose.

Передайте `?deep=1` (также принимает `?deep=true` или просто `?deep`) для probe, который раскрывает **счётчики** bridge (только для информации, не настоящая проверка работоспособности):

```json
{ "status": "ok", "sessions": 3, "pendingPermissions": 1 }
```

> ⚠️ Deep probe — это **только информация**, а не настоящая проверка работоспособности. Он читает accessor'ы счётчиков (`bridge.sessionCount`, `bridge.pendingPermissionCount`), которые являются простыми getter'ами размера Map; они не опрашивают отдельные дочерние процессы/каналы и поэтому не обнаружат сессию, которая зависла, но всё ещё числится в счётчике. Используйте его для дашбордов ёмкости (текущая конкуренция vs. `--max-sessions`, глубина очереди), а не как триггер для «исключить этого демона из ротации». Ответ `503 {"status":"degraded"}` теоретически возможен, если getter'ы кастомной реализации bridge выбрасывают исключение, но getter'ы реального bridge никогда этого не делают — при нормальной работе deep probe всегда возвращает 200. Для настоящей проверки работоспособности полагайтесь на то, принимает ли listener TCP-соединение вообще (т.е. `/health` по умолчанию без `?deep`).

**Аутентификация:** требуется **только при привязке к non-loopback**. При привязке к loopback (`127.0.0.1`, `::1`, `[::1]`) `/health` регистрируется перед bearer middleware, поэтому k8s/Compose probe внутри pod не нуждаются в токене. При привязке к non-loopback (`--hostname 0.0.0.0` и т.д.) маршрут регистрируется после bearer middleware и возвращает 401 без валидного токена — иначе неаутентифицированный вызывающий мог бы опрашивать произвольные адреса, чтобы подтвердить существование `nessy serve`, что является утечкой информации низкой серьёзности и плохо сочетается со сканированием портов. CORS deny + список разрешённых Host всё ещё применяются к исключению для loopback.

### `GET /daemon/status`

Диагностика только для чтения для операторов. В отличие от `/health`, это обычный API демона: он регистрируется после bearer-аутентификации и ограничения частоты запросов, в том числе при привязке к loopback. Параметр запроса:

- `detail=summary` (по умолчанию) читает только состояние демона в памяти.
- `detail=full` также включает диагностику активных сессий и ACP-соединений, счётчики аутентификации device flow и разделы состояния рабочей области.
- любое другое значение `detail` возвращает `400 { "code": "invalid_detail" }`.

`summary` намеренно не вызывает методы состояния рабочей области, не запускает дочерний процесс ACP и не создаёт сессию. `full` запрашивает каждый раздел рабочей области независимо; тайм-аут или исключение помечает только этот раздел как `unavailable` и добавляет проблему `workspace_status_unavailable`.

Форма ответа:

```json
{
  "v": 1,
  "detail": "summary",
  "generatedAt": "2026-06-16T00:00:00.000Z",
  "status": "ok",
  "issues": [],
  "daemon": {
    "pid": 12345,
    "uptimeMs": 3600000,
    "mode": "http-bridge",
    "workspaceCwd": "/repo",
    "nessyCodeVersion": "0.18.1",
    "daemonId": "serve-..."
  },
  "security": {
    "tokenConfigured": true,
    "requireAuth": false,
    "loopbackBind": true,
    "allowOriginConfigured": false,
    "allowOriginMode": "none",
    "sessionShellCommandEnabled": false
  },
  "limits": {
    "maxSessions": 20,
    "maxPendingPromptsPerSession": 5,
    "listenerMaxConnections": 256,
    "eventRingSize": 8000,
    "promptDeadlineMs": null,
    "writerIdleTimeoutMs": null,
    "channelIdleTimeoutMs": 0,
    "sessionIdleTimeoutMs": 1800000,
    "acpConnectionCap": 64
  },
  "runtime": {
    "sessions": { "active": 0 },
    "permissions": { "pending": 0, "policy": "first-responder" },
    "channel": { "live": false },
    "transport": {
      "restSseActive": 0,
      "acp": {
        "enabled": true,
        "connections": 0,
        "connectionStreams": 0,
        "sessionStreams": 0,
        "sseStreams": 0,
        "wsStreams": 0,
        "pendingClientRequests": 0
      }
    }
  }
}
```

`status` равен `error`, если хотя бы одна проблема имеет уровень error, `warning`, если хотя бы одна проблема имеет уровень warning, и `ok` в остальных случаях. Коды проблем стабильны и включают `session_capacity_high`, `connection_capacity_high`, `pending_permissions`, `acp_channel_down`, `preflight_error`, `mcp_budget_warning`, `mcp_budget_exhausted`, `rate_limit_hits` и `workspace_status_unavailable`.

Безопасность: ответ никогда не содержит bearer-токены, client id, полные ACP connection id, пользовательские коды device flow или URL верификации. `summary` не содержит путь к журналу демона; `full` может включать его для прошедших аутентификацию операторов.

### `GET /capabilities`

```json
{
  "v": 1,
  "protocolVersions": {
    "current": "v1",
    "supported": ["v1"]
  },
  "mode": "http-bridge",
  "features": ["health", "daemon_status", "capabilities", "..."],
  "modelServices": [],
  "workspaceCwd": "/canonical/path/to/workspace"
}
```

Стабильный контракт: когда `v` увеличивается, структура фрейма изменилась несовместимым образом.

> **`protocolVersions`** описывает версии протокола serve, с которыми демон может работать. `current` — это предпочтительная версия протокола демона, а `supported` — совместимый набор. Клиенты, которые требуют определённую версию протокола, должны проверить `supported`; UI для конкретных функций всё ещё должен ориентироваться на `features`. Добавлено к v=1: старые демоны v=1 опускают это поле, поэтому SDK-клиенты, которые работают со старыми сборками, должны считать его опциональным.

> **`modelServices` всегда `[]` в Stage 1.** Агент использует свой единственный модельный сервис по умолчанию и не перечисляет его через сеть. Stage 2 заполнит это из зарегистрированных адаптеров моделей, чтобы SDK-клиенты могли построить селекторы сервисов; до тех пор НЕ полагайтесь на то, что это поле непустое.

> **`workspaceCwd`** — это канонический абсолютный путь, к которому привязан этот демон (#3803 §02 — 1 демон = 1 рабочая область). Используйте его, чтобы (a) обнаружить несоответствие перед отправкой `/session` и (b) опустить `cwd` в `POST /session` (маршрут использует этот путь как fallback). Развёртывания с несколькими рабочими областями предоставляют несколько демонов на разных портах, каждый со своим `workspaceCwd`. Добавлено к v=1: демоны v=1 до §02 опускают поле — клиенты, которые работают со старыми сборками, должны проверить на null перед использованием.

### Read-only runtime status routes

Эти маршруты сообщают снимки состояния времени выполнения демона. Это дополнительные маршруты v1, не изменяют состояние и не меняют версию протокола serve. Маршруты состояния рабочей области намеренно **не** запускают дочерний процесс ACP только потому, что клиент опрашивает GET-маршрут: если демон простаивает, они возвращают `initialized: false` с пустым снимком. Маршруты состояния сессии требуют активную сессию и используют стандартную форму `404 SessionNotFoundError` для неизвестных id.

Capability tags:

- `workspace_mcp` → `GET /workspace/mcp`
- `workspace_skills` → `GET /workspace/skills`
- `workspace_providers` → `GET /workspace/providers`
- `workspace_env` → `GET /workspace/env`
- `workspace_preflight` → `GET /workspace/preflight`
- `session_context` → `GET /session/:id/context`
- `session_supported_commands` → `GET /session/:id/supported-commands`
- `session_tasks` → `GET /session/:id/tasks`

Общая ячейка статуса:

```ts
type DaemonStatus =
  | 'ok'
  | 'warning'
  | 'error'
  | 'disabled'
  | 'not_started'
  | 'unknown';

type DaemonErrorKind =
  | 'missing_binary'
  | 'blocked_egress'
  | 'auth_env_error'
  | 'init_timeout'
  | 'protocol_error'
  | 'missing_file'
  | 'parse_error';

interface DaemonStatusCell {
  kind: string;
  status: DaemonStatus;
  error?: string;
  errorKind?: DaemonErrorKind;
  hint?: string;
}
```

`errorKind` — это закрытый enum, общий для `/workspace/preflight`, `/workspace/env` и (в будущем) MCP guardrails, чтобы SDK-клиенты могли отображать рекомендации по устранению на категорию вместо парсинга сообщений в свободной форме. PR 13 (#4175) ввёл семь литералов, перечисленных выше; PR 14 заполнит `blocked_egress`, когда появится probe egress.

Полезные данные статуса никогда не раскрывают значения MCP env, заголовки, детали OAuth/service account, API-ключи провайдера, `baseUrl` / `envKey` провайдера, тело навыка, пути к файлам навыка, определения хуков или значения секретных переменных окружения. `/workspace/env` сообщает только о **наличии** переменных окружения из белого списка; proxy URL очищаются от учётных данных и сводятся к `host:port` перед отправкой по сети.

### `GET /workspace/mcp`

```json
{
  "v": 1,
  "workspaceCwd": "/canonical/path",
  "initialized": true,
  "discoveryState": "completed",
  "servers": [
    {
      "kind": "mcp_server",
      "status": "ok",
      "name": "docs",
      "mcpStatus": "connected",
      "transport": "stdio",
      "disabled": false,
      "description": "Documentation server",
      "extensionName": "docs-ext"
    }
  ]
}
```

`discoveryState` — одно из `not_started`, `in_progress` или `completed`. `transport` — одно из `stdio`, `sse`, `http`, `websocket`, `sdk` или `unknown`. `errors` опускается, когда discovery успешен.

**MCP client guardrails (issue [#4175](https://github.com/NessyLM/nessy-cli/issues/4175) PR 14).** Демоны после PR-14 расширяют полезную нагрузку четырьмя дополнительными полями и одной ячейкой уровня рабочей области:

```jsonc
{
  "v": 1,
  "workspaceCwd": "/canonical/path",
  "initialized": true,
  "discoveryState": "completed",
  "clientCount": 3,
  "clientBudget": 2,
  "budgetMode": "enforce",
  "budgets": [
    {
      "kind": "mcp_budget",
      "scope": "session",
      "status": "error",
      "errorKind": "budget_exhausted",
      "hint": "Raise --mcp-client-budget or remove servers from mcpServers config.",
      "liveCount": 2,
      "budget": 2,
      "mode": "enforce",
      "refusedCount": 1,
    },
  ],
  "servers": [
    {
      "kind": "mcp_server",
      "status": "ok",
      "name": "a",
      "mcpStatus": "connected",
      "transport": "stdio",
      "disabled": false,
    },
    {
      "kind": "mcp_server",
      "status": "ok",
      "name": "b",
      "mcpStatus": "connected",
      "transport": "stdio",
      "disabled": false,
    },
    {
      "kind": "mcp_server",
      "status": "error",
      "name": "c",
      "mcpStatus": "disconnected",
      "transport": "stdio",
      "disabled": false,
      "disabledReason": "budget",
      "errorKind": "budget_exhausted",
      "hint": "...",
    },
  ],
}
```

`budgetMode` — одно из `enforce`, `warn` или `off`. `clientBudget` отсутствует, когда бюджет не установлен. `budgets[]` — это **всегда массив** в демонах после PR-14 (возможно, пустой, когда `budgetMode === 'off'`); демоны до PR-14 полностью опускают поле. v1 выдаёт одну ячейку с `scope: 'session'` (приведение в исполнение на сессию — см. раздел capabilities выше, почему). Потребители ДОЛЖНЫ терпеть дополнительные записи `budgets[]` с нераспознанными значениями `scope` — Wave 5 PR 23 добавит `scope: 'workspace'` (или `'pool'`) наряду с ячейкой на сессию без изменения схемы.

`disabledReason` на ячейках на сервер различает отключённые оператором (`'config'` — список конфигурации `disabledMcpServers`) и отклонённые бюджетом (`'budget'` — обнаружены, но никогда не подключались из-за режима `enforce`). Отказы детерминированы по порядку объявления `Object.entries(mcpServers)`. `status: 'error', errorKind: 'budget_exhausted'` на сервере затеняет сырой `mcpStatus: 'disconnected'` (что верно, но не severity для оператора).

Приведение в исполнение бюджета в PR 14 v1 — это **на сессию, не на рабочую область**. Хотя демоны Mode B — это `1 демон = 1 рабочая область × N сессий` после #4113 на уровне процесса, `McpClientManager` конструируется внутри `Config` каждой сессии ACP через `acpAgent.newSessionConfig`, поэтому N сессий каждая применяет свою собственную копию ограничения. Снимок представляет представление bootstrap-сессии. Wave 5 PR 23 вводит общий пул MCP уровня рабочей области, который переводит это на настоящее приведение в исполнение на рабочую область.

**Обнаружение давления бюджета.** Две поверхности, обе заполнены после PR-14b:

- **Push-события** (объявлены через `mcp_guardrail_events`): подпишитесь на `GET /session/:id/events` и отберите кадры `mcp_budget_warning` / `mcp_child_refused_batch` через `KnownDaemonEvent`. State machine срабатывает один раз на пересечение 75% вверх (перезаряжается ниже 37,5%); отказы коалесцируются один раз на проход discovery в режиме `enforce`.
- **Snapshot poll** (объявлены через `mcp_guardrails`): `GET /workspace/mcp` и проверьте ячейку бюджета на сессию (`budgets[0]`):

- `budgets[0].status === 'warning'` ⇔ `liveCount >= 0.75 * clientBudget` (соответствует порогу гистерезиса, который будет использовать push-событие PR 14b).
- `budgets[0].status === 'error'` ⇔ `refusedCount > 0` (один или несколько серверов отклонены в этом проходе discovery).
- `budgets[0].status === 'ok'` ⇔ ниже порога 75% И нет отказов.

Рекомендуемая частота poll: согласована с тем, что уже опрашивает `/workspace/mcp`; снимок дёшев, и ячейка бюджета не несёт дополнительных затрат на discovery. SDK-клиенты, которые подписываются на push-события, всё равно выигрывают от снимка для состояния после длительного отключения (глубина кольца повторения SSE конечна — `--event-ring-size`, по умолчанию 8000 — поэтому клиент, offline дольше, чем покрытие кольца, использует fallback на ресинхронизацию снимка).

### `GET /workspace/skills`

```json
{
  "v": 1,
  "workspaceCwd": "/canonical/path",
  "initialized": true,
  "skills": [
    {
      "kind": "skill",
      "status": "ok",
      "name": "review",
      "description": "Review code",
      "level": "project",
      "modelInvocable": true,
      "argumentHint": "[path]"
    }
  ]
}
```

`level` — одно из `project`, `user`, `extension` или `bundled`. `errors` опускается, когда discovery успешен.

### `GET /workspace/providers`

```json
{
  "v": 1,
  "workspaceCwd": "/canonical/path",
  "initialized": true,
  "current": { "authType": "nessy", "modelId": "qwen3(nessy)" },
  "providers": [
    {
      "kind": "model_provider",
      "status": "ok",
      "authType": "nessy",
      "current": true,
      "models": [
        {
          "modelId": "qwen3(nessy)",
          "baseModelId": "qwen3",
          "name": "Nessy 3",
          "description": null,
          "contextLimit": 4096,
          "isCurrent": true,
          "isRuntime": false
        }
      ]
    }
  ]
}
```

Модели сгруппированы по типу аутентификации. Диагностика подключения провайдера находится в ячейке `providers` на `/workspace/preflight`; environment preflight находится на `/workspace/preflight` и `/workspace/env` (ниже). `errors` опускается, когда построение снимка успешно.

### `GET /workspace/env`

Сообщает о runtime, platform, sandbox, proxy процесса демона и **наличии** секретных переменных окружения из белого списка. Всегда отвечает из состояния `process.*` — демон никогда не порождает дочерний процесс ACP для обслуживания этого маршрута, и ответ идентичен, независимо от того, ACP запущен или простаивает. Поле `acpChannelLive` только для информации.

```json
{
  "v": 1,
  "workspaceCwd": "/canonical/path",
  "initialized": true,
  "acpChannelLive": false,
  "cells": [
    { "kind": "runtime", "name": "node", "status": "ok", "value": "22.4.0" },
    { "kind": "platform", "name": "darwin", "status": "ok", "value": "arm64" },
    {
      "kind": "sandbox",
      "name": "SANDBOX",
      "status": "disabled",
      "present": false
    },
    {
      "kind": "proxy",
      "name": "HTTPS_PROXY",
      "status": "ok",
      "present": true,
      "value": "proxy.internal:1080"
    },
    {
      "kind": "proxy",
      "name": "NO_PROXY",
      "status": "disabled",
      "present": false
    },
    {
      "kind": "env_var",
      "name": "OPENAI_API_KEY",
      "status": "ok",
      "present": true
    },
    {
      "kind": "env_var",
      "name": "ANTHROPIC_BASE_URL",
      "status": "disabled",
      "present": false
    }
  ]
}
```

Форма ячейки:

```ts
type DaemonEnvKind =
  | 'runtime' // name: 'node' | 'bun' | 'unknown'; value: process.versions.node
  | 'platform' // name: process.platform; value: process.arch
  | 'sandbox' // name: 'SANDBOX' | 'SEATBELT_PROFILE'; value optional
  | 'proxy' // name: HTTP_PROXY | HTTPS_PROXY | NO_PROXY | ALL_PROXY; value: redacted host
  | 'env_var'; // presence-only; value field is ALWAYS omitted

interface DaemonEnvCell extends DaemonStatusCell {
  kind: DaemonEnvKind;
  name: string;
  present?: boolean;
  value?: string;
}
```

**Политика очистки.** Ячейки `kind: 'env_var'` никогда не включают поле `value`; клиенты видят только `present: boolean`. Ячейки `kind: 'proxy'` пропускают сырое значение env через очистку учётных данных (`redactProxyCredentials`) и затем через парсинг `URL`, чтобы сеть несла только `host:port`. `NO_PROXY` проходит через очистку дословно, потому что это список хостов, а не URL. Белый список перечисленных секретных переменных окружения в настоящее время включает `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `DASHSCOPE_API_KEY`, `OPENROUTER_API_KEY` и `NESSY_SERVER_TOKEN`. Другие переменные окружения не перечислены, поэтому случайно установленные секреты остаются невидимыми.

### `GET /workspace/preflight`

Сообщает о проверках готовности демона. **Ячейки уровня демона** (`node_version`, `cli_entry`, `workspace_dir`, `ripgrep`, `git`, `npm`) всегда заполняются из `process.*` и `node:fs`. **Ячейки уровня ACP** (`auth`, `mcp_discovery`, `skills`, `providers`, `tool_registry`, `egress`) требуют активного дочернего процесса ACP — когда демон простаивает, они выдают плейсхолдеры `status: 'not_started'`. Маршрут никогда не порождает ACP исключительно для заполнения ячеек; соответствующие ячейки используют `not_started` как fallback.

Ответ при простое (нет дочернего процесса ACP):

```json
{
  "v": 1,
  "workspaceCwd": "/canonical/path",
  "initialized": true,
  "acpChannelLive": false,
  "cells": [
    {
      "kind": "node_version",
      "status": "ok",
      "locality": "daemon",
      "detail": { "version": "22.4.0", "required": ">=22" }
    },
    {
      "kind": "cli_entry",
      "status": "ok",
      "locality": "daemon",
      "detail": { "path": "/usr/local/bin/nessy", "source": "process.argv[1]" }
    },
    {
      "kind": "workspace_dir",
      "status": "ok",
      "locality": "daemon",
      "detail": { "path": "/canonical/path" }
    },
    { "kind": "ripgrep", "status": "ok", "locality": "daemon" },
    {
      "kind": "git",
      "status": "ok",
      "locality": "daemon",
      "detail": { "version": "2.45.0" }
    },
    {
      "kind": "npm",
      "status": "ok",
      "locality": "daemon",
      "detail": { "version": "10.7.0" }
    },
    {
      "kind": "auth",
      "status": "not_started",
      "locality": "acp",
      "hint": "spawn a session to populate"
    },
    {
      "kind": "mcp_discovery",
      "status": "not_started",
      "locality": "acp",
      "hint": "spawn a session to populate"
    },
    {
      "kind": "skills",
      "status": "not_started",
      "locality": "acp",
      "hint": "spawn a session to populate"
    },
    {
      "kind": "providers",
      "status": "not_started",
      "locality": "acp",
      "hint": "spawn a session to populate"
    },
    {
      "kind": "tool_registry",
      "status": "not_started",
      "locality": "acp",
      "hint": "spawn a session to populate"
    },
    {
      "kind": "egress",
      "status": "not_started",
      "locality": "acp",
      "hint": "egress probing lands in PR 14 (#4175)"
    }
  ]
}
```

Форма ячейки:

```ts
type DaemonPreflightKind =
  | 'node_version'
  | 'cli_entry'
  | 'workspace_dir'
  | 'ripgrep'
  | 'git'
  | 'npm'
  | 'auth'
  | 'mcp_discovery'
  | 'skills'
  | 'providers'
  | 'tool_registry'
  | 'egress';

interface DaemonPreflightCell extends DaemonStatusCell {
  kind: DaemonPreflightKind;
  locality: 'daemon' | 'acp';
  detail?: Record<string, unknown>;
}
```

Семантика `errorKind`:

- `missing_binary` — версия Node ниже требуемой, отсутствует `NESSY_CLI_ENTRY`, ripgrep / git / npm не на PATH (предупреждения, а не ошибки для опциональных бинарников).
- `missing_file` — `boundWorkspace` не существует или не является директорией; ошибка парсинга навыка указывает на отсутствующий или нечитаемый файл.
- `parse_error` — сбой парсинга `SKILL.md`, malformed config JSON.
- `auth_env_error` — `validateAuthMethod` вернул non-null строку неудачи или подкласс `ModelConfigError` распространён из разрешения провайдера.
- `init_timeout` — `withTimeout` reject в bridge (фактический тайм-аут во время ожидания ACP roundtrip). Распознаётся через типизированный класс `BridgeTimeoutError`. Примечание: временная ячейка `mcp_discovery` `warning` с `connecting > 0` НЕ несёт этот kind — это нормальное состояние handshake-in-progress, отличное от реального тайм-аута.
- `protocol_error` — ACP `extMethod` отклонён, потому что канал закрылся mid-request или потому что tool registry неожиданно отсутствовал.
- `blocked_egress` — зарезервировано для PR 14 (#4175). PR 13 оставляет ячейку `egress` как `status: 'not_started'`.

Если bridge не может достичь дочернего процесса ACP при обслуживании запроса preflight (например, закрытие канала mid-request), массив `errors` конверта несёт одну `ServeStatusCell`, описывающую сбой, и ячейки используют плейсхолдеры ACP `not_started` как fallback. Ячейки уровня демона всё ещё возвращаются.
### Workspace file routes

Все пути к файлам разрешаются относительно привязанной рабочей области демона. Ответы используют пути относительно рабочей области и никогда не возвращают абсолютные пути файловой системы в обычных успешных случаях. Успешные ответы о файлах включают:

```http
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

Ошибки файловой системы имеют следующую JSON-форму:

```json
{
  "errorKind": "hash_mismatch",
  "error": "expected sha256:..., found sha256:...",
  "hint": "re-read the file and retry with the latest hash",
  "status": 409
}
```

Значения `errorKind` включают `path_outside_workspace`, `symlink_escape`, `path_not_found`, `binary_file`, `file_too_large`, `untrusted_workspace`, `permission_denied`, `parse_error`, `hash_mismatch`, `file_already_exists`, `text_not_found` и `ambiguous_text_match`.

#### `GET /file`

Читает текстовый файл. Параметры запроса: `path` (обязательный), `maxBytes`, `line` и `limit`. Демон отклоняет бинарные файлы и файлы, превышающие лимит на чтение текста. Ответ включает `hash` — SHA-256 дайджест сырых байтов на диске для всего файла, даже когда `line`, `limit` или `maxBytes` вернули срез.

```json
{
  "kind": "file",
  "path": "src/index.ts",
  "content": "export {};\n",
  "encoding": "utf-8",
  "bom": false,
  "lineEnding": "lf",
  "sizeBytes": 11,
  "returnedBytes": 11,
  "truncated": false,
  "hash": "sha256:...",
  "matchedIgnore": null,
  "originalLineCount": null
}
```

#### `GET /file/bytes`

Читает сырые байты из файла без декодирования. Параметры запроса: `path` (обязательный), `offset` (по умолчанию `0`) и `maxBytes` (по умолчанию `65536`, максимум `262144`). Этот маршрут поддерживает ограниченные окна для больших бинарных файлов без загрузки всего файла. Ответ включает `hash` только когда возвращённое окно покрывает весь файл.

```json
{
  "kind": "file_bytes",
  "path": "assets/logo.png",
  "offset": 0,
  "sizeBytes": 3912,
  "returnedBytes": 3912,
  "truncated": false,
  "contentBase64": "...",
  "hash": "sha256:..."
}
```

#### `POST /file/write`

Создаёт или заменяет текстовый файл. Это строгий маршрут изменения: на loopback без настроенного токена он возвращает `401 { "code": "token_required" }`. С `--require-auth` глобальный bearer middleware отклоняет неаутентифицированные запросы до выполнения маршрута.

Тело запроса:

```json
{
  "path": "src/new.ts",
  "content": "export const value = 1;\n",
  "mode": "create"
}
```

```json
{
  "path": "src/existing.ts",
  "content": "export const value = 2;\n",
  "mode": "replace",
  "expectedHash": "sha256:..."
}
```

`mode` должен быть `create` или `replace`. `create` никогда не перезаписывает существующий файл (`409 file_already_exists`). `replace` требует `expectedHash`; отсутствующие или некорректные хеши возвращают `400 parse_error`, устаревшие хеши — `409 hash_mismatch`. `expectedHash` — это `sha256:` плюс 64 строчных шестнадцатеричных символов, вычисленных по сырым байтам на диске.

`bom`, `encoding` и `lineEnding` могут быть указаны. Замена по умолчанию сохраняет профиль кодировки существующего файла; явные поля переопределяют его. Запись бинарных данных вне области применения.

Демон записывает во временный файл в целевом каталоге, делает fsync где поддерживается, повторно проверяет текущий хеш непосредственно перед `rename()`, затем переименовывает на место. Это предотвращает наблюдение частичных файлов и сериализует исходящие от демона записи в тот же файл, но это не межпроцессное kernel compare-and-swap: внешний редактор всё ещё может войти в гонку в крошечное окно между финальной проверкой хеша и переименованием.

```json
{
  "kind": "file_write",
  "path": "src/existing.ts",
  "mode": "replace",
  "created": false,
  "sizeBytes": 24,
  "hash": "sha256:...",
  "encoding": "utf-8",
  "bom": false,
  "lineEnding": "lf",
  "matchedIgnore": null
}
```

#### `POST /file/edit`

Применяет одну точную замену текста в существующем текстовом файле. Это также строгий маршрут изменения и требует `expectedHash`.

```json
{
  "path": "src/config.ts",
  "oldText": "timeout: 30000",
  "newText": "timeout: 60000",
  "expectedHash": "sha256:..."
}
```

`oldText` должен быть непустым и встречаться ровно один раз. Отсутствие совпадения возвращает `422 text_not_found`; множественные совпадения возвращают `422 ambiguous_text_match`. Маршрут сохраняет кодировку, BOM и окончания строк, и повторно проверяет `expectedHash` непосредственно перед атомарным переименованием.

Явные записи/правки в игнорируемые пути разрешены, потому что аутентифицированный вызывающий явно указал путь. Ответы об успехе и аудиторские события включают `matchedIgnore: "file" | "directory" | null`.

```json
{
  "kind": "file_edit",
  "path": "src/config.ts",
  "replacements": 1,
  "sizeBytes": 128,
  "hash": "sha256:...",
  "encoding": "utf-8",
  "bom": false,
  "lineEnding": "lf",
  "matchedIgnore": null
}
```

### `GET /session/:id/context`

```json
{
  "v": 1,
  "sessionId": "<sid>",
  "workspaceCwd": "/canonical/path",
  "state": {
    "models": {},
    "modes": {},
    "configOptions": []
  }
}
```

`state` отражает те же формы модели/режима/опции конфигурации ACP, используемые в `POST /session`, `POST /session/:id/load` и `POST /session/:id/resume`.

### `GET /session/:id/supported-commands`

```json
{
  "v": 1,
  "sessionId": "<sid>",
  "availableCommands": [
    {
      "name": "init",
      "description": "Initialize the project",
      "input": null,
      "_meta": { "source": "builtin" }
    }
  ],
  "availableSkills": ["review"]
}
```

`availableCommands` — это тот же снимок команд, используемый SSE-уведомлением `available_commands_update`. `availableSkills` перечисляет только имена навыков; клиенты не должны ожидать тела навыков или пути через этот маршрут.

### `GET /session/:id/tasks`

```json
{
  "v": 1,
  "sessionId": "<sid>",
  "now": 1700000000000,
  "tasks": [
    {
      "kind": "agent",
      "id": "agent-1",
      "label": "reviewer: check failure",
      "description": "check failure",
      "status": "running",
      "startTime": 1699999999000,
      "runtimeMs": 1000,
      "outputFile": "/tmp/agent-1.jsonl",
      "isBackgrounded": true,
      "subagentType": "reviewer"
    }
  ]
}
```

Этот маршрут возвращает снимок только для чтения вне полосы. Он намеренно не является prompt и может запрашиваться, пока сессия потоково передаёт данные. Ответ содержит только разрешённые метаданные из реестров задач агента, shell и monitor; контроллеры, таймеры, смещения, ожидающие сообщения и необработанные объекты реестров никогда не раскрываются.

### `GET /session/:id/lsp`

```json
{
  "v": 1,
  "sessionId": "<sid>",
  "workspaceCwd": "/canonical/path",
  "enabled": true,
  "configuredServers": 1,
  "readyServers": 1,
  "failedServers": 0,
  "inProgressServers": 0,
  "notStartedServers": 0,
  "servers": [
    {
      "name": "typescript",
      "status": "READY",
      "languages": ["typescript", "javascript"],
      "transport": "stdio",
      "command": "typescript-language-server"
    }
  ]
}
```

`status` принимает одно из значений `NOT_STARTED`, `IN_PROGRESS`, `READY` или `FAILED`. Для завершившихся ошибкой серверов при наличии добавляется необязательное поле `error`. Отключённый LSP (включая bare mode) возвращает HTTP 200 с `enabled: false`, нулевыми счётчиками и `servers: []`. Включённый LSP без настроенных серверов возвращает `enabled: true`, `configuredServers: 0` и `servers: []`. Если инициализация завершается ошибкой до создания клиента, ответ может содержать `initializationError`; если живой клиент не может предоставить снимок, ответ содержит `statusUnavailable: true`.

Этот маршрут раскрывает только стабильные поля для клиентов. Он намеренно не включает отладочные внутренние данные: идентификаторы процессов, аргументы запуска, хвосты stderr, корневые URI и пути папок рабочей области.

### `POST /session`

Создаёт новую сессию агента или присоединяется к существующей (при `sessionScope: 'single'`, значении по умолчанию).

Запрос:

```json
{
  "cwd": "/absolute/path/to/workspace",
  "modelServiceId": "nessy-prod",
  "sessionScope": "thread"
}
```

| Поле             | Обязательно | Примечания                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`            | нет         | Абсолютный путь, совпадающий с привязанным workspace демона. Если опущено, маршрут использует `boundWorkspace` (прочитайте его из `/capabilities.workspaceCwd`). Несовпадающий непустой `cwd` возвращает `400 workspace_mismatch` (#3803 §02 — 1 демон = 1 workspace). Пути workspace канонизируются через `realpathSync.native` (с fallback только на разрешение для несуществующих путей), чтобы файловые системы без учёта регистра не отклоняли сессии из-за написания.                                                                                                                                                                            |
| `modelServiceId` | нет         | Выбирает, через какой настроенный _model service_ агент будет маршрутизировать запросы (бэкенд-провайдер — Alibaba ModelStudio, OpenRouter и т.д.). Если опущено, агент использует сервис по умолчанию. Если workspace уже имеет сессию, это вызывает `setSessionModel` на существующей и транслирует `model_switched`. Отличается от `modelId` в `POST /session/:id/model`, который выбирает модель **внутри** уже привязанного сервиса. Массив `modelServices` в `/capabilities` зарезервирован для рекламы настроенных сервисов; в Stage 1 он всегда `[]` (сервис агента по умолчанию используется и не перечисляется через HTTP). |
| `sessionScope`   | нет         | Переопределение для каждой сессии для совместного использования сессий. `'single'` (значение по умолчанию для демона) заставляет второй `POST /session` для того же workspace повторно использовать существующую сессию (`attached: true`); `'thread'` принудительно создаёт новую отдельную сессию при каждом вызове. Опустите, чтобы унаследовать значение по умолчанию для демона. Значения вне enum возвращают `400 { code: 'invalid_session_scope' }`. Старые демоны (до #4175 PR 5) молча игнорируют это поле — делайте pre-flight `caps.features.session_scope_override` перед отправкой. Значение по умолчанию для демона жёстко закодировано как `'single'` в продакшене сегодня; #4175 может добавить CLI-флаг `--sessionScope` в последующем обновлении.          |

Ответ:

```json
{
  "sessionId": "<uuid>",
  "workspaceCwd": "/canonical/path",
  "attached": false
}
```

`attached: true` означает, что сессия для этого workspace уже существовала и вы теперь присоединяетесь к ней.

Одновременные вызовы `POST /session` для одного и того же workspace **объединяются** в одно создание — оба вызывающих получают одинаковый `sessionId`, только один сообщает `attached: false`. Если базовое создание завершается ошибкой (init timeout, malformed agent output, OOM), **все объединённые вызывающие получают одну и ту же ошибку** — слот in-flight очищается, поэтому повторный вызов может повторить попытку с нуля.

> ⚠️ **Отклонение `modelServiceId` на новой сессии молчаливо в HTTP-ответе.** Неправильный `modelServiceId` (опечатка, ненастроенный сервис) не приводит к 500 при создании — сессия остаётся работоспособной на модели агента по умолчанию, поэтому вызывающий всё ещё получает `sessionId`, с которым можно повторить переключение модели (через `POST /session/:id/model`). Видимый сигнал ошибки — событие `model_switch_failed` в SSE-потоке сессии, отправленное между handshake создания и вашей первой подпиской. **Подписчики, которым нужно наблюдать это событие, должны передать `Last-Event-ID: 0` в своём первом `GET /session/:id/events`** для воспроизведения с самого старого доступного события ring (охватывает `model_switch_failed` времени создания, даже если подписка происходит через несколько мс после ответа create).

### `POST /session/:id/load`

Восстанавливает сохранённую сессию ACP по id и воспроизводит её историю через SSE. Id в пути является авторитетным; любое поле `sessionId` в теле игнорируется. Делайте pre-flight `caps.features.session_load` — старые демоны возвращают `404` для этого маршрута.

Запрос:

```json
{
  "cwd": "/absolute/path/to/workspace"
}
```

| Поле  | Обязательно | Примечания                                                                                                                                                                                                                               |
| ----- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd` | нет         | Те же правила каноникализации + `workspace_mismatch`, что и для `POST /session`. Опустите, чтобы унаследовать `/capabilities.workspaceCwd`. `mcpServers` намеренно НЕ принимается здесь — MCP на уровне демона управляется настройками (соответствует `POST /session`). |

Ответ:

```json
{
  "sessionId": "persisted-1",
  "workspaceCwd": "/canonical/path",
  "attached": false,
  "state": {
    "models": { ... },
    "modes": { ... },
    "configOptions": [ ... ]
  }
}
```

`state` зеркалит `LoadSessionResponse` из ACP — `models` это `SessionModelState`, `modes` это `SessionModeState`, `configOptions` это массив `SessionConfigOption`. Отсутствующие поля определяются агентом. Поздние присоединившиеся (пути `attached: true` ниже) получают тот же снимок `state`, который видел оригинальный вызывающий `load` — демон кэширует его на записи; runtime-мутации (например, `model_switched`) доставляются через SSE-поток, а не в последующих ответах на присоединение.

`attached: true` означает, что сессия уже была активна (либо от предыдущего `session/load`/`session/resume`, либо потому что конкурирующий одновременный вызывающий опередил вас).

**Воспроизведение истории через SSE.** Пока `loadSession` выполняется на стороне агента, агент отправляет уведомления `session_update` для каждого сохранённого хода. Демон буферизует их в шину событий сессии перед возвратом ответа маршрута, поэтому подписчики, которые немедленно вызывают `GET /session/:id/events` с `Last-Event-ID: 0`, видят полное воспроизведение. **Кольцо воспроизведения ограничено** (по умолчанию 8000 кадров на сессию). Длинные истории со многими ходами tool-call / thought-stream могут превысить это — самые старые кадры молча отбрасываются. Клиенты, которым нужна полная история, должны подписаться немедленно после возврата `load`; альтернативно они могут сохранить event ids SSE и использовать `Last-Event-ID` для возобновления с более поздней границы хода.

**Ошибки:**

- `404` — id сохранённой сессии не существует (`SessionNotFoundError`).
- `400` — `workspace_mismatch` (та же форма, что и `POST /session`).
- `503` — `session_limit_exceeded` (учитывается в `--max-sessions`; in-flight восстановления также учитываются).
- `409` — `restore_in_progress` (уже выполняется `session/resume` для того же id). `Retry-After: 5`. Конкурирующие вызовы одного действия (два одновременных `session/load` для одного id) объединяются — только один возвращает `attached: false`, остальные возвращают `attached: true` с тем же `state`.

### `POST /session/:id/resume`

Восстанавливает сохранённую сессию ACP по id БЕЗ воспроизведения истории через SSE. Контекст модели восстанавливается внутри на стороне агента (через `geminiClient.initialize`, читающий `config.getResumedSessionData`); SSE-поток остаётся чистым для клиентов, у которых история уже отображена. Делайте pre-flight `caps.features.session_resume`; `unstable_session_resume` остаётся устаревшим псевдонимом для старых клиентов.

Та же форма запроса, что и для `/load`. Та же форма ответа — `state` зеркалит `ResumeSessionResponse` из ACP. Та же форма ошибок, включая `409 restore_in_progress` (которое срабатывает, когда `session/load` выполняется; `session/resume`, конкурирующий за другим `session/resume`, объединяется).

Используйте `/load`, когда у клиента нет отображённой истории (холодное переподключение, picker → open). Используйте `/resume`, когда у клиента уже есть ходы на экране и нужен только handle на стороне демона.

> ⚠️ **Почему `unstable_session_resume` всё ещё рекламируется?** HTTP-маршрут демона и capability `session_resume` стабильны для v1, но bridge всё ещё вызывает `connection.unstable_resumeSession` из ACP. Старый тег остаётся только для того, чтобы SDK, выпущенные до `session_resume`, продолжали работать.

### `GET /workspace/:id/sessions`

Список всех активных сессий, чей канонический workspace совпадает с `:id` (URL-encoded absolute cwd).

```bash
curl http://127.0.0.1:4170/workspace/$(jq -rn --arg c "$PWD" '$c|@uri')/sessions
```

Ответ:

```json
{
  "sessions": [
    {
      "sessionId": "<uuid>",
      "workspaceCwd": "/canonical/path",
      "createdAt": "2026-05-17T08:30:00.000Z",
      "displayName": "My Session",
      "clientCount": 2,
      "hasActivePrompt": false
    }
  ]
}
```

Пустой массив (не 404), когда сессий нет — UI выбора сессии не должен завершаться ошибкой просто потому, что workspace простаивает.

### `POST /session/:id/prompt`

Пересылает промпт агенту. Вызывающие с несколькими промптами ставят их в очередь FIFO на сессию (ACP гарантирует один активный промпт на сессию).

Запрос:

```json
{
  "prompt": [{ "type": "text", "text": "What does src/main.ts do?" }]
}
```

Валидация: `prompt` должен быть непустым массивом объектов. Другие ошибки возвращают `400` до достижения bridge.

Ответ:

```json
{ "stopReason": "end_turn" }
```

Другие причины остановки: `cancelled`, `max_tokens`, `error`, `length` (согласно спецификации ACP).

Если HTTP-клиент отключается во время промпта, демон отправляет уведомление ACP `cancel` агенту, который завершает промпт с `stopReason: "cancelled"`.

> **Ограничение Stage 1 — нет тайм-аута промпта на стороне сервера.** Bridge только соревнует `prompt()` агента против `transportClosedReject` (падения дочернего процесса агента) и AbortSignal отключения HTTP от вызывающего. Заклинивший, но живой агент (например, зависший вызов модели) блокирует FIFO сессии до тех пор, пока HTTP-клиент не истечёт по тайм-ауту на своей стороне и не отключится. Долго работающие промпты легитимны (глубокое исследование, анализ большой кодовой базы), поэтому дедлайн по умолчанию намеренно не установлен; Stage 2 предоставит opt-in для настраиваемого `promptTimeoutMs`. До тех пор вызывающие должны установить свой собственный тайм-аут на стороне клиента и отключиться (или вызвать `POST /session/:id/cancel`) по истечении.

### `POST /session/:id/cancel`

Отменяет **текущий активный** промпт на сессии. На стороне ACP это уведомление, а не запрос — агент подтверждает, разрешая активный `prompt()` с `cancelled`.

```bash
curl -X POST http://127.0.0.1:4170/session/$SID/cancel
# → 204 No Content
```

> **Контракт нескольких промптов:** отмена влияет только на активный промпт. Любые промпты, которые тот же клиент ранее отправил через POST и которые всё ещё находятся в очереди за активным, продолжат выполняться. Очереди нескольких промптов — это поведение, введённое демоном (не в спецификации ACP); контракт дляqueued промптов: «они продолжают выполняться, если вы не отмените каждый, или не завершите сессию через выход из канала».

### `DELETE /session/:id`

Явно закрывает активную сессию. Принудительно закрывает, даже когда другие клиенты присоединены — отменяет любой активный промпт, разрешает ожидающие разрешения как отменённые, публикует событие `session_closed`, закрывает EventBus и удаляет сессию из мап демона. Сохранённые на диске сессии НЕ удаляются — их можно перезагрузить через `POST /session/:id/load`. Делайте pre-flight `caps.features.session_close`.

```bash
curl -X DELETE http://127.0.0.1:4170/session/$SID
# → 204 No Content
```

Идемпотентно: возвращает `404` для неизвестных сессий (та же форма `SessionNotFoundError`, что и для других маршрутов).

> **Событие `session_closed`.** SSE-подписчики получают терминальное событие `session_closed` с `{ sessionId, reason: 'client_close', closedBy?: '<clientId>' }` перед завершением потока. SDK-редьюсеры обрабатывают это идентично `session_died` (устанавливает `alive: false`, очищает `pendingPermissions`).

### `PATCH /session/:id/metadata`

Обновляет изменяемые метаданные сессии. В настоящее время поддерживает только `displayName`. Делайте pre-flight `caps.features.session_metadata`.

Запрос:

```json
{ "displayName": "My Investigation Session" }
```

| Поле            | Обязательно | Примечания                                                                   |
| --------------- | ----------- | ---------------------------------------------------------------------------- |
| `displayName`   | нет         | Строка, максимум 256 символов. Пустая строка очищает имя. Опустите, чтобы оставить без изменений. |

Ответ:

```json
{ "sessionId": "<uuid>", "displayName": "My Investigation Session" }
```

Публикует событие `session_metadata_updated` в SSE-поток сессии с `{ sessionId, displayName }`.

### `POST /session/:id/heartbeat`

Обновляет учёт последнего появления демона для этой сессии. Долгоживущие адаптеры (TUI/IDE/web) пингуют это через интервал, чтобы будущая политика отзыва (Wave 5 PR 24) могла отличать мёртвые клиенты от тихих.

Заголовки:

| Заголовок         | Обязательно | Примечания                                                                                                                                                                                                                                    |
| ----------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Nessy-Client-Id` | нет         | Возвращает id, выданный демоном, из `POST /session`. Идентифицированные клиенты также обновляют свою метку времени на клиента; анонимные heartbeat обновляют только водяной знак сессии. Должен удовлетворять той же форме `[A-Za-z0-9._:-]{1,128}`, что и везде. |

Тело запроса пустое (`{}` допустимо — сегодня поля не читаются).

Ответ:

```json
{
  "sessionId": "<sid>",
  "clientId": "<cid>",
  "lastSeenAt": 1700000000123
}
```

`clientId` возвращается только когда предоставлен доверенный `X-Nessy-Client-Id`. `lastSeenAt` это эпоха `Date.now()` на стороне демона (мс), которую bridge сохранил.

Ошибки:

- `400` — `{ code: 'invalid_client_id' }` когда заголовок malformed (правило формы заголовка) или когда он несёт `clientId`, который не зарегистрирован для этой сессии (bridge выбрасывает `InvalidClientIdError` до обновления любой метки времени).
- `404` — неизвестная сессия.

Gating capability: делайте pre-flight `caps.features.client_heartbeat`. Старые демоны возвращают `404` для этого пути.

### `POST /session/:id/model`

Переключает активную модель **внутри** текущего привязанного сервиса модели сессии. Сериализуется через очередь изменения модели сессии.

(Для переключения самого _сервиса_ — Alibaba ModelStudio против OpenRouter и т.д. — передайте `modelServiceId` в `POST /session` для новой сессии. В Stage 1 нет маршрута переключения сервиса в реальном времени.)

Запрос:

```json
{ "modelId": "nessy-staging" }
```

Ответ:

```json
{ "modelId": "nessy-staging" }
```

При успехе публикует `model_switched` в SSE-поток. При неудаче публикует `model_switch_failed` (чтобы пассивные подписчики видели неудачу, а не только вызывающий). Соревнуется с выходом из канала агента, чтобы заклинивший дочерний процесс не мог заблокировать HTTP-обработчик.

### `POST /session/:id/recap`

Capability tag: `session_recap`. Bridge → ACP extMethod `nessy/control/session/recap`.

Формирует одно предложение с ответом на вопрос «на чём я остановился» для сессии. Маршрут оборачивает `generateSessionRecap` из core (`packages/core/src/services/sessionRecap.ts`): функция выполняет побочный запрос к быстрой модели с отключёнными инструментами, `maxOutputTokens: 300` и строгим форматом вывода `<recap>...</recap>`. Побочный запрос читает существующую историю чата `GeminiClient` сессии и не добавляет в неё сообщения.

Тело запроса игнорируется (отправьте `{}` или пустое тело). Нестрогий mutation gate — режим соответствует `/session/:id/prompt`: вызов расходует токены, но не изменяет состояние. Событие SSE не публикуется.

Ответ (200):

```json
{
  "sessionId": "sess:42",
  "recap": "Debugging the auth retry race. Next: add deterministic timing to the integration test."
}
```

`recap` равен `null` (обычный ответ 200, а не ошибка), когда:

- в сессии ещё меньше двух диалоговых ходов;
- побочный запрос не вернул извлекаемую полезную нагрузку `<recap>...</recap>`;
- возникла любая ошибка модели (вспомогательная функция core работает в режиме best effort и никогда не выбрасывает исключение).

Ошибки:

- `400 {code: 'invalid_client_id'}` — некорректный заголовок `X-Nessy-Client-Id`.
- `404` — неизвестная сессия.

Отмена: **в v1 отсутствует**. Маршрут не отслеживает отключение HTTP-клиента, `AbortSignal` не передаётся в bridge, а дочерний процесс ACP выполняет побочный запрос до конца независимо от того, отключился ли вызывающий клиент. Единственные ограничения — резервный тайм-аут bridge в 60 секунд (`SESSION_RECAP_TIMEOUT_MS`) и гонка закрытия транспорта при завершении ACP-канала. Это приемлемо, поскольку recap короткий (одна попытка, `maxOutputTokens: 300`, обычно около 1–5 секунд); в будущем при достаточной пользе относительно затрат трафика можно добавить ext-method отмены по request ID и провести полную сквозную отмену.

### Мутации: approval, tools, init, перезапуск MCP

Issue [#4175](https://github.com/NessyLM/nessy-cli/issues/4175) Wave 4 PR 17 добавляет четыре маршрута управления изменениями, которые позволяют удалённым клиентам изменять поведение системы во время выполнения без обращения к CLI на хосте демона. Все четыре:

- Защищены **strict** mutation gate из PR 15. Демон, сконфигурированный без bearer-токена, отклоняет их с `401 {code: 'token_required'}`. Настройте `--token` (или `NESSY_SERVER_TOKEN`) перед включением.
- Принимают и помечают заголовок `X-Nessy-Client-Id` (audit chain из PR 7). Когда заголовок содержит доверенный id, демон передаёт `originatorClientId` в соответствующее SSE-событие, чтобы cross-client UI могли подавлять эхо собственных мутаций.
- Делайте pre-flight каждого capability по тегу перед предоставлением возможности использования. Старые демоны возвращают `404` для маршрута.

Три из четырёх маршрутов (`tools/:name/enable`, `init`, `mcp/:server/restart`) передают **workspace-события**: каждая активная сессионная SSE-шина получает событие, независимо от того, какая сессия была прикреплена в момент срабатывания мутации. `approval-mode` передаёт **session-событие**, потому что изменение локально для `Config` одной сессии.

#### `POST /session/:id/approval-mode`

Capability tag: `session_approval_mode_control`. Bridge → ACP extMethod `nessy/control/session/approval_mode`.

Изменение режима одобрения активной сессии. Новый режим попадает в per-session `Config` ACP-дочернего процесса немедленно. Настройки НЕ записываются на диск по умолчанию — передайте `persist: true`, чтобы также записать `tools.approvalMode` в настройки workspace.

Запрос:

```json
{ "mode": "auto-edit", "persist": false }
```

`mode` должен быть одним из `'plan' | 'default' | 'auto-edit' | 'auto' | 'yolo'` (зеркало enum `ApprovalMode` из core; SDK экспортирует `DAEMON_APPROVAL_MODES` для runtime-валидации). `persist` по умолчанию `false`.

Ответ (200):

```json
{
  "sessionId": "sess:42",
  "mode": "auto-edit",
  "previous": "default",
  "persisted": false
}
```

Ошибки:

- `400 {code: 'invalid_approval_mode', allowed: [...]}` — неизвестный режим.
- `400 {code: 'invalid_persist_flag'}` — `persist` не boolean.
- `403 {code: 'trust_gate', errorKind: 'auth_env_error'}` — запрошенный режим требует доверенную папку (привилегированные режимы в недоверенных workspace отклоняются через `Config.setApprovalMode` из core).
- `404` — сессия неизвестна.

SSE-событие (session-scoped): `approval_mode_changed` с `{sessionId, previous, next, persisted, originatorClientId?}`.

#### `POST /workspace/tools/:name/enable`

Capability tag: `workspace_tool_toggle`. Чистый file IO — без ACP roundtrip.

Переключение имени инструмента в списке настроек `tools.disabled` workspace. Инструменты, указанные там, **не регистрируются** вообще (в отличие от `permissions.deny`, который сохраняет инструмент зарегистрированным и отклоняет вызов). И встроенные инструменты, и обнаруженные через MCP инструменты проходят через `ToolRegistry.registerTool`, который сверяется с отключённым набором.

> ⚠️ **Имена должны точно совпадать с идентификатором registry.** Разрешение алиасов не происходит — маршрут сохраняет любую строку из параметра пути в `tools.disabled`, а следующий ACP-дочерний процесс сравнивает с `tool.name` во время регистрации. Встроенные инструменты используют каноническое registry-имя (snake_case глагольная форма): `run_shell_command`, `read_file`, `write_file`, `list_directory`, `glob`, `grep_search`, `web_fetch` и т.д. — НЕ display labels (`Shell`, `Read`, `Write`), которые показывает CLI. MCP-инструменты используют квалифицированную форму `mcp__<server>__<name>` (которая также транслируется в событиях `tool_toggled` и перечисляется в `GET /workspace/mcp`). Отключение `Bash` НЕ предотвратит регистрацию `run_shell_command` при следующем запуске.

Активные ACP-дочерние процессы сохраняют уже зарегистрированные инструменты — переключение вступает в силу при **следующем** запуске ACP-дочернего процесса. Скомбинируйте с `POST /workspace/mcp/:server/restart` (для инструментов из MCP) или созданием новой сессии, чтобы изменение вступило в силу в текущем демоне.

Неизвестные имена инструментов принимаются: предварительное отключение ещё не установленного MCP-инструмента — легитимный сценарий.

Запрос:

```json
{ "enabled": false }
```

Ответ (200):

```json
{ "toolName": "run_shell_command", "enabled": false }
```

Ошибки:

- `400 {code: 'invalid_tool_name'}` — пустой параметр пути или параметр пути превышает 256-символьный лимит.
- `400 {code: 'invalid_enabled_flag'}` — `enabled` отсутствует или не boolean.

SSE-событие (workspace-scoped): `tool_toggled` с `{toolName, enabled, originatorClientId?}`.

#### `POST /workspace/init`

Capability tag: `workspace_init`. Чистый file IO — без ACP roundtrip, **без вызова LLM**.

Создание пустого `NESSY.md` (или whatever `getCurrentGeminiMdFilename()` возвращает при `--memory-file-name` overrides) в корне workspace, привязанного к демону. Только механика — для AI-driven заполнения контента сделайте follow-up через `POST /session/:id/prompt`.

По умолчанию отказывается перезаписывать, когда целевой файл существует с non-whitespace контентом. Файлы только с пробелами считаются отсутствующими (соответствует локальной slash-команде `/init`).

Запрос:

```json
{ "force": false }
```

Ответ (200):

```json
{ "path": "/work/bound/NESSY.md", "action": "created" }
```

`action` равен `'created'` для новых созданий, `'noop'` когда существующий файл только с пробелами оставлен без изменений (запись не выполнялась), и `'overwrote'` когда `force: true` заменил non-empty контент. SSE-событие `workspace_initialized` зеркалирует action ответа — наблюдатели могут фильтровать для `action !== 'noop'`, чтобы реагировать только на фактические изменения на диске.

Ошибки:

- `400 {code: 'invalid_force_flag'}` — `force` не boolean.
- `409 {code: 'workspace_init_conflict', path, existingSize}` — файл существует с non-whitespace контентом и `force` опущен/false. Тело содержит абсолютный путь и размер (байты), чтобы SDK-клиенты могли отобразить запрос «перезаписать N байт?» без повторного stat'а.

SSE-событие (workspace-scoped): `workspace_initialized` с `{path, action, originatorClientId?}`.

#### `POST /workspace/mcp/:server/restart`

Capability tag: `workspace_mcp_restart`. Bridge → ACP extMethod `nessy/control/workspace/mcp/restart`.

Перезапуск настроенного MCP-сервера через `McpClientManager.discoverMcpToolsForServer` ACP-дочернего процесса (disconnect + reconnect + rediscover). Делает pre-check снимка бюджета из PR 14 v1 accounting, поэтому перезапуск на budget-saturated workspace возвращает мягкий отказ вместо запуска каскада `BudgetExhaustedError`.

Тело запроса пустое (`{}`). Параметр пути — URL-кодированное имя сервера, как оно указано в конфиге `mcpServers`.

Ответ (200) — discriminated union по `restarted`:

```json
{ "serverName": "docs", "restarted": true, "durationMs": 1234 }
```

```json
{
  "serverName": "docs",
  "restarted": false,
  "skipped": true,
  "reason": "budget_would_exceed"
}
```

Причины мягкого пропуска (все возвращают 200):

| `reason`                | Значение                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'in_flight'`           | Другое обнаружение / перезапуск для этого сервера уже выполняется. Маршрут возвращается немедленно, не дожидаясь оригинального promise. Вызывающий должен повторить после короткой задержки. |
| `'disabled'`            | Сервер сконфигурирован, но указан в `excludedMcpServers`. Включите перед перезапуском.                                                                                                       |
| `'budget_would_exceed'` | Демон в `--mcp-budget-mode=enforce`, целевой сервер сейчас не в `reservedSlots`, и live-счётчик достиг `clientBudget`. Вызывающий должен сначала освободить слот.                            |

Ошибки (не 2xx):

- `400 {code: 'invalid_server_name'}` — пустой параметр пути.
- `404` — имя сервера не в конфиге `mcpServers` или отсутствует активный ACP-канал (перезапуск по определению требует активный экземпляр `McpClientManager`).
- `500` — внутренняя ошибка (например, `ToolRegistry` не инициализирован).

SSE-события (workspace-scoped): `mcp_server_restarted` с `{serverName, durationMs, originatorClientId?}` при успехе; `mcp_server_restart_refused` с `{serverName, reason, originatorClientId?}` при мягком пропуске.

### `GET /session/:id/events` (SSE)

Подписка на поток событий сессии.

Заголовки:

```
Accept: text/event-stream
Last-Event-ID: 42        ← опционально, воспроизведение начиная после id 42
```

Параметры запроса:

| Параметр    | Обязателен | Примечания                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxQueued` | нет        | Лимит **live-backlog** на подписчика. Диапазон `[16, 2048]`, по умолчанию 256. Кадры воспроизведения, принудительно отправленные при подписке, освобождены от лимита; лимит потребляют live-события, приходящие пока подписчик всё ещё обрабатывает большое воспроизведение `Last-Event-ID: 0`. Увеличьте для холодных переподключений, чтобы live tail не срабатывал slow-client warning / eviction пока потребитель не догонит. Out-of-range / non-decimal / present-but-empty значения возвращают `400 invalid_max_queued` перед SSE handshake. Pre-flight `caps.features.slow_client_warning` — старые демоны молча игнорируют параметр. |

Формат кадра. Строка `data:` — это **полная event envelope**, JSON-stringified на одной строке — `{id?, v, type, data, originatorClientId?}`. ACP-специфичный payload (`sessionUpdate`, аргументы `requestPermission` и т.д.) находится в поле `data` envelope; собственное `type` envelope совпадает со SSE `event:` строкой.

```
id: 7
event: session_update
data: {"id":7,"v":1,"type":"session_update","data":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"…"}}}

id: 8
event: permission_request
data: {"id":8,"v":1,"type":"permission_request","data":{"requestId":"<uuid>","sessionId":"<sid>","toolCall":{...},"options":[...]}}

: heartbeat              ← каждые 15с, без payload

event: client_evicted    ← terminal frame, без id (synthetic)
data: {"v":1,"type":"client_evicted","data":{"reason":"queue_overflow","droppedAfter":42}}
```

SSE-уровня `id:` / `event:` строки дублируют `envelope.id` / `envelope.type` для совместимости с EventSource. Raw-`fetch` потребители (SDK's `parseSseStream`) читают всё из JSON envelope и игнорируют SSE preamble строки.

| Тип события             | Триггер                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session_update`        | Любое ACP `sessionUpdate` уведомление (LLM chunks, tool calls, usage)                                                                                                                                                                                                                                                                      |
| `permission_request`    | Agent запросил одобрение инструмента                                                                                                                                                                                                                                                                                                       |
| `permission_resolved`   | Какой-то клиент проголосовал за разрешение через `POST /permission/:requestId`                                                                                                                                                                                                                                                             |
| `permission_partial_vote` | (consensus only) Голос записан, но кворум ещё не достигнут. Несёт `{requestId, sessionId, votesReceived, votesNeeded, quorum, optionTallies}`. Pre-flight `caps.features.permission_mediation`.                                                                                                                                            |
| `permission_forbidden`  | Голос отклонён активной политикой (`designated` mismatch, `local-only` non-loopback, или `consensus` voter не в snapshot). Несёт `{requestId, sessionId, clientId?, reason}`. Pre-flight `caps.features.permission_mediation`.                                                                                                              |
| `model_switched`        | `POST /session/:id/model` успешен                                                                                                                                                                                                                                                                                                          |
| `model_switch_failed`   | `POST /session/:id/model` отклонён                                                                                                                                                                                                                                                                                                         |
| `session_died`          | ACP-дочерний процесс аварийно упал. **Terminal: SSE stream закрывается после этого кадра; сессия удалена из `byId`.** Подписчики должны переподключиться через `POST /session`, чтобы заспаунить новую.                                                                                                                                    |
| `slow_client_warning`   | Subscriber-local: очередь ≥ 75% заполнена. **Non-terminal** — stream продолжается; warning это heads-up перед eviction. Несёт `{queueSize, maxQueued, lastEventId}`. Срабатывает ОДИН раз на эпизод переполнения; перезаряжается после drain очереди ниже 37.5%. Без `id` (synthetic). Pre-flight `caps.features.slow_client_warning`. |
| `client_evicted`        | Subscriber-local: переполнение очереди. **Terminal: SSE stream закрывается после этого кадра** (без `id` — synthetic). Другие подписчики той же сессии продолжают.                                                                                                                                                                         |
| `stream_error`          | Daemon-side ошибка во время fan-out. **Terminal: SSE stream закрывается после этого кадра** (без `id` — synthetic).                                                                                                                                                                                                                        |

Семантика переподключения:

- Отправьте `Last-Event-ID: <n>` для воспроизведения событий с `id > n` из per-session ring (глубина по умолчанию **8000**, настраивается через `nessy serve --event-ring-size <n>`)
- **Gap detection (client-side):** если `<n>` старейшего события всё ещё в ring (например, вы переподключаетесь с `Last-Event-ID: 50`, но ring теперь держит 200–1199), демон воспроизводит с старейшего доступного события без raising. Сравните `id` первого воспроизведённого события с `n + 1`; любая разница — размер потерянного окна. Stage 2 inject'ит явный `stream_gap` synthetic frame на daemon side; в Stage 1 detection — ответственность клиента.
- IDs монотонны на сессию, начиная с 1
- Synthetic frames (`client_evicted`, `slow_client_warning`, `stream_error`) намеренно опускают `id`, чтобы не сжигать sequence slot для других подписчиков

Backpressure:

- Per-subscriber очередь по умолчанию `maxQueued: 256` live-элементов (кадры воспроизведения во время переподключения не учитываются в лимите). Override через `?maxQueued=N` (диапазон `[16, 2048]`) в SSE запросе.
- Когда очередь подписчика пересекает 75% заполнения, bus принудительно отправляет `slow_client_warning` synthetic frame этому подписчику (один раз на эпизод переполнения; перезаряжается после того, как очередь опускается ниже 37.5%). Stream остаётся открытым — warning это предупреждение перед eviction, чтобы клиент быстрее обрабатывал очередь или чисто отключился + переподключился.
- Если очередь фактически переполняется после warning, bus передаёт `client_evicted` terminal frame и закрывает подписку.

### `POST /permission/:requestId`

Голосование за ожидающий `permission_request`. Активная **политика посредничества** определяет победителя:

| Политика                  | Поведение                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `first-responder` (по умолчанию) | Любой проверенный голосующий побеждает; более поздние голосующие получают `404`. Базовый уровень до F3.                                                                                                 |
| `designated`              | Только инициатор prompt (`originatorClientId`) принимает решение; не-инициаторы получают `403 permission_forbidden / designated_mismatch`. Возврат к first-responder для анонимных prompt.              |
| `consensus`               | N из M голосующих должны согласиться (по умолчанию `N = floor(M/2) + 1`, override через `policy.consensusQuorum`). Побеждает первый вариант, достигший `N`. Нерешающие голоса получают `200` + `permission_partial_vote` SSE frames. |
| `local-only`              | Только loopback голосующие решают; удалённые вызывающие получают `403 permission_forbidden / remote_not_allowed`.                                                                                       |

Активная политика настроена в `settings.json` под `policy.permissionStrategy` и представлена на `/capabilities` в `body.policy.permission`. Pre-flight `caps.features.permission_mediation` (с `modes: [...]`) для поддерживаемого сборкой набора.

> **F3 (#4175): координация разрешений между несколькими клиентами.** F3 добавил четыре политики выше. Демоны до F3 хардкодили first-responder; wire shape остаётся бит-в-бит неизменным, когда настроенная политика — `first-responder`. Новые события (`permission_partial_vote`, `permission_forbidden`) аддитивны — старые SDK видят их как `unrecognized_known_event` и игнорируют.

> **Permission timeout (по умолчанию 5 минут).** `permission_request`
> остаётся ожидающим пока: (a) какой-то клиент не проголосует здесь, (b) `POST /session/:id/cancel`
> сработает, (c) HTTP клиент, движущий prompt,
> отключится (mid-prompt cancel разрешает outstanding permissions как
> `cancelled`), (d) сессия убита, (e) демон выключен, **или
> (f) сработает per-session permission timeout** (`DEFAULT_PERMISSION_TIMEOUT_MS`,
> 5 минут). При сработке timeout `requestPermission` агента разрешается
> как `{outcome: 'cancelled'}`, audit ring записывает
> `permission.timeout` entry, stderr демона передаёт однострочное
> breadcrumb, и SSE bus fan-out стандартный
> `permission_resolved` cancelled frame, чтобы подписчики очистились. Timeout
> настраивается через `BridgeOptions.permissionResponseTimeoutMs`;
> headless вызывающие, запускающие long-form prompt, могут захотеть расширить его.

Запрос:

```json
{
  "outcome": {
    "outcome": "selected",
    "optionId": "proceed_once"
  }
}
```

Outcomes:

- `{ "outcome": "selected", "optionId": "<one-of-the-options>" }` — accept / reject / proceed-once / etc, согласно предложенным агентом выборам
- `{ "outcome": "cancelled" }` — отбросить запрос (соответствует тому, что делают внутренне `cancelSession` / `shutdown`)

Ответ:

- `200 {}` — ваш голос принят (разрешён ИЛИ записан под consensus quorum)
- `403 { "code": "permission_forbidden", "reason": "designated_mismatch" | "remote_not_allowed", "requestId", "sessionId" }` — F3: активная политика отклонила ваш голос
- `404 { "error": "..." }` — requestId неизвестен (уже разрешён, никогда не существовал, или сессия разобрана)
- `500 { "code": "cancel_sentinel_collision", ... }` — F3: `allowedOptionIds` агента содержит зарезервированный sentinel `'__cancelled__'`; нарушение контракта agent / daemon
- `501 { "code": "permission_policy_not_implemented", "policy": "<name>" }` — F3 forward-compat: literal политики попал в схему, но её mediator branch ещё не построен (сейчас недостижимо; зарезервировано для будущих политик)

После успешного голосования каждый подключённый клиент видит `permission_resolved` с тем же `requestId` и выбранным `outcome`. Под `consensus`, промежуточные голоса дополнительно fan-out `permission_partial_vote` до кворума.

### Маршруты device-flow для аутентификации (issue #4175 PR 21)

Демон брокерит OAuth 2.0 Device Authorization Grant (RFC 8628), чтобы удалённый SDK клиент мог инициировать логин, чьи токены попадают в файловую систему **демона** — не клиента. Демон сам опрашивает IdP; задача клиента — отображать verification URL + user code и (опционально) подписаться на SSE для событий завершения.

Capability tag: `auth_device_flow` (всегда рекламируется). Поддерживаемые провайдеры в v1: `dp-auth`.

**Runtime locality.** Демон никогда не спавнит браузер — даже если может. Клиент решает, вызывать ли `open(verificationUri)` локально; на headless pod (канонический Mode B deployment) пользователь открывает URL на любом устройстве, где есть браузер. См. `docs/users/nessy-serve.md` для рекомендуемого UX.

**Нет утечки токенов в событиях.** `auth_device_flow_started` несёт только `{deviceFlowId, providerId, expiresAt}`. User code и verification URL возвращаются point-to-point в теле POST 201 и через `GET /workspace/auth/device-flow/:id`; они никогда не транслируются в SSE.

**Per-provider singleton.** Второй `POST` для того же провайдера, пока flow pending, — это идемпотентный take-over — он возвращает существующую запись с `attached: true` вместо запуска свежего IdP запроса.

#### `POST /workspace/auth/device-flow`

Strict mutation gate: требует bearer токен даже на token-less loopback default'ах (`401 token_required`).

Запрос:

```json
{ "providerId": "dp-auth" }
```

Ответ (`201` свежий старт, `200` идемпотентный take-over):

```json
{
  "deviceFlowId": "fa07c61b-…",
  "providerId": "dp-auth",
  "status": "pending",
  "userCode": "USER-1",
  "verificationUri": "https://chat.nessy.ai/api/v1/oauth2/device",
  "verificationUriComplete": "https://chat.nessy.ai/api/v1/oauth2/device?user_code=USER-1",
  "expiresAt": 1700000600000,
  "intervalMs": 5000,
  "attached": false
}
```

Ошибки:

- `400 unsupported_provider` — неизвестный `providerId` (ответ включает `supportedProviders`)
- `409 too_many_active_flows` — достигнут лимит workspace (4); отмените один через `DELETE`
- `401 token_required` — strict gate отклонил запрос без токена
- `502 upstream_error` — IdP вернул неожиданную ошибку

#### `GET /workspace/auth/device-flow/:id`

Чтение текущего состояния. Ожидающие записи эхо `userCode/verificationUri/expiresAt/intervalMs`; terminal записи (5-мин grace) опускают их и surfacing `status` + опционально `errorKind/hint`.

Возвращает `404 device_flow_not_found` для неизвестных id и post-grace evicted записей.

#### `DELETE /workspace/auth/device-flow/:id`

Идемпотентная отмена:

- pending запись → `204` + emit `auth_device_flow_cancelled`
- terminal запись → `204` no-op (без повторного emit события)
- неизвестный id → `404`

#### `GET /workspace/auth/status`

Снимок pending flows + поддерживаемые провайдеры:

```json
{
  "v": 1,
  "workspaceCwd": "/work/bound",
  "providers": [],
  "pendingDeviceFlows": [
    {
      "deviceFlowId": "fa07c61b-…",
      "providerId": "dp-auth",
      "expiresAt": 1700000600000
    }
  ],
  "supportedDeviceFlowProviders": ["dp-auth"]
}
```

#### Device-flow SSE события

Пять типизированных событий (workspace-scoped, fanned out в каждую активную сессионную шину):

- `auth_device_flow_started` `{deviceFlowId, providerId, expiresAt}` — POST успешен; SDK должен подписаться (нет userCode здесь, fetch через GET если нужно)
- `auth_device_flow_throttled` `{deviceFlowId, intervalMs}` — демон соблюл upstream `slow_down`; клиенты, polling GET, должны увеличить свой интервал в соответствие
- `auth_device_flow_authorized` `{deviceFlowId, providerId, expiresAt?, accountAlias?}` — credentials персистены; `accountAlias` — это non-PII label (никогда email/phone)
- `auth_device_flow_failed` `{deviceFlowId, errorKind, hint?}` — terminal; `errorKind` один из `expired_token | access_denied | invalid_grant | upstream_error | persist_failed`. `persist_failed` — daemon-internal: IdP exchange успешен, но демон не смог durably сохранить credentials (EACCES / EROFS / ENOSPC). Пользователь должен повторить, как только основное условие диска исправлено.
- `auth_device_flow_cancelled` `{deviceFlowId}` — DELETE успешен против pending записи

> **Not MCP-compatible.** MCP authorization spec (2025-06-18) мандатирует OAuth 2.1 + PKCE auth-code с redirect callback, который не работает для headless-pod демонов. Mode B's device-flow surface — daemon-private — клиенты, нацеленные на MCP-compliant серверы, должны использовать другой auth path.

## Streaming wire format

События emit'ятся как стандартные EventSource frames. Демон пишет одну `data:` строку на frame (JSON не имеет встроенных newlines после `JSON.stringify`); SDK parser в `packages/sdk-typescript/src/daemon/sse.ts` обрабатывает как это, так и spec-allowed multi-`data:` форму на receive стороне.

## Error frames during streaming

Если bridge iterator throw'ит во время обслуживания SSE подписчика, демон emit'ит terminal `stream_error` frame (без `id`). Строка `data:` — это полная envelope (та же форма, что каждый другой SSE frame в этом документе); фактическое сообщение об ошибке находится под `envelope.data.error`:

```
event: stream_error
data: {"v":1,"type":"stream_error","data":{"error":"<message>"}}
```

Соединение затем закрывается.

## Environment variables

| Переменная         | Назначение                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `NESSY_SERVER_TOKEN` | Bearer token. Очищается от leading/trailing whitespace при запуске.                                                              |

## Source layout

| Путь                                               | Назначение                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/commands/serve.ts`               | yargs command + flag schema                                                                                |
| `packages/cli/src/serve/run-nessy-serve.ts`        | listener lifecycle + signal handling                                                                       |
| `packages/cli/src/serve/server.ts`                 | Express routes + middleware                                                                                |
| `packages/cli/src/serve/auth.ts`                   | bearer + Host allowlist + CORS deny                                                                        |
| `packages/cli/src/serve/httpAcpBridge.ts`          | spawn-or-attach + per-session FIFO + permission registry                                                   |
| `packages/cli/src/serve/status.ts`                 | read-only daemon status wire types + `ServeErrorKind` + `BridgeTimeoutError` + `mapDomainErrorToErrorKind` |
| `packages/cli/src/serve/env-snapshot.ts`           | pure helper that builds `/workspace/env` payloads from `process.*` state, including credential redaction   |
| `packages/acp-bridge/src/eventBus.ts`              | bounded async queue + replay ring                                                                          |
| `packages/sdk-typescript/src/daemon/DaemonClient.ts` | TS client                                                                                                  |
| `packages/sdk-typescript/src/daemon/sse.ts`        | EventSource frame parser                                                                                   |
| `integration-tests/cli/nessy-serve-routes.test.ts` | 18 cases, no LLM                                                                                           |
| `integration-tests/cli/nessy-serve-streaming.test.ts` | 3 cases, real `nessy --acp` child backed by the local fake OpenAI server (POSIX only; skipped on Windows)   |
