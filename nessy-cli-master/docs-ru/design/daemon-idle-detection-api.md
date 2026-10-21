---
title: Интерфейс обнаружения простоя Daemon
---

# Интерфейс обнаружения простоя Daemon

## Фон

### Проблема

Nessy Daemon развёртывается на множестве машин как долгоживущий сервис. Когда Daemon
длительное время не выполняет задач, дальнейшее использование ресурсов машины является
расточительством. Внешнему планировщику (K8s HPA / кастомный Scaler) нужен надёжный
сигнал для определения, находится ли Daemon в простое, чтобы выполнить масштабирование вниз.

### Текущее состояние

В настоящее время доступные интерфейсы:

| Интерфейс                        | Возвращаемая информация                             | Ограничения                                                                 |
| -------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /health?deep=true`          | `{ sessions, pendingPermissions }`                  | Только количество сессий, нельзя различить «есть сессии, но простои» и «есть сессии, которые работают» |
| `GET /workspace/:cwd/sessions`   | `hasActivePrompt` + `clientCount` для каждой сессии | Требует дополнительного запроса, нет временнóй информации (как давно не было активности?) |

**Ключевые отсутствующие данные**:

1. Нет агрегированного показателя «есть ли активные промпты»
2. Нет «последнего времени активности», внешним системам нужно самим поддерживать машину состояний для расчёта длительности простоя
3. Нет количества SSE-соединений (внутренне поддерживается `activeSseCount`, но `/health` не возвращает)
4. Нет состояния живости channel (дочернего процесса агента)

## Цели дизайна

Предоставить интерфейс, который **завершает определение простоя одним HTTP-вызовом**, удовлетворяя:

- Внешний планировщик одним GET может определить, можно ли переработать
- Поддержка временнóго измерения (как давно простаивает), чтобы избежать внешнего поддержания состояния
- Обратная совместимость с существующим поведением `/health`
- Нулевые дополнительные зависимости, использование существующего внутреннего состояния

## Решение

### Расширение ответа `GET /health?deep=true`

Добавить поля в существующий ответ `/health?deep=true`:

```jsonc
// GET /health?deep=true
{
  "status": "ok",

  // ---已有的字段（不变）---
  "sessions": 2,
  "pendingPermissions": 0,

  // --- 新增字段 ---
  "activePrompts": 1, // 正在执行 prompt 的 session 数
  "connectedClients": 3, // 活跃 SSE 连接数
  "channelAlive": true, // agent 子进程是否存活
  "lastActivityAt": "2026-06-10T08:30:00.000Z", // 最后一次活动时间（ISO 8601）
  "idleSinceMs": 120000, // 距离最后活动已经过去的毫秒数
}
```

### Определение полей

| Поле                 | Тип              | Семантика                                                                                   |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------- |
| `activePrompts`      | `number`         | Количество сессий с `promptActive === true` в данный момент                                 |
| `connectedClients`   | `number`         | Количество активных SSE-соединений (существующий `activeSseCount`)                          |
| `channelAlive`       | `boolean`        | Жив ли дочерний процесс агента (существующий `bridge.isChannelLive()`)                      |
| `lastActivityAt`     | `string \| null` | Временная метка последнего начала или завершения промпта в ISO; `null` если промптов не было |
| `idleSinceMs`        | `number \| null` | `Date.now() - lastActivityAt`; `null` если нет записей об активности                        |

### Определение «активности»

Следующие события считаются «активностью», обновляющей `lastActivityAt`:

- Начало выполнения промпта (`promptActive` с false → true)
- Завершение/неудача промпта (`promptActive` с true → false)
- Создание новой сессии (успешный `spawnOrAttach`)
- Восстановление/загрузка сессии (успешный `loadSession` / `resumeSession`)

События, **не** считающиеся активностью (во избежание ложного определения):

- SSE-соединение/разъединение
- heartbeat
- Запрос `/health`
- Запрос/ответ разрешения

### Правила определения простоя (для справки внешнего планировщика)

```python
def should_reclaim(health, idle_threshold_ms=300_000):
    """Условия рекомендации переработки: простой превышает порог (по умолчанию 5 минут)"""
    if health["activePrompts"] > 0:
        return False  # Есть запущенные задачи
    if health["connectedClients"] > 0:
        return False  # Клиенты подключены
    if health["idleSinceMs"] is None:
        # Никогда не было активности — возможно, только что запущенный cold daemon
        return True
    return health["idleSinceMs"] >= idle_threshold_ms
```

## Затронутые изменения кода

### 1. `packages/acp-bridge/src/bridgeTypes.ts`

Добавить в интерфейс `AcpSessionBridge`:

```typescript
/** Количество сессий, выполняющих промпт в данный момент */
get activePromptCount(): number;

/** Временная метка последнего времени активности (epoch ms), null если активности не было */
get lastActivityAt(): number | null;
```

### 2. `packages/acp-bridge/src/bridge.ts`

В фабричной функции `createAcpSessionBridge`:

```typescript
// Отслеживание нового состояния
let lastActivityTimestamp: number | null = null;

function touchActivity(): void {
  lastActivityTimestamp = Date.now();
}
```

Вызывать `touchActivity()` в следующих местах:

- `entry.promptActive = true` (~строка 2528) — начало промпта
- `entry.promptActive = false` (~строка 2551, 2559) — завершение промпта
- После успешного создания сессии в `doSpawn` (~строка 1906)
- После успешного `restoreSession`

Объявить в возвращаемом объекте:

```typescript
get activePromptCount() {
  let count = 0;
  for (const entry of byId.values()) {
    if (entry.promptActive) count++;
  }
  return count;
},

get lastActivityAt() {
  return lastActivityTimestamp;
},
```

### 3. `packages/cli/src/serve/server.ts`

Изменить `healthHandler` (~строка 803) в ветке `deep`:

```typescript
const healthHandler = (req: Request, res: Response): void => {
  const deepQuery = req.query['deep'];
  const deep = deepQuery === '1' || deepQuery === 'true' || deepQuery === '';
  if (!deep) {
    res.status(200).json({ status: 'ok' });
    return;
  }
  try {
    const lastActivityAt = bridge.lastActivityAt;
    const now = Date.now();
    res.status(200).json({
      status: 'ok',
      // 已有的
      sessions: bridge.sessionCount,
      pendingPermissions: bridge.pendingPermissionCount,
      // 新增
      activePrompts: bridge.activePromptCount,
      connectedClients: getActiveSseCount(),
      channelAlive: bridge.isChannelLive(),
      lastActivityAt:
        lastActivityAt !== null ? new Date(lastActivityAt).toISOString() : null,
      idleSinceMs: lastActivityAt !== null ? now - lastActivityAt : null,
    });
  } catch (err) {
    writeStderrLine(
      `nessy serve: /health deep probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(503).json({ status: 'degraded' });
  }
};
```

### 4. `packages/cli/src/serve/server.test.ts`

Добавить тесты:

- Корректность новых полей в `/health?deep=true`
- При отсутствии сессий `activePrompts === 0`, `idleSinceMs === null`
- При выполняющемся промпте `activePrompts > 0`, `idleSinceMs` постоянно обновляется
- После завершения промпта `idleSinceMs` начинает расти

### 5. `packages/acp-bridge/src/bridge.test.ts`

Добавить тесты:

- Изменение значений `activePromptCount` в жизненном цикле промпта
- Обновление `lastActivityAt` после каждого события активности
- Правильное суммирование `activePromptCount` при параллельной работе нескольких сессий

## Список изменений файлов

| Файл                                     | Тип изменения | Описание                                                |
| ---------------------------------------- | ------------- | ------------------------------------------------------- |
| `packages/acp-bridge/src/bridgeTypes.ts` | Расширение интерфейса | Новые свойства `activePromptCount`, `lastActivityAt` |
| `packages/acp-bridge/src/bridge.ts`      | Реализация логики | Новое отслеживание `lastActivityTimestamp` + getter |
| `packages/cli/src/serve/server.ts`       | Расширение HTTP-ответа | Новые поля в `/health?deep=true`                  |
| `packages/cli/src/serve/server.test.ts`  | Тесты         | Покрытие новых полей health-интерфейса              |
| `packages/acp-bridge/src/bridge.test.ts` | Тесты         | Покрытие свойств bridge                             |

## Совместимость

- **Обратная совместимость**: Новые поля добавлены, ни одно существующее поле не изменено/удалено
- **`GET /health` (не deep)**: Поведение не изменено, по-прежнему возвращает только `{ "status": "ok" }`
- **OTel Gauge**: Существующие `registerDaemonGaugeCallbacks` могут опционально добавить gauge `activePrompts`, но это не входит в текущий объём

## Последующие расширения (не входят в текущий объём)

1. **Автоматическое завершение работы**: встроенный параметр daemon `--auto-shutdown-idle-ms`, выход после простоя (подходит для сценариев systemd/K8s Pod)
2. **OTel-метрики**: регистрация `activePrompts`, `idleSinceMs` как gauge в OTel meter
3. **Webhook-колбэки**: активная отправка событий внешней системе при превышении порога простоя
