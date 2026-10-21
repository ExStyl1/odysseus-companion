# auto-update-migration

## AIDT

AIDT-6502

## Зачем

Расширение `@nestor/nessy-cli-extensions`, установленное через npm, не
обновлялось автоматически, если параметр `autoUpdate` отсутствовал в
метаданных. Source мог быть сохранён как `@Nestor/nessy-cli-extensions`, из-за
чего default extension считался неустановленным и во время обновления
параллельно запускалась его повторная установка.

**Проблема:**

- Пользователи не получали автоматические обновления расширения
- Требовалась ручная переустановка с флагом `--auto-update`
- При обновлении расширения мог запускаться `/extensions install` для уже
  установленного default extension

**Решение:**

- Автоматическая миграция при первом запуске CLI
- Обновление `.nessy-extension-install.json` с `autoUpdate: true`
- Новые пользователи получают `--auto-update` сразу при установке
- Регистронезависимое распознавание npm source default extension
- Подавление диалога повторной установки для уже установленного расширения

## Файлы

- `packages/cli/src/ui/AppContainer.tsx`
- `packages/cli/src/ui/hooks/use-default-extension-dialog.ts`
- `packages/cli/src/ui/hooks/use-default-extension-dialog.test.ts`
- `packages/core/src/extension/migration.ts`
- `packages/core/src/extension/extensionManager.ts`
- `packages/core/src/extension/extensionManager.test.ts`
- `packages/core/src/extension/index.ts`
- `packages/core/src/extension/migration.test.ts`

## Код-маркеры

```ts
// [nessy-fork] auto-update-migration
```

Размещён в:

- `use-default-extension-dialog.ts` — проверка установленного default extension
  и команда установки с `--auto-update`
- `extensionManager.ts` — вызов `migrateAutoUpdateForNpmExtension()` в
  `refreshCache()`
- `migration.ts` — регистронезависимое распознавание extension и миграция
  метаданных
- `index.ts` — экспорт функций миграции для CLI

## Откат

1. Удалить вызов `migrateAutoUpdateForNpmExtension()` из `refreshCache()` в
   `extensionManager.ts`
2. Удалить регистронезависимую проверку и функции auto-update из `migration.ts`
3. Вернуть локальную проверку default extension и удалить флаг `--auto-update`
   из `use-default-extension-dialog.ts`
4. Удалить экспорт миграции из `index.ts`
5. Удалить тесты распознавания и миграции
6. Удалить строку из `docs/fork-patches/README.md`
7. Удалить этот файл

## Upstream

Не отправлен. Fork-specific миграция для существующих пользователей T-Bank.
