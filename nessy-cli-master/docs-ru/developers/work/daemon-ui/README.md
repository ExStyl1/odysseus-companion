---
title: UI SDK демона — руководство разработчика
---

# UI SDK демона — руководство разработчика

Подпуть `@nestor/nessy-cli-sdk/daemon` содержит общие UI-примитивы для клиентов демона. Текущая цель внедрения — веб-чат и веб-терминал; нативные локальные интеграции TUI, каналов и IDE сохраняют свои существующие пути по умолчанию, пока контракт UI демона стабилизируется. Это руководство описывает поверхность API, представленную PR #4353 (единым последующим PR для слоя общей транскрипции UI из PR #4328).

## Трехслойная модель

```
Daemon SSE wire (NDJSON envelopes)
   │
   ▼
normalizeDaemonEvent(envelope) → DaemonUiEvent[]
   │
   ▼
reduceDaemonTranscriptEvents(state, events) → DaemonTranscriptState
   │                                            { blocks, currentToolCallId,
   │                                              approvalMode, toolProgress, ... }
   ▼
daemonBlockToMarkdown(block) / ToHtml / ToPlainText  ← your renderer plugs here
```

- **Нормализатор**: принимает сырые SSE-конверты демона, возвращает типизированные события UI
- **Редуктор**: накапливает события в автомат транскрипции
- **Хелперы рендеринга**: проецируют блоки состояния в строки для рендеринга

## Быстрый старт

```ts
import {
  DaemonSessionClient,
  createDaemonTranscriptStore,
  normalizeDaemonEvent,
  daemonBlockToMarkdown,
  selectCurrentTool,
  selectApprovalMode,
} from '@nestor/nessy-cli-sdk/daemon';

const session = await DaemonSessionClient.createOrAttach(client, {
  workspaceCwd,
});
const store = createDaemonTranscriptStore();

for await (const envelope of session.events({ signal })) {
  const events = normalizeDaemonEvent(envelope, {
    clientId: session.clientId,
    suppressOwnUserEcho: true,
  });
  store.dispatch(events);
}

// Read state from any subscriber
store.subscribe(() => {
  const state = store.getSnapshot();
  const currentTool = selectCurrentTool(state);
  const mode = selectApprovalMode(state);
  const markdown = state.blocks.map(daemonBlockToMarkdown).join('\n\n');
  myRenderer.render({ markdown, currentTool, mode });
});
```

## Таксономия событий (28+ типов)

`DaemonUiEvent` — это дискриминированное объединение всех событий UI:

### События потока чата

| Событие                      | Когда                                                        |
| ---------------------------- | ------------------------------------------------------------ |
| `user.text.delta`            | Чанк сообщения пользователя приходит от демона               |
| `assistant.text.delta`       | Чанк потока ассистента                                       |
| `assistant.done`             | Завершение запроса (из sendPrompt resolve)                   |
| `thought.text.delta`         | Чанк рассуждения агента                                      |
| `tool.update`                | Жизненный цикл инструмента (running / completed / cancelled) |
| `shell.output`               | Чанк stdout/stderr инструмента оболочки                      |
| `permission.request`         | Инструменту нужна авторизация пользователя                   |
| `permission.resolved`        | Решение разрешения получено                                  |
| `model.changed`              | Модель сессии переключена                                    |
| `status` / `debug` / `error` | Блоки статуса / отладки / ошибки                             |

### События метаданных сессии (PR-A)

| Событие                         | Когда                                                |
| ------------------------------- | ---------------------------------------------------- |
| `session.metadata.changed`      | Заголовок сессии / отображаемое имя обновлено        |
| `session.approval_mode.changed` | Режим переключен (plan / default / yolo / auto-edit) |
| `session.available_commands`    | Список slash-команд обновлен                         |

### События рабочего пространства (PR-A, Wave 3-4)

| Событие                                | Когда                                      |
| -------------------------------------- | ------------------------------------------ |
| `workspace.memory.changed`             | NESSY.md / файл памяти изменен             |
| `workspace.agent.changed`              | Субагент создан / обновлен / удален        |
| `workspace.tool.toggled`               | Встроенный инструмент включен / выключен   |
| `workspace.initialized`                | `nessy init` завершен                      |
| `workspace.mcp.budget_warning`         | Количество MCP-детей приближается к лимиту |
| `workspace.mcp.child_refused`          | MCP-сервер отклонен из-за бюджета          |
| `workspace.mcp.server_restarted`       | Ручной перезапуск MCP успешен              |
| `workspace.mcp.server_restart_refused` | Ручной перезапуск заблокирован             |

### События device-flow аутентификации (PR-A, Wave 4 OAuth)

`auth.device_flow.{started,throttled,authorized,failed,cancelled}`

Каждое несет `deviceFlowId` демона. События Failed несут закрытый enum `errorKind` (закрытый enum — см. `KNOWN_DEVICE_FLOW_ERROR_KINDS`, экспортируемый из `@nestor/nessy-cli-sdk/daemon` для канонического списка, в настоящее время: `expired_token` / `access_denied` / `invalid_grant` / `upstream_error` / `persist_failed` / `not_found_or_evicted`).

## Контракт рендеринга (PR-D)

Три хелпера проекции, один хелпер превью. Все дискриминируют по `block.kind` или `preview.kind`:

```ts
daemonBlockToMarkdown(block, { sanitizeUrls?, maxFieldLength?, locale? })
daemonBlockToHtml(block, { sanitizer?, ...renderOpts })
daemonBlockToPlainText(block, renderOpts)
daemonToolPreviewToMarkdown(preview, renderOpts)
```

### Кулинарная книга: рендеринг транскрипции в markdown

```ts
const markdown = state.blocks
  .map((b) => daemonBlockToMarkdown(b, { sanitizeUrls: true }))
  .join('\n\n');
```

### Кулинарная книга: рендеринг в санированный HTML для SSR

```ts
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
const md = new MarkdownIt();

const html = state.blocks
  .map((b) => {
    // Two-stage pipeline: markdown → HTML → DOMPurify
    const rawHtml = md.render(daemonBlockToMarkdown(b));
    return DOMPurify.sanitize(rawHtml);
  })
  .join('\n');
```

Или использовать встроенный консервативный HTML-рендерер (без парсинга markdown, только HTML-экранирование):

```ts
const html = state.blocks
  .map((b) => daemonBlockToHtml(b, { sanitizer: DOMPurify.sanitize }))
  .join('\n');
```

### Кулинарная книга: копировать-вставить plain text

```ts
const plain = state.blocks.map(daemonBlockToPlainText).join('\n');
navigator.clipboard.writeText(plain);
```

## Таксономия превью инструментов (13 видов)

| Вид                   | Поверхность                                       |
| --------------------- | ------------------------------------------------- |
| `ask_user_question`   | Вопрос с несколькими вариантами с опциями         |
| `command`             | Команда в стиле Bash + cwd                        |
| `file_diff`           | Редактирование файла с oldText/newText или patch  |
| `file_read`           | Путь + необязательный диапазон строк              |
| `web_fetch`           | URL + HTTP-метод                                  |
| `mcp_invocation`      | MCP-сервер + инструмент + краткое описание args   |
| `code_block`          | Сниппет кода с языковым тегом                     |
| `search`              | Запрос + количество результатов + топ результатов |
| `tabular`             | Columns + rows (ограничено 50, усечение помечено) |
| `image_generation`    | Prompt + необязательный URL миниатюры             |
| `subagent_delegation` | Имя агента + задача                               |
| `key_value`           | Generic строки label/value                        |
| `generic`             | Резервное краткое описание                        |

Каждый имеет проекцию `daemonToolPreviewToMarkdown`. Пользовательские рендереры могут диспетчеризовать по `preview.kind` для богатого отображения по типам (diff файла с подсветкой синтаксиса, бейдж MCP-сервера, миниатюра изображения и т.д.).

## Селекторы состояния (PR-E)

```ts
selectCurrentTool(state); // → DaemonToolTranscriptBlock | undefined
selectApprovalMode(state); // → 'plan' | 'default' | 'auto-edit' | 'yolo' | undefined
selectToolProgress(state, toolCallId); // → { ratio?, step? } | undefined
selectPendingPermissionBlocks(state); // → ReadonlyArray<DaemonPermissionTranscriptBlock>
selectTranscriptBlocks(state); // → ReadonlyArray<DaemonTranscriptBlock>
selectTranscriptBlocksOrderedByEventId(state); // sorted by daemon-monotonic id

// PR-K — sub-agent nesting
selectSubagentChildBlocks(state, parentToolCallId); // direct children only
isSubagentChildBlock(block); // type guard: was this tool invoked inside a sub-agent?
```

`currentToolCallId` автоматически поддерживается редуктором:

- Устанавливается, когда инструмент входит в in-flight статус (`running` / `in_progress` / `pending` / `confirming`)
- Очищается, когда инструмент входит в терминальный статус (`completed` / `failed` / `cancelled` / etc.)
- Неизвестные статусы оставляют его без изменений (прямая совместимость)

## Распространение отмены (PR-E)

Когда `assistant.done.reason === 'cancelled'`, редуктор проходит по каждому выполняющемуся блоку инструмента и принудительно устанавливает его статус в `'cancelled'`. Демон не гарантирует терминальный `tool_call_update` для каждого выполняющегося инструмента, когда родительский запрос отменен — это распространение предотвращает бесконечное вращение спиннеров UI.

Дочерние субагенты отменяются вместе с их родителем, потому что отмена итерирует каждый выполняющийся блок инструмента в `toolBlockByCallId`, а не только текущий указатель.

## Вложенность субагентов (PR-K)

Когда главный агент делегирует субагенту (инструмент `Task` или эквивалент), демон помечает `parentToolCallId` и `subagentType` на **дочерних** вызовах инструментов через `tool_call._meta`. Редуктор читает оба и:

- Зеркалирует `parentToolCallId` + `subagentType` на `DaemonToolTranscriptBlock`
- Разрешает `parentBlockId` (блок транскрипции родителя `id`) когда родительский блок уже в состоянии; иначе оставляет `undefined` и заполняет позже, когда родительский блок позже появится

Внешний порядок прибытия (дочерний до родителя) обрабатывается прозрачно. Дочерний элемент, родитель которого обрезан `maxBlocks`, сохраняет `parentToolCallId` для запросов селектора, но `parentBlockId` обнуляется (dangling id больше не разрешается через `blockIndexById`).

```ts
import {
  selectSubagentChildBlocks,
  isSubagentChildBlock,
} from '@nestor/nessy-cli-sdk/daemon';

// Render a parent tool block, then walk children:
function renderToolBlock(state, block) {
  if (block.kind !== 'tool') return renderOther(block);
  const children = selectSubagentChildBlocks(state, block.toolCallId);
  return (
    <ToolBlock block={block}>
      {children.length > 0 && (
        <Indent>
          {children.map((c) => renderToolBlock(state, c))}
        </Indent>
      )}
    </ToolBlock>
  );
}

// Or filter top-level vs. nested at render time:
const topLevel = state.blocks.filter((b) => !isSubagentChildBlock(b));
```

`selectSubagentChildBlocks` возвращает только **прямых** дочерних элементов. Проходите рекурсивно для рендеринга вложенных субагентов (субагент внутри субагента). Демон не испускает циклы, но рендереры, идущие вверх через `parentBlockId`, должны все равно защитно обнаруживать их (например, ограничение глубины или набор посещенных).

Самоссылки (`parentToolCallId === toolCallId`) отбрасываются нормализатором до достижения редуктора.

## Семантика времени (PR-B)

```ts
interface DaemonTranscriptBlockBase {
  eventId?: number; // PRIMARY sort key — daemon-monotonic
  serverTimestamp?: number; // PREFERRED display — daemon-authoritative
  clientReceivedAt: number; // FALLBACK — local clock
  createdAt: number; // @deprecated alias for clientReceivedAt
}
```

**Всегда сортируйте по `eventId`** (используйте `selectTranscriptBlocksOrderedByEventId`) при отображении длинных сессий. Монотонный курсор демона сохраняется через SSE replay-after-reconnect; клиентские часы — нет.

**Всегда форматируйте отображаемые метки времени из `serverTimestamp`** (с падением на `clientReceivedAt`). Несколько клиентов, просматривающих одну сессию, видят одно и то же "5 минут назад" только когда оба читают часы демона.

```ts
import { formatBlockTimestamp } from '@nestor/nessy-cli-sdk/daemon';

const label = formatBlockTimestamp(block, {
  locale: 'zh-CN',
  timeZone: 'Asia/Shanghai',
  timeStyle: 'short',
});
```

## Соответствие адаптера (PR-G)

Проверьте, что ваш адаптер проецирует эталонный корпус SDK в семантически эквивалентный вывод:

```ts
import { runAdapterConformanceSuite } from '@nestor/nessy-cli-sdk/daemon';

it('my adapter conforms to daemon UI corpus', () => {
  const result = runAdapterConformanceSuite({
    reduce: (events) => myReducer(events),
    renderToText: (state) => myRenderer(state),
  });
  expect(result.failed).toEqual([]);
});
```

Фикстурный корпус (`DAEMON_UI_CONFORMANCE_FIXTURES`) покрывает чат, жизненный цикл инструментов, редактирование файлов, MCP, разрешения, предупреждение бюджета MCP, отмену, исправление malformed payload, OAuth, обновления команд и вложенность субагентов. (Количество выводится во время выполнения — читайте `DAEMON_UI_CONFORMANCE_FIXTURES.length`.)

**Независимо от формата** — ваш адаптер может рендерить в ANSI / HTML / markdown / JSX; фреймворк проверяет только семантическое содержимое через `expectedContains` и `expectedAbsent`.

## Категоризация ошибок (PR-A)

`DaemonUiErrorEvent.errorKind` — это закрытый enum, распространяемый из типизированной таксономии ошибок демона (когда демон помечает это):

```ts
import type { DaemonErrorKind } from '@nestor/nessy-cli-sdk/daemon';
// 'missing_binary' | 'blocked_egress' | 'auth_env_error' | 'init_timeout'
// | 'protocol_error' | 'missing_file' | 'parse_error' | 'budget_exhausted'
```

Рендереры должны ветвиться на `errorKind` для действенных возможностей:

```ts
function errorAffordance(errorKind?: DaemonErrorKind): React.ReactNode {
  switch (errorKind) {
    case 'auth_env_error': return <button>Re-authenticate</button>;
    case 'missing_file':   return <button>Choose file</button>;
    case 'blocked_egress': return <span>Network blocked — check proxy</span>;
    default:               return null;
  }
}
```

## Диспетчеризация происхождения инструмента (PR-A)

`DaemonUiToolUpdateEvent.provenance` — это закрытый enum (`builtin` / `mcp` / `subagent` / `unknown`). С `serverId?: string` когда `mcp`. Используйте для диспетчеризации иконок и бейджей:

```ts
function toolIcon(event: DaemonUiToolUpdateEvent): React.ReactNode {
  switch (event.provenance) {
    case 'mcp':      return <McpIcon server={event.serverId} />;
    case 'subagent': return <SubagentIcon />;
    case 'builtin':  return <BuiltinIcon name={event.toolName} />;
    default:         return <GenericIcon />;
  }
}
```

SDK имеет эвристическое резервное именование `mcp__<server>__<tool>` — даже когда демон явно не помечает происхождение, MCP-инструменты обнаруживаемы.

## Принципы прямой совместимости

Каждый слой в UI SDK демона следует **принципу прямой совместимости**: неизвестные значения НЕ бросают; они деградируют грациозно.

- Неизвестные типы событий демона → событие `debug` с сырым именем типа
- Неизвестный статус инструмента → `currentToolCallId` без изменений (без очистки)
- Неизвестный вид ошибки → `errorKind` undefined (рендерер падает на текст)
- Отсутствует serverTimestamp → падение на `clientReceivedAt`
- Нераспознанная форма превью → вид `generic` с `summary`

Это означает, что **SDK может работать впереди испускания демоном**. Эвристика происхождения инструмента PR-A, извлечение меток времени в трех местах PR-B и сохранение неизвестного статуса PR-E — все это примеры "готово, когда демон отправляет; безопасно, когда нет."

## Перекрестные ссылки

- [PR #4328](https://github.com/NessyLM/nessy-cli/pull/4328) — базовый PR с общим слоем транскрипции UI
- [PR #4353](https://github.com/NessyLM/nessy-cli/pull/4353) — этот PR (единое последующее дополнение)
- [Issue #3803](https://github.com/NessyLM/nessy-cli/issues/3803) — предложение режима демона
- [Issue #4175](https://github.com/NessyLM/nessy-cli/issues/4175) — трекер реализации Mode B v0.16
