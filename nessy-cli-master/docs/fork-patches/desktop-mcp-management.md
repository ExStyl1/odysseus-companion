# desktop-mcp-management

## AIDT

AIDT-7111

## Зачем

Desktop показывал MCP-серверы отключёнными до ручного переподключения и не предоставлял полный набор TUI-механик управления. Патч запускает incremental discovery при открытии страницы, обновляет состояние через polling и добавляет управление подключением, OAuth, tools и resources.

Страница также использует общую кнопку обновления и прокручивается к форме после выбора добавления или редактирования сервера.

## Файлы

- `packages/acp-bridge/src/status.ts` — расширенный MCP status-контракт и resources
- `packages/cli/src/acp-integration/acpAgent.test.ts` — регрессионное покрытие discovery и управления
- `packages/cli/src/acp-integration/acpAgent.ts` — MCP status, discovery, resources и lifecycle-команды
- `packages/cli/src/serve/index.ts` — экспорт MCP resources-контрактов
- `packages/desktop/apps/electron/src/renderer/pages/settings/NessySettingsPage.tsx` — MCP UI, polling, действия и прокрутка к редактору
- `packages/desktop/apps/electron/src/shared/__tests__/ipc-channels.test.ts` — проверка MCP IPC-каналов
- `packages/desktop/apps/electron/src/shared/types.ts` — Desktop API для MCP
- `packages/desktop/apps/electron/src/transport/channel-map.ts` — MCP transport mappings
- `packages/desktop/packages/server-core/src/handlers/rpc/settings.ts` — MCP RPC handlers
- `packages/desktop/packages/shared/src/agent/index.ts` — экспорт MCP ACP helpers
- `packages/desktop/packages/shared/src/agent/nessy-agent.ts` — MCP ACP helpers
- `packages/desktop/packages/shared/src/i18n/locales/de.json` — строки MCP UI
- `packages/desktop/packages/shared/src/i18n/locales/en.json` — строки MCP UI
- `packages/desktop/packages/shared/src/i18n/locales/es.json` — строки MCP UI
- `packages/desktop/packages/shared/src/i18n/locales/hu.json` — строки MCP UI
- `packages/desktop/packages/shared/src/i18n/locales/ja.json` — строки MCP UI
- `packages/desktop/packages/shared/src/i18n/locales/pl.json` — строки MCP UI
- `packages/desktop/packages/shared/src/i18n/locales/ru.json` — строки MCP UI
- `packages/desktop/packages/shared/src/i18n/locales/zh-Hans.json` — строки MCP UI
- `packages/desktop/packages/shared/src/protocol/channels.ts` — MCP RPC channels
- `packages/desktop/packages/shared/src/protocol/dto.ts` — MCP DTO
- `packages/desktop/packages/shared/src/protocol/routing.ts` — удалённо доступные MCP routes

## Откат

1. Удалить MCP status/resources и lifecycle-расширения из ACP status-контракта и `NessyAgent`.
2. Удалить MCP ACP helpers, RPC handlers, channels, DTO и transport mappings из Desktop.
3. Вернуть MCP-раздел Desktop к конфигурационному списку без runtime status, polling, details и lifecycle-действий.
4. Удалить добавленные строки локализации и MCP IPC-тесты.
5. Удалить маркеры `[nessy-fork] desktop-mcp-management`, строку из реестра и этот файл.

## Upstream

Не отправлен.
