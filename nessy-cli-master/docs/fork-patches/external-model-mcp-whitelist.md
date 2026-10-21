# external-model-mcp-whitelist

## AIDT

AIDT-7489, AIDT-8198

## Зачем

Внешние модели (`model.internal === false`) не должны получать доступ к MCP-инструментам по умолчанию. Без белого списка внешняя модель может обращаться к внутренним системам и передавать корпоративные данные внешнему провайдеру.

Реализован fail-closed механизм: внешний модели доступны **только** MCP-серверы из зашитого в код белого списка. Пустой список = ни одного MCP-инструмента.

## Определение «внутренности» модели

Принадлежность модели к внутренним определяется **только по префиксу id модели** (`tgpt/`), а не по `auth-type`. Это единое правило для всех путей создания конфигурации генератора:

- **Registry-путь** (`resolveModelConfig`) — `internal: isInternalModel(config.id)`.
- **Базовый путь** (`resolveContentGeneratorConfigWithSources`) — `internal` всегда пересчитывается как `isInternalModel(model)`, а не наследуется от переданного `generationConfig`.
- **Агентский путь** (`buildAgentContentGeneratorConfig`) — `internal` пересчитывается по целевой модели агента, а не наследуется от родителя.

Без этого внутренняя `tgpt/<model>` модель, авторизованная через кастомный/сервисный токен (`auth-type openai`, кейс ants/CI), трактовалась как внешняя и теряла доступ ко всем MCP-серверам вне белого списка (включая `time`). Исправлено в AIDT-8198: `internal` теперь всегда следует из префикса модели, независимо от способа авторизации. Безопасность сохраняется — по-настоящему внешние модели (не `tgpt/`) по-прежнему ограничиваются whitelist (fail-closed).

## Порядок: сначала фильтрация, потом блокировка

`getAllMcpServers()` выполняет два независимых шага:

1. **Фильтрация** — `isMcpServerInAllowList()`, явный список сессии (`--allowed-mcp-server-names`, `mcp.allowed`). Не зависит от модели: сервер вне списка не существует для этого запуска и не попадает даже в `blocked`.
2. **Блокировка** — `isMcpServerAllowedForModel()`, граница доверия активной модели. Применяется к результату шага 1 и делит его на `allowed` и `blocked`.

Возвращается `{ all, allowed, blocked }`, где `all` — набор после фильтрации. `getMcpServers()` отдаёт `allowed` (перечисление серверов для модели), UI-диалог берёт `all` + `blocked`, чтобы показать заблокированные записи как отключённые. `isMcpServerAllowed()` = оба шага сразу.

Пока `contentGeneratorConfig` не установлен (`refreshAuth()` ещё не вызван), блокировка не действует: внутри sandbox `config.initialize()` вместе с MCP-дискавери выполняется до авторизации, и трактовка «модели ещё нет» как внешней оставила бы серверы неподключёнными даже для internal-моделей. Генерации в этом окне нет, а к моменту запроса инструментов `contentGeneratorConfig` уже установлен: `tool-registry` перепроверяет предикат на каждой декларации, а пересечение границы internal/external вызывает `refreshTools()`.

## Файлы

- `packages/core/src/core/openaiContentGenerator/constants.ts` — `EXTERNAL_MODEL_MCP_WHITELIST` (иммутабельный пустой массив)
- `packages/core/src/config/config.ts` — `isMcpServerInAllowList()`, `isMcpServerAllowedForModel()`, `isMcpServerAllowed()`, интеграция в `getAllMcpServers()` / `getMcpServers()`, `getBlockedMcpServers()`, refresh при переключении через границу доверия
- `packages/core/src/core/contentGenerator.ts` — `internal` пересчитывается как `isInternalModel(model)` в `resolveContentGeneratorConfigWithSources` (AIDT-8198)
- `packages/core/src/models/content-generator-config.ts` — `internal` пересчитывается как `isInternalModel(model)` в `buildAgentContentGeneratorConfig` (AIDT-8198)
- `packages/core/src/tools/tool-registry.ts` — фильтрация MCP в `getFunctionDeclarations()`, `getTool()`, `getFunctionDeclarationsFiltered()`, `getDeferredToolSummary()`
- `packages/core/src/tools/mcp-client-manager.ts` — отклонение `addRuntimeMcpServer()` для неразрешённых серверов
- `packages/core/src/config/config.test.ts` — тесты fail-closed, internal/external переключения, runtime overlay, openai+tgpt / openai+external
- `packages/core/src/tools/tool-registry.test.ts` — тест на неразрешённые MCP-инструменты
- `packages/core/src/tools/mcp-client-manager.test.ts` — тест на отклонение runtime MCP

## Откат

1. Удалить константу `EXTERNAL_MODEL_MCP_WHITELIST` из `constants.ts`.
2. Удалить методы `isMcpServerAllowed()` и `isMcpServerAllowedForModel()` из `config.ts`, оставить только фильтрацию по `allowedMcpServers` (шаг 1).
3. Удалить вызовы `isMcpServerAllowed()` из `config.ts`, `tool-registry.ts`, `mcp-client-manager.ts`.
4. Удалить тесты, специфичные для белого списка внешних моделей.
5. Удалить этот файл и строку из таблицы README.md.

## Upstream

Не отправлен. Корпоративное требование безопасности — внешние модели не должны иметь доступ к MCP без явного белого списка.

## Кодовые маркеры

```ts
// [nessy-fork] external-model-mcp-whitelist
```

Расставлены в:

- `packages/core/src/core/openaiContentGenerator/constants.ts` — константа белого списка
- `packages/core/src/config/config.ts` — метод `isMcpServerAllowed()`
- `packages/core/src/core/contentGenerator.ts` — пересчёт `internal` по префиксу (AIDT-8198)
- `packages/core/src/models/content-generator-config.ts` — пересчёт `internal` по префиксу (AIDT-8198)
- `packages/core/src/tools/tool-registry.ts` — фильтрация деклараций
- `packages/core/src/tools/mcp-client-manager.ts` — guard на runtime добавление
- `packages/core/src/config/config.test.ts` — тесты белого списка
- `packages/core/src/tools/tool-registry.test.ts` — тест на неразрешённые MCP
- `packages/core/src/tools/mcp-client-manager.test.ts` — тест на отклонение runtime MCP
