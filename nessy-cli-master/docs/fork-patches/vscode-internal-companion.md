# vscode-internal-companion

## AIDT

-

## Зачем

Внутреннее расширение Nessy CLI Companion распространяется из корпоративного S3, а не через публичный Marketplace. Fork публикует versioned VSIX и независимые stable/beta aliases с manifest-файлами, периодически проверяет выбранный канал, устанавливает скачанный VSIX через VS Code API с кроссплатформенным CLI fallback и предлагает перезапустить extension host.

Публичные provider-настройки удалены из Settings. Диалог `/auth` оставляет только `dp-auth` и custom OpenAI-compatible provider; `dp-auth` переаутентифицируется через существующее ACP connection без запроса API key и без пересоздания webview/session. Определение VS Code по окружению восстановлено для IDE-интеграции.

## Файлы

- `.gitlab-ci.yml` — сборка и публикация versioned VSIX, channel alias и manifest
- `docs/users/integration-vscode.md` и `docs-ru/users/ide/integration-vscode.md` — внутренняя установка и обновление расширения
- `packages/core/src/ide/detect-ide.ts` и `detect-ide.test.ts` — определение VS Code по окружению
- `packages/core/src/ide/ide-installer.ts` и `ide-installer.test.ts` — установка внутреннего расширения
- `packages/vscode-ide-companion/README.md` — внутреннее описание и установка
- `packages/vscode-ide-companion/package.json` — настройки auto-update и beta-канала
- `packages/vscode-ide-companion/scripts/prepackage.js` — сборка workspace-зависимостей CLI bundle и Web Shell перед packaging
- `scripts/tests/vscode-prepackage.test.ts` — проверка состава и порядка этих зависимостей
- `packages/vscode-ide-companion/src/extension.ts` и `extension.test.ts` — проверка, скачивание и установка обновлений
- `packages/vscode-ide-companion/src/utils/logger.ts` и `logger.test.ts` — production-логирование расширения
- `packages/vscode-ide-companion/src/webview/handlers/AuthMessageHandler.ts` и `AuthMessageHandler.test.ts` — ограниченный список providers и dp-auth без API key
- `packages/vscode-ide-companion/src/services/nessyAgentManager.ts` — переаутентификация через существующее ACP connection
- `packages/vscode-ide-companion/src/webview/providers/WebViewProvider.ts` и `WebViewProvider.test.ts` — отдельный dp-auth flow без reconnect

## Откат

1. Вернуть публикацию и проверку обновлений к upstream Marketplace flow, удалить S3 manifests, channel aliases и настройки auto-update/beta
2. Удалить предварительную сборку CLI bundle dependencies из `prepackage.js` и её regression test
3. Вернуть upstream README и документацию установки
4. Вернуть upstream IDE detection и installer
5. Восстановить полный список providers и generic provider setup в VS Code `/auth`
6. Удалить ACP `authenticate()` wrapper и отдельную ветку `dp-auth` в `WebViewProvider`
7. Удалить маркеры `[nessy-fork] vscode-internal-companion`, строку из реестра и этот файл

## Upstream

Не отправлен. Внутренняя инфраструктура распространения и авторизации.
