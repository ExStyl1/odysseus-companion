# desktop-skill-logging

## AIDT

AIDT-7524

## Зачем

При установке навыков возникали проблемы с отладкой:

- Источником иногда уходила ссылка-обёртка на веб-интерфейс маркета — CLI отвечает
  «неподдерживаемый source»
- В логах нет записей об ошибках — отладка сводится к угадыванию
- Ошибки видны только в консоли разработчика, а не в файле лога приложения

Этот форк-патч добавляет расширенное логирование операций Marketplace:

- `SKILLS_MARKETPLACE_DISCOVERY` — данные от ACP (name, level, managedId, filePath)
  для навыков без filePath
- `[SKILL_SCOPE]` — фактическое расположение файлов навыка
- `SKILLS_MARKETPLACE_SCOPES` — итоговый список принятых навыков с scopes
- При успешной установке — строка с эквивалентной командой: источник, агент,
  scope, рабочий каталог
- При неудачной установке — строка с причиной и идентификатором навыка для всех
  трёх случаев: навык не разрешён в каталоге, нет канонического адреса, установка
  вернула ошибку

## Файлы

- `packages/desktop/packages/server-core/src/handlers/rpc/skills.ts` — логирование
  `SKILLS_MARKETPLACE_DISCOVERY`, `[SKILL_SCOPE]`, `SKILLS_MARKETPLACE_SCOPES`,
  логирование успешной/неуспешной установки с причиной ошибки
- `packages/desktop/packages/server-core/src/services/internal-marketplace.ts` —
  логирование разрешения навыка и источника установки
- `packages/desktop/apps/electron/src/renderer/event-processor/handlers/session.ts` —
  логирование обнаружения навыков и определения scope

## Откат

1. Удалить все вызовы логирования `SKILLS_MARKETPLACE_DISCOVERY`,
   `[SKILL_SCOPE]`, `SKILLS_MARKETPLACE_SCOPES`.
2. Удалить логирование успешной/неуспешной установки навыков.
3. Удалить маркеры `// [nessy-fork] desktop-skill-logging`.

## Upstream

Не отправлен. Внутренняя фича Desktop для отладки операций Marketplace.
