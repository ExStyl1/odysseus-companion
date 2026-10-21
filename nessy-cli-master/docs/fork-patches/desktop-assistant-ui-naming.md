# desktop-assistant-ui-naming

## AIDT

AIDT-7352

## Зачем

В пользовательском интерфейсе Desktop сущность называлась PET, «Pet» или
«Питомец». Для пользовательского сценария это помощник, поэтому видимые
английские и русские подписи, описание, контекстное меню и заголовок окна
используют названия «Assistant» и «Помощник».

Внутренние идентификаторы, API и формат `pet.json` не переименовываются, чтобы
изменение оставалось только интерфейсным.

## Файлы

- `packages/desktop/apps/electron/src/main/window-manager.ts` — задаёт пользовательский заголовок окна `Nessy Assistant`
- `packages/desktop/packages/shared/src/i18n/locales/en.json` — использует Assistant в английских интерфейсных строках
- `packages/desktop/packages/shared/src/i18n/locales/ru.json` — использует «Помощник» в русских интерфейсных строках

Ключевая кодовая точка помечена
`// [nessy-fork] desktop-assistant-ui-naming`.

## Откат

1. Вернуть пользовательские строки Pet и «Питомец» в обеих локалях.
2. Вернуть заголовок окна `Nessy Pet`.
3. Удалить маркер `[nessy-fork] desktop-assistant-ui-naming`, строку из реестра и этот файл.

## Upstream

Не отправлен.
