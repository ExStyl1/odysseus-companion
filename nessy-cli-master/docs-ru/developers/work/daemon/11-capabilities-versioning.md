---
title: Возможности и версионирование протокола
---

# Возможности и версионирование протокола

## Обзор

`GET /capabilities` — это endpoint префлайта демона. Каждый SDK-клиент должен прочитать его перед вызовом любого другого маршрута, чтобы узнать, какую версию протокола поддерживает демон, какие теги функций включены и к какому workspace привязан демон. Контракт:

- **Существует только одна версия протокола: `v1`.** `SERVE_PROTOCOL_VERSION = 'v1'` и `SUPPORTED_SERVE_PROTOCOL_VERSIONS = ['v1']`. Внутри v1 добавляет функции; изменения формы фрейма с нарушением совместимости зарезервированы для v2.
- **У каждого тега есть версия `since`.** Будущие демоны v2 могут рекламировать теги как v1, так и v2.
- **Некоторые теги условны.** Десять тегов (`require_auth`, `mcp_workspace_pool`, `mcp_pool_restart`, `allow_origin`, `prompt_absolute_deadline`, `writer_idle_timeout`, `workspace_settings`, `session_shell_command`, `rate_limit`, `workspace_reload`) рекламируются только при включённом соответствующем переключателе развёртывания. Наличие тега означает, что поведение существует.
- **Тег возможности = контракт поведения.** Добавление нового поведения под существующим тегом может молча сломать клиентов, которые сделали префлайт старого тега. Новое поведение требует нового тега.

Полный реестр живёт в `packages/cli/src/serve/capabilities.ts`.

## Ответственность

- Объявить каждую функцию, которую демон может рекламировать.
- Фильтровать рекламируемые функции по версии протокола и переключателям развёртывания.
- Предоставить `getRegisteredServeFeatures()` (все ключи, без фильтрации), `getAdvertisedServeFeatures(version, toggles)` (отфильтрованные) и `getServeProtocolVersions()` (обёртка `{ current, supported }`).
- Сохранить инвариант «наличие тега означает наличие поведения». `server.test.ts` включает тест, что каждый условный тег рекламируется, когда его переключатель включён; добавление условного тега без предиката приводит к провалу этого теста.

## Архитектура

### Обёртка возможностей

`/capabilities` возвращает:

```ts
{
  v: 1,                    // CAPABILITIES_SCHEMA_VERSION
  mode: 'http-bridge',
  features: ServeFeature[],
  workspaceCwd: string,
  protocol?: { current: 'v1', supported: ['v1'] },
  policy?: { permission: PermissionPolicy },
}
```

`workspaceCwd` — это канонический workspace, привязанный при загрузке демона (см. [`02-serve-runtime.md`](./02-serve-runtime.md)). `policy.permission` — активный медиатор политики.

### `ServeCapabilityDescriptor`

```ts
interface ServeCapabilityDescriptor {
  since: ServeProtocolVersion; // current = 'v1'
  modes?: readonly string[]; // перечисляет режимы работы, когда у функции есть режимы
}
```

Два тега v1 используют `modes`:

- `mcp_guardrails: { since: 'v1', modes: ['warn', 'enforce'] }` — клиенты должны делать префлайт `'enforce'` перед тем, как полагаться на поведение отказа.
- `permission_mediation: { since: 'v1', modes: ['first-responder', 'designated', 'consensus', 'local-only'] }` — это набор, поддерживаемый на этапе сборки; активная политика находится в `policy.permission`.

### Условные теги

```ts
export const CONDITIONAL_SERVE_FEATURES: ReadonlyMap<
  ServeFeature,
  (toggles: AdvertiseFeatureToggles) => boolean
> = new Map([
  ['require_auth', (t) => t.requireAuth === true],
  ['mcp_workspace_pool', (t) => t.mcpPoolActive === true],
  ['mcp_pool_restart', (t) => t.mcpPoolActive === true],
  ['allow_origin', (t) => t.allowOriginActive === true],
  [
    'prompt_absolute_deadline',
    (t) => typeof t.promptDeadlineMs === 'number' && t.promptDeadlineMs > 0,
  ],
  [
    'writer_idle_timeout',
    (t) =>
      typeof t.writerIdleTimeoutMs === 'number' && t.writerIdleTimeoutMs > 0,
  ],
  ['workspace_settings', (t) => t.persistSettingAvailable === true],
  ['session_shell_command', (t) => t.sessionShellCommandEnabled === true],
  ['rate_limit', (t) => t.rateLimit === true],
  ['workspace_reload', (t) => t.reloadAvailable === true],
]);
```

`Map` хранит членство и предикат вместе. Добавление нового условного тега требует двух скоординированных изменений:

1. Зарегистрировать тег и его версию `since` в `SERVE_CAPABILITY_REGISTRY`.
2. Добавить его предикат в `CONDITIONAL_SERVE_FEATURES`.

Базовые теги отсутствуют в `Map` и рекламируются безусловно. Это намеренно представлено отсутствием, а не отдельным Set.

### 67 тегов (v1, сгруппировано по домену)

Фундамент: `health`, `capabilities`.

Сессии: `session_create`, `session_scope_override`, `session_load`, `session_resume`, `unstable_session_resume`, `session_list`, `session_prompt`, `session_cancel`, `session_events`, `session_set_model`, `session_close`, `session_metadata`, `session_context`, `session_context_usage`, `session_supported_commands`, `session_tasks`, `session_stats`, `session_lsp`, `session_approval_mode_control`, `session_recap`, `session_btw`, **`session_shell_command`** (условный), `session_language`, `session_rewind`, `session_hooks`, `session_branch`.

Потоковая передача: `slow_client_warning`, `typed_event_schema`.

Идентичность и heartbeat: `client_identity`, `client_heartbeat`.

Разрешения: `session_permission_vote`, `permission_vote`, **`permission_mediation`** (`modes: ['first-responder', 'designated', 'consensus', 'local-only']`).

Workspace read-only snapshots: `workspace_mcp`, `workspace_skills`, `workspace_providers`, `workspace_env`, `workspace_preflight`, `workspace_hooks`, `workspace_extensions`.

Workspace mutation (Wave 4+): `workspace_memory`, `workspace_agents`, `workspace_agent_generate`, `workspace_tool_toggle`, **`workspace_settings`** (условный), `workspace_init`, `workspace_mcp_restart`, `workspace_mcp_manage`, `workspace_file_read`, `workspace_file_bytes`, `workspace_file_write`, **`workspace_reload`** (условный).

MCP guardrails: **`mcp_guardrails`** (`modes: ['warn', 'enforce']`), `mcp_guardrail_events`, `mcp_server_runtime_mutation`, **`mcp_workspace_pool`** (условный), **`mcp_pool_restart`** (условный).

Управление prompt: **`prompt_absolute_deadline`** (условный), **`writer_idle_timeout`** (условный), `non_blocking_prompt`.

Auth: `auth_provider_install`, `auth_device_flow`, **`require_auth`** (условный), **`allow_origin`** (условный).

Rate limiting: **`rate_limit`** (условный).

Жирные теги имеют `modes` или являются условными.

## Поток

### Сторона демона: сборка обёртки

```mermaid
flowchart LR
    A["GET /capabilities"] --> B["getAdvertisedServeFeatures(version, toggles)"]
    B --> C["фильтрация по isFeatureAvailableInProtocol"]
    C --> D["для каждой функции проверка CONDITIONAL_SERVE_FEATURES"]
    D --> E["да: predicate(toggles) ? включить : отбросить"]
    D --> F["нет: включить безусловно"]
    E --> G["вернуть ServeFeature[]"]
    F --> G
    G --> H["обёрнуть в обёртку:<br/>{ v: 1, mode, features, workspaceCwd, protocol, policy }"]
```

### Сторона клиента: префлайт функции

```mermaid
sequenceDiagram
    autonumber
    participant C как Клиент
    participant D как GET /capabilities
    participant R как Маршрут

    C->>D: GET /capabilities
    D-->>C: { v, mode, features, workspaceCwd, protocol, policy }
    C->>C: features.includes('mcp_workspace_pool')?
    alt да
        C->>R: полагаться на формы ответов с учётом pool<br/>(например entries[] из /workspace/mcp/:server/restart)
    else нет
        C->>R: устаревшая форма ответа с одной записью
    end
```

## Состояние и жизненный цикл

- `CAPABILITIES_SCHEMA_VERSION` — это версия формы обёртки провода, в настоящее время `1`. Увеличивайте её только при нарушении обёртки.
- `SERVE_PROTOCOL_VERSION = 'v1'` — это версия протокола-функции. Добавление функций внутри v1 является аддитивным; старые клиенты не видят нового поведения, если не делают префлайт нового тега. Удаление функции — это нарушение v2.
- `EVENT_SCHEMA_VERSION = 1` — это поле `v` фрейма SSE (см. [`09-event-schema.md`](./09-event-schema.md)). Это независимая ось версионирования; увеличение версии события не подразумевает увеличения версии протокола, и наоборот.
- `session_resume` — это стабильная возможность демона для `POST /session/:id/resume`. `unstable_session_resume` остаётся рекламируемым как устаревший псевдоним, потому что базовый метод ACP всё ещё называется `connection.unstable_resumeSession`; новые клиенты должны определять наличие функции `session_resume`.

## Зависимости

- Читается `packages/cli/src/serve/server.ts` при построении ответов `/capabilities`.
- Входные данные переключателя поступают от `runNessyServe` / `createServeApp`: `{ requireAuth, mcpPoolActive, allowOriginActive, promptDeadlineMs, writerIdleTimeoutMs, persistSettingAvailable, sessionShellCommandEnabled, rateLimit, reloadAvailable }`.
- Активная политика `permission` в обёртке поступает из `BridgeOptions.permissionPolicy`, которая сама читает `settings.json` `policy.permissionStrategy`.

## Конфигурация

| Источник                    | Рычаг                                                           | Влияние на возможности                                                                                                    |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| CLI флаг                    | `--require-auth`                                                | Рекламирует `require_auth`.                                                                                               |
| Env                         | `NESSY_SERVE_NO_MCP_POOL=1`                                     | Прекращает рекламировать `mcp_workspace_pool` и `mcp_pool_restart`; события MCP больше не штампуют `scope: 'workspace'`.  |
| CLI флаг                    | `--mcp-client-budget=N`, `--mcp-budget-mode={off,warn,enforce}` | Не изменяет набор тегов (`mcp_guardrails` рекламируется всегда), но изменяет резервирование на сервер и поведение отказа. |
| CLI флаг / env              | `--rate-limit` / `NESSY_SERVE_RATE_LIMIT=1`                     | Рекламирует `rate_limit`.                                                                                                 |
| Встроенная опция            | `persistSettingAvailable`                                       | Рекламирует `workspace_settings`.                                                                                         |
| CLI флаг / встроенная опция | `--enable-session-shell` / `sessionShellCommandEnabled`         | Рекламирует `session_shell_command`.                                                                                      |
| Встроенная опция            | `reloadAvailable`                                               | Рекламирует `workspace_reload`.                                                                                           |
| `settings.json`             | `policy.permissionStrategy`                                     | Устанавливает `policy.permission` обёртки.                                                                                |

## Ограничения и известные пределы

- **`--require-auth` скрывает префлайт.** При `--require-auth` все маршруты, включая `/capabilities`, требуют bearer auth. Неаутентифицированный клиент не может сделать префлайт `caps.features.require_auth`; тело ответа 401 — это поверхность обнаружения. Тег `require_auth` — это подтверждение аутентификации для аудит-интерфейсов жёсткого развёртывания.
- **Наличие тега означает наличие поведения.** Если будущий контрибьютор добавляет поведение под существующим тегом без увеличения `since`, клиенты, которые сделали префлайт старого тега, могут молча получить новое поведение. Соглашение: новое поведение получает новый тег.
- **Теги `unstable_*` могут изменить форму между версиями** без увеличения протокола. Фиксируйте версию SDK при зависимости от них.
- Каталог маршрутов живёт в [`../../nessy-serve-protocol.md`](../../nessy-serve-protocol.md); эта страница намеренно не дублирует его.

## Ссылки

- `packages/cli/src/serve/capabilities.ts`
- `packages/cli/src/serve/types.ts` (`ServeOptions`, `CapabilitiesEnvelope`)
- `packages/cli/src/serve/server.ts` (сборка обёртки)
- `packages/acp-bridge/src/eventBus.ts` (`EVENT_SCHEMA_VERSION`)
- Справочник провода: [`../../nessy-serve-protocol.md`](../../nessy-serve-protocol.md)
- Auth и guardrails развёртывания: [`12-auth-security.md`](./12-auth-security.md)
