---
title: Миграция на @nestor/nessy-cli-sdk/daemon v2
---

# Миграция на `@nestor/nessy-cli-sdk/daemon` v2

PR #4328 выпустил UI-слой демона v1. PR #4353 (этот PR) выпускает v2 с семью дополнительными коммитами функций. Это руководство описывает изменения сначала для авторов адаптеров веб-чата и веб-терминала. Сопровождающие нативных локальных TUI, каналов и IDE могут позже повторно использовать те же примитивы, но эти пути продуктов по умолчанию не мигрированы этим PR.

## TL;DR для существующих потребителей

**Нет нарушающих изменений.** Каждый коммит в этом PR является дополнительным:

- поля v1 все еще работают (`createdAt` сохранен как `@deprecated` алиас для `clientReceivedAt`)
- нормализатор v1 все еще сопоставляет те же 13 типов событий тем же способом
- редуктор v1 все еще производит те же блоки для событий чата
- Новый API опционален через дополнительные параметры и хелперы

PR безопасен для слияния без каких-либо изменений потребителей. **Принятие новых функций является инкрементальным.**

## Рекомендуемый порядок внедрения

Для каждого адаптера в порядке соотношения усилий/ценности:

### 1. Упорядочивание: переключить ключ сортировки с `createdAt` на `eventId`

**До:**

```ts
const ordered = [...state.blocks].sort((a, b) => a.createdAt - b.createdAt);
```

**После:**

```ts
import { selectTranscriptBlocksOrderedByEventId } from '@nestor/nessy-cli-sdk/daemon';
const ordered = selectTranscriptBlocksOrderedByEventId(state);
```

**Почему**: `eventId` является монотонным для демона; сохраняется при SSE replay-after-reconnect. `createdAt` — это клиентские часы и смещается при повторе.

### 2. Отображение: переключить `createdAt` на `serverTimestamp ?? clientReceivedAt`

**До:**

```tsx
<TimeLabel ms={block.createdAt} />
```

**После:**

```tsx
import { formatBlockTimestamp } from '@nestor/nessy-cli-sdk/daemon';
<TimeLabel text={formatBlockTimestamp(block, { locale })} />;
```

**Почему**: Несколько клиентов видят согласованное "X минут назад" только когда оба читают часы демона. Рендерер плюс `formatBlockTimestamp` обрабатывает часовой пояс + локаль.

**Примечание**: Демону нужно проставлять `_meta.serverTimestamp` на конвертах, чтобы это заработало. SDK готов к прямой совместимости; падает на `clientReceivedAt` до тех пор.

### 3. Слушать новые типы событий — выбрать подмножество для рендеринга

16 новых типов событий (session-meta, workspace, auth) не создают блоки транскрипции. Это побочные наблюдения. Каждый адаптер выбирает, какие отображать:

```ts
// In your SSE consumer
const uiEvents = normalizeDaemonEvent(envelope, {
  clientId,
  suppressOwnUserEcho: true,
});
store.dispatch(uiEvents);

// Then in your UI side
for (const event of uiEvents) {
  switch (event.type) {
    case 'session.approval_mode.changed':
      myApprovalModeBadge.update(event.next);
      break;
    case 'workspace.mcp.budget_warning':
      myToast.show(
        `MCP servers approaching budget: ${event.liveCount}/${event.budget}`,
      );
      break;
    case 'auth.device_flow.started':
      myAuthModal.show({
        deviceFlowId: event.deviceFlowId,
        providerId: event.providerId,
        expiresAt: event.expiresAt,
      });
      break;
    // ... etc, opt into what your UI needs
  }
}
```

Или используйте селекторы для зеркальных побочных каналов состояния:

```ts
import {
  selectApprovalMode,
  selectCurrentTool,
} from '@nestor/nessy-cli-sdk/daemon';

const mode = selectApprovalMode(state); // mirrored from approval_mode.changed
const currentTool = selectCurrentTool(state); // current in-flight tool
```

### 4. Контракт рендеринга: использовать `daemonBlockToMarkdown` (или HTML / plainText)

**До** (каждый адаптер делает свою проекцию):

```ts
function blockToString(block: DaemonTranscriptBlock): string {
  switch (block.kind) {
    case 'user':
      return `You: ${block.text}`;
    case 'assistant':
      return block.text;
    case 'tool':
      return `[${block.title}]\n${block.status}`;
    // ... etc
  }
}
```

**После** (делегировать SDK):

```ts
import { daemonBlockToMarkdown } from '@nestor/nessy-cli-sdk/daemon';
const md = daemonBlockToMarkdown(block);
```

Для HTML SSR:

```ts
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
const html = DOMPurify.sanitize(md.render(daemonBlockToMarkdown(block)));
```

Для plain text:

```ts
import { daemonBlockToPlainText } from '@nestor/nessy-cli-sdk/daemon';
const plain = daemonBlockToPlainText(block);
```

### 5. Тест соответствия

Добавить в набор тестов вашего адаптера:

```ts
import { runAdapterConformanceSuite } from '@nestor/nessy-cli-sdk/daemon';

it('adapter projects daemon UI corpus correctly', () => {
  const result = runAdapterConformanceSuite({
    reduce: (events) => myReduce(events),
    renderToText: (state) => myRender(state),
  });
  expect(result.failed).toEqual([]);
});
```

Это запустит ваш адаптер против 10 фикстурных сценариев и выявит любой дрейф проекции до того, как он достигнет пользователей.

### 6. Диспетчеризация иконок инструментов через `provenance`

**До** (строковое совпадение на toolName):

```tsx
const isMcp = toolName?.startsWith('mcp__');
const isBuiltin = ['Bash', 'Edit', 'Read'].includes(toolName);
```

**После** (типизированное происхождение из PR-A):

```tsx
import type { DaemonUiToolUpdateEvent } from '@nestor/nessy-cli-sdk/daemon';

function toolIcon(event: DaemonUiToolUpdateEvent): React.ReactNode {
  switch (event.provenance) {
    case 'mcp':
      return <McpIcon server={event.serverId} />;
    case 'subagent':
      return <SubagentIcon />;
    case 'builtin':
      return <BuiltinIcon name={event.toolName} />;
    case 'unknown':
    default:
      return <GenericIcon />;
  }
}
```

SDK имеет эвристическое резервное именование `mcp__<server>__<tool>` — работает сегодня, даже когда демон явно не помечает происхождение.

### 7. Категоризация ошибок через `errorKind`

**До** (regex на тексте):

```ts
if (error.text.includes('auth')) showAuthRetry();
else if (error.text.includes('file not found')) showFilePicker();
```

**После** (закрытый enum из PR-A):

```ts
import type { DaemonErrorKind } from '@nestor/nessy-cli-sdk/daemon';

function errorAction(errorKind?: DaemonErrorKind): React.ReactNode {
  switch (errorKind) {
    case 'auth_env_error': return <RetryAuthButton />;
    case 'missing_file':   return <FilePicker />;
    case 'blocked_egress': return <CheckProxyHint />;
    case 'init_timeout':   return <RestartDaemonButton />;
    default:               return null;
  }
}
```

**Примечание**: Демону нужно проставлять `data.errorKind` на session_died / stream_error для заполнения. SDK уже читает это.

### 8. Обработка отмены — уже автоматически

В v1 отмененные запросы оставляли выполняющиеся блоки инструментов вращающимися навсегда.
В v2 (PR-E), `propagateCancellationToInFlightTools` запускается автоматически при `assistant.done.reason === 'cancelled'`. Дочерние субагенты отменяются вместе с их родителем.

**Не требуется изменений адаптера** — ваши спиннеры будут разрешаться корректно.

### 8a. Вложенность субагентов — opt-in для вложенного рендеринга (PR-K)

Блоки инструментов, вызванные внутри делегации субагента, теперь несут `parentToolCallId`, `subagentType` и (когда родитель в состоянии) `parentBlockId`. Адаптеры могут включить вложенный рендеринг:

**До** (плоский список, вызовы субагентов визуально неотличимы от верхнеуровневых):

```tsx
state.blocks.map((b) => <ToolBlock block={b} />);
```

**После** (рекурсивный вложенный рендеринг):

```tsx
import {
  selectSubagentChildBlocks,
  isSubagentChildBlock,
} from '@nestor/nessy-cli-sdk/daemon';

function renderTool(block) {
  const children = selectSubagentChildBlocks(state, block.toolCallId);
  return (
    <ToolBlock block={block}>
      {block.subagentType && <SubagentBadge type={block.subagentType} />}
      {children.length > 0 && <Indent>{children.map(renderTool)}</Indent>}
    </ToolBlock>
  );
}

const topLevel = state.blocks.filter((b) => !isSubagentChildBlock(b));
return topLevel.map(renderTool);
```

**Не требуется изменений адаптера, если вы предпочитаете плоский вид** — новые поля являются дополнительными и игнорируются кодом, который их не читает.

### 9. Таксономия превью инструментов — выбрать подмножество для рендеринга с пользовательскими компонентами

PR-D + PR-F приносят 13 видов превью:

- 4 file-shaped: `file_diff`, `file_read`, `web_fetch`, `mcp_invocation`
- 5 content-shaped: `code_block`, `search`, `tabular`, `image_generation`, `subagent_delegation`
- 2 control: `ask_user_question`, `command`
- 2 generic: `key_value`, `generic`

Каждый адаптер диспетчеризирует по `preview.kind`:

```tsx
function ToolPreviewComponent({ preview }: { preview: DaemonToolPreview }) {
  switch (preview.kind) {
    case 'file_diff':
      return (
        <UnifiedDiffView
          path={preview.path}
          old={preview.oldText}
          new={preview.newText}
        />
      );
    case 'mcp_invocation':
      return (
        <McpCard serverId={preview.serverId} toolName={preview.toolName} />
      );
    case 'tabular':
      return <DataTable columns={preview.columns} rows={preview.rows} />;
    case 'image_generation':
      return (
        <ImagePreview
          thumbnailUrl={preview.thumbnailUrl}
          prompt={preview.prompt}
        />
      );
    // ... or fall back to:
    default:
      return <Markdown text={daemonToolPreviewToMarkdown(preview)} />;
  }
}
```

Адаптеры без пользовательских компонентов для всех 13 видов могут падать на `daemonToolPreviewToMarkdown` SDK для любого необработанного вида.

## Чек-лист обратной совместимости

| Проблема                                           | Статус                                             |
| -------------------------------------------------- | -------------------------------------------------- |
| Существующие чтения `block.createdAt`              | ✅ все еще работает (алиас для `clientReceivedAt`) |
| Существующая обработка событий редуктором          | ✅ без изменений для типов событий v1              |
| Вызовы `daemonTranscriptToUnifiedMessages(blocks)` | ✅ новый параметр options необязателен             |
| Потребители `selectTranscriptBlocks`               | ✅ без изменений                                   |
| Новые типы событий в редукторе v1                  | ✅ no-op, `lastEventId` все еще продвигается       |

## Перекрестные ссылки

- [SUMMARY PR #4353](https://github.com/NessyLM/nessy-cli/pull/4353)
- [README Daemon UI](./README.md) — полная справка API
- [PR #4328](https://github.com/NessyLM/nessy-cli/pull/4328) — базовый PR с общим слоем транскрипции UI
