# mcp-managed-home-placeholder

## Зачем

Расширения и MCP-конфигурации могут указывать `${NESSY_HOME}` в строковых
полях, например в `env.DP_WORKDIR`. При отсутствии переменной в окружении
Nessy CLI всё равно знает активный глобальный каталог через
`Storage.getGlobalNessyDir()`, поэтому placeholder должен разрешаться в этот
каталог.

Если пользователь задал `process.env.NESSY_HOME`, используется его значение.
Иначе используется стандартный `~/.nessy` или каталог, выбранный текущей
конфигурацией Nessy.

## Файлы

- `packages/cli/src/config/settings.ts` — fallback для settings.
- `packages/cli/src/config/settings.test.ts` — default и пользовательский env.
- `packages/core/src/extension/extensionManager.ts` — fallback для extension
  manifests.
- `packages/core/src/extension/extensionManager.test.ts` — default и
  пользовательский env.
- Документация настроек и расширений.

## Откат

Удалить fallback `NESSY_HOME` из `settings.ts` и `extensionManager.ts`,
специфичные тесты, документацию и эту запись реестра.
