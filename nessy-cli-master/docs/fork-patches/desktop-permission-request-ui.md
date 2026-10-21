# desktop-permission-request-ui

## AIDT

AIDT-7049

## Зачем

Desktop показывал минимальную информацию в запросах разрешений — только название файла и краткое описание изменений. Пользователь не мог увидеть полный diff с контекстом, что делало невозможным принятие обоснованных решений.

Эта fork-функция сохраняет переданные ACP поля `path`, `oldText` и `newText` до renderer и автоматически открывает `file_write` diff в существующей изменяемой по ширине боковой preview-панели Desktop. Карточка разрешения остаётся компактной, а закрытие preview не подтверждает и не отклоняет запрос. Unified diff сохраняется как fallback для агентов, использующих старый формат.

Остальной type-aware рендеринг permission-карточки остаётся частью того же патча:

- **file_write**: diff в боковой preview-панели с unified/split режимами
- **bash**: предпросмотр команд с синтаксической подсветкой
- **mcp_mutation**: аргументы MCP инструментов в JSON блоке
- **api_mutation**: детали API запросов
- **admin_approval**: структурированные поля (reason, impact, application)

## Файлы

- `packages/desktop/packages/shared/src/utils/diff-parser.ts` — парсер unified diff
- `packages/desktop/packages/shared/src/utils/__tests__/diff-parser.test.ts` — тесты парсера
- `packages/desktop/packages/shared/src/utils/index.ts` — экспорт парсера
- `packages/desktop/packages/shared/src/agent/backend/types.ts` — поля diff в callback разрешения
- `packages/desktop/packages/shared/src/agent/nessy-agent.ts` — извлечение canonical ACP diff
- `packages/desktop/packages/shared/src/agent/__tests__/nessy-agent-models.test.ts` — проверка передачи ACP содержимого
- `packages/desktop/packages/server-core/src/sessions/SessionManager.ts` — передача diff в renderer event
- `packages/desktop/packages/core/src/types/message.ts` — поля diff в `PermissionRequest`
- `packages/desktop/apps/electron/src/renderer/hooks/useLinkInterceptor.ts` — состояние permission diff в общей preview-панели
- `packages/desktop/apps/electron/src/renderer/context/AppShellContext.tsx` — callbacks открытия и адресного закрытия diff
- `packages/desktop/apps/electron/src/renderer/App.tsx` — рендеринг diff в `FilePreviewPanel`
- `packages/desktop/apps/electron/src/renderer/components/app-shell/input/structured/PermissionRequest.tsx` — type-aware рендеринг запросов
- `packages/desktop/apps/electron/src/renderer/components/ui/DiffRenderer.tsx` — удалённый отдельный inline renderer

## Откат

1. Удалить ACP diff-поля и их передачу из agent/backend, `SessionManager` и `PermissionRequest`.

2. Удалить diff-вариант и callbacks из `useLinkInterceptor`, `AppShellContext` и `App`.

3. Откатить `PermissionRequest.tsx` к базовой версии без type-specific рендеринга.

4. Восстановить upstream-версию `DiffRenderer.tsx`, если она всё ещё существует upstream.

5. Удалить `diff-parser.ts`, его тест и экспорт из `utils/index.ts`, если они больше не используются.

6. Удалить строку из таблицы fork-патчей и этот файл.

## Upstream

Не отправлен. Desktop-specific функционал.
