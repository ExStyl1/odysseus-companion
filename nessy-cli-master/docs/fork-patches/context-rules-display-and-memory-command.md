# context-rules-display-and-memory-command

## AIDT
AIDT-7636

## Зачем
Показывать все context rules (baseline + conditional injected) в выводе `/context detail` и корректно считать токены memory files. Убрать ложный `argumentHint` из команды `/memory`, который рекламировал несуществующие подкоманды.

## Файлы
- `packages/cli/src/ui/commands/contextCommand.ts`
- `packages/cli/src/ui/commands/contextCommand.test.ts`
- `packages/cli/src/ui/commands/memoryCommand.ts`
- `packages/cli/src/ui/commands/memoryCommand.test.ts`
- `packages/core/src/utils/rulesDiscovery.ts`
- `packages/core/src/utils/rulesDiscovery.test.ts`
- `docs/users/features/context-rules.md`
- `docs-ru/users/work/features/context-rules.md`
- `docs/users/features/_meta.ts`

## Откат
1. Удалить маркеры `// [nessy-fork] context-rules-display-and-memory-command` из `contextCommand.ts`, `memoryCommand.ts`, `rulesDiscovery.ts`.
2. Удалить тесты на парсинг rules из `contextCommand.test.ts`, `rulesDiscovery.test.ts`.
3. Удалить тест на отсутствие `argumentHint` из `memoryCommand.test.ts`.
4. Удалить документацию context rules из `docs/users/features/` и `docs-ru/users/work/features/`.
5. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream
Не отправлен.
