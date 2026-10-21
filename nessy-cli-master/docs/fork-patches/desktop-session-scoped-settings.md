# desktop-session-scoped-settings

## AIDT

-

## Зачем

Desktop применял permission mode как общее состояние приложения, поэтому
переключение режима в одном чате меняло остальные сессии или сбрасывало их в
`Auto`. Выбор модели в чате также мог перезаписать default-модель подключения,
а session-level значение модели не сохранялось в локальной истории.

Этот fork-патч хранит permission mode и модель отдельно для каждой сессии.
Глобальные значения используются только как defaults для новых и legacy-сессий.
Выбор в черновике нового чата передаётся создаваемой сессии и не меняет defaults
подключения. Оба значения сохраняются в JSONL и восстанавливаются после
перезапуска Desktop.

## Файлы

- `packages/desktop/apps/electron/src/renderer/App.tsx` — независимое renderer-состояние permission mode для каждой сессии
- `packages/desktop/apps/electron/src/renderer/context/AppShellContext.tsx` — session-level разрешение effective permission mode
- `packages/desktop/apps/electron/src/renderer/pages/ChatPage.tsx` — изменение модели только выбранной сессии
- `packages/desktop/apps/electron/src/renderer/pages/DraftChatPage.tsx` — локальный выбор модели для создаваемой сессии
- `packages/desktop/packages/server-core/src/sessions/SessionManager.ts` — независимое применение и сохранение permission mode и модели
- `packages/desktop/packages/shared/src/sessions/types.ts` — persistent-поля сессии
- `packages/desktop/packages/shared/src/sessions/jsonl.ts` — запись и восстановление значений из JSONL
- `packages/desktop/packages/shared/src/sessions/storage.ts` — сохранение модели в metadata
- `packages/desktop/packages/shared/src/sessions/persistence-queue.ts` — merge session-level metadata
- тесты рядом с перечисленными модулями — регрессии изоляции и восстановления

## Откат

1. Вернуть permission mode к единому app-wide состоянию и удалить session-level persistence.

2. Вернуть обновление connection default из model selector и исключить модель из persistent-полей сессии.

3. Удалить session-level регрессионные тесты.

4. Удалить строку из таблицы fork-патчей и этот файл.

## Upstream

Не отправлен. Desktop-specific исправление.
