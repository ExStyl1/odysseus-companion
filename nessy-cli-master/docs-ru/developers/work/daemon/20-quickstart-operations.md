---
title: Быстрый старт и эксплуатация
---

# Быстрый старт и эксплуатация

Эта страница фокусируется на **как запустить `nessy serve`, как проверить, что он работает, и как выглядит цепочка внутренних вызовов от `nessy serve` к слушающему серверу**. Архитектура, компоненты и детали протокола провода живут на других страницах глубокого погружения в демон.

## 1. Кратчайший путь

```bash
nessy serve
```

Вывод:

```text
nessy serve listening on http://127.0.0.1:4170 (mode=http-bridge, workspace=/your/cwd)
nessy serve: bound to workspace "/your/cwd"
nessy serve: bearer auth disabled (loopback default). Set NESSY_SERVER_TOKEN to enable.
```

Откройте `http://127.0.0.1:4170/demo` в браузере, чтобы увидеть отладочную консоль: UI чата, поток событий и инспектор рабочей области. В режиме разработки loopback по умолчанию `/demo` зарегистрирован **до** `bearerAuth` в ветке loopback маршрута `packages/cli/src/serve/server.ts`, поэтому токен не требуется.

## 2. Рецепты запуска

```bash
# 1. Локальная dev по умолчанию (loopback, без токена)
nessy serve

# 2. Явная рабочая область + эфемерный порт
nessy serve --workspace /path/to/repo --port 0

# 3. Hardened разработка loopback (принудительный bearer даже на loopback)
NESSY_SERVER_TOKEN=$(openssl rand -hex 32) nessy serve --require-auth

# 4. Экспозиция в LAN (не-loopback требует токена)
NESSY_SERVER_TOKEN=$(openssl rand -hex 32) \
  nessy serve --hostname 0.0.0.0 --port 4170

# 5. Настройка для многих сессий и большего кольца реплея
nessy serve --max-sessions 0 --event-ring-size 32000

# 6. Мультиклиентское сотрудничество + строгий бюджет MCP
NESSY_SERVER_TOKEN=secret \
  nessy serve --require-auth \
             --mcp-client-budget 10 \
             --mcp-budget-mode enforce

# 7. Запуск с политикой consensus, настроенной в settings.json
# settings.json: { "policy": { "permissionStrategy": "consensus", "consensusQuorum": 2 } }
nessy serve

# 8. Отладочное логирование
NESSY_SERVE_DEBUG=1 nessy serve

# 9. Отключение пула F2 (откат к MCP клиентам на сессию)
NESSY_SERVE_NO_MCP_POOL=1 nessy serve

# 10. Разрешить cross-origin доступ браузерного веб-UI
NESSY_SERVER_TOKEN=secret \
  nessy serve --allow-origin 'http://localhost:3000'

# 11. Deadline запроса + таймаут простоя SSE
nessy serve --prompt-deadline-ms 300000 --writer-idle-timeout-ms 600000

# 12. Держать дочерний процесс ACP тёплым после закрытия последней сессии
nessy serve --channel-idle-timeout-ms 60000

# 13. Включить HTTP rate limiting
NESSY_SERVE_RATE_LIMIT=1 nessy serve
```

С hardened рецептом loopback (3), `/demo` зарегистрирован после `bearerAuth`. Обычная навигация браузера требует заголовка auth, поэтому используйте curl или скрипт SDK вместо этого.

## 3. Полные флаги запуска

CLI определён в **`packages/cli/src/commands/serve.ts`**:

| Флаг                                    | Тип                            | По умолчанию                            | Требуется когда                         | Эффект                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------ | --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--port <n>`                            | число                          | `4170`                                  | -                                       | TCP порт; `0` означает назначенный ОС эфемерный порт.                                                                                                                                                                                      |
| `--hostname <host>`                     | строка                         | `127.0.0.1`                             | Не-loopback требует токена              | Адрес привязки. Loopback значения: `127.0.0.1`, `localhost`, `::1`, `[::1]`. Скобки `[::1]` автоматически stripping; ввод `host:port` отклоняется с рекомендацией использовать `--port`.                                                   |
| `--token <s>`                           | строка                         | env / нет                               | Не-loopback и `--require-auth`          | Bearer токен; обрезается один раз. **Появляется в `/proc/<pid>/cmdline`, поэтому предпочитайте `NESSY_SERVER_TOKEN`**. stderr запуска также предупреждает об этом.                                                                         |
| `--max-sessions <n>`                    | число                          | `20`                                    | -                                       | Ограничение активных сессий. Избыточный спавн возвращает 503. `0` означает без ограничений. `NaN` / отрицательные значения выбрасывают.                                                                                                    |
| `--max-pending-prompts-per-session <n>` | число                          | `5`                                     | -                                       | Ограничение принятых, но ожидающих/выполняющихся запросов на сессию. Избыточный запрос возвращает 503. `0` / `Infinity` означает без ограничений. Отрицательные или нецелые значения выбрасывают.                                          |
| `--workspace <dir>`                     | строка                         | `process.cwd()`                         | -                                       | Привязанная рабочая область. **Должен быть абсолютным путём, существовать и быть директорией**. Запуск канонизирует его один раз через `canonicalizeWorkspace`. `POST /session` с несовпадающим `cwd` возвращает `400 workspace_mismatch`. |
| `--max-connections <n>`                 | число                          | `256`                                   | -                                       | Listener-level `server.maxConnections`. `0` / `Infinity` означает без ограничений. `NaN` / отрицательные значения проваливают запуск, чтобы избежать fail-open поведения.                                                                  |
| `--require-auth`                        | булево                         | `false`                                 | Требуется токен                         | Расширяет bearer auth на loopback **и** `/health`. Запуск отказывается стартовать без токена.                                                                                                                                              |
| `--enable-session-shell`                | булево                         | `false`                                 | Требуется токен                         | Включает прямое выполнение `POST /session/:id/shell`. Вызывающие также должны отправить session-bound `X-Nessy-Client-Id`.                                                                                                                 |
| `--event-ring-size <n>`                 | число                          | `8000`                                  | -                                       | Глубина кольца SSE-реплея на сессию. Мягкий предел `MAX_EVENT_RING_SIZE = 1_000_000`; out-of-range значения выбрасывают во время построения моста.                                                                                         |
| `--http-bridge`                         | булево                         | `true`                                  | -                                       | Режим моста этапа 1: один дочерний процесс `nessy --acp` мультиплексирован демоном. Режим in-process этапа 2 ещё не реализован; `--no-http-bridge` откатывается и печатает в stderr.                                                       |
| `--mcp-client-budget <n>`               | число                          | нет                                     | Требуется для `mcp-budget-mode=enforce` | Ограничение MCP клиента рабочей области. Должно быть положительным целым.                                                                                                                                                                  |
| `--mcp-budget-mode <m>`                 | `'enforce' \| 'warn' \| 'off'` | `warn`, когда бюджет задан, иначе `off` | `enforce` требует `--mcp-client-budget` | `enforce` отказывает, `warn` только предупреждает при 75%, `off` — только наблюдение.                                                                                                                                                      |
| `--allow-origin <pattern>`              | повторяемая строка             | нет                                     | -                                       | CORS allowlist, заменяющий отказ Origin по умолчанию. `*` требует токена.                                                                                                                                                                  |
| `--allow-private-auth-base-url`         | булево                         | `false`                                 | -                                       | Разрешает установку `baseUrl` провайдера auth localhost / private-network. Использовать только для доверенной локальной разработки.                                                                                                        |
| `--prompt-deadline-ms <n>`              | число                          | нет                                     | -                                       | Серверный лимит wallclock запроса в мс; таймаут прерывает запрос.                                                                                                                                                                          |
| `--writer-idle-timeout-ms <n>`          | число                          | нет                                     | -                                       | Таймаут простоя на SSE-соединение в мс.                                                                                                                                                                                                    |
| `--channel-idle-timeout-ms <n>`         | число                          | `0`                                     | -                                       | Держит дочерний процесс ACP живым после закрытия последней сессии. `0` означает немедленное освобождение.                                                                                                                                  |
| `--session-reap-interval-ms <n>`        | число                          | `60000`                                 | -                                       | Интервал сканирования сборщика сессий. `0` отключает его.                                                                                                                                                                                  |
| `--session-idle-timeout-ms <n>`         | число                          | `1800000`                               | -                                       | Таймаут простоя отключённой сессии. `0` отключает его.                                                                                                                                                                                     |
| `--rate-limit` / `--no-rate-limit`      | булево                         | env / off                               | -                                       | Включает или отключает поэтапное HTTP rate limiting.                                                                                                                                                                                       |
| `--rate-limit-prompt <n>`               | число                          | `10`                                    | `--rate-limit`                          | Запросов запросов на окно.                                                                                                                                                                                                                 |
| `--rate-limit-mutation <n>`             | число                          | `30`                                    | `--rate-limit`                          | Запросов мутаций на окно.                                                                                                                                                                                                                  |
| `--rate-limit-read <n>`                 | число                          | `120`                                   | `--rate-limit`                          | Запросов чтения на окно.                                                                                                                                                                                                                   |
| `--rate-limit-window-ms <n>`            | число                          | `60000`                                 | `--rate-limit`                          | Длина окна rate limiting; должно быть `>= 1000`.                                                                                                                                                                                           |

## 4. Переменные окружения

| Env                                  | Эквивалентный флаг / эффект                                                                                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NESSY_SERVER_TOKEN`                 | Эквивалентно `--token`; `--token` главнее. Обрезается один раз при запуске, чтобы избежать завершающего перевода строки от `cat token.txt`.                                   |
| `NESSY_SERVE_DEBUG`                  | `1` / `true` / `on` / `yes` (без учёта регистра) включает подробные логи stderr.                                                                                              |
| `NESSY_SERVE_NO_MCP_POOL`            | `1` отключает пул MCP рабочей области полностью и откатывается к `McpClientManager` на сессию. Возможности перестают рекламировать `mcp_workspace_pool` / `mcp_pool_restart`. |
| `NESSY_SERVE_MCP_CLIENT_BUDGET`      | Ввод бюджета внутри ACP-дочернего процесса. CLI генерирует его из `--mcp-client-budget` через `childEnvOverrides`; это не родительский env fallback.                          |
| `NESSY_SERVE_MCP_BUDGET_MODE`        | Режим бюджета внутри ACP-дочернего процесса. CLI генерирует его из `--mcp-budget-mode` через `childEnvOverrides`; это не родительский env fallback.                           |
| `NESSY_SERVE_PROMPT_DEADLINE_MS`     | Env fallback для `--prompt-deadline-ms`.                                                                                                                                      |
| `NESSY_SERVE_WRITER_IDLE_TIMEOUT_MS` | Env fallback для `--writer-idle-timeout-ms`.                                                                                                                                  |
| `NESSY_SERVE_MCP_POOL_TRANSPORTS`    | Читается ACP-дочерним процессом. Разделённый запятыми allowlist пула транспортов; по умолчанию `stdio,websocket`.                                                             |
| `NESSY_SERVE_MCP_POOL_DRAIN_MS`      | Читается ACP-дочерним процессом. Задержка слива простоя записи пула; по умолчанию `30000`, ограничено `1000..600000` мс.                                                      |
| `NESSY_SERVE_RATE_LIMIT`             | `1` / `true` включает rate limiting; флаг CLI главнее.                                                                                                                        |
| `NESSY_SERVE_RATE_LIMIT_PROMPT`      | Env fallback для `--rate-limit-prompt`.                                                                                                                                       |
| `NESSY_SERVE_RATE_LIMIT_MUTATION`    | Env fallback для `--rate-limit-mutation`.                                                                                                                                     |
| `NESSY_SERVE_RATE_LIMIT_READ`        | Env fallback для `--rate-limit-read`.                                                                                                                                         |
| `NESSY_SERVE_RATE_LIMIT_WINDOW_MS`   | Env fallback для `--rate-limit-window-ms`.                                                                                                                                    |

Переопределения env на обработчик намеренны: два демона, работающих в одном процессе, не гоняются за `process.env`. `defaultSpawnChannelFactory` снимает env во время спавна.

## 5. `settings.json` также читается

Запуск вызывает `loadSettings(boundWorkspace)` один раз:

| Ключ                        | Тип                                                                | Поведение                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy.permissionStrategy` | `'first-responder' \| 'designated' \| 'consensus' \| 'local-only'` | Устанавливает `BridgeOptions.permissionPolicy`. **Запуск валидирует с `validatePolicyConfig`**; неизвестные значения выбрасывают `InvalidPolicyConfigError` вместо молчаливого отката. |
| `policy.consensusQuorum`    | положительное целое                                                | N для политики `consensus`. По умолчанию `floor(M/2)+1`. Если установлено при политике не consensus, игнорируется, и запуск логирует предупреждение stderr.                            |
| `context.fileName`          | строка                                                             | Переопределяет `getCurrentGeminiMdFilename()` и контролирует, какой файл пишет `POST /workspace/init`.                                                                                 |
| `tools.disabled`            | string[]                                                           | Нормализуется через `normalizeDisabledToolList()` (trim, отбросить пустые записи, dedupe) перед влиянием на следующий спавн ACP-дочернего процесса.                                    |
| `tools.approvalMode`        | строка                                                             | Режим утверждения сессии по умолчанию.                                                                                                                                                 |
| `telemetry`                 | объект                                                             | Конфигурация OTel: `enabled`, `otlpEndpoint`, `otlpProtocol`, per-signal endpoints и другое. См. [`17-configuration.md`](./17-configuration.md).                                       |

Сбой I/O настроек, такой как malformed JSON, откатывается к значениям по умолчанию. `InvalidPolicyConfigError` — исключение: неправильная конфигурация политики явно проваливает запуск.

## 6. Сценарии отказа запуска (явные сбои)

`run-nessy-serve.ts` намеренно выбрасывает вместо отката в этих случаях:

| Сценарий                                                                              | Префикс ошибки                                                                                      |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Не-loopback привязка без токена                                                       | `Refusing to bind ... without a bearer token`                                                       |
| `--require-auth` без токена                                                           | `Refusing to start with --require-auth set but no bearer token`                                     |
| `--workspace` не существует, не директория или не абсолютный                          | `Invalid --workspace ...`                                                                           |
| `--workspace` stat permission denied                                                  | `Invalid --workspace ...: permission denied`                                                        |
| `--mcp-client-budget` не положительное целое                                          | `Must be a positive integer`                                                                        |
| `--mcp-budget-mode=enforce` без бюджета                                               | `requires a positive mcpClientBudget`                                                               |
| `--hostname` записан как `localhost:4170`                                             | `looks like a "host:port" combination. Use --port`                                                  |
| `--hostname [::1]:8080`                                                               | `Invalid --hostname ... brackets indicate an IPv6 literal but the value is not a clean [addr] form` |
| `--max-connections` это `NaN` или отрицательный                                       | `Must be >= 0`                                                                                      |
| `--event-ring-size > 1_000_000`                                                       | Выбрасывается во время построения моста                                                             |
| `--allow-origin '*'` без токена                                                       | `Refusing to start with --allow-origin '*' but no bearer token configured`                          |
| `--prompt-deadline-ms` / `--writer-idle-timeout-ms` не положительное целое            | `Must be a positive integer`                                                                        |
| Неизвестный `policy.permissionStrategy` или не-положительный `policy.consensusQuorum` | `InvalidPolicyConfigError`                                                                          |

## 7. Контрольный список проверки curl

```bash
# 1. Живость
curl http://127.0.0.1:4170/health
# -> {"status":"ok"}

# 1.1 Глубокая живость
curl -s 'http://127.0.0.1:4170/health?deep=1' | jq

# 2. Возможности
curl -s http://127.0.0.1:4170/capabilities | jq

# 3. Готовность префлайта
curl -s http://127.0.0.1:4170/workspace/preflight | jq

# 4. Снимок Env (секреты сообщают только наличие)
curl -s http://127.0.0.1:4170/workspace/env | jq

# 5. Снимок пула / бюджета MCP
curl -s http://127.0.0.1:4170/workspace/mcp | jq

# 6. Создать сессию
curl -s -X POST http://127.0.0.1:4170/session \
  -H 'Content-Type: application/json' \
  -H 'X-Nessy-Client-Id: curl-debug' \
  -d '{}' | jq

# 7. Tail SSE (заменить <sid>)
curl -N \
  -H 'Accept: text/event-stream' \
  -H 'X-Nessy-Client-Id: curl-debug' \
  -H 'Last-Event-ID: 0' \
  'http://127.0.0.1:4170/session/<sid>/events'

# 8. Страница Demo
open http://127.0.0.1:4170/demo
```

Когда bearer auth включён, добавьте `-H "Authorization: Bearer $NESSY_SERVER_TOKEN"` к каждому запросу.

## 8. Можно ли использовать страницу demo?

**Да.** Она реализована `getDemoHtml(port)` в `packages/cli/src/serve/demo.ts` как самодостаточный HTML без внешних зависимостей.

| Режим запуска                 | Где зарегистрирован `/demo`                                       | Прямая навигация браузера                                          |
| ----------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Loopback без `--require-auth` | Ветка pre-auth маршрута loopback `server.ts`, **до** `bearerAuth` | Работает без токена                                                |
| Loopback с `--require-auth`   | Ветка post-auth маршрута `server.ts`, **после** `bearerAuth`      | Сложно использовать из простого браузера; используйте curl или SDK |
| Не-loopback привязка          | Ветка post-auth маршрута `server.ts`, **после** `bearerAuth`      | То же, что выше                                                    |

CSP: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`, плюс `X-Frame-Options: DENY`. Страница может fetch только `'self'` (демон) и не может загружать внешние скрипты или стили.

## 9. Цепочка вызовов от `nessy serve` к слушающему серверу

```text
nessy serve
   |
   v (процесс)
packages/cli/index.ts              main()
   |
   v
gemini.tsx                         main() - parseArguments()
   |
   v (сборка yargs)
config/config.ts                   import { serveCommand } ...
config/config.ts                   .command(serveCommand)
config/config.ts                   await yargsInstance.parse()
   |
   v (handler)
commands/serve.ts                  handler(argv) - пре-проверки запуска
commands/serve.ts                  const { runNessyServe } = await import('../serve/index.js')   # ленивая загрузка
commands/serve.ts                  await runNessyServe({...})
   |
   v
serve/run-nessy-serve.ts           runNessyServe(opts, deps)
   |- валидация токена
   |- валидация бюджета MCP + childEnvOverrides
   |- loadSettings + validatePolicyConfig
   |- PermissionAuditRing + publisher
   |- resolveBridgeFsFactory
   `- createHttpAcpBridge({...})
   |
   v
serve/run-nessy-serve.ts           const app = createServeApp(opts, () => actualPort, {...})
   |
   v
serve/server.ts                    createServeApp() - строит Express app (**не слушает**)
   |- цепочка middleware (Host allowlist / CORS / bearerAuth / mutation gate / rate limit)
   |- монтирование маршрутов (health / demo / capabilities / workspace / session / SSE / ACP HTTP)
   `- return app
   |
   v
serve/run-nessy-serve.ts           server = app.listen(port, hostname, cb)
   |- server.maxConnections = cap
   |- actualPort = server.address().port
   |- write "nessy serve listening on ..."
   |- register SIGINT / SIGTERM (onSignal)
   `- resolve(handle: RunHandle)
   |
   v
commands/serve.ts                  await blockForever()    # блокироваться навсегда до сигнала
```

Ключевые факты:

- **`createServeApp` только строит; не слушает.** Он возвращает экземпляр `express()` с middleware и маршрутами. Вызывающий владеет `app.listen()`. `server.test.ts` использует фабрику таким образом в примерно 25 случаях, поэтому фабрика намеренно не владеет жизненным циклом.
- **`() => actualPort` — ленивая closure.** `actualPort` присваивается в callback `app.listen`. Middleware `hostAllowlist` читает его по требованию, поэтому эфемерные порты (`--port 0`) всё ещё правильно гейтируют заголовок `Host`.
- **`await blockForever()` намеренно.** Если `yargs.parse()` разрешается, CLI top level проваливается в интерактивную точку входа TUI (`gemini.tsx`). SIGINT / SIGTERM выходят через путь `onSignal` `runNessyServe`.

## 10. Разделение файлов HTTP маршрутов

Основная сборка происходит в `createServeApp()` в `server.ts`, который монтирует четыре модульных файла маршрутов:

| Маршруты                                                                                                                           | Файл                                                    | Точка монтирования                                  |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| `/health`, `/demo`, `/capabilities`, все маршруты сессий, device flow, голосование разрешений, SSE и перезапуск MCP одного сервера | `packages/cli/src/serve/server.ts`                      | Зарегистрировано напрямую внутри `createServeApp()` |
| `/workspace/memory` (GET/POST)                                                                                                     | `packages/cli/src/serve/workspace-memory.ts`            | `mountWorkspaceMemoryRoutes()`                      |
| Все маршруты CRUD `/workspace/agents`                                                                                              | `packages/cli/src/serve/workspace-agents.ts`            | `mountWorkspaceAgentsRoutes()`                      |
| `GET /file`, `/file/bytes`, `/list`, `/glob`, `/stat`                                                                              | `packages/cli/src/serve/routes/workspace-file-read.ts`  | `registerWorkspaceFileReadRoutes()`                 |
| `POST /file/write`, `/file/edit`                                                                                                   | `packages/cli/src/serve/routes/workspace-file-write.ts` | `registerWorkspaceFileWriteRoutes()`                |

Для полного маршрута и ссылки на протокол провода см. [`../../nessy-serve-protocol.md`](../../nessy-serve-protocol.md). Для архитектуры см. [`01-architecture.md`](./01-architecture.md).

## 11. Плавное против жёсткого завершения

- **Первый SIGINT / SIGTERM** -> `runNessyServe` `onSignal` -> двухфазное плавное завершение:
  1. `bridge.shutdown()`: каждый канал получает `KILL_HARD_DEADLINE_MS` (10с), затем `channel.kill()`.
  2. `server.close()`: in-flight запросы drain, `SHUTDOWN_FORCE_CLOSE_MS` (5с) запускает `closeAllConnections()`, затем применяется второй deadline 2с.
- **Второй SIGINT / SIGTERM во время уже выхода** -> `bridge.killAllSync()` синхронно SIGKILL все ACP дочерние процессы и вызывает `process.exit(1)` чтобы избежать процессов-сирот.

`RunHandle.close()` возвращаемый `runNessyServe` — программный эквивалент для встраивающих и тестов.

## 12. Встроенный вызов (обход CLI)

```ts
import { runNessyServe } from '@nestor/nessy-cli/serve';

const handle = await runNessyServe({
  port: 0, // эфемерный
  hostname: '127.0.0.1',
  mode: 'http-bridge',
  maxSessions: 20,
  workspace: '/abs/path/to/repo',
});
console.log(`Daemon at ${handle.url}`);
// ... вызвать handle.bridge напрямую или получить доступ к handle.server
await handle.close(); // программное завершение
```

Или получить Express app напрямую и слушать самостоятельно:

```ts
import { createServeApp } from '@nestor/nessy-cli/serve';

const app = createServeApp(
  {
    port: 0,
    hostname: '127.0.0.1',
    mode: 'http-bridge',
    maxSessions: 20,
  },
  () => 0,
  {
    /* deps: bridge, fsFactory, ... */
  },
);

const server = app.listen(0, '127.0.0.1', () => {
  console.log('listening on', server.address());
});
```

Примечание: при вызове `createServeApp` напрямую, `fsFactory.trusted = false` по умолчанию. Агент-side ACP `writeTextFile` отклоняется как `untrusted_workspace`, и предупреждение stderr печатается один раз. Либо внедрите `deps.fsFactory` с явным доверием, внедрите `deps.bridge`, либо примите поведение по умолчанию с trust-gate.

## 13. Рецепты отладки

См. раздел отладки в [`19-observability.md`](./19-observability.md). Общие команды:

```bash
# Демон жив?
curl http://127.0.0.1:4170/health

# Какие возможности рекламируются?
curl -s http://127.0.0.1:4170/capabilities | jq

# Готовность хоста демона
curl -s http://127.0.0.1:4170/workspace/preflight | jq

# Tail live SSE
curl -N -H 'Accept: text/event-stream' \
     -H 'Last-Event-ID: 0' \
     'http://127.0.0.1:4170/session/<sid>/events'

# Подробные логи
NESSY_SERVE_DEBUG=1 nessy serve
```

## Ссылки

- Вход CLI: `packages/cli/src/commands/serve.ts`
- Загрузка: `packages/cli/src/serve/run-nessy-serve.ts`
- Фабрика Express: `packages/cli/src/serve/server.ts`
- Middleware: `packages/cli/src/serve/auth.ts`
- Фабрика моста: `packages/acp-bridge/src/bridge.ts`
- HTML страницы Demo: `packages/cli/src/serve/demo.ts`
- Документация пользователя: [`../../../users/work/features/nessy-serve.md`](../../../users/work/features/nessy-serve.md)
- Протокол провода: [`../../nessy-serve-protocol.md`](../../nessy-serve-protocol.md)
