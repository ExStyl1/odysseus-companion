---
title: Справочник конфигурации
---

# Справочник конфигурации

## Обзор

На этой странице собраны все настройки, влияющие на демон `nessy serve` и его адаптеры: переменные окружения, флаги CLI, ключи `settings.json` и программные опции. Страницы отдельных функций ссылаются сюда, когда им нужны кросс-катting детали конфигурации.

## Флаги CLI (`nessy serve`)

| Флаг                                    | Тип                        | По умолчанию                            | Эффект                                                                                                                                                                                                   |
| --------------------------------------- | -------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--hostname <host>`                     | строка                     | `127.0.0.1`                             | Адрес привязки. Loopback-значения: `127.0.0.1`, `localhost`, `::1`, `[::1]`. Не-loopback требует bearer-токена при запуске. Ввод `host:port` отклоняется с рекомендацией использовать `--port`.          |
| `--port <n>`                            | число                      | `4170`                                  | Порт прослушивания; `0` означает эфемерный.                                                                                                                                                              |
| `--token <s>`                           | строка                     | env                                     | Bearer-токен. Переопределяет `NESSY_SERVER_TOKEN` и обрезается при запуске. Появляется в командной строке процесса, поэтому в развертываниях предпочтительнее env.                                       |
| `--require-auth`                        | булево                     | `false`                                 | Расширяет bearer-аутентификацию на loopback и `/health`; запуск отказывается стартовать без токена.                                                                                                      |
| `--workspace <dir>`                     | абсолютный путь            | `process.cwd()`                         | Привязанная рабочая область. Должен быть абсолютным и директорией; канонизируется один раз при запуске.                                                                                                  |
| `--max-sessions <n>`                    | число                      | `20`                                    | Ограничение активных сессий. `0` / `Infinity` означает без ограничений; `NaN` / отрицательные значения выбрасывают ошибку.                                                                               |
| `--max-pending-prompts-per-session <n>` | число                      | `5`                                     | Ограничение принятых, но ожидающих/выполняющихся запросов на сессию. Избыточный запрос возвращает 503. `0` / `Infinity` означает без ограничений; отрицательные или нецелые значения выбрасывают ошибку. |
| `--max-connections <n>`                 | число                      | `256`                                   | HTTP-листер `server.maxConnections`; `0` / `Infinity` означает без ограничений.                                                                                                                          |
| `--enable-session-shell`                | булево                     | `false`                                 | Включает прямое выполнение `POST /session/:id/shell`. Требует bearer-токена, и каждый вызов должен нести сессионно-привязанный `X-Nessy-Client-Id`.                                                      |
| `--event-ring-size <n>`                 | число                      | `8000`                                  | Кольцо SSE-реплея на сессию; мягкий предел `1_000_000`.                                                                                                                                                  |
| `--http-bridge`                         | булево                     | `true`                                  | Режим моста этапа 1. `--no-http-bridge` всё ещё откатывается к http-bridge и печатает в stderr.                                                                                                          |
| `--mcp-client-budget <n>`               | положительное целое        | не задан                                | Устанавливает `WorkspaceMcpBudget.clientBudget` и передаёт его дочернему процессу ACP через `childEnvOverrides`.                                                                                         |
| `--mcp-budget-mode <m>`                 | `off` / `warn` / `enforce` | `warn`, когда бюджет задан, иначе `off` | Устанавливает `WorkspaceMcpBudget.mode`; `enforce` требует `--mcp-client-budget`.                                                                                                                        |
| `--allow-origin <pattern>`              | повторяемая строка         | не задан                                | Список разрешённых cross-origin, заменяющий отказ CORS по умолчанию. `*` разрешает любой origin, но требует токена.                                                                                      |
| `--allow-private-auth-base-url`         | булево                     | `false`                                 | Разрешает `/workspace/auth/provider` устанавливать `baseUrl` провайдера аутентификации localhost / частной сети; использовать только в доверенной локальной разработке.                                  |
| `--prompt-deadline-ms <n>`              | положительное целое        | не задан                                | Серверный лимит wallclock для запроса в мс. Таймаут прерывает и возвращает ошибку.                                                                                                                       |
| `--writer-idle-timeout-ms <n>`          | положительное целое        | не задан                                | Таймаут простоя на SSE-соединение в мс. Демон закрывает SSE-соединение, когда событие не отправляется в течение этого времени.                                                                           |
| `--channel-idle-timeout-ms <n>`         | неотрицательное целое      | `0`                                     | Как долго держать дочерний процесс ACP живым после закрытия последней сессии. `0` означает немедленное освобождение.                                                                                     |
| `--session-reap-interval-ms <n>`        | неотрицательное целое      | `60000`                                 | Интервал сканирования сборщика сессий; `0` отключает его.                                                                                                                                                |
| `--session-idle-timeout-ms <n>`         | неотрицательное целое      | `1800000`                               | Время ожидания отключения сессии перед сборкой; `0` отключает его.                                                                                                                                       |
| `--rate-limit` / `--no-rate-limit`      | булево                     | env / off                               | Включает поэтапное HTTP-ограничение скорости для маршрутов запросов, мутаций и чтения.                                                                                                                   |
| `--rate-limit-prompt <n>`               | положительное целое        | `10`                                    | Лимит запросов запросов на окно; требует включения ограничения скорости.                                                                                                                                 |
| `--rate-limit-mutation <n>`             | положительное целое        | `30`                                    | Лимит запросов мутаций на окно; требует включения ограничения скорости.                                                                                                                                  |
| `--rate-limit-read <n>`                 | положительное целое        | `120`                                   | Лимит запросов чтения на окно; требует включения ограничения скорости.                                                                                                                                   |
| `--rate-limit-window-ms <n>`            | целое `>= 1000`            | `60000`                                 | Длина окна ограничения скорости; требует включения ограничения скорости.                                                                                                                                 |
| нет флага                               | -                          | -                                       | `NESSY_SERVE_NO_MCP_POOL=1` полностью отключает пул.                                                                                                                                                     |

## Переменные окружения

### Читаются `runNessyServe` / Express middleware

| Env                                  | Эффект                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NESSY_SERVER_TOKEN`                 | Bearer-токен; обрезается при запуске.                                                                                                                                          |
| `NESSY_SERVE_DEBUG`                  | `1` / `true` / `on` / `yes` (без учёта регистра) включает подробные логи stderr. См. [`19-observability.md`](./19-observability.md).                                           |
| `NESSY_SERVE_NO_MCP_POOL`            | `1` отключает пул транспорта MCP рабочей области и откатывается к `McpClientManager` на сессию; возможности перестают рекламировать `mcp_workspace_pool` / `mcp_pool_restart`. |
| `NESSY_SERVE_PROMPT_DEADLINE_MS`     | Резервный вариант env для `--prompt-deadline-ms`.                                                                                                                              |
| `NESSY_SERVE_WRITER_IDLE_TIMEOUT_MS` | Резервный вариант env для `--writer-idle-timeout-ms`.                                                                                                                          |
| `NESSY_SERVE_RATE_LIMIT`             | `1` / `true` включает поэтапное HTTP-ограничение скорости; CLI `--rate-limit` / `--no-rate-limit` главнее.                                                                     |
| `NESSY_SERVE_RATE_LIMIT_PROMPT`      | Резервный вариант env для `--rate-limit-prompt`.                                                                                                                               |
| `NESSY_SERVE_RATE_LIMIT_MUTATION`    | Резервный вариант env для `--rate-limit-mutation`.                                                                                                                             |
| `NESSY_SERVE_RATE_LIMIT_READ`        | Резервный вариант env для `--rate-limit-read`.                                                                                                                                 |
| `NESSY_SERVE_RATE_LIMIT_WINDOW_MS`   | Резервный вариант env для `--rate-limit-window-ms`.                                                                                                                            |

### Передаются дочернему процессу ACP через `BridgeOptions.childEnvOverrides`

`runNessyServe` строит их на каждый обработчик, чтобы два демона в одном процессе не гонялись за `process.env`. Переменные бюджета не являются родительскими env fallback для `nessy serve`; путь CLI должен генерировать их из `--mcp-client-budget` / `--mcp-budget-mode`.

| Env                               | Эффект                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `NESSY_SERVE_MCP_CLIENT_BUDGET`   | Строка положительного целого, потребляемая `readBudgetFromEnv()` дочернего процесса ACP.                                 |
| `NESSY_SERVE_MCP_BUDGET_MODE`     | `off` / `warn` / `enforce`.                                                                                              |
| `NESSY_SERVE_MCP_POOL_TRANSPORTS` | Разделённый запятыми список разрешённых транспортов; пул по умолчанию `stdio,websocket`; может явно включать `http,sse`. |
| `NESSY_SERVE_MCP_POOL_DRAIN_MS`   | Задержка слива простоя записи пула; по умолчанию `30000`, ограничено `1000..600000` мс.                                  |

### Читаются SDK / адаптерами

| Env                      | Эффект                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| `NESSY_DAEMON_URL`       | Базовый URL демона для CLI TUI адаптера, каналов и IDE компаньона. |
| `NESSY_DAEMON_TOKEN`     | Bearer-токен.                                                      |
| `NESSY_DAEMON_WORKSPACE` | Переопределяет `cwd`, отправляемый в `POST /session`.              |

## Ключи `settings.json`

Демон читает настройки один раз при запуске через `loadSettings(boundWorkspace)` внутри `runNessyServe`. Неправильные настройки откатываются к значениям по умолчанию через guard try/catch.

| Ключ                        | Тип                                                                | Эффект                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy.permissionStrategy` | `'first-responder' \| 'designated' \| 'consensus' \| 'local-only'` | Устанавливает `BridgeOptions.permissionPolicy`; активное значение появляется в `/capabilities` как `policy.permission`. **Запуск валидирует** через `validatePolicyConfig()` против `SERVE_CAPABILITY_REGISTRY.permission_mediation.modes`. Неизвестные литералы выбрасывают `InvalidPolicyConfigError` и явно проваливают запуск.                                                                                                                                                                                                                                            |
| `policy.consensusQuorum`    | положительное целое                                                | N для политики `consensus`. **По умолчанию** `floor(M/2) + 1` от `votersAtIssue.size` (M=2 означает единогласно; большее чётное M означает больше половины). Если установлено при политике не consensus, игнорируется, и запуск печатает предупреждение stderr. Не-положительные целые выбрасывают `InvalidPolicyConfigError`. См. [`04-permission-mediation.md`](./04-permission-mediation.md).                                                                                                                                                                              |
| `context.fileName`          | строка                                                             | Переопределяет `getCurrentGeminiMdFilename()` через `BridgeOptions.contextFilename`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tools.disabled`            | string[]                                                           | Инструменты, отключённые для следующего спавна дочернего процесса ACP. Нормализуется через `normalizeDisabledToolList()` (`packages/cli/src/config/normalizeDisabledTools.ts`): не-массив становится `[]`, не-строковые записи пропускаются, пробельные символы обрезаются, пустые записи отбрасываются, дубликаты удаляются с сохранением первого вхождения. Запуск и обновление настроек `restartMcpServer` оба проходят через эту функцию. `ToolRegistry.has(name)` точное и регистрозависимое. `POST /workspace/tools/:name/enable` и `tool_toggled` обновляют этот ключ. |
| `tools.approvalMode`        | `'default' \| 'auto' \| ...`                                       | Режим утверждения сессии по умолчанию; `POST /session/:id/approval-mode` пишет сюда, когда `persist: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `telemetry`                 | объект                                                             | Конфигурация OTel. Ключи включают `enabled`, `otlpEndpoint`, `otlpProtocol`, `otlpTracesEndpoint`, `otlpLogsEndpoint`, `otlpMetricsEndpoint`, `target`, `outfile`, `includeSensitiveSpanAttributes`, `resourceAttributes` и `metrics.includeSessionId`. `resolveTelemetrySettings()` читает это при запуске и инициализирует `initializeTelemetry()`.                                                                                                                                                                                                                         |

## `ServeOptions` (программное встраивание)

`packages/cli/src/serve/types.ts` определяет типизированный объект опций, принимаемый как `runNessyServe`, так и `createServeApp`. Он зеркально отражает флаги CLI выше и добавляет:

| Поле                          | Эффект                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `eventRingSize`               | Переопределяет размер кольца по умолчанию на сессию.                                        |
| `maxPendingPromptsPerSession` | Ограничение ожидающих запросов на сессию; `0` / `Infinity` означает без ограничений.        |
| `mcpPoolActive`               | Программный переключатель, по умолчанию из `NESSY_SERVE_NO_MCP_POOL`.                       |
| `allowOrigins`                | Список разрешённых cross-origin (`string[]`), соответствующий `--allow-origin`.             |
| `allowPrivateAuthBaseUrl`     | Разрешает установку `baseUrl` провайдера аутентификации private / localhost.                |
| `enableSessionShell`          | Включает выполнение shell сессии; bearer-токен и session-bound client id всё ещё требуются. |
| `promptDeadlineMs`            | Лимит wallclock запроса.                                                                    |
| `writerIdleTimeoutMs`         | Таймаут простоя SSE writer.                                                                 |
| `channelIdleTimeoutMs`        | Как долго держать дочерний процесс ACP тёплым после закрытия последней сессии.              |
| `sessionReapIntervalMs`       | Интервал сканирования сборщика сессий.                                                      |
| `sessionIdleTimeoutMs`        | Время ожидания отключения сессии перед сборкой.                                             |
| `rateLimit*`                  | Переключатель, пороги и окно поэтапного HTTP-ограничения скорости.                          |

## `BridgeOptions` (программное встраивание моста)

`packages/acp-bridge/src/bridgeOptions.ts` определяет опции моста. См. [`03-acp-bridge.md`](./03-acp-bridge.md) для полной таблицы. Ключевые поля:

| Поле                                                                                                                    | Эффект                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `boundWorkspace`                                                                                                        | Требуемая каноническая рабочая область.                                                               |
| `sessionScope`                                                                                                          | `'single'` (по умолчанию) vs `'thread'`.                                                              |
| `initializeTimeoutMs`, `maxSessions`, `eventRingSize`, `permissionResponseTimeoutMs`, `maxPendingPermissionsPerSession` | Ограничения ресурсов.                                                                                 |
| `channelFactory`                                                                                                        | Подключаемая фабрика дочернего процесса ACP; по умолчанию `defaultSpawnChannelFactory`.               |
| `fileSystem`                                                                                                            | Адаптер `BridgeFileSystem`. См. [`07-workspace-filesystem.md`](./07-workspace-filesystem.md).         |
| `permissionPolicy`, `permissionConsensusQuorum`, `permissionAudit`                                                      | Проводка медиатора.                                                                                   |
| `statusProvider`                                                                                                        | Ячейки префлайта хоста демона.                                                                        |
| `childEnvOverrides`                                                                                                     | Добавления или удаления переменных окружения на обработчик.                                           |
| `contextFilename`                                                                                                       | Переопределяет `getCurrentGeminiMdFilename()`.                                                        |
| `channelIdleTimeoutMs`                                                                                                  | Как долго держать дочерний процесс ACP живым после закрытия последней сессии, в мс; по умолчанию `0`. |

## Важные значения по умолчанию

| Константа                         | Файл                    | Значение          | Значение                                                             |
| --------------------------------- | ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `DEFAULT_MAX_SESSIONS`            | `bridge.ts`             | `20`              | Ограничение сессий перед `SessionLimitExceededError`.                |
| `MAX_EVENT_RING_SIZE`             | `bridge.ts`             | `1_000_000`       | Мягкий предел для `BridgeOptions.eventRingSize`; защита от опечаток. |
| `DEFAULT_RING_SIZE`               | `eventBus.ts`           | `8000`            | Глубина кольца SSE-реплея на сессию.                                 |
| `DEFAULT_MAX_QUEUED`              | `eventBus.ts`           | `256`             | Ограничение очереди на подписчика.                                   |
| `DEFAULT_MAX_SUBSCRIBERS`         | `eventBus.ts`           | `64`              | Ограничение подписчиков на шину.                                     |
| `WARN_THRESHOLD_RATIO`            | `eventBus.ts`           | `0.75`            | Триггер `slow_client_warning`.                                       |
| `WARN_RESET_RATIO`                | `eventBus.ts`           | `0.375`           | Порог повторного вооружения гистерезиса.                             |
| `DEFAULT_INIT_TIMEOUT_MS`         | `bridge.ts`             | `10_000`          | Таймаут рукопожатия ACP `initialize`.                                |
| `MCP_RESTART_TIMEOUT_MS`          | `bridge.ts`             | `300_000`         | Таймаут моста для `/workspace/mcp/:server/restart`.                  |
| `DEFAULT_PERMISSION_TIMEOUT_MS`   | `bridge.ts`             | `5 * 60_000`      | Таймаут ожидания ответа на разрешение.                               |
| `DEFAULT_MAX_PENDING_PER_SESSION` | `bridge.ts`             | `64`              | Выровнено с `DEFAULT_MAX_SUBSCRIBERS`.                               |
| `MAX_RESOLVED_PERMISSION_RECORDS` | `permissionMediator.ts` | `512`             | FIFO для недавно разрешённых разрешений.                             |
| `KILL_HARD_DEADLINE_MS`           | `spawnChannel.ts`       | `10_000`          | Окно плавного завершения на канал.                                   |
| `SHUTDOWN_FORCE_CLOSE_MS`         | `run-nessy-serve.ts`    | `5_000`           | Таймер принудительного закрытия HTTP-сервера.                        |
| `MAX_READ_BYTES`                  | `fs/policy.ts`          | `256 * 1024`      | Ограничение чтения.                                                  |
| `MAX_WRITE_BYTES`                 | `fs/policy.ts`          | `5 * 1024 * 1024` | Ограничение записи.                                                  |
| `MAX_DISPLAY_NAME_LENGTH`         | `bridge.ts`             | `256`             | Ограничение `displayName` сессии.                                    |

## Кросс-ссылки

- Настройки аутентификации: [`12-auth-security.md`](./12-auth-security.md)
- Возможности и версия протокола: [`11-capabilities-versioning.md`](./11-capabilities-versioning.md)
- Настройка кольца событий и противодавления: [`10-event-bus.md`](./10-event-bus.md)
- Пул / бюджет MCP: [`05-mcp-transport-pool.md`](./05-mcp-transport-pool.md) и [`06-mcp-budget-guardrails.md`](./06-mcp-budget-guardrails.md)
- Политика разрешений: [`04-permission-mediation.md`](./04-permission-mediation.md)
- Руководство пользователя: [`../../../users/work/features/nessy-serve.md`](../../../users/work/features/nessy-serve.md)
