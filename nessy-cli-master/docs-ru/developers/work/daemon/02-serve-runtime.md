---
title: Среда выполнения nessy serve
---

# Serve Runtime

## Обзор

`packages/cli/src/serve/` — это загрузочный слой для `nessy serve`. Он преобразует флаги CLI в `ServeOptions`, проверяет конфигурацию запуска, создает приложение Express, подключает middleware, регистрирует маршруты, предоставляет провайдеры статуса/префлайта хоста daemon, поддерживает кольцо аудита разрешений и владеет двухфазной последовательностью корректного завершения работы. Работа, ориентированная на HTTP, находится в этом слое; работа, ориентированная на ACP, находится на слой ниже в `@nestor/nessy-cli-acp-bridge` (см. [`03-acp-bridge.md`](./03-acp-bridge.md)).

## Обязанности

- Разбор и проверка `ServeOptions`: адрес прослушивания, аутентификация, workspace, лимиты сессий/соединений, бюджет/пул MCP, CORS, тайм-ауты подсказок/SSE/сессий, ограничение скорости и связанные переключатели.
- **Канонизация** связанного workspace ровно один раз. Одна и та же каноническая форма используется `/capabilities`, резервным вариантом `POST /session` и мостом.
- Отклонение небезопасных или недействительных конфигураций запуска: привязка non-loopback без токена, `--require-auth` без токена, `--allow-origin '*'` без токена, `mcpBudgetMode='enforce'` без положительного `mcpClientBudget`, несуществующий или не-директория `--workspace`, а также недействительные значения тайм-аута или ограничения скорости.
- Создание фабрики `WorkspaceFileSystem`, издателя аудита разрешений, `DaemonStatusProvider` и `acp-bridge`.
- Создание приложения Express, подключение middleware (`denyBrowserOriginCors` / `allowOriginCors` -> `hostAllowlist` -> журнал доступа -> `bearerAuth` -> ограничение скорости -> парсер JSON -> телеметрия -> `mutationGate` на маршрут) и монтирование сессии, workspace CRUD, файлов, аутентификации device-flow, голосования разрешений и HTTP-маршрутов ACP.
- Привязка порта прослушивания и регистрация обработчиков сигналов.
- Запуск двухфазного завершения при SIGINT/SIGTERM; принудительный выход при втором сигнале.

## Архитектура

**Точка входа**: `runNessyServe(opts, deps)` в `packages/cli/src/serve/run-nessy-serve.ts`. Возвращает `RunHandle` (`{ url, port, close, ... }`).

**Фабрика приложений**: `createServeApp(opts, getPort, deps)` в `packages/cli/src/serve/server.ts`. Создает Express `Application`. Прямые встраиватели и тесты вызывают его без оболочки загрузки.

**Реестр возможностей**: `SERVE_CAPABILITY_REGISTRY` в `packages/cli/src/serve/capabilities.ts`. Каждый тег имеет версию `since` и опциональные режимы `modes`. Десять условных тегов (`require_auth`, `mcp_workspace_pool`, `mcp_pool_restart`, `allow_origin`, `prompt_absolute_deadline`, `writer_idle_timeout`, `workspace_settings`, `session_shell_command`, `rate_limit`, `workspace_reload`) опускаются, когда их соответствующий переключатель выключен. См. [`11-capabilities-versioning.md`](./11-capabilities-versioning.md).

**Middleware** (`packages/cli/src/serve/auth.ts` и `server.ts`):

| Middleware, в порядке регистрации           | Назначение                                                                                                                        | Примечания                                                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `denyBrowserOriginCors` / `allowOriginCors` | Запрет всех заголовков `Origin` по умолчанию; переключение на allowlist, когда настроен `--allow-origin <pattern>`.               | См. [`12-auth-security.md`](./12-auth-security.md).                                                                                       |
| `hostAllowlist(bind, getPort)`              | На loopback проверяет, что `Host` принадлежит `localhost`, `127.0.0.1`, `[::1]` или `host.docker.internal` плюс фактический порт. | Защита от DNS rebinding. Сравнение без учета регистра и кэшируется на порт.                                                               |
| Middleware журнала доступа                  | Записывает метод, путь, статус, durationMs, sessionId и clientId в `DaemonLogger` при завершении запроса.                         | Регистрируется **до** `bearerAuth`, поэтому отказы 401 также логируются. Пропускает `/health` и heartbeat.                                |
| `bearerAuth(token)`                         | SHA-256 плюс сравнение bearer с постоянным временем `timingSafeEqual`.                                                            | Открытый проход, когда токен не настроен (по умолчанию для loopback dev). Схема `Bearer` без учета регистра.                              |
| Middleware ограничения скорости             | Опциональное ведро токенов на уровень для маршрутов подсказок, мутаций и чтения.                                                  | Регистрируется после `bearerAuth` и перед парсингом JSON; возвращает 429 до парсинга, когда ведро исчерпано.                              |
| `express.json({ limit: '10mb' })`           | Парсинг тела JSON.                                                                                                                | Ошибки парсинга возвращают 400.                                                                                                           |
| `daemonTelemetryMiddleware`                 | Обертывает каждый HTTP-запрос в span OpenTelemetry через `withDaemonRequestSpan`.                                                 | Атрибуты включают route, sessionId, clientId и код статуса.                                                                               |
| `createMutationGate` (на маршрут)           | Опциональный шлюз на уровне маршрута для изменяющих маршрутов, требующих токен даже на loopback.                                  | Возвращает `401 { code: 'token_required' }`. Не глобальный `app.use`; маршруты вызывают `mutate({ strict: true })` по мере необходимости. |

**Подсистемы**:

| Путь                                                             | Роль                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve/fs/`                                                      | Фабрика `WorkspaceFileSystem` плюс `policy.ts` (проверки размера/доверия/бинарников), `paths.ts` (канонизация, resolveWithin, отклонение ссылок), `audit.ts` и типизированные значения `FsError`.                                                                                                                                                                                                                                      |
| `serve/routes/workspace-file-read.ts`, `workspace-file-write.ts` | HTTP обработчики для `GET /file`, `GET /file/bytes`, `POST /file/write` и `POST /file/edit`.                                                                                                                                                                                                                                                                                                                                           |
| `serve/workspace-memory.ts`                                      | `GET/POST /workspace/memory` (NESSY.md CRUD).                                                                                                                                                                                                                                                                                                                                                                                          |
| `serve/workspace-agents.ts`                                      | `GET/POST/DELETE /workspace/agents` (субагент CRUD).                                                                                                                                                                                                                                                                                                                                                                                   |
| `serve/daemon-status-provider.ts`                                | Снимок окружения плюс ячейки префлайта хоста daemon: версия Node, запись CLI, статистика workspace, ripgrep, git, npm.                                                                                                                                                                                                                                                                                                                 |
| `serve/permission-audit.ts`                                      | `PermissionAuditRing` (FIFO на 512 записей) и `createPermissionAuditPublisher`.                                                                                                                                                                                                                                                                                                                                                        |
| `serve/auth/device-flow.ts`, `qwen-device-flow-provider.ts`      | Маршруты OAuth device-flow. См. [`12-auth-security.md`](./12-auth-security.md).                                                                                                                                                                                                                                                                                                                                                        |
| `serve/daemon-logger.ts`                                         | Структурированные файловые логи `DaemonLogger`. См. [`19-observability.md`](./19-observability.md).                                                                                                                                                                                                                                                                                                                                    |
| `serve/debug-mode.ts`                                            | Общий предикат `isServeDebugMode()`, управляющий подробным контекстом ошибок в HTTP ответах.                                                                                                                                                                                                                                                                                                                                           |
| `serve/acp-http/`                                                | Транспорт ACP Streamable HTTP (RFD #721), смонтирован на `/acp`. Семь файлов реализуют POST JSON-RPC, GET SSE, DELETE teardown и общее использование моста параллельно с поверхностью REST.                                                                                                                                                                                                                                            |
| `serve/demo.ts`                                                  | Встроенный HTML для `GET /demo`: консоль отладки браузера с UI чата, журналом событий и инспектором workspace. На loopback без `--require-auth` регистрируется **до** `bearerAuth`; на non-loopback или с `--require-auth` регистрируется **после** `bearerAuth`. Подается с CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'` плюс `X-Frame-Options: DENY`. |

**Шимы повторного экспорта** для совместимости с путями импорта до F1:

- `serve/event-bus.ts` -> `@nestor/nessy-cli-acp-bridge/eventBus`
- `serve/status.ts` -> `@nestor/nessy-cli-acp-bridge/status`
- `serve/httpAcpBridge.ts` -> `@nestor/nessy-cli-acp-bridge`

## Поток

### Последовательность загрузки

1. **Разрешение и обрезка токена** из `opts.token` или `NESSY_SERVER_TOKEN`; это
   предотвращает тихую поломку сравнения bearer из-за завершающего перевода строки от `cat token.txt`.
2. **Защита от опечаток имени хоста**: `--hostname localhost:4170` выдает ошибку и предлагает `--port`.
3. **Префлайт аутентификации**: non-loopback без токена отказывает; `--require-auth` без токена отказывает.
4. **Проверка workspace**: абсолютный путь, существует, директория. `EACCES` / `EPERM` оборачиваются, чтобы указать на флаг.
5. **Канонизация workspace**: `canonicalizeWorkspace(rawWorkspace)` запускает `realpathSync.native` один раз и передает `/capabilities`, резервному варианту `POST /session` и мосту.
6. **Проверка бюджета MCP**: положительное целое число; `enforce` требует бюджета.
7. **Вывод переключателя пула MCP**: родительское окружение `NESSY_SERVE_NO_MCP_POOL=1` делает `mcpPoolActive=false`, поэтому возможности честно опускают `mcp_workspace_pool` и `mcp_pool_restart`.
8. **Проверка CORS / тайм-аута / ограничения скорости**: `--allow-origin '*'` требует токен; значения подсказки, writer, канала простоя, сессии простоя, сборщика и окна ограничения скорости быстро завершаются ошибкой при недействительности.
9. **`childEnvOverrides` на handle**: передача `NESSY_SERVE_MCP_CLIENT_BUDGET` и `NESSY_SERVE_MCP_BUDGET_MODE` дочернему процессу ACP через `BridgeOptions.childEnvOverrides` вместо мутации `process.env`.
10. **Загрузка `settings.json` один раз**: чтение `context.fileName`, `policy.permissionStrategy` и `policy.consensusQuorum`. Поврежденные файлы откатываются к значениям по умолчанию. `validatePolicyConfig()` проверяет `policy.*` против `SERVE_CAPABILITY_REGISTRY.permission_mediation.modes`; неизвестные стратегии или неположительный `consensusQuorum` выбрасывают `InvalidPolicyConfigError`. Кворум, установленный при стратегии не-`consensus`, логирует предупреждение stderr.
11. **Выделение `PermissionAuditRing`** (512 записей).
12. **Создание `fsFactory`**: `runNessyServe` по умолчанию `trusted: true`; прямые вызовы `createServeApp` по умолчанию `trusted: false` и предупреждают один раз.
13. **`createHttpAcpBridge`**, см. [`03-acp-bridge.md`](./03-acp-bridge.md).
14. **`createServeApp`** собирает Express.
15. **`server.listen(port, hostname)`**, затем разрешение фактического `getPort()` для allowlist хоста.
16. **Регистрация обработчиков SIGINT / SIGTERM** для корректного завершения.

### Корректное завершение работы

1. **Фаза 1 - демонтаж моста** при первом сигнале:
   - Утилизация реестра device-flow и отмена ожидающих потоков.
   - `bridge.shutdown()` помечает каждый канал `isDying = true`, отправляет корректное закрытие в stdin каждого дочернего процесса ACP, ждет `KILL_HARD_DEADLINE_MS` (10s) на канал, затем вызывает `channel.kill()` при необходимости.
2. **Фаза 2 - демонтаж HTTP**:
   - `server.close()` прекращает принимать новые соединения и позволяет завершиться запросам в процессе выполнения.
   - `SHUTDOWN_FORCE_CLOSE_MS` (5s) запускает `server.closeAllConnections()`.
   - Второй дедлайн 2s при необходимости эскалирует снова.
3. **Второй сигнал во время выхода**:
   - `bridge.killAllSync()` + `process.exit(1)` для предотвращения зависания дочерних процессов, блокирующих выход daemon.

## Состояние и жизненный цикл

`RunHandle` предоставляет:

- `url`: разрешенный URL прослушивания, после разрешения эфемерного порта.
- `port`: фактический порт, включая разрешение `0`.
- `close({ timeoutMs? })`: программное завершение для встраивателей и тестов.

Вызов `createServeApp` напрямую возвращает только `Application`; встраиватель владеет `listen` и завершением.

## Зависимости

| Upstream используемый `serve/`                                                              | Downstream использующий `serve/`  |
| ------------------------------------------------------------------------------------------- | --------------------------------- |
| `@nestor/nessy-cli-acp-bridge`: мост, шина событий, типы статуса                            | Обработчик подкоманды `nessy` CLI |
| `packages/core`: `loadSettings`, `getCurrentGeminiMdFilename`, `Config`, `WorkspaceContext` | Прямые встраиватели, тесты        |
| ACP SDK (`@agentclientprotocol/sdk`): `PROTOCOL_VERSION`, `ClientSideConnection` через мост |                                   |
| Express + body-parser, `node:crypto`, `node:fs`, `node:path`                                |                                   |

## Конфигурация

| Источник                         | Ключ                                                                                            | Эффект                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Env                              | `NESSY_SERVER_TOKEN`                                                                            | Bearer токен после обрезки.                                                                         |
| Env                              | `NESSY_SERVE_NO_MCP_POOL=1`                                                                     | Принудительно `mcpPoolActive=false`.                                                                |
| Окружение дочернего процесса ACP | `NESSY_SERVE_MCP_CLIENT_BUDGET` / `NESSY_SERVE_MCP_BUDGET_MODE`                                 | Генерируется из `--mcp-client-budget` / `--mcp-budget-mode` и передается через `childEnvOverrides`. |
| Env                              | `NESSY_SERVE_PROMPT_DEADLINE_MS` / `NESSY_SERVE_WRITER_IDLE_TIMEOUT_MS`                         | Тайм-ауты простоя подсказки / SSE по умолчанию.                                                     |
| Env                              | `NESSY_SERVE_RATE_LIMIT*`                                                                       | Переключатель ограничения скорости, лимиты подсказки/мутации/чтения и окно по умолчанию.            |
| Env                              | `NESSY_SERVE_DEBUG=1`                                                                           | Подробные логи stderr. См. [`19-observability.md`](./19-observability.md).                          |
| Flags                            | `--hostname`, `--port`                                                                          | Привязка прослушивания.                                                                             |
| Flags                            | `--token`, `--require-auth`, `--enable-session-shell`                                           | Bearer токен, усиление аутентификации loopback и явный переключатель выполнения оболочки.           |
| Flag                             | `--workspace`                                                                                   | Переопределяет `process.cwd()`.                                                                     |
| Flags                            | `--max-sessions`, `--max-pending-prompts-per-session`, `--max-connections`, `--event-ring-size` | Лимиты моста / Express.                                                                             |
| Flags                            | `--mcp-client-budget=N`, `--mcp-budget-mode={off,warn,enforce}`                                 | Передается дочернему процессу ACP.                                                                  |
| Flags                            | `--allow-origin`, `--allow-private-auth-base-url`                                               | Allowlist CORS браузера и переключатель установки аутентификации localhost/private.                 |
| Flags                            | `--prompt-deadline-ms`, `--writer-idle-timeout-ms`, `--channel-idle-timeout-ms`                 | Управление жизненным циклом подсказки, SSE writer и дочернего процесса ACP.                         |
| Flags                            | `--session-reap-interval-ms`, `--session-idle-timeout-ms`                                       | Управление сборкой отключенных сессий.                                                              |
| Flags                            | `--rate-limit*`                                                                                 | Ограничение скорости HTTP на уровень.                                                               |
| `settings.json`                  | `policy.permissionStrategy`, `policy.consensusQuorum`                                           | Политика и кворум `MultiClientPermissionMediator`.                                                  |
| `settings.json`                  | `context.fileName`                                                                              | Переопределение `getCurrentGeminiMdFilename` для моста.                                             |

См. [`17-configuration.md`](./17-configuration.md) для сводной справки.

## Предостережения и известные ограничения

- Прямой `createServeApp` без `deps.fsFactory` или `deps.bridge` по умолчанию `trusted: false`; агентский ACP `writeTextFile` отклоняет как `untrusted_workspace`. Предупреждение печатается один раз.
- `denyBrowserOriginCors` отклоняет **все** запросы с `Origin`; демо-страница работает, потому что другое middleware сначала удаляет совпадающие same-origin значения.
- Порядок парсера тела: маршруты, использующие `mutate({ strict: true })`, возвращают 401 только после `express.json()`. Худший случай — `--max-connections × express.json({limit: '10mb'})`, до около 2.5 ГБ переходной памяти на насыщенном слушателе loopback; этот компромисс намеренный.
- Несколько daemon в одном процессе должны использовать `childEnvOverrides` на handle; мутация `process.env` создает гонку, потому что `defaultSpawnChannelFactory` делает снимок окружения во время запуска.

## Ссылки

- `packages/cli/src/serve/run-nessy-serve.ts` (загрузка, проверка загрузки, корректное завершение)
- `packages/cli/src/serve/server.ts` (`createServeApp()`, сборка middleware и маршрутов)
- `packages/cli/src/serve/auth.ts` (CORS, allowlist хоста, bearer auth, шлюз мутаций)
- `packages/cli/src/serve/rate-limit.ts` (ограничение скорости HTTP на уровень)
- `packages/cli/src/serve/capabilities.ts` (реестр возможностей и условная реклама)
- `packages/cli/src/serve/types.ts` (`ServeOptions`, `CapabilitiesEnvelope`)
- `packages/cli/src/serve/daemon-status-provider.ts`
- `packages/cli/src/serve/permission-audit.ts`
- Проблемы: [#3803](https://github.com/NessyLM/nessy-cli/issues/3803), [#4175](https://github.com/NessyLM/nessy-cli/issues/4175)
