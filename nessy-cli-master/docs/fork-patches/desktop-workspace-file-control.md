# desktop-workspace-file-control

## AIDT

AIDT-7196

## Зачем

Агент в Desktop не мог по просьбе пользователя открыть файл, встроенный
браузер или дерево рабочей папки. Пользователь мог перейти к файлу только по
ссылке в сообщении, а после закрытия панели не всегда мог открыть её повторно.

Патч добавляет агенту действия `open_file`, `open_url` и `show_workspace`,
кнопки открытия дерева во всех меню рабочего пространства и закрытую по
умолчанию панель проекта. При открытии все папки дерева свёрнуты. Дерево
показывается только для сессий с явно подключённой рабочей папкой и скрывает
служебные элементы `config.json`, `sessions`, `events.jsonl`, `sources`,
`views.json`, `statuses`, `labels`, `.DS_Store`, `dist`, `build`, `.git`,
`.idea` и `node_modules`.

Текстовые файлы из дерева открываются во встроенном preview, где их можно
редактировать и сохранять. Путь изменённого пользователем файла незаметно
добавляется к контексту следующего обычного сообщения, не меняя видимый текст
пользователя и не запуская новый ход автоматически.

## Файлы

- `packages/desktop/apps/electron/src/renderer/App.tsx` — состояние панели, обработка действий агента, preview, редактирование и сохранение файлов
- `packages/desktop/apps/electron/src/renderer/components/app-shell/AppShell.tsx` — передача команды открытия дерева в верхнюю панель
- `packages/desktop/apps/electron/src/renderer/components/app-shell/TopBar.tsx` — открытие дерева из кнопки и меню рабочего пространства
- `packages/desktop/apps/electron/src/renderer/components/app-shell/WorkingDirectoryPanel.tsx` — закрываемая панель дерева проекта
- `packages/desktop/apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx` — открытие дерева из меню выбора рабочей папки
- `packages/desktop/apps/electron/src/renderer/components/right-sidebar/SessionFilesSection.tsx` — свёрнутое по умолчанию дерево проекта, открытие файлов и пустые папки
- `packages/desktop/apps/electron/src/renderer/components/right-sidebar/session-files-watch.ts` — наблюдение за явно заданным корнем
- `packages/desktop/apps/electron/src/renderer/components/right-sidebar/__tests__/session-files-watch.test.ts` — тест режима наблюдения за проектом
- `packages/desktop/apps/electron/src/renderer/context/AppShellContext.tsx` — callback открытия дерева
- `packages/desktop/apps/electron/src/renderer/playground/mock-utils.ts` — mock записи файла
- `packages/desktop/apps/electron/src/shared/types.ts` — Desktop API записи файла
- `packages/desktop/apps/electron/src/transport/channel-map.ts` — transport mapping записи файла
- `packages/desktop/packages/server-core/src/handlers/rpc/files.ts` — безопасная запись файла и уведомление сессии
- `packages/desktop/packages/server-core/src/handlers/rpc/sessions.ts` — получение отфильтрованного дерева проекта
- `packages/desktop/packages/server-core/src/handlers/session-manager-interface.ts` — контракт уведомления об изменённом файле
- `packages/desktop/packages/server-core/src/sessions/SessionManager.ts` — Desktop actions, локальный MCP endpoint и дополнительный контекст изменённых файлов
- `packages/desktop/packages/session-tools-core/src/index.ts` — экспорт схемы Desktop tool
- `packages/desktop/packages/session-tools-core/src/tool-defs.ts` — схема и описание Desktop tool
- `packages/desktop/packages/session-tools-core/src/tool-defs-filtering.test.ts` — проверка доступности Desktop tool
- `packages/desktop/packages/shared/src/agent/desktop-tool.ts` — реализация действий управления Desktop
- `packages/desktop/packages/shared/src/agent/__tests__/desktop-tool.test.ts` — тесты действий управления Desktop
- `packages/desktop/packages/shared/src/agent/backend/types.ts` — backend callback управления Desktop
- `packages/desktop/packages/shared/src/agent/index.ts` — экспорт Desktop tool
- `packages/desktop/packages/shared/src/agent/mode-manager.ts` — доступность инструмента в режимах агента
- `packages/desktop/packages/shared/src/agent/nessy-agent.ts` — регистрация Desktop tool
- `packages/desktop/packages/shared/src/agent/session-scoped-tool-callback-registry.ts` — session-scoped callback управления интерфейсом
- `packages/desktop/packages/shared/src/agent/session-scoped-tools.ts` — подключение Desktop tool к сессии
- `packages/desktop/packages/shared/src/agent/__tests__/session-tool-safe-mode-permissions.test.ts` — safe-mode поведение Desktop tool
- `packages/desktop/packages/shared/src/mcp/local-http-server.ts` — локальный HTTP MCP endpoint сессионных инструментов
- `packages/desktop/packages/shared/src/mcp/local-http-server.test.ts` — тест локального MCP endpoint
- `packages/desktop/packages/shared/src/mcp/index.ts` — экспорт локального MCP server
- `packages/desktop/packages/shared/src/prompts/system.ts` — инструкция агенту по управлению Desktop
- `packages/desktop/packages/shared/src/protocol/channels.ts` — RPC channel записи файла
- `packages/desktop/packages/shared/src/protocol/dto.ts` — событие действия Desktop
- `packages/desktop/packages/shared/src/i18n/locales/*.json` — локализованное название дерева проекта
- `packages/desktop/packages/ui/src/components/overlay/CodePreviewOverlay.tsx` — callback сохранения редактируемого кода
- `packages/desktop/packages/ui/src/components/overlay/DocumentFormattedMarkdownOverlay.tsx` — callback сохранения Markdown
- `packages/desktop/packages/ui/src/components/overlay/JSONPreviewOverlay.tsx` — callback сохранения JSON

## Откат

1. Удалить Desktop tool, session-scoped callback, локальный MCP endpoint и связанные тесты.
2. Удалить событие Desktop action и обработку открытия файла, браузера и дерева.
3. Удалить панель дерева проекта, команды её открытия и фильтрацию служебных элементов.
4. Вернуть preview к режиму без сохранения и удалить RPC записи файла.
5. Удалить накопление изменённых пользователем файлов и их добавление к контексту следующего сообщения.
6. Удалить локализации, маркеры `[nessy-fork] desktop-workspace-file-control`, строку из реестра и этот файл.

## Upstream

Не отправлен.
