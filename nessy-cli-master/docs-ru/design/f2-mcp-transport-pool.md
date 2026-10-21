---
title: 'F2: Общий пул транспортов MCP — Дизайн v2.2'
---

# F2: Общий пул транспортов MCP — Дизайн v2.2

> Целевая ветка `daemon_mode_b_main` (согласно стратегии ветвления #4175). Заменяет PR 23 из Wave 5 (#4175).
> **Единый PR** согласно рекомендациям мейнтейнеров о функционально-связанных батчах (2026-05-19).
> Автор: doudouOUC. Дата: 2026-05-20. Ревизия: 2026-05-20 (v2.2 — исправления по итогам ревью реализации).

---

## 0. Журнал изменений

### v2.2 (2026-05-20) — реализация PR #4336 + 32 исправления по ревью

PR #4336 доставил F2 как 6 атомарных коммитов + 6 исправляющих коммитов за ~4 часа. Вэньшао проводил ревью кумулятивно в 3 батча; каждый батч порождал inline-замечания и критические исправления, которые включались обратно. Таблица ниже фиксирует изменения относительно v2.1, сгруппированные по батчам ревью.

#### v2.1 → первый батч ревью (коммиты 1-4, wenshao C1-C7 + S1-S4)

| #   | Место                                                      | Что было неправильно                                                                                                                                              | Коммит исправления |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| C1  | `acpAgent.ts:269` — путь закрытия IDE                      | Слив пула выполнялся только в обработчике SIGTERM; нормальное закрытие по инициативе IDE утекало записи, пока ОС не завершит процессы. Зеркально добавлен слив пула при `await connection.closed` | `ae0b296c4`        |
| C2  | `mcp-pool-entry.ts:cancelDrainTimer`                       | `cancelDrainTimer` сбрасывал `maxIdleTimer` при каждом колебании, нарушая жёсткий лимит из §6.3. Теперь только очищает `drainTimer`; max-idle живёт всё время жизни записи | `ae0b296c4`        |
| C3  | `mcp-pool-entry.ts:doRestart`                              | Ошибка переподключения оставляла запись в зомби-состоянии (`localStatus=CONNECTED`, `state='active'`, устаревший снимок). Добавлен try/catch + переход в `'failed'` при ошибке | `ae0b296c4`        |
| C4  | `mcp-pool-entry.ts:forceShutdown`                          | `state='closed'` устанавливался ПОСЛЕ await'ов, поэтому конкурентный `acquire` мог увидеть `'active'` и выдать устаревшее соединение. Устанавливается синхронно в начале | `ae0b296c4`        |
| C5  | `mcp-transport-pool.ts:drainAll`                           | Конкурентный `acquire` мог создать свежую запись в процессе слива. Добавлен мьютекс-флаг `draining` + `await Promise.allSettled(spawnInFlight)` перед очисткой | `ae0b296c4`        |
| C6  | `mcp-pool-entry.ts:statusChangeListener`                   | Слушатель не фильтровался по `serverName`; каждая запись получала уведомления о статусе от всех серверов + эхо собственных записей `markActive` | `ae0b296c4`        |
| C7  | `mcp-client-manager.ts:discoverAllMcpToolsIncremental`     | Условие пула добавлено в `discoverAllMcpTools`, но пропущено в `Incremental` — `/mcp refresh` обходил пул, создавая сессионный клиент | `ae0b296c4`        |
| S1  | `session-mcp-view.ts:passesSessionFilter`                  | В документации не указано, что `excludeTools` использует прямое равенство (без поддержки формы со скобками); расхождение с `mcp-client.ts:isEnabled` | `ae0b296c4`        |
| S2  | `pid-descendants.ts` docstring                             | Утверждалось о Windows-специфичной ветке `taskkill /F`, которой не существовало — Node полифильтрует `process.kill('SIGTERM')` в `TerminateProcess` | `ae0b296c4`        |
| S3  | `session-mcp-view.ts:applyTools` debug log                 | Строка содержала литерал `"N"` вместо интерполяции — операторы видели `applied 12 tools (filtered to N registered)` | `ae0b296c4`        |
| S4  | `mcp-transport-pool.ts:createUnpooledConnection` status cb | Захардкожено как `() => CONNECTED`, поэтому `aggregateStatusByName` врал после отключения. Теперь `() => client.getStatus()` | `ae0b296c4`        |

#### Батч саморевью коммита 5 (R1-R3 малые)

| #   | Место                                               | Что было неправильно                                                                                                                                           | Коммит исправления |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| R1  | `server.test.ts:918` обёртка `/capabilities`        | Тест утверждал `getAdvertisedServeFeatures()` (без переключателей), но server.ts передаёт `mcpPoolActive: opts.mcpPoolActive !== false` (по умолчанию включено). Якорь переключателя | `3e68c00bc`        |
| R2  | `server.test.ts` покрытие переключателей по умолчанию | Нет теста, запускающегося с опциями по умолчанию для проверки рекламы тегов пула. Добавлен явный тест с `mcpPoolActive: false` | `3e68c00bc`        |
| R3  | `events.ts:DaemonMcpServerRestartRefusedData`       | В документации сказано, что пре-PR SDK увидят новое значение как unknown и отобразят обобщённо — на самом деле `MCP_RESTART_REFUSED_REASONS.has(...)` отклоняет → тихий дроп | `3e68c00bc`        |

#### Второй батч ревью (коммиты 1-5, wenshao R1-R10)

| #   | Место                                                   | Что было неправильно                                                                                                                                                                          | Коммит исправления |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| WR1 | `mcp-pool-entry.ts:maxIdleTimer`                        | Исправление C2 корректно сохранило `maxIdleTimer` при колебании, но действие срабатывания принудительно закрывало независимо от `refs.size`. Активная сессия с re-attach внутри грейса теряла инструменты через 5 мин | `72399f109`        |
| WR2 | `mcp-client-manager.ts:discoverAllMcpToolsViaPool`      | `releaseAllPooledConnections` + повторный acquire ВСЕХ на каждый проход оставлял краткое окно с нулём зарегистрированных MCP-инструментов И сбрасывал каждый таймер слива. Diff против желаемого `(name, fingerprint)` | `72399f109`        |
| WR3 | `mcp-pool-entry.ts:doRestart` snapshot fan-out          | Перезапуск обновлял `toolsSnapshot`/`promptsSnapshot` и испускал типизированные события — но ни один экземпляр `SessionMcpView` не был подписан на этот поток. Итерировать `subscribers` напрямую после снимка | `72399f109`        |
| WR4 | `mcp-transport-pool.ts:getSnapshot subprocessCount`     | Считал websocket в `subprocessCount` — websocket диалит удалённо, без локального дочернего процесса. Ограничено только `'stdio'` | `72399f109`        |
| WR5 | `mcp-pool-entry.ts:doRestart` PowerShell `-Filter`      | Интерполировал `${pid}` напрямую в строку `-Filter`. Guard `Number.isInteger` на entry-point предотвращает инъекцию сегодня; привязать к `$p` для защиты в глубину против будущих ослаблений guard | `72399f109`        |
| WR6 | `mcp-pool-entry.ts` ctor `cfg` field                    | `readonly cfg: MCPServerConfig` было неявно публичным, раскрывая env API keys / header auth / OAuth поля. Сделано `private`; новый геттер `transportKind` для единственного внешнего читателя | `72399f109`        |
| WR7 | `mcp-pool-events.ts` преждевременные экспорты           | 5 guard'ов типа PoolEvent + ре-экспорт `Prompt` + `PoolEntryConnectionStatus` не имели вызывающих. Удалено; оставлен `MCPCallInterruptedError` (требование дизайна §13.4) | `72399f109`        |
| WR8 | `acpAgent.ts:269,300` дублирование слива пула           | SIGTERM + закрытие IDE имели идентичные блоки `if (agentInstance) { try { await shutdownMcpPool(8_000) } catch... }`. Выделен хелпер `drainPoolBeforeExit(label)` | `72399f109`        |

#### Батч саморевью коммита 6 (R1-R3 критичная гонка)

| #   | Место                                   | Что было неправильно                                                                                                                                                               | Коммит исправления |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 6R1 | `mcp-transport-pool.ts:onClosed`        | Гонка освобождения слота: A завершает spawn, B (другой fingerprint, то же имя) начинает spawn, A сливает. Close-cb проверял только `entries` (B ещё не зарегистрирован) → преждевременное освобождение | `0e58a098f`        |
| 6R2 | `events.ts:mcpBudgetWarningCount` JSDoc | События уровня workspace веером расходятся на N сессий → N инкрементов редюсера; потребители, агрегирующие по сессиям, двойной счёт. В JSDoc добавлено пояснение о множителе | `0e58a098f`        |
| 6R3 | `acpAgent.ts:broadcastBudgetEvent`      | Итерировал `this.sessions.keys()` напрямую во время async веера; конкурентный `killSession` мог повредить итератор. Снимок через `Array.from(...)` | `0e58a098f`        |

#### Третий батч ревью (коммиты 1-6, wenshao W1-W15)

| #   | Место                                                          | Что было неправильно                                                                                                                                                                                | Коммит исправления |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| W1  | `mcp-transport-pool.ts:spawnEntry` catch                       | Ошибка spawn утекала `statusChangeListener` перманентно — только `forceShutdown` удаляет его. Добавлен `entry.forceShutdown('manual')` в catch | `4a3c5cd90`        |
| W2  | `mcp-pool-entry.ts:statusChangeListener` cross-check           | Модульная карта `serverStatuses` общая для записей с разными fingerprint'ами. Ошибка транспорта A писала DISCONNECTED, слушатель B портил `localStatus` B. Добавлена проверка `client.getStatus()` | `4a3c5cd90`        |
| W3  | `mcp-pool-entry.ts:doRestart` обход pid                        | Перезапуск пропускал `listDescendantPids` + `sigtermPids` — каждый перезапуск обёрток stdio на `npx`/`uvx` осиротлял фактического грандchild MCP. Добавлен обход перед disconnect | `4a3c5cd90`        |
| W4  | `mcp-pool-entry.ts:doRestart` гонка таймера слива              | Таймер слива мог сработать во время yield перезапуска → `forceShutdown` удаляет запись → `client.connect` создаёт сироту. Добавлен `cancelDrainTimer` + `state→active` в начале `doRestart` | `4a3c5cd90`        |
| W5  | `mcp-client-manager.ts:pooledConnections` мёртвые хендлы       | Когда запись переходила в `'failed'`, менеджер держал мёртвый `PooledConnection` вечно. Подписка на события записи; eviction при `'failed'` (идемпотентно через guard `get(name) === conn`) | `4a3c5cd90`        |
| W6  | `mcp-client-manager.ts:discoverAllMcpToolsViaPool` реентрантность | Два прохода могли пересекаться, оба `set(name, conn)` → первая conn утекала. Добавлен мьютекс `discoveryInFlight`; второй вызывающий ожидает тот же promise. Новый регрессионный тест | `4a3c5cd90`        |
| W9  | `acpAgent.ts:parsePoolDrainMs` строгость                       | `Number.parseInt` принимал `'30000ms'` / `'30000abc'`. Строгий regex `^\d+$`; отклонение с stderr warning + fallback на значение по умолчанию | `4a3c5cd90`        |
| W10 | `mcp-transport-pool.ts:acquire` порядок indexAttach             | `indexAttach` мутировал `sessionToEntries` ДО `entry.attach()`. Если `attach` бросал, stale reverse-index mapping. Перемещён `indexAttach` после успешного `attach` (оба пути: fast + in-flight) | `4a3c5cd90`        |
| W13 | `mcp-transport-pool.ts:subprocessCount` JSDoc                  | Документация всё ещё утверждала `stdio + websocket` после WR4, ограничившего до stdio. Обновлено | `4a3c5cd90`        |
| W14 | `mcp-transport-pool.ts:createUnpooledConnection` catch         | Та же утечка `statusChangeListener`, что и W1, в пути без пула. То же зеркало: `forceShutdown` перед disconnect | `4a3c5cd90`        |
| W15 | `bridge.ts:restartMcpServer` response                          | Приведение `as PoolEntries` было некорректным — нетипизированный JSON от дочернего ACP. Проверка `Array.isArray` + guard формы для каждой записи; malformed записи пропускаются с stderr breadcrumb | `4a3c5cd90`        |

#### Отклонено с ответом (оформлено как follow-up'ы F2)

| #   | Место                                                   | Причина отклонения                                                                                                                                                                        |
| --- | ------------------------------------------------------- |-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| W7  | Пробелы покрытия тестами (4 некритичных пути)           | 1/4 добавлен (регрессионный тест W6); остальные отложены на сфокусированный PR покрытия тестами после слияния серии F2                                                                    | 
| W8  | `maxReconnectAttempts` / `reconnectStrategy` не используются | Заполнители forward-compat для отложенного reconnect на основе health-monitor (дизайн §6.6); удаление + повторное добавление создаёт churn публичного типа                                | 
| W11 | Дублирование блоков attach: fast-path / in-flight-path  | ✅ Выполнено в PR A: приватные хелперы `attachPooledSession` + `rollbackReservationOnSpawnFailure` (коммит `2d546efca`)                                                                    | 
| W12 | `passesSessionFilter` O(M×N) на `applyTools`            | ✅ Выполнено в PR A: `applyTools` / `applyPrompts` предварительно вычисляют `Set` фильтров один раз на проход; предикат становится O(1) на инструмент (коммит `a4a855ab3`)                 | 
| R9  | `McpClientManager` ctor с 7 позиционными сентинелями    | ✅ Выполнено в PR A: ctor с объектом опций + тестовая фабрика `mkManager` (коммит `0cb1eaa27`)                                                                                             | 
| R10 | `pgrep -P <pid>` цена на PID-уровень                    | ✅ Выполнено в PR A: единый снимок `ps -A -o pid=,ppid=` + BFS в памяти; BFS на pgrep сохранён как fallback для BusyBox \<v1.28 / distroless (коммит заземляется как финальная часть PR A) | 

#### Счётчик ошибок

- **3 батча × 27 критических / важных исправлений** + 5 документационных / предложений = **32 исправления по ревью** всего
- **2 критичные гонки, пойманные только со второго взгляда** (6R1 гонка освобождения слота во время spawn; W6 реентрантность обнаружения)
- **0 тихих отказов в продакшене** — каждое исправление имеет inline-breadcrumb `// F2 (#4175 commit X review fix — wenshao YN):`, указывающий на оригинальное ревью

### v2.1 (2026-05-20) — стратегия единого PR + 12 исправлений по ревью

| #      | Что                                                                                                           | Почему                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| V21-1  | Переход с плана 6 под-PR на **единый функционально-связанный PR** с 6 атомарными коммитами                    | Согласно рекомендациям мейнтейнера (#4175 branching strategy); ревьюер может читать коммит за коммитом через `git log -p` |
| V21-2  | Добавлен `sessionToEntries: Map<sid, Set<ConnectionId>>` reverse index в пуле (§6)                            | `releaseSession` O(N записей) → O(ссылок сессии); необходимо для масштаба 1000 сессий |
| V21-3  | Query-параметр `?fingerprint=` на route перезапуска (§13.1)                                                   | Оператор может захотеть перезапустить только одну запись, когда одно имя имеет несколько fingerprint'ов; почти нулевая стоимость добавить сейчас |
| V21-4  | Путь ошибки spawn явно освобождает зарезервированный слот (§6.1, §6.5)                                        | Иначе слот утекает до следующего прохода health-monitor; тонкая реальная ошибка |
| V21-5  | Новый §13.4: семантика вызова инструмента в полёте во время reconnect                                         | `MCPCallInterruptedError`; пул НЕ авто-повторяет (запись небезопасна) |
| V21-6  | Новый §10.4: `/mcp disable X` запускает повторное применение `SessionMcpView`                                 | Иначе mid-session disable не удаляет уже зарегистрированные инструменты |
| V21-7  | Status route выставляет `entryIndex`, а не raw fingerprint (§8.3)                                             | Избежание side-channel утечки ротации OAuth-токена через изменение fingerprint |
| V21-8  | Reconnect backoff специфицирован: stdio фиксированный 5s × 3, HTTP/SSE экспоненциальный 1/2/4/8/16s × 5 (§6.6) | v2 не указывал; HTTP нуждается в большем бюджете retry для сетевых колебаний |
| V21-9  | `canonicalOAuth(o)` нормализует `{enabled: false}` ≡ `undefined` ≡ `null` (§5.1)                              | Иначе функционально эквивалентные конфигурации порождают различные записи |
| V21-10 | Переименован хелпер fallback пула из "legacy in-process acquire" в `createUnpooledConnection` (§5.3, §6.1)    | SDK MCP bypass перманентен, не legacy |
| V21-11 | `drainAll(opts?)` возвращает `Promise<void>` с wall-clock бюджетом `timeoutMs` (§17)                          | Вызывающему нужно знать, когда слив завершается для порядка shutdown |
| V21-12 | Зафиксированы имена полей reducer SDK (Q1 resolved): сохраняем `mcpBudgetWarningCount` и т.д. с семантикой scope в JSDoc | Никаких переименований публичного API mid-PR |
| V21-13 | Зафиксированы Q3 (пул по умолчанию включён, kill switch `--no-mcp-pool`), Q4 (HTTP/SSE opt-in), Q6 (жадная конструкция) | Доставка единым PR; никакого flag gating не нужно |
| V21-14 | Добавлены R9/R10/R11 риски единого PR (§23)                                                                   | Усталость ревьюера, конфликт слияния daemon_mode_b_main, время CI |
| V21-15 | Обработка сиротских записей при удалении расширения отложена до естественного reap через `MAX_IDLE_MS` (§16.3) | Нет явного `invalidateByExtension`; сохраняет единообразие модели |

### v2 (2026-05-20) — первоначальные исправления по ревью из наброска v1

| #   | Что                                                                                                 | Почему                                                                                       |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| C1  | Пул веером раздаёт **Tools + Prompts** (было: только инструменты)                                   | `McpClient` ctor принимает оба реестра; промпты иначе тихо терялись в режиме пула |
| C2  | Новый раздел о **сосуществовании глобального состояния** (`serverStatuses` / `mcpServerRequiresOAuth` module Maps) | Разделение между сессиями уже существует сегодня; пул наследует + формализует |
| C3  | Путь фабрики `connectToMcpServer` **унифицирован** с классом `McpClient` в F2-1                   | v1 рефакторил только класс; оставил бы параллельный путь без пула |
| C4  | Повтор снимка при attach (в стиле earlyEvents) добавлен в `PoolEntry.attach()`                    | Новая гонка: сессия-B attach → сервер испускает `tools/list_changed` до подключения подписки |
| C5  | `spawnInFlight: Map<ConnectionId, Promise<PoolEntry>>>` для dedupe конкурентного acquire          | v1 упомянуто в тестовой матрице, но пропущено в контракте реализации |
| C6  | Кроссплатформенный обход descendant-pid (Linux/macOS pgrep, Windows wmic/PowerShell)              | v1 говорил "скопируйте `pgrep -P` из opencode" — это только Unix |
| C7  | Поле `trust` на сессионной **копии** объекта инструмента                                          | trust живёт на `DiscoveredMCPTool`; общий экземпляр смешивал бы trust между сессиями |
| C8  | Транспорты HTTP/SSE **opt-in** в пул (по умолчанию: stdio + websocket only)                       | Некоторые MCP HTTP серверы хранят состояние сессии на транспорт; разделение рискует bleed состояния |
| C9  | Явный bypass SDK MCP сервера (`isSdkMcpServerConfig`)                                             | `sendSdkMcpMessage` per-session по дизайну |
| C10 | Путь OAuth явно **отложен до F3**                                                                 | Поток OAuth нуждается в маршрутизации в стиле PermissionMediator; не в scope F2 |
| C11 | Семантика route перезапуска специфицирована (имя → все совпадающие записи)                        | `POST /workspace/mcp/:server/restart` из PR 17 ранее был однозначен (1 запись); теперь 1..N |
| C12 | Рефактор status route (новый путь: `NessyAgent.getMcpPoolAccounting()`)                           | `httpAcpBridge.ts:733-770` сейчас читает менеджер bootstrap-сессии — нужно изменить |
| C13 | Счётчик генерации на `PoolEntry` для guard устаревшего обработчика `tools/list_changed`           | Паттерн opencode: `if (s.clients[name] !== client) return` |
| C14 | Разбиение под-PR 4 → **6**                                                                        | v1 недооценил; A2/B1/B3/C6 каждый добавляет реальную работу |
| C15 | Ленивая конструкция пула (только когда увидено N≥2 сессий) — опционально                          | `nessy serve --foreground` с одной сессией не выиграет; экономит стоимость инициализации |

---

## 1. Цели / Не-цели

**Цели**

- N сессий в 1 workspace, разделяющих 1 процесс на уникальную-конфигурацию-сервера — ключ по fingerprint
- Сохранение представлений `ToolRegistry` / `PromptRegistry` на сессию (фильтрация, trust)
- Refcount + жизненный цикл grace-drain, устойчивый к reattach
- Кроссплатформенная очистка descendant-pid
- Budget guardrails выпускаются из per-session в per-workspace (PR 14 обещал это)
- Обратная совместимость с non-daemon standalone nessy (пул не конструируется там)

**Не-цели (scope F2)**

- Меж-workspace пулинг (инвариант 1 daemon = 1 workspace из PR #4113 остаётся)
- Меж-daemon пулинг (вне scope — территория multi-process orchestrator)
- Переработка маршрутизации OAuth (F3 с `PermissionMediator`)
- Персистентность пула across daemon restart (только in-memory)
- Авто-детекция "pool-safe" HTTP серверов (только opt-in flag)
- Live diff `MCPServerConfig` для in-place мутации записей (изменение конфига → новая запись, старая сливает)

---

## 2. Текущее состояние (цель замены)

```
acpAgent.newSession(sessionId)
  → newSessionConfig(cwd, mcpServers)                  // acpAgent.ts:1771
  → loadCliConfig → new Config → config.initialize()
  → ToolRegistry ctor → new McpClientManager(config, ...)   // tool-registry.ts:199
  → for (name, cfg) in config.getMcpServers():
      new McpClient(name, cfg, toolRegistry, promptRegistry, workspaceContext, ...)
      → client.connect() → client.discover(config)
```

**Карта связностей (что должно быть разорвано или продето):**

| Связность                                                                        | Расположение                                      | Действие в F2                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `McpClient` ctor привязывает 1 ToolRegistry + 1 PromptRegistry                   | mcp-client.ts:106-119                             | Пул владеет транспортом; `SessionMcpView` (per session) владеет per-session реестрами |
| Обработчик `ListRootsRequestSchema` замыкает `workspaceContext.getDirectories()` | mcp-client.ts:142-153 + connectToMcpServer.ts:893 | Единый workspace-bound контекст пула                                                |
| Слушатель `workspaceContext.onDirectoriesChanged` регистрируется на connect      | mcp-client.ts:907                                 | Пул регистрирует один раз на запись                                                 |
| `McpClientManager` `new`'d внутри ToolRegistry                                   | tool-registry.ts:199                              | Добавить опциональный параметр ctor `pool?`; инъекция из Config                     |
| Budget enforcement per-session                                                   | mcp-client-manager.ts:91-95 comment               | Переместить state machine в пул                                                     |
| `serverDiscoveryPromises` dedupe in-flight на сервер                             | mcp-client-manager.ts:350                         | Пул имеет `spawnInFlight: Map<ConnectionId, Promise<PoolEntry>>`                    |
| `setMcpBudgetEventCallback` регистрация per-session                              | acpAgent.ts:1851-1899                             | Пул испускает → `NessyAgent` транслирует всем сессиям                              |

**Уже-разделяемое состояние (пул наследует, не вводит):**

| Состояние                                          | Расположение                     | Примечание                                                              |
| -------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| `serverStatuses: Map<string, MCPServerStatus>`     | mcp-client.ts:292 (module-level) | Process-wide сегодня; ключ пула всё ещё по имени → "any-CONNECTED-wins" |
| `mcpServerRequiresOAuth: Map<string, boolean>`     | mcp-client.ts:302 (module-level) | То же                                                                   |
| `MCPOAuthTokenStorage` on-disk токены              | `~/.nessy/mcp-oauth/<name>.json`  | Daemon-host shared; пул просто эффективнее эксплуатирует                |

---

## 3. Результаты исследования

| Проект          | Пул?               | Ключ                                          | Жизненный цикл                                                                        | Паттерны для заимствования                                                                                                   |
| --------------- | ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **claude-code** | Нет, per-process   | `name + JSON.stringify(cfg)` (lodash.memoize) | `clearServerCache` + remote backoff×5; stdio crash → `failed`                         | Сортировка ключей SHA-256 `hashMcpConfig` для инвалидации/кеинга                                                             |
| **opencode**    | Да, per workspace  | только **имя** сервера (без хэша конфига)     | Без refcount / без eviction / без restart; Effect finalizer + `pgrep -P` рекурсивный SIGTERM | Обход descendant-pid, guard устаревшего обработчика (`if (s.clients[name] !== client) return`), fan-out `tools/list_changed` через event bus |

**Что F2 наследует от каждого:** хэш конфига от claude-code (обрабатывает per-session env/auth расхождения, которые opencode не учитывает), обход descendant-pid от opencode (обёртки npx/uvx утекают). Что добавляем: refcount + drain (multi-client daemon), авто-restart (long-running daemon), fan-out промптов, guard генерации.

---

## 4. Архитектура

### 4.1 Расположение процессов

```
HTTP daemon (packages/cli/src/serve, nessy serve)
  │ порождает
  ▼
ACP child (nessy --acp, один процесс на workspace)
  │
  NessyAgent (acpAgent.ts)
  ├── McpTransportPool ◄── новый, workspace-scoped, 1 экземпляр
  │     ├── entries: Map<ConnectionId, PoolEntry>
  │     ├── spawnInFlight: Map<ConnectionId, Promise<PoolEntry>>
  │     ├── workspaceContext (привязан к daemon workspace)
  │     └── budget guardrails (PR 14 state machine, повышен до workspace)
  │
  └── sessions: Map<sessionId, Session>
        └── Session.Config → ToolRegistry → McpClientManager(pool?)
                                                     │
                                            ┌────────┴────────┐
                                            │ pool injected   │
                                            ▼                 ▼
                                pool.acquire(name,cfg,sid)   legacy in-process
                                  → SessionMcpView            (standalone nessy)
                                    .applyTools/Prompts
                                    (фильтрация + регистрация в
                                     собственных реестрах сессии)
```

**Пул живёт в ACP child**, не в HTTP daemon. HTTP daemon запрашивает состояние пула через существующую поверхность extMethod `bridge.client` (`getMcpPoolAccounting`, `restartMcpServer`). Код F2 находится в **`packages/core/src/tools/`** (рядом с `mcp-client-manager.ts`), не в `packages/acp-bridge/`.

### 4.2 Диаграмма классов

```
McpTransportPool
  ├─ acquire(name, cfg, sid) → PooledConnection
  ├─ release(connectionId, sid) → void
  ├─ releaseSession(sid) → void   (массовое освобождение для teardown сессии)
  ├─ restartByName(name) → RestartResult[]
  ├─ getAccounting() → McpClientAccounting   (workspace-scope)
  ├─ getBudgetMode/Budget()
  ├─ drainAll() → Promise<void>   (shutdown)
  └─ onBudgetEvent: (event) => void   (устанавливается NessyAgent)

PoolEntry (внутренний)
  ├─ refs: Set<sessionId>
  ├─ client: McpClient
  ├─ toolsSnapshot: DiscoveredMCPTool[]
  ├─ promptsSnapshot: Prompt[]
  ├─ generation: number   (++ на reconnect; guard устаревшего события)
  ├─ state: 'spawning' | 'active' | 'draining' | 'closed' | 'failed'
  ├─ drainTimer?: NodeJS.Timeout
  ├─ healthMonitor: { intervalTimer, consecutiveFailures, isReconnecting }
  ├─ subscribers: Map<sid, SessionMcpView>
  ├─ attach(sid, view) → PooledConnection
  └─ detach(sid) → void

PooledConnection (хендл, возвращаемый вызывающему)
  ├─ id: ConnectionId
  ├─ on('toolsChanged' | 'promptsChanged' | 'disconnected' | 'reconnected' | 'failed', cb)
  ├─ callTool(name, args, { sessionId }) → CallToolResult
  ├─ readResource(uri, { sessionId, signal })
  └─ release()

SessionMcpView (per session, per server)
  ├─ ctor(toolRegistry, promptRegistry, sessionId, serverName, cfg)
  ├─ applyTools(snapshot) → void   (фильтрация по include/exclude, декорация trust)
  ├─ applyPrompts(snapshot) → void
  └─ teardown() → void   (удаляет свои регистрации)
```

---

## 5. Ключ пула (Fingerprint)

### 5.1 Хэшированные канонические поля

```ts
type PoolKey = string; // sha256 hex, первых 16 символов достаточно (collision-free для реалистичного N)
type ConnectionId = `${serverName}::${PoolKey}`;

function fingerprint(cfg: MCPServerConfig): PoolKey {
  const canonical = {
    transport: mcpTransportOf(cfg),
    command: cfg.command ?? null,
    args: cfg.args ?? [],
    cwd: cfg.cwd ?? null,
    env: sortedEntries(cfg.env ?? {}), // [[k,v],...] отсортировано по k
    url: cfg.url ?? null,
    httpUrl: cfg.httpUrl ?? null,
    headers: sortedEntries(cfg.headers ?? {}),
    timeout: cfg.timeout ?? null,
    oauth: canonicalOAuth(cfg.oauth),
  };
  return sha256(JSON.stringify(canonical)).slice(0, 16);
}

/**
 * V21-9: нормализация функционально-эквивалентных OAuth конфигов,
 * чтобы они схлопывались в один fingerprint. `{enabled: false}`,
 * `undefined`, `null` и `{}` все означают "no OAuth" → все возвращают `null`.
 */
function canonicalOAuth(o?: OAuthConfig | null): OAuthConfig | null {
  if (!o || !o.enabled) return null;
  return {
    enabled: true,
    clientId: o.clientId ?? null,
    scopes: o.scopes ? [...o.scopes].sort() : null,
    authorizationUrl: o.authorizationUrl ?? null,
    tokenUrl: o.tokenUrl ?? null,
  };
}

// Исключённые поля (per-session фильтры, НЕ transport-level):
//   includeTools, excludeTools, trust, description, extensionName
```

### 5.2 Gating по классу транспорта

```ts
const POOLED_TRANSPORTS_DEFAULT = new Set(['stdio', 'websocket']);

function isPoolable(cfg: MCPServerConfig, opts: PoolOptions): boolean {
  if (isSdkMcpServerConfig(cfg)) return false;
  const transport = mcpTransportOf(cfg);
  return opts.pooledTransports.has(transport);
}
```

**По умолчанию `pooledTransports = {stdio, websocket}`**. Операторы включают HTTP/SSE через:

- CLI: `--mcp-pool-transports=stdio,websocket,http,sse`
- Env: `NESSY_SERVE_MCP_POOL_TRANSPORTS=stdio,websocket,http`

**Почему по умолчанию исключены HTTP/SSE**: некоторые реализации MCP HTTP серверов привязывают состояние (auth контекст, память разговора) к TCP/SSE потоку; несколько ACP сессий, разделяющих его, будут bleed состояние. stdio + websocket — настоящие OS процессы, чьё состояние наблюдаемо и изолируемо.

### 5.3 SDK MCP bypass

`isSdkMcpServerConfig(cfg)` true → пул возвращает тонкую обёртку `PooledConnection` через `createUnpooledConnection(name, cfg, sid)`, которая немедленно конструирует `McpClient`, без разделения, без записи в пул. Причина: `sendSdkMcpMessage` per-session по дизайну (маршрутизируется через ACP control plane обратно в исходную сессию). Тот же путь используется для HTTP/SSE, когда транспорт не в `pooledTransports` (§10.3).

V21-10: имя `createUnpooledConnection`, не `legacyInProcessAcquire` — SDK MCP и HTTP opt-out перманентные выборы дизайна, не legacy код.

---

## 6. Жизненный цикл

### 6.1 acquire / release

```ts
class McpTransportPool {
  private entries = new Map<ConnectionId, PoolEntry>();
  private spawnInFlight = new Map<ConnectionId, Promise<PoolEntry>>();

  /** V21-2: reverse index, O(refs) releaseSession вместо O(entries). */
  private sessionToEntries = new Map<string, Set<ConnectionId>>();

  async acquire(
    name: string,
    cfg: MCPServerConfig,
    sid: string,
  ): Promise<PooledConnection> {
    if (!isPoolable(cfg, this.opts)) {
      return this.createUnpooledConnection(name, cfg, sid);
    }
    const id: ConnectionId = `${name}::${fingerprint(cfg)}`;

    if (this.entries.has(id)) {
      this.indexAttach(sid, id);
      return this.entries.get(id)!.attach(sid);
    }
    let inFlight = this.spawnInFlight.get(id);
    if (!inFlight) {
      const slot = this.tryReserveSlot(name);
      if (slot === 'refused') {
        throw new BudgetExhaustedError(
          name,
          this.clientBudget!,
          this.reservedSlots.size,
        );
      }
      inFlight = this.spawnEntry(name, cfg, id)
        .catch((err) => {
          // V21-4: освобождение зарезервированного слота при ошибке spawn. Без
          // этого слот утекает до запуска health monitor (который не запускается,
          // потому что нет записи для мониторинга).
          if (slot === 'reserved') this.releaseSlotName(name);
          throw err;
        })
        .finally(() => this.spawnInFlight.delete(id));
      this.spawnInFlight.set(id, inFlight);
    }
    const entry = await inFlight;
    this.indexAttach(sid, id);
    return entry.attach(sid);
  }

  release(id: ConnectionId, sid: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.detach(sid);
    this.indexDetach(sid, id);
    if (entry.refs.size === 0) entry.startDrainTimer(this.opts.drainDelayMs);
  }

  /** V21-2: O(refs этой сессии), не O(all entries). */
  releaseSession(sid: string): void {
    const ids = this.sessionToEntries.get(sid);
    if (!ids) return;
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      entry.detach(sid);
      if (entry.refs.size === 0) entry.startDrainTimer(this.opts.drainDelayMs);
    }
    this.sessionToEntries.delete(sid);
  }

  private indexAttach(sid: string, id: ConnectionId): void {
    let ids = this.sessionToEntries.get(sid);
    if (!ids) {
      ids = new Set();
      this.sessionToEntries.set(sid, ids);
    }
    ids.add(id);
  }

  private indexDetach(sid: string, id: ConnectionId): void {
    const ids = this.sessionToEntries.get(sid);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) this.sessionToEntries.delete(sid);
  }
}
```

### 6.2 Concurrent-acquire dedupe (`spawnInFlight`)

Зеркалит `McpClientManager.serverDiscoveryPromises` (mcp-client-manager.ts:350). Без него 5 сессий, порождающихся при старте, все видят `entries.has(id) === false` и_race_ породить 5 дочерних процессов.

### 6.3 Drain grace + idle cap

```ts
const DRAIN_DELAY_MS_DEFAULT = 30_000; // grace после последнего release
const MAX_IDLE_MS_DEFAULT = 5 * 60_000; // жёсткий лимит (защита от петли отмены drain)
```

State machine в `PoolEntry`:

```
spawning ──spawn ok──► active ──last detach──► draining ──timeout──► closed
   │                     │                       │
   │                     │                       └──attach──► active (отмена таймера)
   spawn fail───────────►failed
                          │
                          └──manual restart──► spawning
```

Жёсткий idle cap: таймер drain может быть отменён+перезапущен бесконечно (колебание acquire/release). `MAX_IDLE_MS` — отдельный таймер, запускаемый **при первом idle** и никогда не сбрасываемый; когда срабатывает, принудительное закрытие даже если drain сейчас в активном grace. Предотвращает зомби записей пула от багованных клиентов, трясущих acquire/release.

### 6.4 Кроссплатформенный обход descendant-pid

**R10 / R23 T7 / обновление PR A (2026-05-22)**: переход от BFS на pid (один подпроцесс `pgrep -P <pid>` / `Get-CimInstance -Filter` на узел) к единому снимку таблицы процессов с последующим обходом дерева в памяти. Две мотивации: (1) один fork вместо B^D fork'ов на горячем пути shutdown пула; (2) консистентность снимка — pre-fix BFS мог пропустить потомков, породившихся между смежными уровнями BFS. Путь на pid сохранён как fallback для BusyBox `ps` \<v1.28 (без поддержки `-o`) и distroless контейнеров без `ps`.

```ts
// packages/core/src/tools/pid-descendants.ts
export async function listDescendantPids(rootPid: number): Promise<number[]> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  try {
    if (process.platform === 'win32')
      return await listDescendantPidsWin(rootPid);
    return await listDescendantPidsUnix(rootPid);
  } catch {
    return []; // ОС сама reap'ит сироты; shutdown пула всё равно продолжается.
  }
}

async function listDescendantPidsUnix(root: number): Promise<number[]> {
  let tree: Map<number, number[]> | undefined;
  try {
    tree = await snapshotProcessTreeUnix(); // ps -A -o pid=,ppid=
  } catch {
    /* fall through to fallback */
  }
  if (tree) return walkDescendants(tree, root); // O(потомков), 1 fork
  return await listDescendantPidsUnixPgrepFallback(root); // legacy BFS
}

async function snapshotProcessTreeUnix(): Promise<Map<number, number[]>> {
  // -A: все процессы (POSIX, эквивалент -e, но недвусмысленно на BSD).
  // -o pid=,ppid=: колонки pid + ppid, trailing `=` подавляет заголовки.
  const { stdout } = await execFile('ps', ['-A', '-o', 'pid=,ppid='], {
    timeout: 2000,
    maxBuffer: 8 * 1024 * 1024, // покрывает >250k процессов патологических хостов
  });
  const childrenByPpid = new Map<number, number[]>();
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    /* parse, push into childrenByPpid */
  }
  return childrenByPpid;
}

// Windows: единый снимок Get-CimInstance Win32_Process | ConvertTo-Csv
// всех строк (ProcessId, ParentProcessId) + обход в памяти; per-pid
// `Get-CimInstance -Filter "ParentProcessId=$p"` сохранён как fallback.
```

Вызывается из `PoolEntry.shutdown()` перед `client.disconnect()`. Обрабатывает утечки обёрток `npx @modelcontextprotocol/server-X`, `uvx ...`, `pnpm dlx ...`. MAX_DESCENDANTS=256 / MAX_DEPTH=8 caps сохранены.

### 6.5 Обработка ошибки spawn

Если `spawnEntry` отклоняется после подключения нескольких подписчиков (через `spawnInFlight`):

- Все ожидающие получают отклонение
- `tryReserveSlot` освобождён **через явный `.catch` arm в `acquire`** (V21-4); без этого исправления слот утекал до следующего прохода health-monitor, который никогда не запускался, потому что не существовало записи для мониторинга.
- Ошибочная запись НЕ сохраняется в `entries`
- Пути кода подписчиков обрабатывают как если бы `acquire` изначально провалился (существующая логика catch `discoverMcpToolsForServer` per-session остаётся валидной)

### 6.6 Reconnect backoff (V21-8)

Когда `PoolEntry` входит в reconnect после падения транспорта:

| Семейство транспортов | Стратегия                                    | Предел                                                           |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| stdio                 | Фиксированный 5s × 3 попытки                 | По существующему `DEFAULT_HEALTH_CONFIG.reconnectDelayMs`        |
| websocket             | Фиксированный 5s × 3 попытки                 | То же, что stdio                                                 |
| http (opt-in)         | Экспоненциальный 1s, 2s, 4с, 8с, 16s × 5     | Удалённые endpoint'ы колеблются при временных сетевых проблемах; больший бюджет |
| sse (opt-in)          | Экспоненциальный 1с, 2с, 4с, 8с, 16с × 5     | То же, что http                                                  |

После исчерпания предела: запись переходит в состояние `failed`; подписчики получают событие `failed`; новый `acquire` для того же `ConnectionId` повторяет spawn один раз, затем бросает. Перезапуск оператора (§13) сбрасывает состояние.

---

## 7. Discovery / SessionMcpView

### 7.1 Dual fan-out Tools + Prompts

```ts
// packages/core/src/tools/mcp-client.ts — split discover на чистый
async discoverAndReturn(cliConfig: Config): Promise<{
  tools: DiscoveredMCPTool[];
  prompts: Prompt[];
}> {
  if (this.status !== MCPServerStatus.CONNECTED) throw new Error('Client is not connected.');
  try {
    const [prompts, tools] = await Promise.all([
      discoverPrompts(this.serverName, this.client, /* no registry */),
      discoverTools(this.client, this.serverConfig, this.serverName, this.debugMode, this.workspaceContext),
    ]);
    if (prompts.length === 0 && tools.length === 0) {
      throw new Error('No prompts or tools found on the server.');
    }
    return { tools, prompts };
  } catch (e) {
    this.updateStatus(MCPServerStatus.DISCONNECTED);
    throw e;
  }
}

// Legacy discover() сохранён, делегирует discoverAndReturn + регистрирует (для standalone nessy)
async discover(cliConfig: Config): Promise<void> {
  const { tools, prompts } = await this.discoverAndReturn(cliConfig);
  for (const t of tools) this.toolRegistry.registerTool(t);
  for (const p of prompts) this.promptRegistry.registerPrompt(p);
}
```

```ts
class SessionMcpView {
  applyTools(snapshot: DiscoveredMCPTool[]) {
    this.sessionToolRegistry.removeToolsByServer(this.serverName);
    for (const tool of snapshot) {
      if (!this.passesFilter(tool)) continue;
      // C7: per-session копия trust (не мутировать общий снимок)
      const localTool = tool.withTrust(this.cfg.trust);
      this.sessionToolRegistry.registerTool(localTool);
    }
  }
  applyPrompts(snapshot: Prompt[]) {
    this.sessionPromptRegistry.removePromptsByServer(this.serverName);
    for (const p of snapshot) this.sessionPromptRegistry.registerPrompt(p);
  }
}
```

### 7.2 Replay снимка при attach (в стиле earlyEvents)

```ts
class PoolEntry {
  attach(sid: string): PooledConnection {
    this.refs.add(sid);
    this.cancelDrainTimer();
    const view = new SessionMcpView(...);
    this.subscribers.set(sid, view);
    // Немедленно воспроизводим текущий снимок, чтобы подписчик не пропустил
    // обновления, приземлившиеся между завершением in-flight discover и
    // attach.
    if (this.state === 'active') {
      view.applyTools(this.toolsSnapshot);
      view.applyPrompts(this.promptsSnapshot);
    }
    return this.makeHandle(sid, view);
  }
}
```

Зеркалит исправление #1 PR 14b `BridgeClient.earlyEvents` — решает аналогичную гонку для attach пула.

### 7.3 Guard устаревшего обработчика (счётчик генерации)

```ts
class PoolEntry {
  private generation = 0;

  private async reconnect(): Promise<void> {
    this.generation += 1;
    const myGen = this.generation;
    await this.client.disconnect();
    await this.client.connect();
    if (myGen !== this.generation) return; // вытеснен другим reconnect
    const snap = await this.client.discoverAndReturn(this.cfg);
    if (myGen !== this.generation) return;
    this.toolsSnapshot = snap.tools;
    this.promptsSnapshot = snap.prompts;
    this.fanOut('toolsChanged');
    this.fanOut('promptsChanged');
  }

  private onServerToolsListChanged = () => {
    const myGen = this.generation;
    this.client
      .discoverAndReturn(this.cfg)
      .then((snap) => {
        if (myGen !== this.generation) return;
        this.toolsSnapshot = snap.tools;
        this.fanOut('toolsChanged');
      })
      .catch(/* swallow + log */);
  };
}
```

Без этого устаревший обработчик от pre-reconnect экземпляра Client мог бы перезаписать post-reconnect снимок устаревшими данными.

**Инвариант монотонности** (уточнение V21): `generation` только инкрементируется, никогда не сбрасывается. Любая in-flight операция захватывает `myGen` на входе, затем post-`await` проверяет `myGen === this.generation`. Эквивалентно "никакого вытесняющего события не произошло с момента моего старта". Ограничен Number.MAX_SAFE_INTEGER (~285k лет при 1Hz reconnect), переполнение не беспокоит.

### 7.4 Унификация пути (расширение scope F2-1)

`packages/core/src/tools/mcp-client.ts` имеет ДВА пути connect-to-server:

1. Класс `McpClient` (mcp-client.ts:100) — используется `McpClientManager`
2. Фабричная функция `connectToMcpServer` (mcp-client.ts:875) — используется `discoverMcpTools` (строка 560) и `connectAndDiscover` (строка 607)

F2-1 должен свести оба за `McpClient.discoverAndReturn` (с `connectToMcpServer` становящимся приватным хелпером `McpClient` или оба вызывают общий примитив `establishConnection()`). Иначе пул покрывает только путь класса; путь фабрики остаётся per-session и подрывает всё усилие.

---

## 8. Сосуществование глобального состояния

### 8.1 `serverStatuses` (mcp-client.ts:292) — collision-толерантная запись

Модульная `Map<serverName, MCPServerStatus>`. `ConnectionId` пула — `name::hash`, но `updateMCPServerStatus(name, status)` пишет по имени. **Несколько записей пула для одного имени (разные fingerprint'ы, например token-divergence) будут затирать статус друг друга.**

**Разрешение**: пул перехватывает запись статуса:

```ts
class PoolEntry {
  updateStatus(s: MCPServerStatus) {
    this.localStatus = s;
    const aggregated = this.pool.aggregateStatusByName(this.serverName);
    updateMCPServerStatus(this.serverName, aggregated);
  }
}

class McpTransportPool {
  aggregateStatusByName(name: string): MCPServerStatus {
    // Любое CONNECTED ⇒ CONNECTED
    // Иначе любое CONNECTING ⇒ CONNECTING
    // Иначе DISCONNECTED
    const entries = [...this.entries.values()].filter(
      (e) => e.serverName === name,
    );
    if (entries.some((e) => e.localStatus === CONNECTED)) return CONNECTED;
    if (entries.some((e) => e.localStatus === CONNECTING)) return CONNECTING;
    return DISCONNECTED;
  }
}
```

Status route выставляет `entryCount: number`, чтобы операторы видели, когда имя → несколько записей.

### 8.2 Хранение OAuth токенов

`MCPOAuthTokenStorage` пишет в `~/.nessy/mcp-oauth/<serverName>.json` — уже daemon-host-shared. Пул выигрывает попутно (первая сессия завершает OAuth → токен на диске → reconnect записи пула подхватывает токен → все остальные сессии piggy-back).

**Оговорка — multi-fingerprint случай**: 2 записи для одного имени (разные headers/env), но один OAuth провайдер → обе читают один файл токена. Если токены server-scoped (OAuth типично), это работает. Если токены env-scoped (редко), нужно явное расширение ключа хранения. **Отложено до F3** с задокументированным known-limitation.

### 8.3 `entryCount` в снимке

Ячейка на сервер `GET /workspace/mcp` добавляет:

```ts
{
  kind: 'mcp_server',
  name: 'github',
  status: 'ok',
  mcpStatus: 'connected',
  entryCount: 2,                          // НОВОЕ — N записей пула для этого имени
  entrySummary?: [                        // НОВОЕ — opaque breakdown на запись
    { entryIndex: 0, refs: 2, status: 'connected' },
    { entryIndex: 1, refs: 1, status: 'connecting' },
  ],
  ...
}
```

**V21-7**: `entrySummary[].entryIndex` — **стабильный opaque integer**, присваиваемый при создании записи (порядок вставки внутри группы имени), НЕ raw fingerprint. Рассуждение: fingerprint меняется при ротации OAuth токенов или env vars, что утекало бы эту информацию через diff'ы снимка (оператор мог бы вывести "токен ротировался в T+5min" из перехода `'a3b1' → 'f972'`). `entryIndex` монотонен внутри группы имени, но остаётся стабильным при ротациях, потому что старая запись сливает и новая запись получает следующий индекс.

Старые SDK клиенты игнорируют неизвестные поля по контракту PR 14; новые клиенты используют `entryCount` для бейджей. Внутренний путь перезапуска по fingerprint использует opaque токен, возвращаемый только через привилегированный extMethod, не выставленный в HTTP snapshot.

---

## 9. WorkspaceContext / ListRoots

### 9.1 Единая регистрация

Экземпляры `McpClient` пула разделяют **один** `WorkspaceContext` — workspace context демона, привязанный демоном (инвариант PR #4113). Обработчик `ListRootsRequestSchema` из `connectToMcpServer` замыкает этот единственный контекст.

Слушатель `onDirectoriesChanged` регистрируется **один раз на запись**, не один раз на `acquire`. Отсоединяется при shutdown записи.

### 9.2 Fan-up `roots/list_changed`

Сервер уведомляет клиент о новых roots → пул веером рассылает:

- Пул повторно обнаруживает (сервер может сообщить другой набор инструментов под новыми roots) → событие `toolsChanged` → все представления подписчиков повторно применяют

### 9.3 Per-session `updateWorkspaceDirectories`

**Контракт**: в Mode B per-session добавления директорий — мягкая подсказка, не авторитетная. `WorkspaceContext` пула — daemon-level.

Два варианта реализации:

- **v1 простой**: игнорировать per-session добавления, логировать warning при детектировании
- **v2 union**: пул хранит `extraRoots: Map<sessionId, Set<dir>>`, обработчик ListRoots возвращает union bound workspace + всех extras. Per-session удаление запускает `roots/list_changed`. Добавляет 50-80 LOC сложности.

**Выбираем v1 простой для F2**; v2 union как follow-up, если материализуется user pain.

---

## 10. Per-session инъекция

### 10.1 `mcpServers` из `newSession({mcpServers})`

`newSessionConfig(cwd, mcpServers, ...)` смешивает инжектированный список с `settings.merged.mcpServers` (acpAgent.ts:1778-1831). Пул потребляет **per-session merged view**:

```ts
async newSessionConfig(...) {
  const config = await loadCliConfig(...);
  if (this.mcpPool) config.setMcpTransportPool(this.mcpPool);
  // ...existing setMcpBudgetEventCallback REMOVED — пул обрабатывает broadcast напрямую
}
```

Когда две сессии инжектируют сервер одного имени с разными env/headers → разные fingerprint'ы → две записи пула. Разделение пула срабатывает только когда сессии полностью согласованы.

### 10.2 Auth расхождение

Статичные `~/.nessy/settings.json` mcpServers идентичны across сессий → все разделяют → 80% случай. Per-session инжектированные mcpServers с per-user токенами → уникальные fingerprint'ы → нет разделения. Оба безопасны.

### 10.3 HTTP transport opt-in (рекап из §5.2)

По умолчанию `pooledTransports = {stdio, websocket}`. HTTP/SSE серверы идут через путь `createUnpooledConnection` (один McpClient на сессию), если оператор не включил opt-in.

### 10.4 `/mcp disable X` mid-session (V21-6)

Когда оператор запускает `/mcp disable github` против живой сессии:

1. `Config.disableMcpServer('github')` добавляет в per-Config set `disabledMcpServers`
2. **F2 hook**: `Config.onDisabledMcpServersChanged` запускает; `SessionMcpView` для этого имени вызывает `teardown()` (удаляет свои регистрации tool/prompt из реестров сессии)
3. Запись пула **может оставаться живой**, если другие сессии всё ещё ссылаются на неё (refcount > 0) — только представление отключающей сессии detach'ится
4. Если все сессии отключают → refcount → 0 → запускается таймер слива

Без шага 2 mid-session disable оставил бы уже зарегистрированные инструменты в `ToolRegistry` сессии до следующего рестарта сессии. Тест 21.4 покрывает это.

`/mcp enable github` — обратное: запускает свежий `pool.acquire` для сессии, attach'ит новое представление, повторно применяет снимок.

---

## 11. Выпуск budget guardrails

### 11.1 State machine перемещается в пул

`tryReserveSlot` / `releaseSlotName` / 75% hysteresis / refused batch coalescing / `bulkPassDepth` / `pendingRefusalNames` — всё мигрирует из `McpClientManager` в `McpTransportPool`. `McpClientManager` сохраняет состояние только когда работает standalone (без инжектированного пула).

### 11.2 Scope ячейки снимка

```ts
{
  kind: 'mcp_budget',
  scope: 'workspace',          // НОВОЕ значение (PR 14 v1 возвращал 'session')
  liveCount: 5,
  clientBudget: 10,
  budgetMode: 'enforce',
  status: 'ok',
}
```

По контракту PR 14: "Потребители ДОЛЖНЫ терпеть дополнительные записи с нераспознанными значениями scope (dropping, не fail)". Старые SDK клиенты видят `scope: 'workspace'`, рендерят как unknown (или fallback на top-level числа). Новые SDK добавляют хелпер `isWorkspaceScopedBudget(cell)`.

### 11.3 Event fan-out

```ts
class NessyAgent {
  constructor() {
    this.mcpPool = new McpTransportPool({
      onBudgetEvent: (event) => this.broadcastBudgetEvent(event),
    });
  }

  private broadcastBudgetEvent(event: McpBudgetEvent) {
    for (const [sid, session] of this.sessions) {
      const enriched = {
        ...event,
        scope: 'workspace' as const,
        sessionId: sid,
      };
      session.connection
        .extNotification('nessy/notify/session/mcp-budget-event', enriched)
        .catch((err) =>
          debugLogger.debug('budget event delivery failed', { sid, err }),
        );
    }
  }
}
```

### 11.4 Изменения контракта типов SDK

PR 14b экспортировал это (должно расширяться аддитивно):

- `DaemonMcpBudgetWarningData` — добавить `scope?: 'workspace' | 'session'` (опционально для обратной совместимости; отсутствует = 'session')
- `DaemonMcpChildRefusedBatchData` — то же расширение `scope?`
- `DaemonMcpGuardrailEvent` — дискриминатор без изменений

Новые хелперы SDK:

```ts
export function isWorkspaceScopedBudgetEvent(
  e: DaemonMcpGuardrailEvent,
): boolean;
```

Reducer state на `DaemonSessionViewState`:

- **Никаких новых полей** — `mcpBudgetWarningCount` / `mcpChildRefusedBatchCount` инкрементируются независимо от scope (scope — свойство каждого события, не отдельный поток)
- Задокументировать, что при F2 эти счётчики отражают workspace-level события, веером расходящиеся на каждую сессию — они будут инкрементироваться **одновременно across всех приаттаченных сессий** при budget pressure

**V21-12 (Q1 resolved, зафиксировано в v2.1)**: сохраняем существующие имена полей (`mcpBudgetWarningCount`, `mcpChildRefusedBatchCount`, `lastMcpBudgetWarning`, `lastMcpChildRefusedBatch`) с расширенной семантикой scope, задокументированной в JSDoc:

```ts
/**
 * Счётчик событий `mcp_budget_warning`, наблюдаемых сессией.
 * При F2 (`scope: 'workspace'`) это инкрементируется одновременно
 * across всех приаттаченных сессий, потому что budget события
 * веером расходятся на workspace уровне. Используйте
 * `isWorkspaceScopedBudgetEvent(lastMcpBudgetWarning)` для
 * проверки scope последнего события.
 */
mcpBudgetWarningCount: number;
```

Обоснование: PR 14b уже отгрузил эти имена как публичную поверхность SDK; переименование — breaking change хуже, чем слегка неточная семантика.

---

## 12. OAuth — явное откладывание на F3

OAuth 401 fallback в `connectToMcpServer` (mcp-client.ts:950-1010) нуждается в интерактивном разрешении (открытие браузера или device-flow). Mode B демон **НЕ ДОЛЖЕН порождать браузер** (согласно дизайну PR 21 — статический-source grep тест падает на билде на `open`/`xdg-open`/`shell.openExternal`).

**Поведение F2 на сервере, требующем OAuth**:

1. Первый acquire запускает `connectToMcpServer` → 401 детектирован
2. Пул ловит OAuth-required исключение, помечает запись как `failed_auth_required`
3. Status route выставляет `errorKind: 'auth_env_error'` (существующий errorKind PR 13)
4. Пул **НЕ повторяет автоматически**
5. Оператор запускает `/mcp auth <name>` (существующий CLI) ИЛИ использует route device-flow из PR 21 для получения токена на диске → следующий session acquire повторяет и успешен

**F3 заменит шаги 4-5** маршрутизацией `PermissionMediator` запроса завершения OAuth в приаттаченные сессии для first-responder.

Это избегает смешивания F2 в работу auth state-machine.

---

## 13. Семантика route перезапуска

### 13.1 `POST /workspace/mcp/:server/restart` под пулом

Сегодня (PR 17): перезапуск в менеджере bootstrap-сессии = перезапуск единственной записи для этого имени.

Под пулом: имя → возможно несколько записей (разные fingerprint'ы для одного имени = разные сессии с разными конфигами).

**Специфицированное поведение**:

| Запрос                                             | Поведение                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /workspace/mcp/:server/restart`              | Перезапуск **всех** записей, совпадающих по `serverName` (параллельно через `Promise.allSettled`)    |
| `POST /workspace/mcp/:server/restart?entryIndex=0` | V21-3: перезапуск только записи #0 (opaque индекс из snapshot §8.3); 404 если не найдена |
| `POST /workspace/mcp/:server/restart?entryIndex=*` | Явное "все" (то же, что без параметра)                                                    |

Форма ответа:

```ts
type RestartResult = {
  entryIndex: number;        // V21-7: opaque индекс, не raw fingerprint
  restarted: boolean;
  durationMs?: number;
  reason?: string;           // 'budget_would_exceed' | 'not_connected' | 'in_flight'
};
POST /workspace/mcp/:server/restart → { entries: RestartResult[] }
```

Старая форма `{restarted: true, durationMs}` сохранена при `entries.length === 1` И без query-параметра `entryIndex` для обратной совместимости; клиенты могут детектировать новую форму проверкой `'entries' in response`.

### 13.2 In-flight restart dedupe

```ts
class PoolEntry {
  private restartInFlight?: Promise<void>;
  async restart(): Promise<void> {
    if (this.restartInFlight) return this.restartInFlight;
    this.restartInFlight = this.doRestart().finally(() => {
      this.restartInFlight = undefined;
    });
    return this.restartInFlight;
  }
}
```

### 13.3 Budget check (сохраняет поведение PR 17)

Пре-рестарт пул проверяет budget: если disconnect+reconnect всё ещё вписывается, OK. Текущая семантика PR 17 `{restarted:false, skipped:true, reason:'budget_would_exceed'}` сохранена (просто теперь применяется на запись).

### 13.4 In-flight вызов инструмента во время reconnect (V21-5, новое)

Сессия A вызывает `pool.callTool('git.commit', args)` → запрос попадает в stdin базового child → child процесс крашится mid-write → запись переходит в reconnect:

```ts
class MCPCallInterruptedError extends Error {
  readonly serverName: string;
  readonly entryIndex: number;
  readonly clientGeneration: number;   // pre-reconnect generation
  readonly args: unknown;              // оригинальные args, для retry вызывающим если безопасно
  constructor(serverName, entryIndex, clientGeneration, args) { ... }
}
```

**Спецификация**:

- Промис in-flight вызова отклоняется с `MCPCallInterruptedError` как только детектировано падение транспорта (не ждать reconnect)
- Пул **НЕ авто-повторяет** вызов; семантика небезопасна для writes (commit, file edit, etc.) и пул не может отличить read от write
- Вызывающий (типично уровень исполнения инструментов в agent loop) ловит эту ошибку и решает: retry / surface пользователю / abort
- После reconnect: сессия A может повторно вызвать (тот же `PooledConnection.callTool`); пул маршрутизирует в новый экземпляр транспорта прозрачно
- `MCPCallInterruptedError.clientGeneration` позволяет вызывающему скоррелировать с последующим событием `reconnected` если нужно

Тест 21.6 должен покрывать: породить long-running stdio MCP, отправить вызов инструмента, убить child mid-call, утверждать отклонение `MCPCallInterruptedError` с ненулевым `clientGeneration`.

---

## 14. Рефактор status route

### 14.1 Новый путь запроса

```ts
// httpAcpBridge.ts:733 buildWorkspaceMcpStatus — замена источника данных
let accounting: McpClientAccounting | undefined;
try {
  // НОВОЕ: query пул напрямую через bridge extMethod, не bootstrap сессию
  accounting = await this.bridge.client.getMcpPoolAccounting();
} catch (err) {
  // Fallback на legacy путь bootstrap сессии для non-pool демона
  const manager = config.getToolRegistry()?.getMcpClientManager();
  if (manager) accounting = manager.getMcpClientAccounting();
}
```

`NessyAgent` выставляет `getMcpPoolAccounting()`:

```ts
class NessyAgent {
  getMcpPoolAccounting(): McpClientAccounting | undefined {
    return this.mcpPool?.getAccounting();
  }
}
```

ACP child бриджит через `extMethod` для вызова демоном.

### 14.2 entryCount + entrySummary

Согласно §8.3.

### 14.3 Случай без bootstrap-сессии

Сегодня (PR 12), когда демон idle (нет сессий ещё), `GET /workspace/mcp` возвращает `initialized: false`, потому что нет bootstrap-сессии для запроса.

Под пулом: пул существует с ctor `NessyAgent` → status route может вернуть live accounting **даже с нулём сессий**. Ячейка `initialized: true` даже пре-первой-сессии. **Задокументированное изменение поведения** в описании PR; не регрессия.

---

## 15. Взаимодействие loadSession / resume (PR 6 #4222)

### 15.1 Отмена drain при resume

```
session-A активна, держит ref entry-X
session-A disconnect (без явного закрытия) → в итоге killSession → pool.releaseSession(A) → entry-X.refs.size === 0 → запускается таймер слива (30с)
session-A resume в пределах 30с → новый newSessionConfig → pool.acquire возвращает entry-X → attach отменяет drain
session-A resume после 30с → entry-X уже закрыт → пул порождает новую запись (cold start)
```

### 15.2 Окно кэша `restoreState` (5мин, из PR 6)

`acpAgent.restoreState` удерживается 5 мин после disconnect. Drain пула (30с по умолчанию) < окно restore (5мин) → resume между 30с и 5мин платит за cold start MCP. Приемлемый trade-off (сам resume — редкий путь).

Альтернатива: пул читает конфиг daemon's restore-window и расширяет drain для соответствия. Добавляет coupling между пулом и state machine сессии; **откладываем на follow-up, если пользователь не сообщит о боли cold-start**.

### 15.3 Взаимодействие `pendingRestoreIds`

`acpAgent.killSession()` должен вызвать `pool.releaseSession(sid)` ПОСЛЕ очистки `pendingRestoreIds`. Порядок:

1. Сессия помечена как restorable (`pendingRestoreIds.add(sid)`)
2. Session.close() — но ref пула всё ещё держится
3. После истечения `RESTORE_WINDOW_MS` без resume: `killSession` перманентно чистит → `pool.releaseSession(sid)` запускает drain

Избегает срабатывания drain во время окна restore.

---

## 16. Hot config reload

### 16.1 Implicit reload через изменение fingerprint

Пользователь редактирует `~/.nessy/settings.json` mid-flight, меняет env сервера:

1. Старые сессии держат старый снимок `Config`/`McpServers` → продолжают acquire старого fingerprint → ref entry-OLD сохраняется
2. Новая сессия читает свежие settings → новый fingerprint → создаётся entry-NEW → сосуществует с entry-OLD
3. Старые сессии естественно закрываются → entry-OLD сливает → в итоге закрыт
4. Steady state: только entry-NEW остаётся

**Никакой live-мутации running соединений** — чистое разделение между сессиями на разных версиях конфига.

### 16.2 Forced reload route (опционально)

```
POST /workspace/mcp/reload-all
  → для каждой сессии: re-load settings, swap Config.mcpServers
  → для каждой записи больше не referenced: schedule eviction
```

Полезно для "Я изменил env vars и хочу немедленный эффект across всех сессий". Откладываем на F2 follow-up (не blocking).

### 16.3 Сиротские записи при удалении расширения (V21-15)

Сценарий: расширение `foo-ext` регистрирует MCP сервер `foo-server`. Оператор запускает `/extension uninstall foo-ext`. Lifecycle расширения удаляет `foo-server` из `extensionMcpServers`, поэтому будущие вызовы `loadCliConfig` не включают его. Но:

- Live сессии держат снимки `Config`, которые всё ещё включают `foo-server` → эти сессии продолжают использовать запись
- Новые сессии после uninstall не acquire'ят (сервер больше не в их merged mcpServers) → нет увеличения refcount

**Разрешение**: полагаемся на естественный drain. По мере закрытия старых сессий refcount падает; в итоге запись достигает `MAX_IDLE_MS = 5min` и принудительно закрывается. **Никакого явного API `pool.invalidateByExtension(name)`** — сохраняет модель единообразной с hot config reload (§16.1).

Trade-off: сервер расширения может работать до 5min после uninstall, если долгая сессия держит его живым. Приемлемо; операторы могут `/mcp restart foo-server` затем убить сессию если срочность требует.

---

## 17. Порядок shutdown

Последовательность `NessyAgent.close()` (должна быть обеспечена):

```
1. Установить acceptingNewSessions = false; отклонять новый POST /session
2. Для каждого in-flight промпта: signal cancel, await завершения (существующий lifecycle PR 11)
3. Для каждой сессии: trigger close → pool.releaseSession(sid)
4. await pool.drainAll({ force: true, timeoutMs: 10_000 })   ← bypasses 30s grace
   ├── Для каждой записи: cancel drain + health timers, mark draining
   ├── Для каждой записи параллельно: listDescendantPids → SIGTERM children
   ├── Для каждой записи параллельно: client.disconnect()
   └── Promise.race против timeoutMs; abandoned записи получают SIGKILL
5. Закрытие канала Bridge
6. Process exit
```

**V21-11**: сигнатура `drainAll`:

```ts
async drainAll(opts?: {
  force?: boolean;       // default false; true bypasses 30s grace timer
  timeoutMs?: number;    // default 10_000; wall-clock budget; SIGKILL stragglers after
}): Promise<DrainResult>;

type DrainResult = {
  drained: number;       // записей, отключившихся чисто
  forced: number;        // записей SIGKILLed после timeout
  errors: Array<{ entryIndex: number; serverName: string; error: string }>;
};
```

Вызывающий использует `DrainResult` для shutdown логгирования; при `forced > 0` логировать warning, чтобы оператор знал, что сервер не shutdown'ился чисто.

---

## 18. Расположение файлов

**Новые файлы:**

```
packages/core/src/tools/
  mcp-transport-pool.ts        # McpTransportPool main (~700 LOC)
  mcp-pool-key.ts              # fingerprint + canonicalize хелперы (~150 LOC)
  mcp-pool-entry.ts            # PoolEntry: refcount + drain + health + generation (~500 LOC)
  session-mcp-view.ts          # SessionMcpView: filter + register tools/prompts (~200 LOC)
  mcp-pool-events.ts           # PoolEvent discriminated union (~80 LOC)
  pid-descendants.ts           # listDescendantPids cross-platform (~150 LOC, incl. tests)

packages/core/src/tools/
  mcp-transport-pool.test.ts   # ~900 LOC
  mcp-pool-entry.test.ts       # ~400 LOC
  session-mcp-view.test.ts     # ~250 LOC
  mcp-pool-key.test.ts         # ~150 LOC
  pid-descendants.test.ts      # ~200 LOC (Unix + Windows skip-gated)
```

**Изменённые файлы:**

```
packages/core/src/tools/mcp-client.ts            # discoverAndReturn() split; connectToMcpServer unified
packages/core/src/tools/mcp-client-manager.ts    # optional pool param; budget state conditional
packages/core/src/tools/tool-registry.ts         # threads pool from config into McpClientManager
packages/core/src/config/config.ts               # setMcpTransportPool / getMcpTransportPool
packages/cli/src/acp-integration/acpAgent.ts     # NessyAgent.mcpPool construction; broadcastBudgetEvent;
                                                 # newSessionConfig wires pool into Config;
                                                 # killSession calls pool.releaseSession
packages/cli/src/serve/run-nessy-serve.ts           # pass --mcp-pool-transports + budget env to ACP child
packages/cli/src/serve/httpAcpBridge.ts          # buildWorkspaceMcpStatus reads pool;
                                                 # restartMcpServer extMethod returns RestartResult[]
packages/cli/src/serve/capabilities.ts           # advertise mcp_workspace_pool
packages/sdk/src/daemon/mcpEvents.ts             # scope?: optional field; isWorkspaceScopedBudgetEvent helper
```

---

## 19. Доставка единым PR — разбиение на коммиты (V21-1)

Согласно рекомендациям мейнтейнера о функционально-связанных батчах (#4175 branching strategy 2026-05-19), F2 отгружается как **один PR с 6 атомарными коммитами**. Ревьюер может пройти через `git log -p HEAD~6..HEAD` и ревьюить коммит за коммитом.

| Коммит # | Заголовок                                                                                       | Scope                                                                                                                                                                                                                                                                                                                                                                                                                  | Затронутые файлы                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1        | `refactor(core): split McpClient.discover into pure tool/prompt list and unify connect paths` | Добавить `discoverAndReturn()`; извлечь общий `establishConnection()` используемый обоими `McpClient.connect()` и фабрикой `connectToMcpServer()`; legacy `discover()` становится тонкой обёрткой, регистрирующей (сохраняет поведение standalone nessy). Никаких наблюдаемых изменений поведения.                                                                                                                                                | `mcp-client.ts`, `mcp-client.test.ts`                                                                                    |
| 2        | `feat(core): McpTransportPool + SessionMcpView`                                               | Ядро пула: `fingerprint`, refcount, dedupe `spawnInFlight`, reverse index `sessionToEntries`, state machine drain, replay снимка при attach, guard генерации, dual fan-out tool+prompt, per-session копия trust. Mock McpClient для unit тестов. Никакой production обвязки.                                                                                                                                                 | новые `mcp-transport-pool.ts`, `mcp-pool-key.ts`, `mcp-pool-entry.ts`, `session-mcp-view.ts`, `mcp-pool-events.ts` + тесты |
| 3        | `feat(core): cross-platform descendant pid sweep + pool health monitor`                       | `listDescendantPids` (Unix `pgrep -P` рекурсивный, Windows PowerShell CIM); unified health monitor внутри `PoolEntry` (interval check + failure count + reconnect backoff по §6.6); интеграционные тесты subprocess-spawn gated на `NESSY_INTEGRATION === '1'`.                                                                                                                                                             | новый `pid-descendants.ts` + тесты; `mcp-pool-entry.ts`                                                                    |
| 4        | `feat(serve): wire McpTransportPool into NessyAgent daemon mode`                               | `Config.setMcpTransportPool` + `getMcpTransportPool`; `ToolRegistry` threads pool into `McpClientManager`; `McpClientManager` optional `pool?` ctor param; `acpAgent.NessyAgent` constructs pool at init; `newSessionConfig` injection; `killSession` calls `pool.releaseSession`; SDK MCP + HTTP/SSE bypass via `createUnpooledConnection`; CLI flags `--mcp-pool-transports`, `--mcp-pool-drain-ms`, `--no-mcp-pool`. | `config.ts`, `tool-registry.ts`, `mcp-client-manager.ts`, `acpAgent.ts`, `run-nessy-serve.ts`                               |
| 5        | `feat(serve): pool-aware status + restart routes`                                             | `NessyAgent.getMcpPoolAccounting` extMethod; `httpAcpBridge.buildWorkspaceMcpStatus` pool-first + bootstrap-session fallback; `restartMcpServer` принимает `?entryIndex=` и возвращает `RestartResult[]`; `entryCount` + `entrySummary[].entryIndex` на ячейке; capability tags `mcp_workspace_pool` + `mcp_pool_restart`.                                                                                                   | `httpAcpBridge.ts`, `capabilities.ts`, SDK types                                                                         |
| 6        | `feat(serve): graduate MCP budget guardrails to workspace scope`                              | Переместить `tryReserveSlot`/`releaseSlotName`/hysteresis state machine из `McpClientManager` в пул; удалить per-session `setMcpBudgetEventCallback` wiring в `acpAgent.newSessionConfig`; `NessyAgent.broadcastBudgetEvent` fan-out; snapshot cell `scope: 'workspace'`; SDK `scope?` additive field; `isWorkspaceScopedBudgetEvent` helper; inline doc updates.                                                          | `mcp-transport-pool.ts`, `mcp-client-manager.ts`, `acpAgent.ts`, `httpAcpBridge.ts`, SDK                                 |

**Оценка LOC всего**: ~4100 production + ~1900 тесты = ~6000 LOC (оценка v2 ~3850; рост поглощает коррекции V21).

**Цель слияния**: единый PR в `daemon_mode_b_main`. Периодический batch merge в `main` согласно стратегии #4175.

**Процесс саморевью перед открытием PR**:

1. После каждого коммита запускать агента `code-reviewer` на diff коммита; принятые находки включать в тот же коммит
2. Для коммитов 2/4/6 (наивысший риск дизайна) дополнительно запускать `silent-failure-hunter` + `type-design-analyzer`
3. После того как все 6 коммитов приземлились: 3 полных прохода ревью разными комбинациями агентов на full PR diff
4. Запустить полный набор тестов + typecheck + lint across всех затронутых пакетов

Зеркалит паттерн пре-ревью специалистом PR 21.

---

## 20. Capability tags + изменения контракта SDK

### 20.1 Новые capability tags (рекламируются атомарно в v0.16, V21-1)

Поскольку F2 отгружается одним PR, все три тега рекламируются вместе. Потребители пула могут предполагать **`mcp_workspace_pool` advertise ⇒ поля `entryCount`/`entrySummary`/`scope?` все присутствуют**; никакой per-field capability check не нужен.

| Тег                        | Когда рекламируется                                                                                | Значение                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `mcp_workspace_pool`       | Когда `NessyAgent.mcpPool !== undefined` (всегда true в daemon mode если нет kill switch `--no-mcp-pool`) | `GET /workspace/mcp` отражает pool-level состояние; поля `entryCount` + `entrySummary` присутствуют    |
| `mcp_pool_restart`         | Всегда когда `mcp_workspace_pool` включён                                                           | `POST /workspace/mcp/:server/restart` принимает `?entryIndex=` и может вернуть `entries: RestartResult[]` |
| (расширяет `mcp_guardrails`) | без изменений                                                                                      | Тот же тег, payload расширен `scope` (`'workspace'` при F2)                                            |

### 20.2 Аддитивная поверхность SDK

```ts
// @nestor/nessy-cli-sdk — additive only
export interface DaemonMcpBudgetWarningData {
  // существующие поля...
  scope?: 'workspace' | 'session'; // НОВОЕ — отсутствует на старых демонах (означает 'session')
}

export interface DaemonMcpChildRefusedBatchData {
  // существующие поля...
  scope?: 'workspace' | 'session';
}

export interface ServeWorkspaceMcpServerStatus {
  // существующие поля...
  entryCount?: number;
  entrySummary?: Array<{
    fingerprint: string;
    refs: number;
    status: MCPServerStatus;
  }>;
}

export function isWorkspaceScopedBudgetEvent(
  e: DaemonMcpGuardrailEvent,
): boolean;
```

`EVENT_SCHEMA_VERSION` остаётся на `1` (additive).

---

## 21. Тестовая матрица

### 21.1 Ключ пула (F2-2)

- Одинаковый конфиг → одинаковый ключ (permutation env-key стабильна, permutation header-key стабильна)
- env значение diff 1 байт → другой ключ
- header `Authorization` значение diff → другой ключ
- `includeTools`/`excludeTools`/`trust` мутированы → ТОТ ЖЕ ключ (per-session фильтр)
- Два `new MCPServerConfig(...)` с идентичным содержимым → одинаковый ключ (canonical hash, не identity)

### 21.2 Жизненный цикл (F2-2)

- 3 сессии acquire одинаковый ключ → 1 spawn (проверить через spy на `client.connect`)
- Последовательность release n,n-1,...,1 → таймер drain запускается только на 1→0
- 30s drain: acquire на 25s отменяет таймер; acquire на 35s порождает новую запись
- `MAX_IDLE_MS` (5min) жёсткое закрытие даже если drain flapping
- Spawn fails во время in-flight: все ожидающие получают ошибку; слот освобождён; запись не сохранена

### 21.3 Concurrent acquire (F2-2)

- 5 одновременных `acquire(sameKey)` пока нет записи → ровно 1 вызов `spawnEntry`, все 5 получают одинаковую запись
- Spawn отклоняется → все 5 ожидающих отклоняются с той же ошибкой; последующий acquire re-spawns

### 21.4 Per-session isolation (F2-2)

- Сессия A `excludeTools: ['foo']`, Сессия B без исключения → A's ToolRegistry опускает foo, B имеет его; оба из одного `toolsSnapshot`
- Сессия A `trust: true`, Сессия B `trust: false` → Session A's `DiscoveredMCPTool.trust === true`, B's `false`; проверить НЕ shared reference (мутация одного не влияет на другой)
- Сессия A acquire'ит prompt-only сервер → A's PromptRegistry populated, ToolRegistry empty для этого сервера

### 21.5 Изменение списка Tool/Prompt (F2-2)

- Сервер испускает `notifications/tools/list_changed` → все подписчики `applyTools` вызваны с новым снимком
- Устаревший обработчик от pre-reconnect генерации НЕ перезаписывает снимок
- `notifications/prompts/list_changed` аналог

### 21.6 Crash + reconnect (F2-2)

- Kill subprocess через `process.kill` → подписчики получают событие `disconnected`
- 3 reconnect попытки (используя существующий `MCPHealthMonitorConfig`) → успех → `reconnected` + свежий снимок
- Exhausted retries → все подписчики получают `failed`; запись переходит в состояние `failed`; новые acquires retry один раз затем throw

### 21.7 Descendant pid sweep (F2-2b)

- Linux/macOS: spawn `bash -c "sleep 60 & sleep 60"` как stdio command → kill root → проверить оба потомка reaped (`/proc/<pid>/status` poll, или `kill(0, pid) === false`)
- Windows: spawn `cmd /c "ping -t localhost"` wrapper → kill → проверить ping subprocess gone
- `pgrep` недоступен (PATH missing) → graceful degradation: log warning, просто SIGTERM root, не краш

### 21.8 Budget на workspace scope (F2-4)

- 4 сессии × `--mcp-client-budget=2` с 3 статичными MCP серверами → workspace total = 3 (не 12); snapshot cell `scope: 'workspace'`, `liveCount: 3`
- Budget warning fires один раз на 75% upward crossing across whole workspace; broadcast на все 4 сессии одновременно
- Hysteresis re-arm: drop to 37.5% → следующее crossing fires снова

### 21.9 Backward compat (F2-3)

- Standalone `nessy` (без демона) → `mcpPool === undefined` → все существующие тесты `mcp-client-manager.test.ts` проходят без изменений
- `--no-mcp-pool` daemon flag → fallback на per-session, все существующие daemon e2e тесты проходят

### 21.10 Credential isolation (F2-3)

- Сессия A инжектирует `{name: 'github', headers: {Authorization: 'Bearer tokenA'}}`, Сессия B `tokenB` → 2 отдельных процесса; проверить через snapshot `entryCount: 2`; проверить A's tool calls идут через A's transport (проверка заголовка в stdin/log)

### 21.11 LoadSession / resume (F2-3)

- Закрытие сессии → drain starts → resume в пределах 30s → запись пула reused (no cold start, asserted via `client.connect` spy count)
- Resume после 30s но до истечения restore-window → pool cold start; содержимое restoreState всё ещё сохранено

### 21.12 Restart route (F2-3b)

- 1 запись для имени → `POST /workspace/mcp/foo/restart` возвращает legacy форму `{restarted: true, durationMs}`
- 2 записи для имени (разные fingerprint'ы) → возвращает `{entries: [{fingerprint, restarted, ...}, ...]}`
- Restart пока другой restart in-flight → второй вызов возвращает тот же promise (deduped)
- Restart когда budget would exceed → `{restarted: false, skipped: true, reason: 'budget_would_exceed'}` на запись

### 21.13 Status route (F2-3b)

- Idle демон (нет сессий) но пул имеет кэшированные записи от предыдущей сессии → `GET /workspace/mcp` возвращает `initialized: true` с live accounting
- Bootstrap session DNE → fallback на pool-direct path; никакой ошибки
- Pool query throws → falls back на bootstrap-session path; никогда не крашится snapshot

### 21.14 SDK reducer (F2-4)

- `mcpBudgetWarningCount` инкрементируется одновременно across всех subscriber сессий когда workspace event broadcasts
- `isWorkspaceScopedBudgetEvent(e)` корректно идентифицирует scope из payload
- Old daemon (без поля `scope`) → defaults к интерпретации 'session'

### 21.15 Hot config reload (F2-3)

- Mid-flight settings.json change → old сессия держит old entry, new сессия создаёт new entry, оба сосуществуют; old drains naturally когда last old сессия закрывается
- 0 сессий после old сессия закрывается → drain timer fires → old entry GC'd → только new entry остаётся

### 21.16 Shutdown ordering (F2-3)

- `NessyAgent.close()` triggers в порядке: stop accepting → drain prompts → close sessions → `pool.drainAll` → no zombie pids в `pgrep -P <acpChildPid>` после exit

---

## 22. Открытые вопросы

V21 зафиксировал Q1/Q3/Q4/Q6 в design defaults (доставка единым PR). Q2/Q5/Q7/Q8/Q9 остаются.

| #     | Вопрос                                                                                                          | F2 design default                                                                         | Решение нужно до |
| ----- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------- |
| Q1 ✅ | Имена полей reducer SDK — переименовать или сохранить?                                                          | **ЗАФИКСИРОВАНО v2.1**: сохранить `mcpBudgetWarningCount` и т.д. с расширенной семантикой scope в JSDoc | resolved         |
| Q2    | Capability `mcp_workspace_pool` — bump `protocolVersions` ('v1' → 'v1.1'), или остаться 'v1' additive?          | **Остаться 'v1' additive** (консистентно с прецедентом PR 14b)                            | коммит 5         |
| Q3 ✅ | Флаг `--no-mcp-pool` — default on или opt-in?                                                                   | **ЗАФИКСИРОВАНО v2.1**: default on; `--no-mcp-pool` это kill switch                       | resolved         |
| Q4 ✅ | HTTP/SSE default — пул off или on?                                                                              | **ЗАФИКСИРОВАНО v2.1**: пул off; opt-in через `--mcp-pool-transports`                     | resolved         |
| Q5    | `POST /workspace/mcp/reload-all` — включить в F2 или follow-up?                                                 | **Follow-up**                                                                             | n/a (отложено)   |
| Q6 ✅ | Lazy construction пула — стоит ли conditional?                                                                  | **ЗАФИКСИРОВАНО v2.1**: eager (всегда конструировать в `NessyAgent` ctor)                 | resolved         |
| Q7    | Окно `restoreState` vs drain пула — держать раздельно, align, или читать из settings?                           | **Держать раздельно 30s default** + config knob `--mcp-pool-drain-ms`                     | коммит 4         |
| Q8    | Обработка OAuth — подтвердить откладывание F3, задокументировать workaround?                                    | **Отложено до F3**, задокументировать workaround `/mcp auth <name>`                       | коммит 4         |
| Q9    | Экспозиция `entrySummary` — всегда включать, или за verbose flag?                                               | **Всегда включать** (малый payload, полезно для ops)                                      | коммит 5         |
| Q10   | Обновить `codeagents/nessy-cli-daemon-design/02-architectural-decisions.md` decision #3 — координировать с @wenshao? | F2 PR description ссылается на codeagents PR; два PR ревьюятся независимо                 | PR open          |

---

## 23. Риски

### Высокие

- **R1 (A2 global state)**: коллизия `serverStatuses` при multi-entry same-name. Митигировано aggregate-status функцией; остающийся риск — SDK потребители читают сырую global Map (маловероятно — используется только через accessor `getMCPServerStatus(name)`).
- **R2 (PromptRegistry симметрия)**: забвение fan-out промптов в любом пути кода тихо дропает промпты. Митигировано тестом 21.4 F2-2 third bullet + интеграционным тестом, утверждающим prompt parity vs pre-F2.
- **R3 (HTTP transport state-bleed)**: opt-in HTTP пула для... [продолжение ниже]

### Средние

- **R4 (path unification F2-1)**: фабричная функция `connectToMcpServer` и класс `McpClient` имеют тонкие поведенческие diff'ы (например, capabilities advertised at construct time vs connect time). Митигировано тем, что F2-1 — чистый refactor PR с полным регрессионным покрытием перед началом работы над пулом.
- **R5 (Windows descendant pid)**: PowerShell `Get-CimInstance` может быть медленным (стоимость spawn) или заблокированным AppLocker. Митигировано 2s timeout + graceful degradation.
- **R6 (Amplification события пула)**: budget warning, веером расходящийся на 100 сессий, вызывает 100 вызовов extNotification в tight loop. Митигировано параллелизацией `Promise.all` + per-session catch (существующий паттерн PR 14b).

### Низкие

- **R7 (Стабильность fingerprint across версий MCPServerConfig)**: будущие поля, добавленные в `MCPServerConfig`, не включённые в fingerprint, могут тихо позволить некорректное разделение. Митигировано явной функцией канонизации + тестом, перечисляющим все поля `MCPServerConfig` и утверждающим покрытие.
- **R8 (Гонки счётчика генерации)**: быстрые циклы restart могут исчерпать точность JS number (≈ 2^53 = ~285k лет при 1/сек). Не практическая проблема.

### Специфичные для единого PR (V21-14)

- **R9 (Усталость ревью от ~6000 LOC единого PR)**: bandwidth ревьюера становится критическим путём. F3 заблокирован на слиянии F2 → блокирует других контрибьюторов. Митигация: (a) пре-ревью с 3 specialist агентами и fold P0/P1 перед открытием, зеркаля паттерн PR 21; (b) структурировать как 6 атомарных коммитов, чтобы ревьюер мог пройти пошагово; (c) заранее координировать окно ревью с @wenshao через комментарий #4175.
- **R10 (Накопление конфликтов слияния `daemon_mode_b_main`)**: F2 затрагивает `acpAgent.ts`, `httpAcpBridge.ts`, `capabilities.ts`, `mcp-client*.ts` — все hot paths. F3 / F4 контрибьюторы, приземляющиеся конкурентно, рискуют конфликтами во время 1–2 недельного окна ревью F2. Митигация: ежедневный `git rebase origin/daemon_mode_b_main`; координировать через обновление #4175, что F2 in-flight + просит F3/F4 отложить изменения hot-file до слияния F2.
- **R11 (Время исполнения CI)**: ~1900 LOC новых тестов включая subprocess spawn + cross-platform pid sweep могут подтолкнуть CI с 30мин → 50мин. Митигация: (a) gate subprocess тесты за `process.env.NESSY_INTEGRATION === '1'`, запускать подмножество в PR CI + полный набор в nightly; (b) Vitest parallelism ≥ 4; (c) Windows pid sweep тесты skip-gated только на GHA Windows runner.

---

## 24. Обновления документации

| Документ                                                                       | Обновление                                                                                                                                                  | Когда                                                |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `codeagents/nessy-cli-daemon-design/02-architectural-decisions.md`             | Decision #3 "MCP server lifetime": сейчас "per-session"; обновить до "workspace-pooled with config-hash key under daemon mode; per-session standalone" | F2-3 merges (координировать с @wenshao codeagents PR) |
| `codeagents/nessy-cli-daemon-design/06-roadmap.md`                             | Wave 5 PR 23 → отметить как F2 series; ссылка на PRs                                                                                                           | F2-3 merges                                          |
| `packages/cli/src/serve/README.md` (если существует) или новый `docs/serve/mcp-pool.md` | Новый раздел: семантика пула, fingerprint key, transport opt-in, семантика restart, интерпретация snapshot статуса                                       | F2-3b                                                |
| `packages/sdk/README.md`                                                       | Поле `scope?` на guardrail событиях, `entryCount` на статусе серверера, хелпер `isWorkspaceScopedBudgetEvent`                                                | F2-4                                                 |
| Тело issue #4175                                                               | Обновить запись F2 с таблицей под-PR, ссылка на design v2 (этот док)                                                                                         | Перед открытием F2-1                                    |
| Тело issue #3803                                                               | Decision #3 row: обновить "Currently per-session" → "Workspace-pooled under daemon (F2)"                                                                  | После слияния F2-3                                    |
| Inline комментарий `acpAgent.ts:869-936`                                           | Удалить forward reference "Wave 5 PR 23"; обновить до "graduated by F2 to `scope: 'workspace'`"                                                            | F2-4 PR                                              |
| CHANGELOG / release notes (Wave 6 / F5)                                        | Заголовок "MCP processes now shared across sessions in a workspace"                                                                                      | F5 release                                           |

---

## 25. Шаблон описания PR (доставка единым PR)

```markdown
## feat(serve): shared MCP transport pool (workspace-scoped) [F2]

Единый функционально-связанный PR согласно стратегии ветвления #4175 (2026-05-19).
Заменяет то, что изначально планировалось как Wave 5 PR 23 + под-PRs F2-1..F2-4.

### Scope

~4100 LOC production + ~1900 LOC тестов across 6 атомарных коммитов.
Пройти через `git log -p HEAD~6..HEAD` для commit-by-commit ревью.

### Design doc

См. `docs/design/f2-mcp-transport-pool.md` (v2.1).

### Пре-ревью specialist агенты (по паттерну PR 21)

Включено в первый коммит перед открытием:

- code-reviewer: N находок, все приняты
- silent-failure-hunter: N находок, все приняты
- type-design-analyzer: N находок, все приняты

### Закрывает

(ничего — запись F2 в #4175 остаётся открытой до слияния PR в main batch)

### Related

- #3803 decision #3 update (codeagents PR <link>)
- PR 14b (#4271 merged) — budget guardrail base; F2 повышает scope до workspace
- F1 (#4319 merged) — acp-bridge package; F2 зависит от injection seams

### Backward совместимость

- Standalone `nessy` (non-daemon): пул не конструируется; существующее поведение сохранено
- Daemon `nessy serve --no-mcp-pool`: kill switch fallback на per-session
- SDK: все новые поля additive (`entryCount`, `scope?`); EVENT_SCHEMA_VERSION остаётся на 1
- Старые SDK клиенты: неизвестное `scope: 'workspace'` игнорируется по контракту PR 14
- Старые демоны: потребители SDK могут детектировать отсутствие capability `mcp_workspace_pool` и fallback

### Test plan

- [ ] Ключ пула: стабильность permutation env, расхождение header, исключение per-session фильтра
- [ ] Жизненный цикл: разделение 3 сессий, drain grace, concurrent acquire dedupe, release слота при ошибке spawn
- [ ] Dual fan-out Tools + Prompts, per-session копия trust, replay снимка при attach
- [ ] Generation guard: pre-reconnect обработчик не перезаписывает post-reconnect снимок
- [ ] Crash + reconnect со stdio backoff (5s × 3) и HTTP backoff (1/2/4/8/16s × 5)
- [ ] Descendant pid sweep: Linux/macOS pgrep recursion, Windows PowerShell CIM
- [ ] Budget на workspace scope: 4 сессии × budget=2 → 3 max (не 12); fan-out на все приаттаченные
- [ ] LoadSession resume в пределах drain window: запись пула reused, no cold start
- [ ] Hot config reload: old/new записи сосуществуют; old drains naturally
- [ ] Restart route: selectivity `?entryIndex=`; legacy форма single-entry response сохранена
- [ ] In-flight вызов инструмента во время reconnect: отклонение `MCPCallInterruptedError`
- [ ] Standalone nessy: все существующие тесты mcp-client-manager проходят без изменений
```

## Резюме

F2 v2.1 = единый PR с 6 атомарными коммитами (~6000 LOC), таргетящий `daemon_mode_b_main`. Ключевые опоры дизайна:

1. **`McpTransportPool`** в `packages/core` (сторона ACP child), workspace-scoped, refcount + 30s drain
2. **Fingerprint key** SHA-256 over canonical config включая env/headers (паттерн claude-code), исключая per-session фильтры (includeTools/trust)
3. **`SessionMcpView`** per-session проекция tool+prompt реестра с копией trust
4. **Replay снимка + generation guard** для attach гонки и устаревших уведомлений
5. **Кроссплатформенный descendant pid sweep** (паттерн opencode + Windows port)
6. **HTTP/SSE opt-in**, SDK MCP bypass, OAuth отложен до F3
7. **Budget state machine** повышается до workspace scope; snapshot cell + push events расширяются аддитивно (`scope?`)
8. **Status + restart routes** рефактор: pool-first с bootstrap-session fallback; `entryCount` + `RestartResult[]`

**Открытые вопросы Q1–Q10** в §22 нуждаются в решениях мейнтейнера перед соответствующими под-PR. Рекомендуется разрешить Q1–Q4 перед стартом F2-3 (те gate'ят широкое направление); Q5–Q10 могут разрешаться инкрементально.
