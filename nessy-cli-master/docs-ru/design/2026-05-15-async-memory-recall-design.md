---
title: Асинхронное припоминание памяти — спецификация дизайна
---

# Асинхронное припоминание памяти — спецификация дизайна

**Дата:** 2026-05-15
**Статус:** Утверждено
**Связанные issues:** #3761, #3759
**Связанные PRs:** #3814, #3866

---

## Проблема

`relevanceSelector.ts` использует `AbortSignal.timeout(1_000)` (добавлено в #3866). При холодном старте первой сессии qwen3.5-flash в среднем ~908 мс — стабильно достигает 1-секундного порога. Внешний дедлайн 2,5 с в `resolveAutoMemoryWithDeadline` означает, что каждый UserQuery может блокироваться до 2,5 с, даже когда припоминание всегда неудачно.

Коренная причина: путь запроса главного агента `await` результата припоминания перед отправкой модели. Любая медлительность в побочном запросе припоминания напрямую добавляется к видимой пользователю задержке.

---

## Дизайн

### Основная идея

Запускать припоминание при UserQuery и никогда не await его. Потреблять результат в двух оппортунистических точках — whichever fires first:

1. **Точка потребления UserQuery** — синхронная проверка `settledAt !== null` непосредственно перед `turn.run()`. Без ожидания: если уже settled, использовать; если нет, пропустить.
2. **Точка инъекции ToolResult** — та же проверка для каждого ToolResult turn. Инъекция памяти как `system-reminder` **добавляется после** частей functionResponse в `requestToSend`, давая модели контекст памяти перед следующим ответом. (Добавлять, не вставлять в начало: Nessy API требует, чтобы functionResponse немедленно следовал за functionCall модели — см. существующий пропуск IDE-контекста `hasPendingToolCall` для того же ограничения.)

Это соответствует паттерну, используемому Claude Code upstream (`startRelevantMemoryPrefetch` / опрос `settledAt` в `query.ts`).

---

## Структуры данных

### Новый тип `MemoryPrefetchHandle` (в `client.ts`)

```typescript
type MemoryPrefetchHandle = {
  promise: Promise<RelevantAutoMemoryPromptResult>;
  /** Установлено promise.finally(). null пока promise не settled. */
  settledAt: number | null;
  /** True после инъекции памяти — предотвращает двойную инъекцию. */
  consumed: boolean;
  controller: AbortController;
};
```

### Изменение поля на `GeminiClient`

| Удалить                                                    | Добавить                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `pendingRecallAbortController: AbortController \| undefined` | `pendingMemoryPrefetch: MemoryPrefetchHandle \| undefined` |

---

## Изменения

### 1. `client.ts` — удалить `resolveAutoMemoryWithDeadline`

Удалить функцию полностью. Она заменена механизмом флага `settledAt`.

### 2. `client.ts` — путь запуска UserQuery

Заменить вызов `resolveAutoMemoryWithDeadline` на:

```typescript
// Прервать любой входящий prefetch из предыдущего UserQuery перед установкой
// нового handle (предотвращает осиротевшие побочные запросы, когда пользователь печатает снова
// до того, как припоминание settled).
this.pendingMemoryPrefetch?.controller.abort();
this.pendingMemoryPrefetch = undefined;

const controller = new AbortController();
// Связать сигнал вызывающего в контроллер prefetch, чтобы прерывание пользователя
// (Ctrl-C / Esc) на родительском turn также завершало побочный запрос припоминания.
const onParentAbort = () => controller.abort();
if (signal.aborted) {
  controller.abort();
} else {
  signal.addEventListener('abort', onParentAbort, { once: true });
}

const promise = this.config
  .getMemoryManager()
  .recall(projectRoot, partToString(request), {
    config: this.config,
    excludedFilePaths: this.surfacedRelevantAutoMemoryPaths,
    abortSignal: controller.signal,
  })
  .catch((error: unknown) => {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      debugLogger.warn('Managed auto-memory recall prefetch failed.', error);
    }
    return EMPTY_RELEVANT_AUTO_MEMORY_RESULT;
  });

const handle: MemoryPrefetchHandle = {
  promise,
  settledAt: null,
  consumed: false,
  controller,
};
void promise.finally(() => {
  handle.settledAt = Date.now();
  signal.removeEventListener('abort', onParentAbort);
});
this.pendingMemoryPrefetch = handle;
// нет await — продолжать немедленно
```

### 3. `client.ts` — точка потребления UserQuery (заменяет `await relevantAutoMemoryPromise`)

```typescript
const prefetchHandle = this.pendingMemoryPrefetch;
if (
  prefetchHandle &&
  prefetchHandle.settledAt !== null &&
  !prefetchHandle.consumed
) {
  prefetchHandle.consumed = true;
  this.pendingMemoryPrefetch = undefined;
  const result = await prefetchHandle.promise; // уже settled, возвращается немедленно
  if (result.prompt) {
    // unshift, не push: держать память в начале systemReminders, чтобы
    // она вела блок system-reminder на UserQuery turns. (ToolResult
    // turns вместо этого добавляют в requestToSend для сохранения pairing functionCall /
    // functionResponse — см. ниже.)
    systemReminders.unshift(result.prompt);
    for (const doc of result.selectedDocs) {
      this.surfacedRelevantAutoMemoryPaths.add(doc.filePath);
    }
  }
}
```

### 4. `client.ts` — точка инъекции ToolResult (новая)

После сборки `requestToSend`, перед `turn.run()`, добавить:

```typescript
if (messageType === SendMessageType.ToolResult) {
  const prefetchHandle = this.pendingMemoryPrefetch;
  if (
    prefetchHandle &&
    prefetchHandle.settledAt !== null &&
    !prefetchHandle.consumed
  ) {
    prefetchHandle.consumed = true;
    this.pendingMemoryPrefetch = undefined;
    const result = await prefetchHandle.promise;
    if (result.prompt) {
      // Добавить (не в начало) чтобы части functionResponse оставались первыми
      // и pairing functionCall/functionResponse модели
      // не нарушался на нативном пути Gemini.
      requestToSend = [...requestToSend, result.prompt];
      for (const doc of result.selectedDocs) {
        this.surfacedRelevantAutoMemoryPaths.add(doc.filePath);
      }
    }
  }
}
```

### 5. `client.ts` — пути очистки

Handle освобождается двумя различными механизмами:

**5 сайтов abort-and-clear** (prefetch всё ещё pending, прервать контроллер перед сбросом ссылки). Заменить `pendingRecallAbortController?.abort()` + `= undefined` на:

```typescript
this.pendingMemoryPrefetch?.controller.abort();
this.pendingMemoryPrefetch = undefined;
```

Сайты: `resetChat()`, ранний возврат `MaxSessionTurns`, ранний возврат `boundedTurns=0`, ранний возврат `SessionTokenLimitExceeded`, ранний возврат Arena control-signal. Путь запуска также выполняет это abort-then-replace, когда новый UserQuery приходит, пока предыдущий prefetch всё ещё в полёте.

**2 сайта clear-only** (prefetch уже settled и мы потребляем его — нет контроллера для прерывания, просто сбросить ссылку):

```typescript
prefetchHandle.consumed = true;
this.pendingMemoryPrefetch = undefined;
```

Сайты: точка потребления UserQuery, точка инъекции ToolResult.

### 6. `relevanceSelector.ts` — удалить `AbortSignal.timeout(1_000)`

Удалить комбинированный `AbortSignal.any([AbortSignal.timeout(1_000), callerAbortSignal])` и передать `callerAbortSignal` напрямую.

---

## Сравнение поведения

| Сценарий                                     | До                               | После                                                  |
| -------------------------------------------- | -------------------------------- | ------------------------------------------------------ |
| припоминание завершается до подготовки модели | инъекция на UserQuery, ожидание ~0 | инъекция на UserQuery, ожидание ~0                   |
| припоминание медленное (холодный старт)      | блокировка до 2,5 с              | пропуск UserQuery, инъекция на первом ToolResult       |
| припоминание таймаутится (1 с)               | прерывание, пустой результат, нет памяти | нет жёсткого таймаута; инъекция когда settled         |
| нет tool calls, припоминание медленное       | блокировка до 2,5 с, затем пропуск | пропуск UserQuery, нет возможности ToolResult — пропуск |
| пользователь отправляет 2-е сообщение до settled припоминания | 2-е припоминание гонится с 1-м handle | 1-й handle прерван, когда 2-й UserQuery запускает новый handle |

---

## Вне объёма

- Изменение формата инъекции памяти с `system-reminder` на вложение `tool-result` (стиль CC)
- Пропуск байтового бюджета на сессию
- Пропуск однословного промпта
