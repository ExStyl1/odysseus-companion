---
title: Документация разработчика daemon
---

# Документация разработчика Daemon

Это техническая документация для разработчиков по **режиму daemon в nessy-cli**: HTTP-демон `nessy serve`, пакет `@nestor/nessy-cli-acp-bridge`, пул транспортов MCP с областью видимости workspace, медиация разрешений для нескольких клиентов, типизированная схема событий daemon v1, демон-клиент TypeScript SDK и адаптеры для подключения к демону.

Эта документация дополняет, а не заменяет следующие существующие документы:

| Существующий документ                                                                        | Аудитория              | Источник истины для                                         |
| -------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| [`../../../users/work/features/nessy-serve.md`](../../../users/work/features/nessy-serve.md) | Операторы              | Быстрый старт для пользователя, флаги, модель угроз         |
| [`../../nessy-serve-protocol.md`](../../nessy-serve-protocol.md)                             | Разработчики протокола | Каталог HTTP-маршрутов, формы запросов/ответов, коды ошибок |
| [`../examples/daemon-client-quickstart.md`](../examples/daemon-client-quickstart.md)         | Пользователи SDK       | Пошаговое руководство по TypeScript                         |
| `../daemon-client-adapters/`                                                                 | Авторы адаптеров       | Заметки по дизайну клиентских адаптеров                     |
| [`../../../design/f2-mcp-transport-pool.md`](../../../design/f2-mcp-transport-pool.md)       | Сопровождающие F2      | Дизайн пула транспортов MCP workspace v2.2                  |

Если вы хотите **запустить демон и начать его использовать**, сначала прочитайте `nessy-serve.md`. Если вы хотите **создать клиент на основе wire-формата**, прочитайте `nessy-serve-protocol.md`. Если вы хотите **понять, расширить или отладить внутреннее устройство daemon**, прочитайте этот набор документов.

## Порядок чтения

Выберите путь, соответствующий вашей цели:

- **Сначала запустите и проверьте демон**: `20 -> 17 -> 19`.
- **Новый участник**: `01 -> 02 -> 03 -> 08 -> 09 -> 10 -> 11 -> 12`.
- **Добавление нового клиентского адаптера**: `01 -> 09 -> 10 -> 13 -> (14 / 15 / 16)`.
- **Работа с пулом MCP или бюджетом**: `01 -> 03 -> 05 -> 06`.
- **Работа с разрешениями**: `01 -> 03 -> 04 -> 12`.
- **Отладка продакшн-демона**: `19 -> 18 -> 17 -> 20`.

## Набор документов

### Фундамент

- [`01-architecture.md`](./01-architecture.md) — архитектура системы, топология процессов, карта пакетов и все семь диаграмм последовательностей верхнего уровня.

### Ядро сервера

- [`02-serve-runtime.md`](./02-serve-runtime.md) — загрузка `runNessyServe`, приложение Express, цепочка middleware, корректное завершение работы.
- [`03-acp-bridge.md`](./03-acp-bridge.md) — внутреннее устройство пакета `@nestor/nessy-cli-acp-bridge`, мультиплексирование сессий, фабрика каналов, дочерний процесс ACP.
- [`04-permission-mediation.md`](./04-permission-mediation.md) — `MultiClientPermissionMediator`, четыре политики, инвариант N1 тайм-аута, sentinel отмены.
- [`05-mcp-transport-pool.md`](./05-mcp-transport-pool.md) — `McpTransportPool` (F2), записи пула, обратный индекс, перезапуск, дренаж.
- [`06-mcp-budget-guardrails.md`](./06-mcp-budget-guardrails.md) — `WorkspaceMcpBudget`, режимы (`off`/`warn`/`enforce`), гистерезис, объединение отказанных пакетов.
- [`07-workspace-filesystem.md`](./07-workspace-filesystem.md) — песочница `WorkspaceFileSystem`, политика путей, аудит, контракт `BridgeFileSystem`.
- [`08-session-lifecycle.md`](./08-session-lifecycle.md) — создание / прикрепление / загрузка / возобновление, `X-Nessy-Client-Id`, heartbeat, вытеснение, метаданные.
- [`09-event-schema.md`](./09-event-schema.md) — типизированная схема событий v1: все 43 известных типа событий с полезными данными, редьюсеры, обратная совместимость.
- [`10-event-bus.md`](./10-event-bus.md) — `EventBus`, монотонные ID, кольцевое воспроизведение, `Last-Event-ID`, противодавление медленных клиентов, `client_evicted`.
- [`11-capabilities-versioning.md`](./11-capabilities-versioning.md) — реестр возможностей, версия протокола, версия схемы, условная реклама.
- [`12-auth-security.md`](./12-auth-security.md) — bearer middleware, allowlist хостов, запрет CORS, шлюз мутаций, `--require-auth`, исключение `/health`, device flow.

### Клиенты

- [`13-sdk-daemon-client.md`](./13-sdk-daemon-client.md) — TypeScript SDK: `DaemonClient`, `DaemonSessionClient`, `DaemonAuthFlow`, парсер SSE, редьюсеры событий, слой транскрипции `ui/*`.
- [`14-cli-tui-adapter.md`](./14-cli-tui-adapter.md) — общий слой транскрипции UI и отношения с устаревшим адаптером daemon TUI CLI.
- [`15-channel-adapters.md`](./15-channel-adapters.md) — общая база `DaemonChannelBridge` и адаптеры для каналов DingTalk, WeChat (Weixin), Telegram, Feishu.
- [`16-vscode-ide-adapter.md`](./16-vscode-ide-adapter.md) — `DaemonIdeConnection`, принудительная работа только с loopback, мост через webview.

### Справочные приложения

- [`17-configuration.md`](./17-configuration.md) — переменные окружения, флаги CLI, ключи `settings.json`, влияющие на демон.
- [`18-error-taxonomy.md`](./18-error-taxonomy.md) — типизированные ошибки по слоям с рекомендациями по устранению.
- [`19-observability.md`](./19-observability.md) — `NESSY_SERVE_DEBUG`, рецепты отладки, пробелы в телеметрии.
- [`20-quickstart-operations.md`](./20-quickstart-operations.md) — кратчайший путь запуска, проверки curl, карта маршрутов и встроенные рецепты вызовов.

## Глоссарий

- **ACP** — Agent Client Protocol. JSON-RPC через stdio между мостом daemon и дочерним процессом ACP. Это не HTTP-протокол, который клиенты используют для взаимодействия с демоном.
- **Дочерний процесс ACP** — дочерний процесс, который демон запускает (`nessy --acp`) для размещения среды выполнения агента. Мост мультиплексирует один дочерний процесс ACP для многих подключенных клиентов.
- **acp-bridge** — пакет `@nestor/nessy-cli-acp-bridge` (`packages/acp-bridge/`). Владеет мультиплексированием сессий, медиатором разрешений, шиной событий и фабрикой каналов.
- **BridgeClient** — `packages/acp-bridge/src/bridgeClient.ts`. Обертывает одно соединение ACP `ClientSideConnection` и обрабатывает `requestPermission`, `sendPrompt` и `cancelSession`.
- **Фабрика каналов** — подключаемая стратегия запуска или прикрепления к дочернему процессу ACP. `spawnChannel` по умолчанию запускает `nessy --acp` как подпроцесс; `inMemoryChannel` запускает его внутри процесса для тестов.
- **DaemonClient** — `packages/sdk-typescript/src/daemon/DaemonClient.ts`. Фасад уровня TypeScript SDK HTTP для daemon.
- **DaemonSessionClient** — `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts`. Обертка с областью видимости сессии, которая отслеживает `lastSeenEventId` для воспроизведения SSE.
- **EventBus** — `packages/acp-bridge/src/eventBus.ts`. Внутренний pub/sub на сессию с монотонными ID, ограниченным кольцом и противодавлением на подписчика.
- **F1 / F2 / F3 / F4** — внутренние этапы, отслеживаемые в [#4175](https://github.com/NessyLM/nessy-cli/issues/4175). F1: выделение моста и `BridgeFileSystem`. F2: пул транспортов MCP с областью видимости workspace. F3: медиация разрешений для нескольких клиентов. F4: завершение протокола и поверхности клиентских daemon.
- **MCP** — Model Context Protocol. Серверы предоставляют инструменты, ресурсы и подсказки; дочерний процесс ACP daemon подключается к ним.
- **McpTransportPool** — `packages/core/src/tools/mcp-transport-pool.ts`. Пул F2 с областью видимости workspace, предоставляющий один MCP транспорт для каждого имени сервера и отпечатка конфигурации.
- **Политика медиатора** — одна из `first-responder`, `designated`, `consensus` или `local-only`. Определяет, как разрешаются голоса разрешений для нескольких клиентов.
- **ID клиента-инициатора** — `X-Nessy-Client-Id` клиента, который инициировал подсказку, запрашивающую разрешение. Политика `designated` принимает голоса только от этого ID.
- **PoolEntry** — `packages/core/src/tools/mcp-pool-entry.ts`. Одна запись в `McpTransportPool`: один MCP транспорт, счетчик ссылок прикрепленных сессий и таймер простоя дренажа.
- **Область видимости сессии** — `single` (одна сессия ACP используется всеми клиентами) или `thread` (одна сессия на поток разговора). По умолчанию `single`.
- **SSE** — Server-Sent Events. Исходящий канал событий daemon (`GET /session/:id/events`).
- **Workspace** — директория, к которой демон был привязан при запуске (`--workspace` или `cwd`). Один процесс daemon = один workspace.

## Якоря исходного кода реализации

Используйте эти якоря при переходе от документации к последнему коду в `main`:

| Поверхность                           | Якоря реализации                                                                                                                                                                                                                                          | Основные документы                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Загрузка и сборка HTTP                | `packages/cli/src/serve/run-nessy-serve.ts`, `server.ts`, `/demo`                                                                                                                                                                                         | [`02`](./02-serve-runtime.md), [`20`](./20-quickstart-operations.md)                                                   |
| Мост ACP и мультиплексирование сессий | `packages/acp-bridge/src/bridge.ts`, `packages/acp-bridge/src/bridgeTypes.ts`, `@nestor/nessy-cli-acp-bridge`                                                                                                                                             | [`03`](./03-acp-bridge.md), [`08`](./08-session-lifecycle.md)                                                          |
| Медиация разрешений                   | `packages/acp-bridge/src/permissionMediator.ts`, `fromLoopback: boolean`, `policy.*`                                                                                                                                                                      | [`04`](./04-permission-mediation.md), [`12`](./12-auth-security.md)                                                    |
| Пул транспортов MCP                   | `packages/core/src/tools/mcp-transport-pool.ts`, `mcp-pool-key.ts`, `pid-descendants.ts`, `session-mcp-view.ts`, `/mcp refresh`, `MCPCallInterruptedError`                                                                                                | [`05`](./05-mcp-transport-pool.md), [`06`](./06-mcp-budget-guardrails.md)                                              |
| Ограничители бюджета MCP              | `packages/core/src/tools/mcp-workspace-budget.ts`, `ServeMcpBudgetStatusCell.scope`, `budgets[]`                                                                                                                                                          | [`06`](./06-mcp-budget-guardrails.md)                                                                                  |
| Файловая система Workspace            | `packages/cli/src/serve/fs/`, `assertTrustedForIntent(trusted, intent)`, `meta.matchedIgnore`, `includeIgnored`                                                                                                                                           | [`07`](./07-workspace-filesystem.md)                                                                                   |
| Схема событий и запись SSE            | `packages/sdk-typescript/src/daemon/events.ts`, `packages/cli/src/serve/server.ts`, `formatSseFrame`, `packages/cli/src/acp-integration/session/emitters/ToolCallEmitter.ts`, `ToolCallEmitter.resolveToolProvenance`, `tool_call.provenance`, `serverId` | [`09`](./09-event-schema.md), [`10`](./10-event-bus.md)                                                                |
| Повторная синхронизация событий       | `state_resync_required`, `awaitingResync`, `RESYNC_PASSTHROUGH_TYPES`, `asKnownDaemonEvent`, `unrecognizedKnownEventCount`                                                                                                                                | [`09`](./09-event-schema.md), [`10`](./10-event-bus.md)                                                                |
| Возможности                           | `packages/cli/src/serve/capabilities.ts`, `mcp_server_restart_refused.reason`, `MCP_RESTART_REFUSED_REASONS.has`                                                                                                                                          | [`11`](./11-capabilities-versioning.md)                                                                                |
| Аутентификация и device flow          | `packages/cli/src/serve/auth.ts`, `packages/cli/src/serve/auth/device-flow.ts`                                                                                                                                                                            | [`12`](./12-auth-security.md)                                                                                          |
| Демон-клиент TypeScript SDK           | `packages/sdk-typescript/src/daemon/{DaemonClient,DaemonSessionClient,DaemonAuthFlow,sse,events,types}.ts`, `MCP_RESTART_DEFAULT_TIMEOUT_MS`                                                                                                              | [`13`](./13-sdk-daemon-client.md)                                                                                      |
| Общий слой транскрипции UI            | `DaemonUiEventType`, `DaemonSessionProvider`, `packages/webui/src/daemon/`                                                                                                                                                                                | [`13`](./13-sdk-daemon-client.md), [`14`](./14-cli-tui-adapter.md), [`../daemon-ui/README.md`](../daemon-ui/README.md) |
| Каналы и IDE-адаптеры                 | `packages/channels/`, `packages/vscode-ide-companion/src/services/daemonIdeConnection.ts`                                                                                                                                                                 | [`15`](./15-channel-adapters.md), [`16`](./16-vscode-ide-adapter.md)                                                   |

## Что намеренно вне области применения

- **Демон-клиенты Java / Python SDK** — только TypeScript SDK сегодня предоставляет демон-клиент. Документ 13 только для TypeScript.
- **Детали продукта Web UI** — общий слой транскрипции и точки входа daemon Web UI охвачены здесь, но детали продукта UI отслеживаются в `docs/developers/daemon-ui/` и заметках по дизайну адаптеров.
- **Расширение Zed (`packages/zed-extension/`)** — оно запускает `nessy --acp` напрямую через stdio и обходит демон.
- **Экспериментальный хостинг внутри процесса** — `--no-http-bridge` сегодня все еще использует http-bridge; стабильный режим serve внутри процесса потребует новой документации при появлении.

## Текущее покрытие режима daemon

### Покрытие ядра сервера

| Область                            | Текущее состояние                                                                                                                                                                                             | Основные документы                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Загрузка / путь прослушивания      | `nessy serve` лениво загружает `runNessyServe`, проверяет аутентификацию/workspace/бюджет/настройки, создает приложение Express, затем вызывает `app.listen` и блокируется навсегда до сигнала.               | [`02`](./02-serve-runtime.md), [`20`](./20-quickstart-operations.md)      |
| Ограничители аутентификации / сети | Loopback по умолчанию без bearer; non-loopback требует bearer; `--require-auth` расширяет bearer на loopback и `/health`; Host allowlist и запрет CORS по умолчанию активны.                                  | [`12`](./12-auth-security.md), [`17`](./17-configuration.md)              |
| Жизненный цикл сессии              | `POST /session`, `load`, `resume`, изменение метаданных, heartbeat, вытеснение, сборка простоя, лимиты ожидающих подсказок и корректное закрытие задокументированы.                                           | [`08`](./08-session-lifecycle.md), [`10`](./10-event-bus.md)              |
| Мост ACP                           | Один дочерний процесс ACP мультиплексирован по умолчанию; `sessionScope` поддерживает `single` и `thread`; `BridgeFileSystem`, имя файла контекста, переопределения env и тайм-аут простоя канала подключены. | [`03`](./03-acp-bridge.md), [`07`](./07-workspace-filesystem.md)          |
| Пул / бюджет MCP                   | Пул MCP workspace включен по умолчанию, если не указано `NESSY_SERVE_NO_MCP_POOL=1`; события ограничителя и семантика перезапуска задокументированы.                                                          | [`05`](./05-mcp-transport-pool.md), [`06`](./06-mcp-budget-guardrails.md) |
| Разрешения                         | Медиатор F3 поддерживает `first-responder`, `designated`, `consensus` и `local-only`; недействительные настройки явно завершаются ошибкой.                                                                    | [`04`](./04-permission-mediation.md), [`12`](./12-auth-security.md)       |

### Wire-протокол

| Область              | Текущее состояние                                                                                                                                                | Основные документы                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| HTTP-маршруты        | Каталог маршрутов находится в `nessy-serve-protocol.md`; этот набор daemon только ссылается на него и объясняет принадлежность реализации.                       | [`../../nessy-serve-protocol.md`](../../nessy-serve-protocol.md), [`20`](./20-quickstart-operations.md)       |
| Схема событий        | `EVENT_SCHEMA_VERSION = 1`; 43 известных типа событий; синтетические фреймы без ID для подписчиков; `_meta.serverTimestamp` проставляется на границе записи SSE. | [`09`](./09-event-schema.md), [`10`](./10-event-bus.md)                                                       |
| Возможности          | `SERVE_PROTOCOL_VERSION = 'v1'`; 67 зарегистрированных тегов; 10 условных тегов.                                                                                 | [`11`](./11-capabilities-versioning.md)                                                                       |
| Оболочка сессии      | `POST /session/:id/shell` существует за `--enable-session-shell`, bearer auth и привязанным к сессии `X-Nessy-Client-Id`; тег возможности условный.              | [`11`](./11-capabilities-versioning.md), [`17`](./17-configuration.md), [`20`](./20-quickstart-operations.md) |
| Ограничение скорости | Опциональное ограничение скорости HTTP на уровень предоставляется через флаги CLI/env и условный тег возможности.                                                | [`11`](./11-capabilities-versioning.md), [`17`](./17-configuration.md)                                        |

### Клиенты / SDK

| Область                     | Текущее состояние                                                                                                                                                  | Основные документы                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Демон-клиент TypeScript SDK | `DaemonClient`, `DaemonSessionClient`, `DaemonAuthFlow`, парсер SSE, редьюсеры событий, префлайт возможностей и экспорт транскрипции UI задокументированы.         | [`13`](./13-sdk-daemon-client.md)                                                                                                             |
| Общий слой транскрипции UI  | SDK `daemon/ui/*` нормализует события daemon в 37 семантических типов событий UI, сводит их в блоки транскрипции и предоставляет рендереры/помощники соответствия. | [`14`](./14-cli-tui-adapter.md), [`../daemon-ui/README.md`](../daemon-ui/README.md), [`../daemon-ui/MIGRATION.md`](../daemon-ui/MIGRATION.md) |
| Потребитель daemon Web UI   | `packages/webui/src/daemon/` потребляет хранилище транскрипций SDK через React-провайдеры и адаптеры.                                                              | [`14`](./14-cli-tui-adapter.md), [`../daemon-client-adapters/web-ui.md`](../daemon-client-adapters/web-ui.md)                                 |
| CLI TUI / каналы / VS Code  | Устаревшие пути все еще существуют; миграция на общие примитивы транскрипции задокументирована как последующая работа, а не завершенное поведение.                 | [`14`](./14-cli-tui-adapter.md), [`15`](./15-channel-adapters.md), [`16`](./16-vscode-ide-adapter.md)                                         |

### Ссылки и операции

| Область                  | Текущее состояние                                                                                                                                                                  | Основные документы                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Конфигурация             | Полные флаги `nessy serve`, переменные окружения, `settings.json`, `ServeOptions`, `BridgeOptions` и важные константы собраны на одной странице.                                   | [`17`](./17-configuration.md)         |
| Быстрый старт / операции | Кратчайший путь запуска, рецепты запуска, проверки curl, поведение аутентификации демо-страницы, разделение маршрутов, поведение завершения и встроенные рецепты вызовов охвачены. | [`20`](./20-quickstart-operations.md) |
| Ошибки                   | Явные ошибки времени загрузки, ошибки маршрутов, ошибки моста, ошибки EventBus, ошибки файловой системы и ошибки медиатора обобщены с рекомендациями по устранению.                | [`18`](./18-error-taxonomy.md)        |
| Наблюдаемость            | `NESSY_SERVE_DEBUG`, рецепты curl, полезные события, пробелы в телеметрии и контрольные списки расследования задокументированы.                                                    | [`19`](./19-observability.md)         |

### Устаревшие или исторические поверхности

| Поверхность                                        | Статус                                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `docs/developers/daemon-client-adapters/tui.md`    | Исторический черновик для старого спайка `DaemonTuiAdapter`; текущая архитектура общего транскрипции UI находится в документе 14. |
| `packages/cli/src/ui/daemon/daemon-tui-adapter.ts` | Устаревший экспериментальный адаптер все еще в дереве. Новая общая работа UI должна предпочитать SDK `daemon/ui/*`.               |
| `--no-http-bridge`                                 | Принимается для совместимости, но использует http-bridge и печатает stderr.                                                       |

### Обратная совместимость

- Схема событий v1 аддитивна. Новые известные типы событий должны добавляться в `DAEMON_KNOWN_EVENT_TYPE_VALUES`; старые SDK должны рассматривать неизвестные типы как обратно совместимые.
- Теги возможностей — это контракты поведения. Новое поведение требует нового тега, особенно если клиенты могут выполнять префлайт перед вызовом маршрута.
- `sessionScope: 'thread'` — это текущее разделение по потокам разговора; избегайте возвращения к старой формулировке с областью видимости клиента.
- Обертка `_meta` и полезная данные ACP `data._meta` различны. Происхождение вызова инструмента находится под полезными данными ACP; временные метки*emit*сервера находятся в оболочке SSE.

## Происхождение версии

Этот набор документов отражает поверхность режима daemon, которая в настоящее время объединена в `main`, включая последующую работу из [#4412](https://github.com/NessyLM/nessy-cli/pull/4412). Он намеренно описывает текущее поведение, а не более ранние снимки планирования F-серии.
